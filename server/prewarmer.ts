import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {chromium, type BrowserContext, type Page} from 'playwright-core';

// The prewarmer is a headless Chromium that loads ui.perfetto.dev against a
// running trace_processor_shell's RPC port. The UI's initial query burst
// (track list, slice counts, thread / process metadata, plugin work, …) hits
// trace_processor while the page hydrates; by the time the prewarmer closes
// those queries are cached, so when a real user later opens the same URL the
// page renders without waiting on the trace_processor again.
//
// Three things are non-obvious about this:
//
//   1. The UI gates non-default rpc_port connections behind a localStorage
//      feature flag (`cspAllowAnyWebsocketPort`). An init script writes it
//      before the page's own scripts read it, so the connection just works.
//
//   2. When trace_processor reports a preloaded trace, the UI shows a
//      "Use trace processor native acceleration?" dialog and blocks the
//      load on a user click. The same init script attaches a tiny
//      MutationObserver that auto-clicks "YES, use loaded trace" the
//      moment the dialog renders.
//
//   3. The browser is launched lazily and reused across calls. Spinning a
//      fresh chromium per request would cost 1–2 s every time.
//
// We wait for full quiescence — not just network idle — via Perfetto's own
// `window.waitForPerfettoIdle()`. That signal checks: no in-flight trace
// engine requests, no pending redraws, no `.progress.progress-anim`
// indicator, no running message-mode omnibox, no outstanding task-tracker
// tasks, no non-infinite running animations. It is the exact "is the UI
// idle?" predicate the Perfetto team uses in its own tests, so plugins
// have run, every initial query has come back, and trace_processor's
// cache reflects the full set the UI fires.
//
// On top of all that, callers can pass `prewarmSql`: arbitrary SQL that's
// POSTed to the trace_processor's `/query` endpoint after the page settles.
// Use this to prime modules and queries the user knows they'll run later
// (`INCLUDE PERFETTO MODULE android.startup; SELECT * FROM android_startups;`
// …) so the UI's ad-hoc SQL hits a fully-warm cache too.

// Per-step timeout for Playwright operations inside warm(). Five
// minutes covers very large traces (~500 MB scale) where Perfetto's
// post-load WebSocket query burst, plus the inner 60 s Perfetto idle
// deadline + networkidle fallback, can each take more than a minute.
// Hitting this is "something is genuinely wrong", not "slow trace".
const PREWARM_WAIT_MS = 300_000;
const PREWARM_SQL_TIMEOUT_MS = 120_000;
const IDLE_HYSTERESIS_MS = 250;
// How long to wait for Perfetto's main bundle to install its test
// hooks on `window`. The bundle finishes initializing well after
// Playwright's `load` event fires; 30 s is comfortable headroom even
// on a cold network without making "Perfetto truly never booted"
// indistinguishable from a slow start.
const PERFETTO_BOOT_TIMEOUT_MS = 30_000;

/**
 * The init script injected into every prewarm tab before any page-script
 * runs. Composed of two independent concerns (separated for readability,
 * concatenated for transport — Playwright takes a single string per
 * `addInitScript`).
 */

/** Enables the `cspAllowAnyWebsocketPort` Perfetto feature flag, which
 *  lets the UI open a WebSocket to a non-default rpc_port. Without this
 *  the UI shows the "Using a different port requires a flag change"
 *  modal and never even tries to connect to trace_processor.
 *
 *  The value must match Perfetto's `OverrideState` enum exactly —
 *  Perfetto validates the localStorage blob with a Zod schema that
 *  accepts only the literals `'OVERRIDE_TRUE'` and `'OVERRIDE_FALSE'`,
 *  and silently drops anything else (including the obvious-looking
 *  `'true'` / `true`). Source:
 *    ui/src/core/feature_flags.ts → Flags.load(), and
 *    ui/src/public/feature_flag.ts → OverrideState. */
const FEATURE_FLAG_SCRIPT = `
  try {
    window.localStorage.setItem(
      'perfettoFeatureFlags',
      JSON.stringify({cspAllowAnyWebsocketPort: 'OVERRIDE_TRUE'}),
    );
  } catch (e) { /* private window or storage disabled — proceed anyway */ }
`;

/** Watches the DOM for any Perfetto modal that would otherwise block the
 *  headless prewarm tab forever, and auto-clicks the right button:
 *
 *   - "Version mismatch"
 *       → "Use mismatched version regardless (might crash)" — needed when
 *         the local trace_processor binary is a different version from
 *         the ui.perfetto.dev release. Without this the prewarm hangs
 *         before it ever gets to the preloaded-trace dialog.
 *
 *   - "Use trace processor native acceleration?"
 *       → "YES, use loaded trace" — the preloaded-trace dialog. Without
 *         this the page never asks trace_processor for the loaded trace
 *         and the prewarm is a no-op against the engine.
 *
 *  Each successful click stamps `window.__autoAcceptFiredAt[<key>]` with
 *  the click time so the bench can verify both dialogs were seen. */
const AUTO_ACCEPT_SCRIPT = `
  (function autoAcceptPerfettoDialogs() {
    if (!window.__autoAcceptFiredAt) window.__autoAcceptFiredAt = {};
    // Each rule matches a dialog by title regex and picks a button by
    // text regex. Ordered: highest-priority first; we click at most one
    // button per tick to give Perfetto's modal-close + re-open animation
    // time to settle before the next match.
    var rules = [
      {
        key: 'versionMismatch',
        title: /version mismatch/i,
        button: /mismatched version regardless/i,
      },
      {
        key: 'preloadedTrace',
        title: /native acceleration/i,
        button: /use loaded trace/i,
      },
    ];
    function tryClick() {
      var dialog = document.querySelector('.pf-modal-dialog');
      if (dialog === null) return;
      var titleEl = dialog.querySelector('h1');
      if (titleEl === null) return;
      var titleText = titleEl.textContent || '';
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!rule.title.test(titleText)) continue;
        if (window.__autoAcceptFiredAt[rule.key] !== undefined) return;
        var buttons = dialog.querySelectorAll('footer button');
        for (var i = 0; i < buttons.length; i++) {
          if (rule.button.test(buttons[i].textContent || '')) {
            window.__autoAcceptFiredAt[rule.key] = performance.now();
            buttons[i].click();
            return;
          }
        }
        return;
      }
    }
    var start = function () {
      if (document.body === null) { setTimeout(start, 50); return; }
      new MutationObserver(tryClick).observe(
        document.body, {childList: true, subtree: true},
      );
      // Modal may already exist at injection time.
      tryClick();
    };
    start();
  })();
`;

const INIT_SCRIPT = FEATURE_FLAG_SCRIPT + AUTO_ACCEPT_SCRIPT;

export class PrewarmError extends Error {}

/**
 * Hand-encodes a trace_processor.QueryArgs proto (single optional string at
 * field 1) and POSTs it to a running trace_processor_shell's `/query`
 * endpoint. We do not need protobufjs here — the wire format for one
 * length-delimited string is short enough to encode by hand, and avoiding
 * the dependency keeps the prewarmer light. The result stream is drained
 * and discarded: we only care that the SQL ran, not what it returned.
 */
function encodeQueryArgs(sql: string): Buffer {
  const sqlBytes = Buffer.from(sql, 'utf8');
  const lenBytes: number[] = [];
  let len = sqlBytes.length;
  while (len > 0x7f) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  lenBytes.push(len);
  return Buffer.concat([
    Buffer.from([0x0a]), // field 1 (sql_query), wire type 2 (length-delimited)
    Buffer.from(lenBytes),
    sqlBytes,
  ]);
}

function runSql(
  host: string,
  port: number,
  sql: string,
  timeoutMs: number,
): Promise<void> {
  const body = encodeQueryArgs(sql);
  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host,
        port,
        path: '/query',
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Content-Length': String(body.length),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.on('data', () => {}); // drain
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('SQL query timed out')));
    req.write(body);
    req.end();
  });
}

export class Prewarmer {
  private contextPromise: Promise<BrowserContext> | undefined;
  private userDataDir: string | undefined;
  private closed = false;

  /**
   * @param prewarmSql  Extra SQL run against trace_processor after the UI
   *                    settles. Empty = no second pass. Multi-statement
   *                    input is supported — the whole blob is sent in
   *                    one `QueryArgs.sql_query`.
   */
  constructor(private readonly prewarmSql: string = '') {}

  /**
   * Runs ui.perfetto.dev against `127.0.0.1:port` in a headless tab, waits
   * for the UI to reach quiescence, optionally runs user-supplied SQL,
   * and discards the tab. Throws `PrewarmError` on timeout or browser
   * failure.
   *
   * The quiescence signal is Perfetto's own `window.waitForPerfettoIdle()`
   * — a test utility shipped by ui.perfetto.dev that returns when every
   * one of the following is true:
   *   - no in-flight trace engine requests
   *   - no pending raf redraws
   *   - no outstanding tasks in either task tracker
   *   - no `.progress.progress-anim` element in the DOM
   *   - no `.pf-omnibox--message-mode` element in the DOM
   *   - no non-infinite running animations
   * In other words: the UI has fully booted, every plugin has run, every
   * initial query the page fires has returned, and trace_processor's
   * cache reflects that whole set.
   *
   * Why prefer this over `networkidle`: networkidle is HTTP-focused and
   * doesn't track Perfetto's WebSocket frames cleanly, so it can fire
   * before the engine queries finish. `waitForPerfettoIdle` is the
   * predicate Perfetto's own tests use, so a Perfetto refactor that
   * changes how queries fan out updates this signal too. */
  async warm(port: number, timeoutMs: number = PREWARM_WAIT_MS): Promise<void> {
    if (this.closed) throw new PrewarmError('prewarmer is shut down');
    const t0 = Date.now();
    const stage = (name: string): void => {
      // One log line per major step so an operator can see, after the
      // fact, exactly where prewarm spent its time and whether the
      // page-load or the SQL pass dominated.
      process.stdout.write(
        `prewarm:   :${port}  +${((Date.now() - t0) / 1000).toFixed(2)}s  ${name}\n`,
      );
    };
    const context = await this.launch();
    stage('launched browser');
    const page = await context.newPage();
    stage('new page');
    try {
      // URL form documented by ui.perfetto.dev itself in
      //   ui/src/frontend/index.ts:112 (`'https://ui.perfetto.dev/#!/?rpc_port=1234'`).
      // The rpc_port lives in the hash route's query, not in location.search:
      // Perfetto reads it via Router.parseUrl(...).args.rpc_port. Putting it
      // in location.search silently does nothing.
      const url = `https://ui.perfetto.dev/#!/?rpc_port=${port}`;
      await page.goto(url, {timeout: timeoutMs, waitUntil: 'domcontentloaded'});
      stage('domcontentloaded');
      await page.waitForLoadState('load', {timeout: timeoutMs});
      stage('load event');
      // Wait for the preloaded-trace dialog to be auto-accepted. This
      // is the moment Perfetto commits to loading the trace and starts
      // firing engine queries — *before* this point waitForPerfettoIdle
      // would return trivially-true (no in-flight engine work means
      // "idle"), and the prewarm would close the tab without warming
      // anything. The init script stamps the timestamp the instant it
      // clicks the button, so we can synchronize on it. On an older
      // Perfetto that doesn't show the dialog we time out after
      // PERFETTO_BOOT_TIMEOUT_MS and proceed — by then any direct-load
      // codepath has had ample time to start work.
      await this.waitForTraceLoadingStarted(page);
      stage('trace-load started');
      await this.waitForPerfettoIdle(page, timeoutMs);
      stage('page-load idle');
      if (this.prewarmSql.length > 0) {
        await runSql('127.0.0.1', port, this.prewarmSql, PREWARM_SQL_TIMEOUT_MS);
        stage('user-sql done');
        // The user SQL itself can spawn UI redraws (e.g. when it loads a
        // module the UI then surfaces). Wait one more time so the row
        // transitions to `prewarmed` only when the UI is *also* settled
        // against the post-SQL state.
        await this.waitForPerfettoIdle(page, timeoutMs);
        stage('post-sql idle');
      }
    } catch (err) {
      throw new PrewarmError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Blocks until Perfetto has committed to loading the trace from
   *  trace_processor — concretely, until our `AUTO_ACCEPT_SCRIPT`
   *  observes the "Use trace processor native acceleration?" dialog
   *  and clicks "use loaded trace". That click is the precise moment
   *  the UI transitions from "showing modal" to "fetching trace data
   *  from the RPC backend".
   *
   *  Why this matters: before the click, Perfetto's idle indicators
   *  are all trivially true (no in-flight engine work means "idle"),
   *  so calling waitForPerfettoIdle prematurely returns instantly and
   *  the prewarm closes the tab without populating the cache. After
   *  the click, indicators flip and the subsequent idle wait actually
   *  blocks on engine work.
   *
   *  Soft timeout: a newer/different Perfetto might never show the
   *  dialog (auto-loads). We bound the wait by PERFETTO_BOOT_TIMEOUT_MS
   *  and proceed regardless — by then any direct-load codepath has had
   *  plenty of time to start work and the following idle check picks
   *  it up cleanly. */
  private async waitForTraceLoadingStarted(page: Page): Promise<void> {
    type AcceptWindow = {__autoAcceptFiredAt?: Record<string, number>};
    try {
      await page.waitForFunction(
        () => {
          const w = globalThis as unknown as AcceptWindow;
          return w.__autoAcceptFiredAt?.preloadedTrace !== undefined;
        },
        undefined,
        {timeout: PERFETTO_BOOT_TIMEOUT_MS},
      );
    } catch {
      // Dialog never appeared in time — newer Perfetto, direct-load
      // codepath, or unrelated UI change. Fall through; the idle wait
      // that follows will catch real engine activity once it starts.
    }
  }

  /** Drives the page to a state where `trace_processor`'s cache is warm.
   *
   *  Primary signal: Perfetto's own `window.waitForPerfettoIdle(hMs)`
   *  test utility. It checks eight indicators (no in-flight engine
   *  requests, no pending redraws, no outstanding task-tracker tasks,
   *  no `.progress.progress-anim` element, no `.pf-omnibox--message-mode`
   *  element, no non-infinite running animations) and resolves only
   *  when all eight hold for `hMs` continuously. When it resolves, the
   *  trace_processor cache reflects every query the UI fires on load.
   *
   *  We must first wait for `window.waitForPerfettoIdle` to actually
   *  exist on the page. Perfetto assigns it during the async init of
   *  its main bundle, which finishes after Playwright's `load` event.
   *  Calling `page.evaluate` too early gets a "doesn't exist" answer
   *  and we'd skip the real quiescence wait. The wait is bounded by
   *  the outer prewarm timeout — on an older Perfetto build that
   *  hasn't shipped the utility, this throws and we fall back below.
   *
   *  Fallback: if `waitForPerfettoIdle` never appears, or rejects
   *  (Perfetto has a hardcoded 60s internal deadline; the
   *  omnibox-message-mode indicator occasionally stays stuck in
   *  headless because there is no user interaction to dismiss the
   *  bottom message, even though every engine indicator has settled),
   *  fall back to Playwright's `networkidle`. Playwright treats both
   *  HTTP and WebSocket connections as network activity, so once
   *  networkidle fires no more queries can be in flight — the engine
   *  cache is necessarily warm.
   *
   *  Why not parse the rejection details out of the error message:
   *  earlier revisions of this code did that, but the message format
   *  is internal to Perfetto and would silently rot if changed.
   *  `networkidle` is the documented Playwright signal and stable
   *  across Perfetto versions.
   *
   *  All `page.evaluate` callbacks run in the browser context where
   *  `window` is defined; this server module's tsconfig has no DOM lib,
   *  so we route through `globalThis` and a typed cast. */
  private async waitForPerfettoIdle(page: Page, timeoutMs: number): Promise<void> {
    type IdleWindow = {waitForPerfettoIdle?: (hMs: number) => Promise<void>};
    let symbolReady = false;
    try {
      // `waitForFunction` polls in the page until the predicate is
      // truthy, with an explicit timeout. This is the documented way
      // to wait for a script-injected symbol; busy-loop on the server
      // would have to cross the CDP boundary each tick.
      await page.waitForFunction(
        () => {
          const w = globalThis as unknown as IdleWindow;
          return typeof w.waitForPerfettoIdle === 'function';
        },
        undefined,
        {timeout: PERFETTO_BOOT_TIMEOUT_MS},
      );
      symbolReady = true;
    } catch {
      // Either Perfetto changed and the symbol is gone, or the page
      // is broken and the bundle never finished. Either way the
      // networkidle fallback is the right thing.
    }
    if (symbolReady) {
      // Perfetto's util has a hardcoded 60s internal deadline and
      // ignores any caller timeout. Catch its rejection in-page so a
      // stuck display-only indicator doesn't poison the Playwright
      // call frame.
      const idle = await page.evaluate(async (hMs) => {
        const w = globalThis as unknown as IdleWindow;
        try {
          await w.waitForPerfettoIdle!(hMs);
          return true;
        } catch {
          return false;
        }
      }, IDLE_HYSTERESIS_MS);
      if (idle) return;
    }
    // Fallback: networkidle catches WebSocket and HTTP quiescence.
    // Once it fires, no more engine queries are in flight — the
    // cache is as warm as it's going to get.
    await page.waitForLoadState('networkidle', {timeout: timeoutMs});
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.contextPromise;
    this.contextPromise = undefined;
    if (pending !== undefined) {
      const ctx = await pending.catch(() => null);
      if (ctx !== null) await ctx.close().catch(() => {});
    }
    if (this.userDataDir !== undefined) {
      fs.rmSync(this.userDataDir, {recursive: true, force: true});
      this.userDataDir = undefined;
    }
  }

  /**
   * Lazily launches a *persistent* chromium context with two non-default
   * settings that the prewarm flow needs:
   *
   *   1. `--disable-web-security` lets ui.perfetto.dev (a public origin)
   *      `fetch('http://127.0.0.1:N/status')` against trace_processor.
   *      Chrome's Local Network Access policy otherwise denies the call
   *      with "Permission was denied for this request to access the
   *      loopback address space" and the page falls back to WASM mode —
   *      the prewarm runs but never touches the trace_processor cache.
   *      Perfetto's own `cspAllowAnyWebsocketPort` feature flag relaxes
   *      Perfetto's CSP but is layered above LNA and can't bypass it.
   *
   *   2. `bypassCSP: true` so our `INIT_SCRIPT` (which sets the
   *      `perfettoFeatureFlags` localStorage value and installs the
   *      modal auto-accept observer) is not blocked by the page's
   *      strict-CSP `script-src 'self'`.
   *
   * `launch_persistent_context` is the only way to combine
   * `--disable-web-security` with a user-data-dir in Playwright. The
   * directory lives under /tmp and is removed on `close()`.
   */
  private async launch(): Promise<BrowserContext> {
    if (this.contextPromise !== undefined) return this.contextPromise;
    this.userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pf-tl-prewarm-'),
    );
    const userDataDir = this.userDataDir;
    this.contextPromise = chromium
      .launchPersistentContext(userDataDir, {
        headless: true,
        bypassCSP: true,
        args: ['--no-sandbox', '--disable-web-security'],
      })
      .then(async (ctx) => {
        await ctx.addInitScript(INIT_SCRIPT);
        return ctx;
      })
      .catch((err) => {
        this.contextPromise = undefined;
        fs.rmSync(userDataDir, {recursive: true, force: true});
        throw new PrewarmError(
          `cannot launch chromium for prewarm: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
    return this.contextPromise;
  }
}
