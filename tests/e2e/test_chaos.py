#!/usr/bin/env python3
"""Chaos / monkey e2e for trace-launcher.

Hammers the UI in ways a user could but a deterministic test usually doesn't:
  - rapid, interleaved clicks across many rows in random order
  - back-to-back Start/Stop/Prewarm presses on the same row
  - simulating a kernel-side kill (SIGKILL, the OOM-killer's signal) on a
    running child to confirm the row transitions cleanly to 'killed'
  - exhausting the port pool, then dismissing the inline error chip on
    every row simultaneously
  - running this all under the recorder so a failure leaves a video

The goal is *no stuck states*: after every chaos burst, the UI must agree
with the server's snapshot — every row in a terminal state (idle / live /
crashed) within a bounded recovery window.

Usage:
  /mnt/agent/recordings/app/recorder.py --name "trace-launcher chaos" -- \\
      .venv/bin/python tests/e2e/test_chaos.py
"""

from __future__ import annotations

import json
import os
import random
import signal as _signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright

PROJECT = Path(__file__).resolve().parents[2]
PORT = 9311  # different from the deterministic suite so they don't collide
BASE = f"http://127.0.0.1:{PORT}"
TP_BASE = 19700  # disjoint port range
# Deliberately smaller than len(SAFE_TRACES) so the exhaustion scenario can
# actually exhaust the pool. Override via TL_CHAOS_TP_COUNT for local tuning.
TP_COUNT = int(os.environ.get("TL_CHAOS_TP_COUNT", "2"))
SEED = int(os.environ.get("TL_CHAOS_SEED", "20260515"))
SHOTS = Path(os.environ.get("RECORD_SHOTS_DIR", "/tmp/pf-tl-chaos-shots"))
SHOTS.mkdir(parents=True, exist_ok=True)

RESULTS: list[tuple[str, bool, str]] = []
_shot_n = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    flag = "CHECKPOINT_OK" if ok else "CHECKPOINT_FAIL"
    line = f"{flag}: {name}"
    if detail:
        line += f"  ({detail})"
    print(line, flush=True)
    return ok


def shot(page: Page, label: str) -> None:
    """Best-effort full-page screenshot. Errors are logged, never raised: a
    flaky screenshot must not abort a scenario or mask a real assertion."""
    global _shot_n
    _shot_n += 1
    path = SHOTS / f"{_shot_n:02d}-{label}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        print(f"SHOT: {path}", flush=True)
    except Exception as e:  # noqa: BLE001 — screenshots are diagnostic only
        print(f"SHOT_FAIL: {label}: {e}", flush=True)


def wait_until(
    predicate, timeout: float = 10.0, interval: float = 0.2, label: str = "predicate"
) -> bool:
    """Poll `predicate` until it returns truthy or `timeout` elapses.

    Returns whether the predicate finally held. Strongly preferred over fixed
    `wait_for_timeout` calls because the latter either flakes (too short) or
    wastes wall time (too long). Add new scenarios via this helper.
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            if predicate():
                return True
        except Exception:  # noqa: BLE001 — predicate may transiently fault
            pass
        time.sleep(interval)
    print(f"   wait_until timed out after {timeout:.1f}s waiting for {label}", flush=True)
    return False


def wait_port(port: int, timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


# Traces that *don't* crash on their own — we want to choose what crashes.
SAFE_TRACES = (
    "android-boot.pftrace",
    "chrome-startup.perfetto-trace",
    "scheduler.trace",
)


def trace_row(page: Page, name: str) -> Locator:
    return page.locator(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
    )


def primary_button(page: Page, name: str) -> Locator:
    return trace_row(page, name).locator(".pf-tl-td--actions button").first


def prewarm_button(page: Page, name: str) -> Locator:
    return trace_row(page, name).locator(".pf-tl-td--actions button").nth(1)


TRANSIENT_STATES = ".pf-tl-state--starting, .pf-tl-state--prewarming"
TERMINAL_STATES = (
    ".pf-tl-state--idle, .pf-tl-state--live, "
    ".pf-tl-state--prewarmed, .pf-tl-state--crashed"
)
ACTIVE_STATES = (
    ".pf-tl-state--starting, .pf-tl-state--live, "
    ".pf-tl-state--prewarming, .pf-tl-state--prewarmed"
)


def wait_for_terminal_state(
    page: Page, timeout: float = 15.0, confirm_for: float = 1.2
) -> int:
    """Wait until no row is in a transient state, sustained for `confirm_for`.

    Returns 0 on success, or the latest non-zero transient count on timeout.

    Why the sustain window: the UI polls the server every ~600 ms while
    things are active, so a row's chip can flip back into 'starting' across
    a Mithril redraw between two consecutive `count()` queries. A single
    zero-snapshot is therefore an unreliable terminal signal — we require
    `confirm_for` seconds of continuous zero before declaring success. This
    also separates true settled states from flap states caused by tight
    Start→Stop→Start chaos cycles.
    """
    deadline = time.time() + timeout
    last_seen = -1
    settled_since: float | None = None
    while time.time() < deadline:
        n = page.locator(TRANSIENT_STATES).count()
        last_seen = n
        if n == 0:
            if settled_since is None:
                settled_since = time.time()
            elif time.time() - settled_since >= confirm_for:
                return 0
        else:
            settled_since = None
        time.sleep(0.2)
    return last_seen if last_seen >= 0 else page.locator(TRANSIENT_STATES).count()


SERVER_LOG = Path(os.environ.get("TL_CHAOS_SERVER_LOG", "/tmp/pf-tl-chaos-server.log"))


def start_server() -> subprocess.Popen[bytes]:
    cmd = [
        str(PROJECT / "node_modules" / ".bin" / "tsx"),
        "server/index.ts",
        "--tp-binary", "fixtures/fake-tp",
        "--traces-dir", "fixtures/traces",
        "--recursive-search",
        "--port", str(PORT),
        "--tp-port-base", str(TP_BASE),
        "--tp-port-count", str(TP_COUNT),
    ]
    # CRITICAL: redirect stdout/stderr to a file, NOT to subprocess.PIPE.
    # A PIPE we never read fills the OS pipe buffer (~64 KB) and blocks the
    # server's next write — at which point every API request hangs and the
    # UI's "starting" rows stick forever. The file path is logged so anyone
    # debugging a failure can `tail` it after the run.
    SERVER_LOG.parent.mkdir(parents=True, exist_ok=True)
    log_fh = SERVER_LOG.open("wb")
    print(f"server log: {SERVER_LOG}", flush=True)
    proc = subprocess.Popen(
        cmd, cwd=str(PROJECT), stdout=log_fh, stderr=subprocess.STDOUT
    )
    if not wait_port(PORT):
        print("CHECKPOINT_FAIL: server did not come up", flush=True)
        proc.terminate()
        log_fh.close()
        sys.exit(1)
    print(f"server up on {BASE}", flush=True)
    return proc


def _snapshot() -> list[dict]:
    """Pull the server's current `running` snapshot via the public API.

    This is the same data the UI polls — pid, port, status, prewarm, exit —
    so any chaos assertion that compares to "server reality" can ground
    itself here rather than guessing from /proc.
    """
    body = json.dumps({"dir": "", "query": "", "filters": []}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/state",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=4.0) as resp:
        return json.loads(resp.read())["running"]


def _count_active_children() -> int:
    """Children with status in (starting, live), as the server sees them.

    The server has only three statuses — starting, live, crashed. Prewarming
    and prewarmed are UI-only states layered on top of `live` (they live in
    the `prewarm` field). So `starting + live` server-side == the UI count of
    `starting + live + prewarming + prewarmed`.
    """
    return sum(1 for c in _snapshot() if c.get("status") in ("starting", "live"))


def _stop_all_via_api() -> None:
    """Stop every child via the public API. Returns when the request resolves;
    children may still be in their SIGTERM grace window — pair with a poll."""
    req = urllib.request.Request(
        f"{BASE}/api/stop-all", data=b"", method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=4.0):
            pass
    except urllib.error.HTTPError:
        # The server returns 200 normally; treat any HTTP error as visible
        # to callers via the convergence check that follows.
        pass


def _port_free(port: int, host: str = "127.0.0.1") -> bool:
    """True iff `port` is currently *not* accepting connections. Mirrors the
    server's allocator probe so we can wait for the OS-level port reclaim
    that follows a SIGTERM (the children map clears immediately on stop,
    but the kernel keeps the port bound until the python http.server fully
    exits, up to KILL_GRACE_MS = 5 s later)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.2)
    try:
        s.connect((host, port))
        return False
    except OSError:
        return True
    finally:
        s.close()


def _wait_zero_active(timeout: float = 12.0) -> bool:
    """Block until the server reports zero active children *and* every
    trace_processor port in the configured pool is actually free at the OS
    level. The latter is necessary because stop() empties the children map
    immediately while the OS keeps the port bound until SIGTERM (or the
    KILL_GRACE_MS SIGKILL backstop) completes. Without this, the very next
    Start in a chaos scenario races the previous child's port reclaim and
    fails with OUT_OF_PORTS — and the test sees a row stuck idle."""
    pool_ports = list(range(TP_BASE, TP_BASE + TP_COUNT))

    def _settled() -> bool:
        if _count_active_children() != 0:
            return False
        return all(_port_free(p) for p in pool_ports)

    return wait_until(
        _settled,
        timeout=timeout,
        interval=0.25,
        label="server idle + every pool port reclaimed",
    )


def find_child_pid(name: str) -> int | None:
    """Return the pid the server has recorded for the running child of `name`."""
    for child in _snapshot():
        if child.get("name") == name and child.get("status") in ("starting", "live"):
            return int(child["pid"])
    return None


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def scenario_monkey_clicks(page: Page) -> None:
    """Hammer Start/Stop/Prewarm on many rows in randomised order."""
    rng = random.Random(SEED)
    actions = []
    for name in SAFE_TRACES:
        for kind in ("start", "prewarm", "stop", "start", "stop"):
            actions.append((name, kind))
    rng.shuffle(actions)

    for name, kind in actions:
        try:
            if kind == "start":
                primary_button(page, name).dispatch_event("click")
            elif kind == "stop":
                # The primary button is Stop when the row is live — same target.
                primary_button(page, name).dispatch_event("click")
            elif kind == "prewarm":
                prewarm_button(page, name).dispatch_event("click")
        except Exception as e:
            print(f"   (click {kind} on {name} skipped: {e})", flush=True)
        # Tiny stagger but well under the poll cadence — most actions race
        # poll callbacks. The server must remain consistent regardless.
        page.wait_for_timeout(rng.randint(15, 80))

    # Settling budget covers the worst case the shuffle can produce:
    #   rapid Start -> Stop -> Start on the same row can re-enter `starting`
    #   while the previous fake-tp is still in its KILL_GRACE_MS=5 s SIGTERM
    #   grace, holding a port from the small pool. Each row needs roughly one
    #   grace cycle to fully unwind plus a poll interval to be observed.
    settle_timeout = 60.0
    transient_left = wait_for_terminal_state(page, timeout=settle_timeout)
    check(
        "after random Start/Stop/Prewarm bursts, every row reaches a terminal state",
        transient_left == 0,
        f"{transient_left} row(s) still transient after {settle_timeout:.0f} s",
    )
    shot(page, "after-monkey")

    # Convergence: server-side (starting + live) must equal UI-side
    # (starting + live + prewarming + prewarmed), since prewarm is layered
    # on top of `status=live`. Poll for the full SIGTERM-grace + poll-cadence
    # window before declaring failure.
    diff = ui_active = n_children = 0

    def _converged() -> bool:
        nonlocal diff, ui_active, n_children
        ui_active = page.locator(ACTIVE_STATES).count()
        n_children = _count_active_children()
        diff = abs(n_children - ui_active)
        return diff == 0

    wait_until(_converged, timeout=10.0, interval=0.3, label="ui/server convergence")
    check(
        "ui active count converges with server-side child count",
        diff == 0,
        f"ui active={ui_active} children={n_children}",
    )


def scenario_double_clicks_same_row(page: Page) -> None:
    """Same row, ten clicks in <100ms — must collapse to one child."""
    name = SAFE_TRACES[0]
    # Drive to idle deterministically: use the API rather than guessing button
    # semantics from the current row state.
    _stop_all_via_api()
    _wait_zero_active()
    wait_until(
        lambda: trace_row(page, name).locator(".pf-tl-state--idle").count() == 1,
        timeout=5.0, label=f"{name} idle"
    )

    btn = primary_button(page, name)
    for _ in range(10):
        btn.dispatch_event("click")

    # Wait for the row to leave 'starting' (it must, exactly once). If the
    # collapse logic is broken we'd see N parallel starts saturating the pool.
    wait_until(
        lambda: trace_row(page, name).locator(".pf-tl-state--live").count() == 1,
        timeout=10.0, label=f"{name} reaches live"
    )

    # Server snapshot is the ground truth — count children matching this trace.
    children_for_name = [c for c in _snapshot() if c.get("name") == name]
    active_for_name = [c for c in children_for_name if c.get("status") != "crashed"]
    check(
        "ten rapid Start clicks on the same row spawn exactly one child",
        len(active_for_name) == 1,
        f"server reports {len(active_for_name)} active for {name}",
    )


def _stop_all_and_settle(page: Page) -> None:
    """Drive the catalog to a uniformly-idle state.

    Uses the public API for the stop (deterministic, no Mithril rerender
    races) and then polls both server *and* UI until both report idle. This
    is the only safe precondition for scenarios that assume a clean slate.
    """
    _stop_all_via_api()
    _wait_zero_active()
    wait_until(
        lambda: page.locator(ACTIVE_STATES).count() == 0
        and page.locator(".pf-tl-state--crashed").count() == 0,
        timeout=8.0,
        label="ui has no active or crashed rows",
    )


def _start_and_wait_live(page: Page, name: str) -> None:
    primary_button(page, name).dispatch_event("click")
    page.wait_for_selector(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
        ' .pf-tl-state--live',
        timeout=15_000,
    )


_SAFE_CHILD_COMMS = frozenset({"fake-tp", "python3", "python", "bash"})


def _proc_comm(pid: int) -> str:
    """Read `/proc/<pid>/comm` for a sanity check before signalling. Returns
    an empty string if the pid is unreadable (already gone, EACCES, etc.)."""
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


def _kill_child(name: str, signal: str) -> int | None:
    """Send `signal` to the fake-tp child process backing trace `name`.

    Hardened against the catastrophic "negative pid" footgun: this function
    NEVER invokes `/usr/bin/kill -SIG -<pid>`. Instead it uses `os.kill`
    against the *exact, positive* pid the server reported, after three
    independent safety checks:

      1. pid must be a plausible user-process pid (>= 1000 — far above the
         pgid of init, kthreadd, systemd, sshd, etc.).
      2. pid must not be the test runner itself or any of its ancestors.
      3. `/proc/<pid>/comm` must match a known fake-tp impostor — bash (the
         shim before exec) or python3 (after exec'ing into `-m http.server`).
         A mismatch means the pid was reused by something we didn't spawn;
         refuse to signal.

    Returns the pid that was signalled, or None if no live child existed or
    the safety checks refused. Never returns a value without having performed
    a single, narrowly-targeted os.kill().
    """
    pid = find_child_pid(name)
    if pid is None:
        return None
    if not isinstance(pid, int) or pid < 1000:
        print(
            f"   SAFETY: refusing to signal pid={pid!r} for {name} "
            f"(implausibly low — would be unsafe)",
            flush=True,
        )
        return None
    own = os.getpid()
    forbidden_ancestors = _ancestor_pids(own)
    if pid == own or pid in forbidden_ancestors:
        print(
            f"   SAFETY: refusing to signal pid={pid} for {name} "
            f"(self or ancestor of test runner: {forbidden_ancestors})",
            flush=True,
        )
        return None
    comm = _proc_comm(pid)
    if comm not in _SAFE_CHILD_COMMS:
        print(
            f"   SAFETY: refusing to signal pid={pid} for {name} "
            f"(/proc/{pid}/comm={comm!r}, not in {sorted(_SAFE_CHILD_COMMS)})",
            flush=True,
        )
        return None
    sig = getattr(_signal, f"SIG{signal}", None)
    if sig is None:
        print(f"   SAFETY: unknown signal name {signal!r}", flush=True)
        return None
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        # Already gone in the racewindow between snapshot and kill. Benign.
        return pid
    return pid


def _ancestor_pids(start: int) -> set[int]:
    """Walk /proc/<pid>/status PPid chain and return every ancestor pid plus
    a sentinel for the system-critical pids we must never signal (1, 0)."""
    ancestors: set[int] = {0, 1}
    cur = start
    for _ in range(64):  # depth-bounded, defensive
        try:
            data = Path(f"/proc/{cur}/status").read_text()
        except OSError:
            break
        ancestors.add(cur)
        ppid = 0
        for line in data.splitlines():
            if line.startswith("PPid:"):
                try:
                    ppid = int(line.split()[1])
                except (IndexError, ValueError):
                    ppid = 0
                break
        if ppid <= 1:
            break
        cur = ppid
    return ancestors


def scenario_kill_signals(page: Page) -> None:
    """SIGKILL, SIGSEGV, SIGTERM (without our stop) — every signal must surface."""
    cases = [
        # (signal, expected chip label, scenario label)
        ("KILL", "killed", "kill-sigkill"),
        ("SEGV", "crashed (SIGSEGV)", "kill-sigsegv"),
        ("TERM", "crashed (SIGTERM)", "kill-sigterm-out-of-band"),
    ]
    for signal, expected, label in cases:
        _stop_all_and_settle(page)
        name = SAFE_TRACES[0]
        _start_and_wait_live(page, name)

        pid = _kill_child(name, signal)
        check(
            f"[{label}] found server-side pid for {name}",
            pid is not None,
            f"pid={pid}",
        )
        if pid is None:
            continue

        page.wait_for_selector(
            f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
            ' .pf-tl-state--crashed',
            timeout=10_000,
        )
        chip_text = trace_row(page, name).locator(
            ".pf-tl-state--crashed"
        ).inner_text().strip()
        check(
            f"[{label}] chip shows '{expected}'",
            chip_text == expected,
            f"got {chip_text!r}",
        )
        shot(page, label)

        # Recovery: clicking Retry must spawn a fresh child for every flavour.
        primary_button(page, name).dispatch_event("click")
        page.wait_for_selector(
            f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
            ' .pf-tl-state--live',
            timeout=15_000,
        )
        check(f"[{label}] retry after the signal brings the row back to live", True)


def scenario_kill_during_prewarm(page: Page) -> None:
    """Killing the child while a prewarm is in flight must not leak state."""
    _stop_all_and_settle(page)
    name = SAFE_TRACES[2]
    _start_and_wait_live(page, name)
    prewarm_button(page, name).dispatch_event("click")
    page.wait_for_selector(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
        ' .pf-tl-state--prewarming',
        timeout=10_000,
    )
    pid = _kill_child(name, "KILL")
    if pid is None:
        check("kill-during-prewarm: child pid available", False)
        return

    # The chip must end up crashed; the prewarm task quietly bails.
    page.wait_for_selector(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
        ' .pf-tl-state--crashed',
        timeout=10_000,
    )
    label = trace_row(page, name).locator(".pf-tl-state--crashed").inner_text().strip()
    check(
        "killing a child mid-prewarm surfaces as 'killed' (prewarm task aborts cleanly)",
        label == "killed",
        f"chip text: {label!r}",
    )


def scenario_browser_reload_mid_action(page: Page) -> None:
    """Reload the page while traces are running — UI must re-show them."""
    _stop_all_and_settle(page)
    names = SAFE_TRACES[:2]
    for name in names:
        primary_button(page, name).dispatch_event("click")
    for name in names:
        page.wait_for_selector(
            f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
            ' .pf-tl-state--live',
            timeout=15_000,
        )

    # Hard reload mid-life — simulates the user F5'ing while traces are open.
    page.reload()
    page.wait_for_selector("table.pf-tl-table")
    # Both rows must re-appear as live within a poll cycle or two.
    for name in names:
        page.wait_for_selector(
            f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
            ' .pf-tl-state--live',
            timeout=10_000,
        )
    live_after = page.locator(".pf-tl-state--live").count()
    check(
        "after a hard reload, live traces remain visible and accurate",
        live_after == len(names),
        f"{live_after}/{len(names)} live after reload",
    )


def scenario_port_exhaustion_churn(page: Page) -> None:
    """Fill the pool, overflow it, dismiss errors, then verify recovery.

    The pool size (`TP_COUNT`) is deliberately smaller than `len(SAFE_TRACES)`
    so that the last starts are guaranteed to fail with OUT_OF_PORTS. The
    server surfaces this as a typed error code; the UI renders an inline
    `.pf-tl-row-error` chip on the offending row.
    """
    assert TP_COUNT < len(SAFE_TRACES), (
        f"chaos test misconfigured: pool ({TP_COUNT}) must be smaller than "
        f"the safe trace set ({len(SAFE_TRACES)}) to exhaust deterministically"
    )

    _stop_all_and_settle(page)

    fillers = list(SAFE_TRACES[:TP_COUNT])      # exactly fills the pool
    overflow = list(SAFE_TRACES[TP_COUNT:])     # at least one
    check(
        "exhaustion scenario starts from idle",
        page.locator(ACTIVE_STATES).count() == 0,
        f"{page.locator(ACTIVE_STATES).count()} active row(s)",
    )

    # Step 1 — fill the pool exactly. Wait for each to be live so we know the
    # port is committed before the next click.
    for name in fillers:
        primary_button(page, name).dispatch_event("click")
    for name in fillers:
        page.wait_for_selector(
            f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
            ' .pf-tl-state--live',
            timeout=15_000,
        )
    check(
        "pool fills exactly to TP_COUNT live children",
        _count_active_children() == TP_COUNT,
        f"server reports {_count_active_children()} active",
    )
    shot(page, "pool-full")

    # Step 2 — every overflow click must surface an OUT_OF_PORTS chip on its
    # own row. Use the API surface for the *test's* expectation, not just the
    # UI — that way a typo in the CSS class name fails loudly.
    overflow_target = overflow[0]
    primary_button(page, overflow_target).dispatch_event("click")
    appeared = wait_until(
        lambda: trace_row(page, overflow_target)
        .locator(".pf-tl-row-error")
        .count() == 1,
        timeout=6.0,
        label=f"row error appears on {overflow_target}",
    )
    error_text = ""
    if appeared:
        # Message is on the host element's `title` (tooltip) since the
        # chip is now icon + dismiss only.
        error_text = (
            trace_row(page, overflow_target)
            .locator(".pf-tl-row-error")
            .get_attribute("title")
            or ""
        ).strip()
    check(
        "overflow Start surfaces OUT_OF_PORTS as an inline row error",
        appeared and "port" in error_text.lower(),
        f"error tooltip: {error_text!r}",
    )
    shot(page, "out-of-ports")

    # Step 3 — the close button on the error chip must dismiss it cleanly.
    trace_row(page, overflow_target).locator(
        ".pf-tl-row-error__close"
    ).first.dispatch_event("click")
    dismissed = wait_until(
        lambda: trace_row(page, overflow_target)
        .locator(".pf-tl-row-error")
        .count() == 0,
        timeout=3.0,
        label="row error dismissed",
    )
    check("inline row error can be dismissed", dismissed)

    # Step 4 — stop one filler, then retry the previously-failed start.
    # The pool must recover: the same overflow trace now starts cleanly.
    freed = fillers[0]
    trace_row(page, freed).locator(".pf-tl-td--actions button").first.dispatch_event(
        "click"
    )  # Stop on the live row
    wait_until(
        lambda: trace_row(page, freed).locator(".pf-tl-state--idle").count() == 1,
        timeout=10.0,
        label=f"{freed} returns to idle",
    )
    primary_button(page, overflow_target).dispatch_event("click")
    recovered = wait_until(
        lambda: trace_row(page, overflow_target)
        .locator(".pf-tl-state--live")
        .count() == 1,
        timeout=15.0,
        label=f"{overflow_target} starts after pool recovery",
    )
    check(
        "port pool recovers and the previously-failed start succeeds",
        recovered,
        f"server now reports {_count_active_children()} active",
    )
    shot(page, "pool-recovered")

    # Step 5 — final consistency: pool size never exceeded.
    check(
        "server never reports more children than the pool allows",
        _count_active_children() <= TP_COUNT,
        f"server: {_count_active_children()}, pool: {TP_COUNT}",
    )


def run_scenarios(page: Page) -> None:
    page.set_default_timeout(12_000)
    page.goto(BASE)
    page.wait_for_selector("table.pf-tl-table")
    page.wait_for_selector("tr.pf-tl-tr--trace")
    shot(page, "loaded")

    scenario_monkey_clicks(page)
    scenario_double_clicks_same_row(page)
    scenario_kill_signals(page)
    scenario_kill_during_prewarm(page)
    scenario_browser_reload_mid_action(page)
    scenario_port_exhaustion_churn(page)

    # Final consistency check: stopping all (via the public API, the same
    # contract a script user would hit) leaves zero active rows. We poll the
    # *UI* directly — if the server stops but the UI never reflects it, that
    # is itself a regression we want to surface here.
    _stop_all_via_api()
    _wait_zero_active()
    settled = wait_until(
        lambda: page.locator(
            ".pf-tl-state--live, .pf-tl-state--starting, "
            ".pf-tl-state--prewarming, .pf-tl-state--prewarmed, "
            ".pf-tl-state--crashed"
        ).count() == 0,
        timeout=10.0,
        label="ui returns to fully idle after stop-all",
    )
    remaining = page.locator(
        ".pf-tl-state--live, .pf-tl-state--starting, "
        ".pf-tl-state--prewarming, .pf-tl-state--prewarmed, "
        ".pf-tl-state--crashed"
    ).count()
    check(
        "after the storm, stop-all returns the catalog to idle",
        settled and remaining == 0,
        f"{remaining} non-idle row(s) left",
    )
    shot(page, "final")


def main() -> int:
    server = start_server()
    headless = os.environ.get("TL_E2E_HEADLESS") == "1"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1366, "height": 900})
            try:
                run_scenarios(page)
            finally:
                page.wait_for_timeout(600)
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n=== {passed}/{len(RESULTS)} checkpoints passed ===", flush=True)
    if failed:
        print("FAILED: " + ", ".join(failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
