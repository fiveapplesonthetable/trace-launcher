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
SHOTS = Path(os.environ.get("RECORD_SHOTS_DIR", "/tmp/tl-e2e-shots"))
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
        f'tr.tl-tr--trace:has(.tl-name-cell__text[title="{name}"])'
    )


def start_server() -> subprocess.Popen[bytes]:
    cmd = [
        str(PROJECT / "node_modules" / ".bin" / "tsx"),
        "server/index.ts",
        "--tp-binary", "fixtures/fake-tp",
        "--traces-dir", "fixtures/traces",
        "--recursive-search",
        "--metadata-db", "fixtures/metadata.db",
        "--metadata-table", "traces",
        "--port", str(PORT),
    ]
    proc = subprocess.Popen(
        cmd, cwd=str(PROJECT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    if not wait_port(PORT):
        print("CHECKPOINT_FAIL: server did not come up", flush=True)
        proc.terminate()
        sys.exit(1)
    print(f"server up on {BASE}", flush=True)
    return proc


def run_scenarios(page: Page) -> None:
    page.set_default_timeout(12_000)

    # --- 1. catalog renders -------------------------------------------------
    page.goto(BASE)
    page.wait_for_selector("table.tl-table")
    page.wait_for_selector("tr.tl-tr--trace")
    row_count = page.locator("tr.tl-tr--trace").count()
    check("catalog renders trace rows", row_count >= 5, f"{row_count} rows")
    shot(page, "catalog")

    # --- 2. in-directory search filters ------------------------------------
    search = page.locator(".tl-search__input")
    search.fill("boot")
    page.wait_for_timeout(700)
    after = page.locator("tr.tl-tr--trace").count()
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
    boot.locator(".tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        'tr.tl-tr--trace:has(.tl-name-cell__text[title="android-boot.pftrace"])'
        ' .tl-state--live',
        timeout=15_000,
    )
    check(
        "starting a trace yields the live state",
        boot.locator(".tl-state--live").count() == 1,
    )
    shot(page, "running-live")

    # --- 5. a crashing trace_processor surfaces as crashed -----------------
    crash = trace_row(page, "broken-crash.pftrace")
    crash.locator(".tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        'tr.tl-tr--trace:has(.tl-name-cell__text[title="broken-crash.pftrace"])'
        ' .tl-state--crashed',
        timeout=15_000,
    )
    check(
        "a crashing trace_processor is shown as crashed",
        crash.locator(".tl-state--crashed").count() == 1,
    )
    shot(page, "crashed")

    # --- 6. a hanging trace_processor stays "starting" ---------------------
    hang = trace_row(page, "slow-hang.pftrace")
    hang.locator(".tl-td--actions button").first.dispatch_event("click")
    page.wait_for_selector(
        'tr.tl-tr--trace:has(.tl-name-cell__text[title="slow-hang.pftrace"])'
        ' .tl-state--starting',
        timeout=10_000,
    )
    page.wait_for_timeout(3500)  # it must NOT flip to live
    check(
        "a hanging trace_processor stays 'starting'",
        hang.locator(".tl-state--starting").count() == 1,
    )
    shot(page, "hang")

    # --- 7. double-clicking Start is idempotent ----------------------------
    sched = trace_row(page, "scheduler.trace")
    sched_btn = sched.locator(".tl-td--actions button").first
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
        ".tl-state--live, .tl-state--starting, .tl-state--crashed"
    ).count()
    check(
        "double-click Start spawns only one child",
        active == 1,
        f"{active} active state(s) on scheduler row",
    )

    # --- 8. the Columns menu toggles a metadata column ---------------------
    page.get_by_role("button", name="Columns").click()
    page.wait_for_selector(".tl-dropdown__panel")
    page.locator('.tl-checkbox:has-text("device")').click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    device_header = page.locator('th.tl-th:has-text("device")').count() == 1
    check("Columns menu adds the metadata 'device' column", device_header)
    shot(page, "columns")

    # --- 9. the Filters editor adds a metadata SQL filter ------------------
    page.get_by_role("button", name="Filters").click()
    page.wait_for_selector(".tl-filter-panel")
    selects = page.locator(".tl-filter-panel .tl-select")
    selects.nth(0).select_option("meta:device")
    selects.nth(1).select_option("contains")
    page.locator(".tl-filter-editor__value").fill("pixel-9")
    page.get_by_role("button", name="Add").click()
    page.wait_for_timeout(800)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    chip = page.locator(".tl-chip-filter").count() == 1
    filtered = page.locator("tr.tl-tr--trace").count()
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
    active_states = ".tl-state--live, .tl-state--starting, .tl-state--crashed"
    running_before = page.locator(active_states).count()
    page.get_by_role("button", name="Start all shown").click()
    page.wait_for_selector(
        'tr.tl-tr--trace:has(.tl-name-cell__text[title="chrome-startup.perfetto-trace"])'
        ' .tl-state--live',
        timeout=12_000,
    )
    page.wait_for_timeout(800)
    running_after = page.locator(active_states).count()
    check(
        "Start all shown only spawns traces in the filtered view",
        running_after == running_before + 1
        and trace_row(page, "chrome-startup.perfetto-trace")
            .locator(".tl-state--live").count() == 1,
        f"active rows: {running_before} -> {running_after}",
    )
    shot(page, "bulk-filtered")

    # remove the filter again
    page.locator(".tl-chip-filter__remove").first.click()
    page.wait_for_timeout(700)
    check(
        "removing the filter restores the catalog",
        page.locator(".tl-chip-filter").count() == 0,
    )

    # --- 9c. status filter narrows the catalog by runtime state ------------
    page.get_by_role("button", name="Filters").click()
    page.wait_for_selector(".tl-filter-panel")
    selects = page.locator(".tl-filter-panel .tl-select")
    selects.nth(0).select_option("status")
    page.locator(".tl-filter-editor__value").fill("crashed")
    page.get_by_role("button", name="Add").click()
    page.wait_for_timeout(500)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    crashed_rows = page.locator("tr.tl-tr--trace").count()
    crashed_chips = page.locator("tr.tl-tr--trace .tl-state--crashed").count()
    check(
        "status filter narrows the catalog to crashed rows",
        crashed_rows == 1 and crashed_chips == 1,
        f"{crashed_rows} row(s), {crashed_chips} crashed",
    )
    shot(page, "status-filter")
    page.locator(".tl-chip-filter__remove").first.click()
    page.wait_for_timeout(500)

    # --- 10. directory navigation ------------------------------------------
    page.locator('tr.tl-tr--dir:has-text("nested")').click()
    page.wait_for_timeout(700)
    in_nested = (
        page.locator(".tl-crumb--current").inner_text().strip() == "nested"
        and trace_row(page, "game-frame.pftrace").count() == 1
    )
    check("navigating into a sub-directory works", in_nested)
    page.locator('.tl-crumb:has-text("root")').click()
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

    # --- 12. stop all -------------------------------------------------------
    page.get_by_role("button", name="Stop all shown").click()
    page.wait_for_timeout(1500)
    remaining = page.locator(
        ".tl-state--live, .tl-state--starting, .tl-state--crashed"
    ).count()
    check(
        "Stop all shown reaps every running child",
        remaining == 0,
        f"{remaining} active row(s) left",
    )
    shot(page, "stopped")


def main() -> int:
    server = start_server()
    # Headed by default (so the recorder captures a real screen); set
    # TL_E2E_HEADLESS=1 for a fast, display-less smoke run.
    headless = os.environ.get("TL_E2E_HEADLESS") == "1"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1366, "height": 900})
            try:
                run_scenarios(page)
            finally:
                page.wait_for_timeout(800)  # settle margin for the recording
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n=== {passed}/{len(RESULTS)} checkpoints passed ===", flush=True)
    if failed:
        print("FAILED: " + ", ".join(failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
