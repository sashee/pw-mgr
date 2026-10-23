"""End-to-end: the file explorer (web SPEC §9.5) shows the vault's tree as it is stored, read-only, with passwords
masked until asked for, and its module isn't loaded during normal use.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_explorer.py    # after `make deps`
"""

import sys

from playwright.sync_api import expect

from harness import Backend, add_entry, create_vault, harness, lock, new_device, unlock

PASSWORD = "correct horse battery staple"


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


def run(browser, backend: Backend, port: int) -> None:
    page = new_device(browser, f"http://localhost:{port}").page
    fetched: list[str] = []
    page.on("request", lambda r: fetched.append(r.url) if "/js/explorer/" in r.url else None)
    create_vault(page, backend.setup_token("user", "create", "alice"))
    add_entry(page, "GitHub", "alice", PASSWORD)
    add_entry(page, "Mail", "alice", "another secret")
    lock(page)
    unlock(page)
    assert fetched == [], fetched
    ok("the explorer module isn't loaded during normal use")

    # --- the root: the vault and the version the second save replaced, with the root's revision
    page.click("#settings")
    page.click("#explore-files")
    expect(page.locator("#explorer-entries li")).to_have_count(2)
    expect(page.locator("li[data-name='vault']")).to_be_visible()
    snapshot = page.locator("#explorer-entries li").nth(1).get_attribute("data-name")
    assert snapshot.startswith("vault@"), snapshot
    expect(page.locator("#explorer-root")).to_contain_text("revision")
    ok(f"the root lists the vault and {snapshot}")

    # --- a file: its fields in full, and its JSON with the passwords masked until revealed
    page.locator("li[data-name='vault'] button").click()
    content = page.locator("#explorer-content")
    expect(content).to_contain_text('"title": "GitHub"')
    expect(content).to_contain_text("••••••••")
    assert PASSWORD not in page.content(), "no password in the page before it is revealed"
    expect(page.locator("#explorer-fields")).to_contain_text("SHA-256 of the content")
    page.click("#explorer-reveal")
    expect(content).to_contain_text(PASSWORD)
    page.click("#explorer-reveal")
    expect(content).not_to_contain_text(PASSWORD)
    ok("a file shows its fields and its JSON, with passwords masked until revealed")

    # --- back up to the root, into the snapshot (masked again), and back to settings
    page.locator("#explorer-path button", has_text="/").click()
    page.locator(f"li[data-name='{snapshot}'] button").click()
    expect(content).to_contain_text('"title": "GitHub"')
    expect(content).not_to_contain_text("Mail")
    assert PASSWORD not in page.content()
    page.click("#explorer-back")
    page.wait_for_selector("#settings-screen")
    ok("the snapshot holds the vault as it was before the last save; back returns to settings")


if __name__ == "__main__":
    sys.exit(harness(run))
