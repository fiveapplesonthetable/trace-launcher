#!/usr/bin/env python3
"""Benchmarks + verifies the prewarm flow against a real trace_processor_shell.

The chaos and UI suites use `fake-tp` (which only binds a port via
`python -m http.server`), so they cannot exercise:

  - the "Use trace processor native acceleration?" dialog Perfetto UI
    shows when trace_processor reports a preloaded trace, and which the
    prewarmer's init script must auto-click for the prewarm to ever complete
  - whether the prewarmer actually waits for the UI to reach quiescence
    (every plugin run, every initial query returned) before closing the tab
  - the actual end-to-end time savings of prewarming on a real engine

This script does. It needs:

  TL_BENCH_TP_BINARY    path to real trace_processor_shell
  TL_BENCH_TRACE        path to a real .pftrace / .perfetto-trace

(Defaults are baked in but you should set these explicitly when running.)

Optional:

  TL_BENCH_HEADLESS=0   run the user-load Playwright tab headed (default
                        when run under the recorder so the video shows
                        the dialog click)

For each of (no-prewarm, normal-prewarm, prewarm-sql) it measures:

  - prewarm-finish: server-side, /api/prewarm + poll until prewarmed.
  - user-load:      a Playwright tab navigates to ui.perfetto.dev's deep
                    link, auto-accepts the preloaded-trace dialog if it
                    shows, and waits for `window.waitForPerfettoIdle()` to
                    resolve (the predicate Perfetto's own tests use). The
                    reported time is "from page.goto to fully idle".

And captures screenshots at three checkpoints per scenario:

  01-<scenario>-page-loaded.png      right after `load` event
  02-<scenario>-dialog-clicked.png   immediately after auto-accept fires
  03-<scenario>-fully-idle.png       once waitForPerfettoIdle resolves

The screenshots land in $RECORD_SHOTS_DIR when running under the recorder,
or /tmp/pf-tl-prewarm-bench-shots otherwise.

PASS criteria (the part that must hold, not just be measured):

  - Every scenario completes with a "loaded" outcome.
  - Every scenario except no-prewarm reaches `prewarm=prewarmed`.
  - Every scenario logs a non-null `window.__autoAcceptFiredAt`, proving
    the dialog appeared and the auto-accept clicked it (anything else
    would mean we measured a code path the user doesn't actually take).

Run:
  python3 -m venv .e2e-venv && .e2e-venv/bin/pip install playwright \
    && .e2e-venv/bin/playwright install chromium
  npm run build
  /mnt/agent/recordings/app/recorder.py --name "tl-prewarm-bench" -- \
    .e2e-venv/bin/python tests/e2e/test_prewarm_bench.py
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from playwright.sync_api import Page, sync_playwright

PROJECT = Path(__file__).resolve().parents[2]
DEFAULT_TP = "/home/zim/.local/share/perfetto/prebuilts/trace_processor_shell"
DEFAULT_TRACE = PROJECT / "fixtures" / "traces" / "android-boot.pftrace"

# Example "user SQL" for the third scenario. Picks a curated handful of stdlib
# modules + a probe query so the prewarm-sql case is meaningfully different
# from the no-sql normal-prewarm case but does not take a minute the way a
# blind-include-all sweep does.
DEFAULT_PREWARM_SQL = """
INCLUDE PERFETTO MODULE slices.with_context;
INCLUDE PERFETTO MODULE android.startup.startups;
INCLUDE PERFETTO MODULE cpu.frequency;
SELECT 1 FROM thread LIMIT 1;
SELECT COUNT(*) FROM thread_slice;
"""

LAUNCHER_PORT = 9420
TP_PORT_BASE = 19900
TP_PORT_COUNT = 4
USER_LOAD_TIMEOUT_MS = 120_000
# Generous to absorb prewarm + post-SQL idle (each gated by Perfetto's
# 60 s internal deadline + the networkidle fallback). Five minutes is
# comfortable headroom on the largest test traces without masking a
# genuine hang.
PREWARM_TIMEOUT_S = 300.0
# The engine-side probe SQL. This is the most sensitive prewarm-benefit
# signal we have: with --prewarm-sql, trace_processor has already
# compiled the `android.startup.startups` module and the query is a
# straight table read; without it, trace_processor has to parse and
# compile the module on first reference (often several seconds).
ENGINE_PROBE_SQL = (
    "INCLUDE PERFETTO MODULE android.startup.startups;\n"
    "SELECT COUNT(*) FROM android_startups;"
)

SHOTS_DIR = Path(
    os.environ.get("RECORD_SHOTS_DIR", "/tmp/pf-tl-prewarm-bench-shots")
)
SHOTS_DIR.mkdir(parents=True, exist_ok=True)

# Init script for the user-facing tab. Mirror of the server-side one in
# server/prewarmer.ts — kept duplicated on purpose so the bench has no
# source-tree dependency on TS. Updates here should track the server.
USER_INIT_SCRIPT = r"""
  try {
    window.localStorage.setItem(
      'perfettoFeatureFlags',
      JSON.stringify({cspAllowAnyWebsocketPort: 'OVERRIDE_TRUE'}),
    );
  } catch (e) { /* fine */ }
  (function () {
    if (!window.__autoAcceptFiredAt) window.__autoAcceptFiredAt = {};
    var rules = [
      {key: 'versionMismatch', title: /version mismatch/i,
       button: /mismatched version regardless/i},
      {key: 'preloadedTrace',  title: /native acceleration/i,
       button: /use loaded trace/i},
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
        document.body, {childList: true, subtree: true}
      );
      tryClick();
    };
    start();
  })();
"""


@dataclass
class ScenarioResult:
    name: str
    prewarm_s: float | None
    prewarm_state: str
    # Time from `goto` to Perfetto's full quiescence signal. In headless
    # this is floor-bound by Perfetto's hardcoded 60 s idle deadline +
    # a stuck omnibox-message indicator that can only clear via user
    # interaction, so the prewarm benefit doesn't show up here. Kept
    # for completeness; for the real prewarm benefit see `first_track_s`
    # and `engine_probe_s`.
    load_s: float | None
    # Time from `goto` to first `.pf-track` element rendered. This is
    # the perceptually meaningful "I can see something" moment and is
    # not capped by Perfetto's headless-only idle deadline — the
    # signal a real user gets in a real browser.
    first_track_s: float | None
    # Latency of a known module-include + count query against
    # trace_processor's HTTP RPC. The most sensitive prewarm-benefit
    # signal: with --prewarm-sql, the module is already compiled and
    # the query is a table read; without it, trace_processor compiles
    # the module on first reference.
    engine_probe_s: float | None
    outcome: str
    # Map of rule-key → ms-at-click (or empty if nothing fired). Mirrors
    # window.__autoAcceptFiredAt from the init script; we keep the raw dict
    # so the summary can show *which* dialogs auto-accept caught.
    auto_accept_fired: dict[str, float] = field(default_factory=dict)
    screenshots: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Launcher lifecycle
# ---------------------------------------------------------------------------


def start_launcher(
    tp_binary: str, traces_dir: str, prewarm_sql: str | None, scenario: str
) -> tuple[subprocess.Popen[bytes], Path]:
    cmd = [
        str(PROJECT / "node_modules" / ".bin" / "tsx"),
        "server/index.ts",
        "--tp-binary", tp_binary,
        "--traces-dir", traces_dir,
        "--port", str(LAUNCHER_PORT),
        "--tp-port-base", str(TP_PORT_BASE),
        "--tp-port-count", str(TP_PORT_COUNT),
    ]
    if prewarm_sql is not None:
        cmd += ["--prewarm-sql", prewarm_sql]
    # One log per scenario so the post-mortem keeps prewarm stage
    # timestamps from previous runs — earlier versions truncated and
    # ate the very output that explained suspicious results.
    log_path = Path(f"/tmp/pf-tl-bench-launcher-{scenario}.log")
    log_fh = log_path.open("wb")
    proc = subprocess.Popen(
        cmd, cwd=str(PROJECT), stdout=log_fh, stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", LAUNCHER_PORT), timeout=0.4):
                return proc, log_path
        except OSError:
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError(f"launcher did not come up. see {log_path}")


def stop_launcher(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)


# ---------------------------------------------------------------------------
# Launcher API helpers
# ---------------------------------------------------------------------------


def _post_json(path: str, body: dict, timeout: float = 5.0) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{LAUNCHER_PORT}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _snapshot():
    return _post_json("/api/state", {"dir": "", "query": "", "filters": []})


def _state_for(trace_key: str):
    for child in _snapshot().get("running", []):
        if child.get("key") == trace_key:
            return child
    return None


def trigger_start(trace_key: str) -> None:
    _post_json("/api/open", {"trace": trace_key})
    # trace_processor parses the trace at startup before binding the HTTP
    # port, so for big traces this can take minutes. Headroom up to the
    # 5-minute prewarm budget keeps the bench usable on real workloads.
    deadline = time.time() + PREWARM_TIMEOUT_S
    while time.time() < deadline:
        c = _state_for(trace_key)
        if c is not None and c.get("status") == "live":
            return
        time.sleep(0.5)
    raise RuntimeError(f"start of {trace_key!r} did not reach 'live'")


def trigger_prewarm_and_wait(trace_key: str) -> tuple[float, str]:
    """Returns (elapsed_seconds, final_prewarm_state). A hang here is the
    canary: a broken auto-accept leaves the headless prewarmer's tab stuck
    on the dialog and we observe a timeout, not `prewarmed`."""
    t0 = time.monotonic()
    _post_json("/api/prewarm", {"trace": trace_key})
    deadline = t0 + PREWARM_TIMEOUT_S
    while time.monotonic() < deadline:
        c = _state_for(trace_key) or {}
        if c.get("prewarm") in ("prewarmed", "prewarm-failed"):
            return time.monotonic() - t0, c["prewarm"]
        time.sleep(0.25)
    return PREWARM_TIMEOUT_S, "timeout"


def child_port(trace_key: str) -> int:
    c = _state_for(trace_key)
    if c is None:
        raise RuntimeError(f"no running child for {trace_key!r}")
    return int(c["port"])


def probe_engine_query_latency(rpc_port: int) -> float:
    """Times one round-trip of ENGINE_PROBE_SQL against trace_processor's
    HTTP RPC `/query` endpoint. Bypasses the UI entirely so the number
    reflects only engine state — the cleanest signal we have for whether
    `--prewarm-sql` actually warmed the included module.

    The wire format is a `QueryArgs` proto with one optional string at
    field 1. We hand-encode the single length-delimited field rather
    than pulling in `protobufjs` for a one-line message."""
    sql_bytes = ENGINE_PROBE_SQL.encode("utf-8")
    # protobuf varint of the byte length
    length = len(sql_bytes)
    varint = bytearray()
    while length > 0x7F:
        varint.append((length & 0x7F) | 0x80)
        length >>= 7
    varint.append(length & 0x7F)
    body = bytes([0x0A]) + bytes(varint) + sql_bytes
    req = urllib.request.Request(
        f"http://127.0.0.1:{rpc_port}/query",
        data=body,
        headers={"Content-Type": "application/x-protobuf"},
        method="POST",
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=120.0) as resp:
        resp.read()  # drain
    return time.monotonic() - t0


# ---------------------------------------------------------------------------
# User-side load measurement (with screenshot capture)
# ---------------------------------------------------------------------------


def _shot(page: Page, name: str, scenario: str, idx: int) -> str:
    fname = f"{idx:02d}-{scenario}-{name}.png"
    path = SHOTS_DIR / fname
    try:
        page.screenshot(path=str(path), full_page=False)
        print(f"SHOT: {path}", flush=True)
        return str(path)
    except Exception as e:  # noqa: BLE001 — diagnostic only
        print(f"SHOT_FAIL: {fname}: {e}", flush=True)
        return ""


def _wait_for_perfetto_idle(page: Page, timeout_ms: int) -> bool:
    """Returns True if the page exposed `waitForPerfettoIdle()` and it
    resolved within the timeout. False on a missing symbol or rejection.

    First waits for the symbol to actually be installed on `window` —
    Perfetto assigns it during async init of its main bundle, which
    finishes after Playwright's `load` event. Calling `evaluate` too
    early would get a "doesn't exist" answer and skip the real wait,
    making the timings meaningless. The wait is bounded so an older
    Perfetto build without the utility falls through to the caller's
    networkidle fallback in finite time.

    Lifted from server/prewarmer.ts so the user-side measurement uses
    the same quiescence signal as the prewarmer itself."""
    try:
        page.wait_for_function(
            "typeof window.waitForPerfettoIdle === 'function'",
            timeout=30_000,
        )
    except Exception:  # noqa: BLE001 — older Perfetto build
        return False
    return page.evaluate(
        """async (timeoutMs) => {
          try {
            await Promise.race([
              window.waitForPerfettoIdle(250),
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error('idle wait timed out')), timeoutMs)),
            ]);
            return true;
          } catch (_e) { return false; }
        }""",
        timeout_ms,
    )


def measure_user_load(rpc_port: int, scenario: str) -> ScenarioResult:
    """Opens ui.perfetto.dev?rpc_port=N, auto-accepts the preloaded-trace
    dialog, waits for `waitForPerfettoIdle()`, and reports timings +
    screenshots. The returned ScenarioResult.load_s is "from page.goto to
    fully idle".

    Uses the exact same browser setup as the prewarmer (persistent context
    + --disable-web-security + bypass_csp). A real user with a normal Chrome
    sees the same prewarm benefit; the bypass here exists because headless
    Chrome's Local Network Access policy refuses the ui.perfetto.dev →
    127.0.0.1 fetch and there is no in-page prompt we can click. Measuring
    a code path the real engine never reaches would make the numbers
    meaningless."""
    # Default to headed when running under the recorder so the captured
    # video shows the actual click + load. Set TL_BENCH_HEADLESS=1 to force.
    headless_env = os.environ.get("TL_BENCH_HEADLESS")
    headless = (
        headless_env == "1"
        if headless_env is not None
        else os.environ.get("RECORD_DISPLAY") is None
    )
    # Same form Perfetto documents in ui/src/frontend/index.ts:112 —
    # rpc_port lives in the hash route's query, not in location.search.
    url = f"https://ui.perfetto.dev/#!/?rpc_port={rpc_port}"
    shots: list[str] = []
    outcome = "loaded"
    elapsed: float | None = None
    user_data_dir = Path("/tmp") / f"pf-tl-bench-userdata-{os.getpid()}-{rpc_port}"
    user_data_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(user_data_dir),
            headless=headless,
            bypass_csp=True,
            args=["--no-sandbox", "--disable-web-security"],
        )
        context.add_init_script(USER_INIT_SCRIPT)
        page = context.new_page()
        t0 = time.monotonic()
        first_track_s: float | None = None
        try:
            page.goto(
                url, wait_until="domcontentloaded", timeout=USER_LOAD_TIMEOUT_MS
            )
            page.wait_for_load_state("load", timeout=USER_LOAD_TIMEOUT_MS)
            shots.append(_shot(page, "page-loaded", scenario, 1))
            # Brief wait so the auto-accept observer fires and the dialog
            # is replaced by the post-click DOM.
            page.wait_for_timeout(800)
            shots.append(_shot(page, "dialog-clicked", scenario, 2))
            # The perceptually meaningful "ready" signal: first track
            # rendered. Perfetto's track-shell widget uses the BEM class
            # `pf-track` (see ui/src/widgets/track_shell.ts:200) and the
            # selector is the one Perfetto's own playwright tests rely on,
            # so it tracks Perfetto's UI refactors.
            try:
                page.wait_for_selector(".pf-track", timeout=USER_LOAD_TIMEOUT_MS)
                first_track_s = time.monotonic() - t0
            except Exception:  # noqa: BLE001 — fall through to idle wait
                pass
            idle_ok = _wait_for_perfetto_idle(page, USER_LOAD_TIMEOUT_MS)
            if not idle_ok:
                # Fallback to networkidle so the bench still produces a
                # number on an old Perfetto build without the test util.
                page.wait_for_load_state("networkidle", timeout=USER_LOAD_TIMEOUT_MS)
            shots.append(_shot(page, "fully-idle", scenario, 3))
        except Exception as e:  # noqa: BLE001 — benchmark, not a unit test
            outcome = f"timeout/error: {e}"
        elapsed = time.monotonic() - t0
        fired: dict[str, float] = {}
        try:
            raw = page.evaluate(
                "() => (window.__autoAcceptFiredAt "
                "        && typeof window.__autoAcceptFiredAt === 'object') "
                "        ? window.__autoAcceptFiredAt : {}"
            )
            if isinstance(raw, dict):
                fired = {str(k): float(v) for k, v in raw.items()}
        except Exception:  # noqa: BLE001 — page may have died
            fired = {}
        # Visual sanity: the dialog must not be left up.
        try:
            if page.locator(
                ".pf-modal-dialog h1:has-text('native acceleration')"
            ).count() > 0:
                outcome = f"DIALOG-STUCK ({outcome})"
        except Exception:  # noqa: BLE001
            pass
        context.close()
    # Persistent context leaves the profile on disk; we don't reuse it.
    shutil.rmtree(user_data_dir, ignore_errors=True)
    return ScenarioResult(
        name=scenario,
        prewarm_s=None,
        prewarm_state="n/a",
        load_s=elapsed,
        first_track_s=first_track_s,
        engine_probe_s=None,
        outcome=outcome,
        auto_accept_fired=fired,
        screenshots=shots,
    )


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


def run_scenario(
    name: str,
    tp_binary: str,
    traces_dir: str,
    trace_path: str,
    *,
    prewarm: bool,
    prewarm_sql: str | None,
) -> ScenarioResult:
    print(f"\n=== scenario: {name} ===", flush=True)
    proc, log_path = start_launcher(tp_binary, traces_dir, prewarm_sql, name)
    print(f"launcher log: {log_path}", flush=True)
    try:
        trigger_start(trace_path)
        prewarm_t: float | None = None
        prewarm_s = "n/a"
        if prewarm:
            prewarm_t, prewarm_s = trigger_prewarm_and_wait(trace_path)
            print(f"prewarm finish: {prewarm_t:.2f}s · {prewarm_s}", flush=True)
        port = child_port(trace_path)
        # Engine probe runs BEFORE user-load. Putting it after would
        # contaminate the no-prewarm baseline because the UI's own
        # queries warm the engine mid-measurement.
        try:
            probe_s = probe_engine_query_latency(port)
            print(f"engine probe: {probe_s:.2f}s", flush=True)
        except Exception as e:  # noqa: BLE001 — diagnostic
            probe_s = None
            print(f"engine probe FAILED: {e}", flush=True)
        r = measure_user_load(port, name)
        r.prewarm_s = prewarm_t
        r.prewarm_state = prewarm_s
        r.engine_probe_s = probe_s
        auto = (
            "auto-accept: "
            + ", ".join(
                f"{k}@{v / 1000:.2f}s" for k, v in r.auto_accept_fired.items()
            )
            if r.auto_accept_fired
            else "AUTO-ACCEPT DID NOT FIRE"
        )
        load_disp = f"{r.load_s:.2f}s" if r.load_s is not None else "—"
        track_disp = (
            f"{r.first_track_s:.2f}s" if r.first_track_s is not None else "—"
        )
        print(
            f"user load: first-track {track_disp} · idle {load_disp} · "
            f"{r.outcome} · {auto}",
            flush=True,
        )
        return r
    finally:
        stop_launcher(proc)


def main() -> int:
    tp_binary = os.environ.get("TL_BENCH_TP_BINARY", DEFAULT_TP)
    trace = os.environ.get("TL_BENCH_TRACE", str(DEFAULT_TRACE))
    sql = os.environ.get("TL_BENCH_PREWARM_SQL", DEFAULT_PREWARM_SQL).strip()
    if not os.path.isfile(tp_binary) or not os.access(tp_binary, os.X_OK):
        print(f"FATAL: tp_binary not executable: {tp_binary}", flush=True)
        return 2
    if not os.path.isfile(trace):
        print(f"FATAL: trace not found: {trace}", flush=True)
        return 2
    trace_real = os.path.realpath(trace)
    traces_dir = os.path.dirname(trace_real)
    print(f"bench: tp_binary = {tp_binary}", flush=True)
    print(f"bench: trace     = {trace_real}", flush=True)
    print(f"bench: shots dir = {SHOTS_DIR}", flush=True)

    results: list[ScenarioResult] = []
    results.append(
        run_scenario(
            "no-prewarm",
            tp_binary, traces_dir, trace_real,
            prewarm=False, prewarm_sql=None,
        )
    )
    results.append(
        run_scenario(
            "normal-prewarm",
            tp_binary, traces_dir, trace_real,
            prewarm=True, prewarm_sql=None,
        )
    )
    results.append(
        run_scenario(
            "prewarm-sql",
            tp_binary, traces_dir, trace_real,
            prewarm=True, prewarm_sql=sql,
        )
    )

    print("\n=== summary ===", flush=True)
    header = (
        f"{'scenario':<22} {'prewarm':>10} {'state':>16} "
        f"{'eng probe':>10} {'first-track':>12} {'fully-idle':>11} outcome"
    )
    print(header, flush=True)
    for r in results:
        pre_s = f"{r.prewarm_s:.2f}s" if r.prewarm_s is not None else "—"
        load_s = f"{r.load_s:.2f}s" if r.load_s is not None else "—"
        track_s = (
            f"{r.first_track_s:.2f}s" if r.first_track_s is not None else "—"
        )
        probe_s = (
            f"{r.engine_probe_s:.2f}s" if r.engine_probe_s is not None else "—"
        )
        print(
            f"{r.name:<22} {pre_s:>10} {r.prewarm_state:>16} "
            f"{probe_s:>10} {track_s:>12} {load_s:>11} {r.outcome}",
            flush=True,
        )

    failures: list[str] = []
    for r in results:
        if r.name != "no-prewarm" and r.prewarm_state != "prewarmed":
            failures.append(
                f"{r.name}: expected prewarm=prewarmed, got {r.prewarm_state!r}"
            )
        if not r.outcome.startswith("loaded"):
            failures.append(
                f"{r.name}: user load did not complete cleanly ({r.outcome})"
            )
        if "DIALOG-STUCK" in r.outcome:
            failures.append(
                f"{r.name}: 'use trace processor' dialog was left visible"
            )
        if not r.auto_accept_fired:
            failures.append(
                f"{r.name}: auto-accept never fired — the timing reflects a "
                "code path the user does not take"
            )

    if failures:
        print("\nFAIL", flush=True)
        for f in failures:
            print(f"  - {f}", flush=True)
        return 1
    print("\nPASS — auto-accept verified, every scenario loads cleanly.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
