"""End-to-end: locking (web SPEC §7.4):

  15 minutes without input lock (on Playwright's fake clock), and input resets the timer
  deleting the passkey this session was created with locks
  a request that finds the session expired locks, and the change isn't saved

The expiry runs against its own backend with a short session lifetime.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_locking.py    # after `make deps`
"""

import sys
import time

from playwright.sync_api import expect

from harness import Backend, create_vault, harness, join, lock, new_device, unlock

SESSION_TTL_S = 30


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


def run(browser, backend: Backend, port: int) -> None:
    laptop = new_device(browser, f"http://localhost:{port}")
    page = laptop.page
    page.context.clock.install()
    recovery_key = create_vault(page, backend.setup_token("user", "create", "alice"))

    # --- inactivity: input resets the 15 minutes, then the app locks
    page.clock.fast_forward("14:00")
    expect(page.locator("#new-entry")).to_be_visible()
    page.keyboard.press("Shift")
    page.clock.fast_forward("14:00")
    expect(page.locator("#new-entry")).to_be_visible()
    page.clock.fast_forward("01:30")
    page.wait_for_selector("#unlock")
    ok("15 minutes without input lock the app; input resets the timer")

    # --- deleting the passkey this session was created with locks
    phone = new_device(browser, f"http://phone.localhost:{port}").page
    join(phone, backend.setup_token("setup-token", "create", "alice"), recovery_key)
    unlock(page)
    page.click("#settings")
    current = page.locator("#passkeys li", has_text="this session")
    current.locator("button[data-action='delete']").click()
    page.wait_for_selector("#unlock")
    page.click("#unlock")
    expect(page.locator(".banner")).to_contain_text("The passkey login failed")
    ok("deleting the passkey this session was created with locks")


def run_expiry(browser, backend: Backend, port: int) -> None:
    page = new_device(browser, f"http://localhost:{port}").page
    create_vault(page, backend.setup_token("user", "create", "alice"))
    lock(page)
    unlock(page)
    page.click("#new-entry")
    page.fill("#title", "Too late")
    time.sleep(SESSION_TTL_S + 1)
    page.click("#save")
    page.wait_for_selector("#unlock")
    unlock(page)
    expect(page.locator("li[data-entry='Too late']")).to_have_count(0)
    ok("a request that finds the session expired locks, and nothing is saved")


if __name__ == "__main__":
    sys.exit(harness(run) or harness(run_expiry, extra_env={"BACKEND_SESSION_TTL": f"{SESSION_TTL_S}s"}))
