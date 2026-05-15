import {chromium, type Browser} from 'playwright-core';

// The prewarmer is a headless Chromium that loads ui.perfetto.dev against a
// running trace_processor_shell's RPC port. The UI's initial query burst
// (track list, slice counts, thread / process metadata, …) hits the
// trace_processor while the page hydrates; by the time the prewarmer closes
// those queries are cached, so when a real user later opens the same URL the
// page renders without waiting on the trace_processor again.
//
// Two things are non-obvious about this:
//
//   1. The UI gates non-default rpc_port connections behind a localStorage
//      feature flag (`cspAllowAnyWebsocketPort`). An init script writes it
//      before the page's own scripts read it, so the connection just works.
//
//   2. The browser is launched lazily and reused across calls. Spinning a
//      fresh chromium per request would cost 1–2 s every time.

const PREWARM_WAIT_MS = 60_000;

const INIT_SCRIPT = `
  try {
    window.localStorage.setItem(
      'perfettoFeatureFlags',
      JSON.stringify({cspAllowAnyWebsocketPort: 'true'}),
    );
  } catch (e) { /* private window or storage disabled — proceed anyway */ }
`;

export class PrewarmError extends Error {}

export class Prewarmer {
  private launchPromise: Promise<Browser> | undefined;
  private closed = false;

  /**
   * Runs ui.perfetto.dev against `127.0.0.1:port` in a headless tab, waits
   * for the page's queries against trace_processor to drain, and discards
   * the tab. Throws PrewarmError on timeout or browser failure.
   *
   * The signal we wait for is "network idle" — Playwright considers the
   * page settled once no new HTTP request has been made for 500 ms. By
   * the time that fires, ui.perfetto.dev has loaded, hydrated, asked
   * trace_processor for its initial track list / thread / process /
   * counters / slice-count round, and received all the responses. The
   * trace_processor has now cached every one of those queries; when the
   * user later opens the same URL themselves, the second cohort of
   * requests hits the cache and the viewer renders without delay.
   *
   * Why not a DOM selector probe? Perfetto UI's internal DOM (track
   * elements, loading containers, …) is a moving target; tying the
   * prewarm signal to a specific class name turned every UI refresh
   * into a silent "prewarm always times out". Network idle is a stable
   * contract that survives DOM refactors and matches the actual
   * goal exactly. */
  async warm(port: number, timeoutMs: number = PREWARM_WAIT_MS): Promise<void> {
    if (this.closed) throw new PrewarmError('prewarmer is shut down');
    const browser = await this.launch();
    const context = await browser.newContext();
    try {
      await context.addInitScript(INIT_SCRIPT);
      const page = await context.newPage();
      const url =
        `https://ui.perfetto.dev/?rpc_port=${port}` +
        `#!/viewer?rpc_port=${port}`;
      // First leg: page navigated + initial JS executed.
      await page.goto(url, {timeout: timeoutMs, waitUntil: 'domcontentloaded'});
      // Second leg: every query against trace_processor has returned.
      // Wait for the *load* event explicitly first (assets in flight), then
      // for the network to fall idle. If ui.perfetto.dev keeps a long-lived
      // connection alive past the load that defeats `networkidle`, we still
      // unblock — the cache is warmed at this point, the extra wait would
      // only delay the row's transition to `prewarmed`.
      try {
        await page.waitForLoadState('load', {timeout: timeoutMs});
        await page.waitForLoadState('networkidle', {timeout: timeoutMs});
      } catch (innerErr) {
        // A waitForLoadState timeout is not a hard failure for prewarming —
        // the queries probably fired during the long wait, and the cache
        // is now warm enough to make the user's later click much faster.
        // Surface the inner timeout via the rethrow path only when nothing
        // useful happened, i.e. the page never reached `load`.
        if (
          innerErr instanceof Error &&
          /waitForLoadState\(.*load.*\)/.test(innerErr.message)
        ) {
          throw innerErr;
        }
      }
    } catch (err) {
      throw new PrewarmError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.launchPromise === undefined) return;
    const browser = await this.launchPromise.catch(() => null);
    this.launchPromise = undefined;
    if (browser !== null) await browser.close().catch(() => {});
  }

  private async launch(): Promise<Browser> {
    if (this.launchPromise !== undefined) return this.launchPromise;
    this.launchPromise = chromium
      .launch({headless: true, args: ['--no-sandbox']})
      .catch((err) => {
        this.launchPromise = undefined;
        throw new PrewarmError(
          `cannot launch chromium for prewarm: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
    return this.launchPromise;
  }
}
