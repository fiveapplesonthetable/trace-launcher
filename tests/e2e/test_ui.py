#!/usr/bin/env python3
"""End-to-end UI test for trace-launcher.

Boots the real server against the bundled fixtures, drives a headed Chrome
through every important flow, and asserts against the DOM. Designed to run
under the sandbox recorder so the run is reviewable as video + screenshots.

Scenarios covered:
  - catalog renders; search (in-directory) filters the list
  - recursive search finds a trace in a sub-directory
  - starting a trace -> "live"; it appears in the Running panel
  - a crashing trace_processor -> "crashed" card with retry/dismiss
  - a hanging trace_processor -> stays "starting" (never falsely "live")
  - double-clicking Start spawns only one child (idempotent)
  - the Columns menu toggles a metadata column into the table
  - the Filters editor adds a metadata SQL filter; a chip appears
  - directory navigation via the folder rows + breadcrumb
  - the theme toggle switches dark <-> light
  - "Stop all" reaps every running child

Usage (under the recorder):
  recorder.py --name "trace-launcher e2e" -- \
      /path/to/venv/bin/python tests/e2e/test_ui.py
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright

PROJECT = Path(__file__).resolve().parents[2]
PORT = 9211
BASE = f"http://127.0.0.1:{PORT}"
# Second server used for the max-ports test: a tiny port pool we can exhaust.
SMALL_PORT = 9212
SMALL_BASE = f"http://127.0.0.1:{SMALL_PORT}"
SMALL_TP_PORTS = 2  # only 2 trace_processor ports — a 3rd start must fail.
SHOTS = Path(os.environ.get("RECORD_SHOTS_DIR", "/tmp/pf-tl-e2e-shots"))
SHOTS.mkdir(parents=True, exist_ok=True)

# Collected (name, ok, detail) tuples; the process exits non-zero if any failed.
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
    global _shot_n
    _shot_n += 1
    path = SHOTS / f"{_shot_n:02d}-{label}.png"
    page.screenshot(path=str(path))
    print(f"SHOT: {path}", flush=True)


def wait_port(port: int, timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def trace_row(page: Page, name: str) -> Locator:
    """The catalog table row for a trace, located by its full-name title."""
    return page.locator(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"])'
    )


def start_server(
    http_port: int = PORT,
    tp_port_base: int = 19000,
    tp_port_count: int = 4096,
) -> subprocess.Popen[bytes]:
    cmd = [
        str(PROJECT / "node_modules" / ".bin" / "tsx"),
        "server/index.ts",
        "--tp-binary", "fixtures/fake-tp",
        "--traces-dir", "fixtures/traces",
        "--recursive-search",
        "--metadata-db", "fixtures/metadata.db",
        "--metadata-table", "traces",
        "--port", str(http_port),
        "--tp-port-base", str(tp_port_base),
        "--tp-port-count", str(tp_port_count),
    ]
    proc = subprocess.Popen(
        cmd, cwd=str(PROJECT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    if not wait_port(http_port):
        print("CHECKPOINT_FAIL: server did not come up", flush=True)
        proc.terminate()
        sys.exit(1)
    print(f"server up on http://127.0.0.1:{http_port}", flush=True)
    return proc


def run_scenarios(page: Page) -> None:
    page.set_default_timeout(12_000)

    # --- 1. catalog renders -------------------------------------------------
    page.goto(BASE)
    page.wait_for_selector("table.pf-tl-table")
    page.wait_for_selector("tr.pf-tl-tr--trace")
    row_count = page.locator("tr.pf-tl-tr--trace").count()
    check("catalog renders trace rows", row_count >= 5, f"{row_count} rows")
    shot(page, "catalog")

    # --- 2. in-directory search filters ------------------------------------
    search = page.locator(".pf-tl-search__input")
    search.fill("boot")
    page.wait_for_timeout(700)
    after = page.locator("tr.pf-tl-tr--trace").count()
    check(
        "search narrows the catalog",
        after == 1 and trace_row(page, "android-boot.pftrace").count() == 1,
        f"{after} row(s) for 'boot'",
    )
    shot(page, "search")

    # --- 3. recursive search reaches a sub-directory -----------------------
    search.fill("game")
    page.wait_for_timeout(700)
    found_nested = trace_row(page, "game-frame.pftrace").count() == 1
    check("recursive search finds a nested trace", found_nested)
    search.fill("")
    page.wait_for_timeout(700)

    # --- 4. start a trace -> live ------------------------------------------
    boot = trace_row(page, "android-boot.pftrace")
    boot.locator(".pf-tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="android-boot.pftrace"])'
        ' .pf-tl-state--live',
        timeout=15_000,
    )
    check(
        "starting a trace yields the live state",
        boot.locator(".pf-tl-state--live").count() == 1,
    )
    shot(page, "running-live")

    # --- 4b. prewarm flow ---------------------------------------------------
    # Click the secondary action (the bolt icon) on the already-live row. The
    # state chip should flip to 'prewarming' within a couple of poll cycles.
    # The fake trace_processor isn't a real RPC server, so the prewarmer will
    # eventually time out and the chip becomes 'prewarm-failed' — but that
    # *itself* exercises the failure-surfacing path, which is the point.
    boot.locator(".pf-tl-td--actions button").nth(1).dispatch_event("click")
    page.wait_for_selector(
        'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="android-boot.pftrace"])'
        ' .pf-tl-state--prewarming',
        timeout=10_000,
    )
    check(
        "clicking prewarm transitions the row to 'prewarming'",
        boot.locator(".pf-tl-state--prewarming").count() == 1,
    )
    shot(page, "prewarming")

    # --- 5. a crashing trace_processor surfaces as crashed -----------------
    crash = trace_row(page, "broken-crash.pftrace")
    crash.locator(".pf-tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="broken-crash.pftrace"])'
        ' .pf-tl-state--crashed',
        timeout=15_000,
    )
    check(
        "a crashing trace_processor is shown as crashed",
        crash.locator(".pf-tl-state--crashed").count() == 1,
    )
    shot(page, "crashed")

    # --- 6. a hanging trace_processor stays "starting" ---------------------
    hang = trace_row(page, "slow-hang.pftrace")
    hang.locator(".pf-tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="slow-hang.pftrace"])'
        ' .pf-tl-state--starting',
        timeout=10_000,
    )
    page.wait_for_timeout(3500)  # it must NOT flip to live
    check(
        "a hanging trace_processor stays 'starting'",
        hang.locator(".pf-tl-state--starting").count() == 1,
    )
    shot(page, "hang")

    # --- 7. double-clicking Start is idempotent ----------------------------
    sched = trace_row(page, "scheduler.trace")
    sched_btn = sched.locator(".pf-tl-td--actions button").first
    # dispatch_event bypasses Playwright's actionability checks and goes
    # straight to the button's onclick handler, so we can fire two presses
    # back-to-back without racing the inert-on-pending guard. That proves the
    # server stays idempotent even when both synthetic clicks land before the
    # UI has marked the button busy.
    sched_btn.dispatch_event("click")
    sched_btn.dispatch_event("click")
    page.wait_for_timeout(3000)
    # Exactly one of the three "active" states for the scheduler row.
    active = sched.locator(
        ".pf-tl-state--live, .pf-tl-state--starting, .pf-tl-state--crashed"
    ).count()
    check(
        "double-click Start spawns only one child",
        active == 1,
        f"{active} active state(s) on scheduler row",
    )

    # --- 8. the Columns menu toggles a metadata column ---------------------
    page.get_by_role("button", name="Columns").click()
    page.wait_for_selector(".pf-tl-dropdown__panel")
    page.locator('.pf-tl-checkbox:has-text("device")').click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    device_header = page.locator('th.pf-tl-th:has-text("device")').count() == 1
    check("Columns menu adds the metadata 'device' column", device_header)
    shot(page, "columns")

    # --- 9. the Filters editor adds a metadata SQL filter ------------------
    page.get_by_role("button", name="Filters").click()
    page.wait_for_selector(".pf-tl-filter-panel")
    selects = page.locator(".pf-tl-filter-panel .pf-tl-select")
    selects.nth(0).select_option("meta:device")
    selects.nth(1).select_option("contains")
    page.locator(".pf-tl-filter-editor__value").fill("pixel-9")
    page.get_by_role("button", name="Add").click()
    page.wait_for_timeout(800)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    chip = page.locator(".pf-tl-chip-filter").count() == 1
    filtered = page.locator("tr.pf-tl-tr--trace").count()
    check(
        "a metadata filter is applied and shows a chip",
        chip and 1 <= filtered <= 4,
        f"{filtered} row(s) match device~pixel-9",
    )
    shot(page, "filter")

    # --- 9b. "Start all shown" respects the active filter -------------------
    # The filter scoped the catalog to two traces; only those should be
    # started. (slow-hang is already running from test 6, so just one new
    # live trace lands — chrome-startup.)
    active_states = ".pf-tl-state--live, .pf-tl-state--starting, .pf-tl-state--crashed"
    running_before = page.locator(active_states).count()
    page.get_by_role("button", name="Start all shown").click()
    page.wait_for_selector(
        'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="chrome-startup.perfetto-trace"])'
        ' .pf-tl-state--live',
        timeout=12_000,
    )
    page.wait_for_timeout(800)
    running_after = page.locator(active_states).count()
    check(
        "Start all shown only spawns traces in the filtered view",
        running_after == running_before + 1
        and trace_row(page, "chrome-startup.perfetto-trace")
            .locator(".pf-tl-state--live").count() == 1,
        f"active rows: {running_before} -> {running_after}",
    )
    shot(page, "bulk-filtered")

    # remove the filter again
    page.locator(".pf-tl-chip-filter__remove").first.click()
    page.wait_for_timeout(700)
    check(
        "removing the filter restores the catalog",
        page.locator(".pf-tl-chip-filter").count() == 0,
    )

    # --- 9c. status filter narrows the catalog by runtime state ------------
    page.get_by_role("button", name="Filters").click()
    page.wait_for_selector(".pf-tl-filter-panel")
    selects = page.locator(".pf-tl-filter-panel .pf-tl-select")
    selects.nth(0).select_option("status")
    page.locator(".pf-tl-filter-editor__value").fill("crashed")
    page.get_by_role("button", name="Add").click()
    page.wait_for_timeout(500)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    crashed_rows = page.locator("tr.pf-tl-tr--trace").count()
    crashed_chips = page.locator("tr.pf-tl-tr--trace .pf-tl-state--crashed").count()
    check(
        "status filter narrows the catalog to crashed rows",
        crashed_rows == 1 and crashed_chips == 1,
        f"{crashed_rows} row(s), {crashed_chips} crashed",
    )
    shot(page, "status-filter")
    page.locator(".pf-tl-chip-filter__remove").first.click()
    page.wait_for_timeout(500)

    # --- 10. directory navigation ------------------------------------------
    page.locator('tr.pf-tl-tr--dir:has-text("nested")').click()
    page.wait_for_timeout(700)
    in_nested = (
        page.locator(".pf-tl-crumb--current").inner_text().strip() == "nested"
        and trace_row(page, "game-frame.pftrace").count() == 1
    )
    check("navigating into a sub-directory works", in_nested)
    page.locator('.pf-tl-crumb:has-text("root")').click()
    page.wait_for_timeout(700)

    # --- 11. theme toggle ---------------------------------------------------
    page.locator('button[title="Switch to light theme"]').click()
    page.wait_for_timeout(300)
    is_light = page.evaluate(
        "document.documentElement.getAttribute('data-theme')"
    )
    check("theme toggle switches to light", is_light == "light")
    shot(page, "light-theme")
    page.locator('button[title="Switch to dark theme"]').click()
    page.wait_for_timeout(300)

    # --- 11b. Open all shown spawns one tab per live row -------------------
    # Counts new tabs created when "Open all shown" is clicked. To keep the
    # test offline and fast, we block any navigation to ui.perfetto.dev at
    # the context level — every open() still spawns a Page object that we
    # observe via the 'page' event, but the underlying request is aborted
    # so we never actually hit the network.
    #
    # Openable rows are every row whose backing child holds a bound port:
    # the UI states live, prewarming, and prewarmed (server status='live'
    # in all three, with prewarm/prewarmed layered on the same port).
    live_count = page.locator(
        ".pf-tl-state--live, .pf-tl-state--prewarming, .pf-tl-state--prewarmed"
    ).count()
    context = page.context
    opened_pages: list[Page] = []
    on_new_page = lambda new: opened_pages.append(new)  # noqa: E731
    context.on("page", on_new_page)
    # Abort outbound nav to anything other than the local server so opens
    # don't have to round-trip ui.perfetto.dev.
    context.route(
        "**/*",
        lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort(),
    )
    page.get_by_role("button", name="Open all shown").click()
    page.wait_for_timeout(700)
    # Give the browser a moment to register the new pages, then stop
    # listening so a later batch click in another scenario doesn't pollute.
    context.remove_listener("page", on_new_page)
    for tab in opened_pages:
        try:
            tab.close()
        except Exception:  # noqa: BLE001 — already-closed tabs are fine
            pass
    context.unroute("**/*")
    check(
        "Open all shown opens one tab per live row",
        len(opened_pages) == live_count and live_count > 0,
        f"opened {len(opened_pages)} tab(s) for {live_count} live row(s)",
    )

    # --- 12. stop all -------------------------------------------------------
    page.get_by_role("button", name="Stop all shown").click()
    page.wait_for_timeout(1500)
    remaining = page.locator(
        ".pf-tl-state--live, .pf-tl-state--starting, .pf-tl-state--crashed"
    ).count()
    check(
        "Stop all shown reaps every running child",
        remaining == 0,
        f"{remaining} active row(s) left",
    )
    shot(page, "stopped")


def run_max_ports_scenario(page: Page) -> None:
    """Drive a server with only SMALL_TP_PORTS ports: a 3rd start must error.

    Verifies that OutOfPortsError surfaces as an inline .pf-tl-row-error on the
    offending row (with a hint to free a port by stopping a running trace),
    and that the dismiss button on that error chip clears it.
    """
    page.set_default_timeout(12_000)
    page.goto(SMALL_BASE)
    page.wait_for_selector("tr.pf-tl-tr--trace")

    # Sort by name so the row ordering is deterministic across runs.
    rows = ["android-boot.pftrace", "chrome-startup.perfetto-trace"]
    for name in rows:
        trace_row(page, name).locator(".pf-tl-td--actions button").first.dispatch_event("click")
    # Wait until both reach 'live' so we know they've claimed both ports.
    for name in rows:
        page.wait_for_selector(
            f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{name}"]) .pf-tl-state--live',
            timeout=15_000,
        )

    # Now exhaust the pool: start a third trace with no port left.
    third_name = "scheduler.trace"
    third = trace_row(page, third_name)
    third.locator(".pf-tl-td--actions button").first.dispatch_event("click")
    # The inline error chip should appear on the offending row.
    page.wait_for_selector(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{third_name}"]) .pf-tl-row-error',
        timeout=8_000,
    )
    # The full error message lives in the `title` tooltip now (the chip
    # itself is icon + dismiss so it fits beside the state chip on a single
    # row line). Reading the attribute is the stable way to assert on
    # message contents without relying on visual text.
    tooltip = third.locator(".pf-tl-row-error").get_attribute("title") or ""
    text = tooltip.strip().lower()
    check(
        "out-of-ports surfaces an inline row error with a stop-a-trace hint",
        third.locator(".pf-tl-row-error").count() == 1
        and ("stop a running trace" in text or "free" in text),
        f"row-error tooltip: {text!r}",
    )
    shot(page, "max-ports-error")

    # Dismiss the inline error and confirm the chip is gone.
    third.locator(".pf-tl-row-error__close").dispatch_event("click")
    page.wait_for_timeout(400)
    check(
        "dismissing the inline error clears it",
        third.locator(".pf-tl-row-error").count() == 0,
    )

    # Free a port: stopping one of the live rows must let the next start succeed.
    free_name = rows[0]
    trace_row(page, free_name).locator(".pf-tl-td--actions button").first.dispatch_event("click")
    page.wait_for_timeout(800)
    third.locator(".pf-tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        f'tr.pf-tl-tr--trace:has(.pf-tl-name-cell__text[title="{third_name}"]) .pf-tl-state--live',
        timeout=15_000,
    )
    check(
        "freeing a port lets the previously-blocked start succeed",
        third.locator(".pf-tl-state--live").count() == 1,
    )
    shot(page, "max-ports-recovered")


def main() -> int:
    # The main server uses the default port pool. The small-ports server runs
    # on a separate HTTP port + a disjoint trace_processor port range so the
    # two never collide.
    server = start_server()
    small_server = start_server(
        http_port=SMALL_PORT,
        tp_port_base=19500,
        tp_port_count=SMALL_TP_PORTS,
    )
    # Headed by default (so the recorder captures a real screen); set
    # TL_E2E_HEADLESS=1 for a fast, display-less smoke run.
    headless = os.environ.get("TL_E2E_HEADLESS") == "1"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1366, "height": 900})
            try:
                run_scenarios(page)
                run_max_ports_scenario(page)
            finally:
                page.wait_for_timeout(800)  # settle margin for the recording
                browser.close()
    finally:
        for proc in (server, small_server):
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n=== {passed}/{len(RESULTS)} checkpoints passed ===", flush=True)
    if failed:
        print("FAILED: " + ", ".join(failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
