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
   * until the UI signals the trace has loaded, and discards the tab. Throws
   * PrewarmError on timeout or browser failure.
   */
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
      await page.goto(url, {timeout: timeoutMs, waitUntil: 'domcontentloaded'});
      // The UI surfaces "trace loaded" by rendering at least one track. We
      // also accept "loading indicator cleared" as a fallback for UI builds
      // that don't render tracks until the user interacts. Passed as a
      // string so the function body is evaluated in the page context and
      // doesn't drag DOM types into the server's TypeScript config.
      await page.waitForFunction(
        `
          (() => {
            const tracks = document.querySelectorAll(
              'track-panel, .track-shell, .track',
            );
            if (tracks.length > 0) return true;
            const loading = document.querySelector('.pf-ui-main__loading');
            if (loading === null) return false;
            return loading.getAttribute('data-state') === 'none';
          })()
        `,
        undefined,
        {timeout: timeoutMs, polling: 500},
      );
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
