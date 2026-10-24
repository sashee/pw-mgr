"""End-to-end: settings, the password generator, cleanup, rollback and the conflict notice (web SPEC §7, §9.4;
e2ee-store/sdk/SPEC.md §6.4–§6.11), against the real backend. Step-up is shortened to 5 seconds so it can be exercised.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_settings.py    # after `make deps`
"""

import re
import sqlite3
import sys
import time

from playwright.sync_api import expect

from harness import Backend, create_vault, harness, join, lock, new_device, unlock

REAUTH_WINDOW_S = 5
SYMBOLS = "!#$%&()*+,-./:;<=>?@[]^_{|}~"

# The root directory as the SDK sees it, unlocked with the recovery key in the page: its blob, and what it lists.
TREE = """
async ({ recoveryKey }) => {
  const { makeFlows } = await import("/sdk/flows.js");
  const { labels } = await import("/sdk/labels.js");
  const { hexDecode } = await import("/sdk/crypto.js");
  const flows = makeFlows({ labels: labels("pw-mgr") });
  const session = await flows.unlockWithRecoveryKey(await flows.loadKeys(), hexDecode(recoveryKey));
  return { root: session.root.blobId, entries: (await flows.list(session, [])).map(({ name, id }) => ({ name, id })) };
}
"""


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


def open_settings(page) -> None:
    page.click("#settings")
    page.wait_for_selector("#settings-screen")


def passkey_rows(page) -> list[str]:
    page.wait_for_selector("#settings-screen")
    return page.locator("#passkeys li").all_inner_texts()


def setup_token_from(page) -> str:
    """Settings → Add device; handles the step-up prompt if it comes. Returns the token."""
    page.click("#add-device")
    page.wait_for_selector("#setup-token, #confirm-identity")
    if page.is_visible("#confirm-identity"):
        page.click("#confirm-identity")
    return page.inner_text("#setup-token").strip()


def db(backend: Backend):
    return sqlite3.connect(backend.database)


def run(browser, backend: Backend, port: int) -> None:
    laptop = new_device(browser, f"http://localhost:{port}")
    page = laptop.page
    recovery_key = create_vault(page, backend.setup_token("user", "create", "alice"))

    # --- password generator: classes and length, KeePassXC-style
    page.click("#new-entry")
    for field in ["#title", "#username-input", "#password-input", "#urls", "#notes"]:
        expect(page.locator(field)).to_have_attribute("spellcheck", "false")
    page.fill("#title", "Generated")
    page.click("#generate")
    expect(page.locator("#generator")).to_be_visible()
    first = page.inner_text("#generated")
    assert len(first) == 20, first
    expect(page.locator("#generator-strength")).to_contain_text("Excellent")
    page.fill("#generate-length", "32")
    page.press("#generate-length", "Enter")
    for cls in ["braces", "punctuation", "dashes", "math", "logograms"]:
        page.click(f"button[data-class='{cls}']")
    expect(page.locator("button[data-class='upper']")).to_have_attribute("aria-pressed", "true")
    expect(page.locator("button[data-class='math']")).to_have_attribute("aria-pressed", "false")
    generated = page.inner_text("#generated")
    assert re.fullmatch(r"[A-Za-z0-9]{32}", generated) and re.search(r"[0-9]", generated), generated
    page.click("#regenerate")
    assert page.inner_text("#generated") != generated
    for cls in ["upper", "lower", "digits"]:
        page.click(f"button[data-class='{cls}']")
    expect(page.locator("#generator .error")).to_contain_text("Select at least one")
    expect(page.locator("#use-password")).to_be_disabled()
    page.click("button[data-class='digits']")
    page.click(".advanced summary")
    page.fill("#generate-include", "€")
    page.fill("#generate-exclude", "0123")
    generated = page.inner_text("#generated")
    assert re.fullmatch(r"[4-9€]{32}", generated) and "€" in generated, generated
    page.click("#use-password")
    assert page.input_value("#password-input") == generated
    expect(page.locator("#generator")).to_be_hidden()
    page.click("#save")
    expect(page.locator("li[data-entry='Generated']")).to_be_visible()
    page.click("#new-entry")
    page.click("#generate")
    expect(page.locator("#generate-length")).to_have_value("32")
    assert re.fullmatch(r"[4-9€]{32}", page.inner_text("#generated")), "the settings are remembered on this device"
    page.click("text=Cancel")
    ok("the generator: classes, length, extra and excluded characters, strength, remembered settings")

    # --- settings: the one passkey, then a second device through "Add device"
    open_settings(page)
    rows = passkey_rows(page)
    # The session still comes from the setup token: the passkey hasn't been used to log in yet.
    assert len(rows) == 1 and "can unlock" in rows[0] and "last used never" in rows[0] and "this session" not in rows[0], rows
    lock(page)
    unlock(page)
    open_settings(page)
    rows = passkey_rows(page)
    assert len(rows) == 1 and "this session" in rows[0] and "last used never" not in rows[0], rows
    token = setup_token_from(page)
    expect(page.locator("#setup-fragment")).to_have_text(f"/#setup={token}")
    expect(page.locator("#setup-expiry")).to_contain_text("Valid for 14:")
    phone = new_device(browser, f"http://phone.localhost:{port}", prf_at_create=False)
    join(phone.page, token, recovery_key)
    expect(phone.page.locator("li[data-entry='Generated']")).to_be_visible()
    page.click("#done")
    rows = passkey_rows(page)
    assert len(rows) == 2 and "phone.localhost" in rows[1] and "can unlock" in rows[1], rows
    ok("Add device creates a setup link that a second device joins with")

    # --- both devices edit the same entry: the later save wins and says so
    page.click("#back")
    page.locator("li[data-entry='Generated'] button.entry").click()
    page.click("#edit")
    phone.page.locator("li[data-entry='Generated'] button.entry").click()
    phone.page.click("#edit")
    phone.page.fill("#username-input", "from-phone")
    phone.page.click("#save")
    expect(phone.page.locator("li[data-entry='Generated']")).to_be_visible()
    page.fill("#username-input", "from-laptop")
    page.click("#save")
    expect(page.locator("#notice")).to_contain_text("also changed on another device")
    ok("saving an entry changed on another device shows a notice")

    # --- entry history: an overwritten password can be seen, copied and restored
    page.click("#new-entry")
    page.fill("#title", "Bank")
    page.fill("#password-input", "original-password")
    page.click("#save")
    for replacement in ["second-password", "third-password"]:
        page.locator("li[data-entry='Bank'] button.entry").click()
        page.click("#edit")
        page.fill("#password-input", replacement)
        page.click("#save")
        expect(page.locator("li[data-entry='Bank']")).to_be_visible()
    page.locator("li[data-entry='Bank'] button.entry").click()
    expect(page.locator("#history")).to_have_text("History (2)")
    page.click("#history")
    versions = page.locator("#versions > li")
    expect(versions).to_have_count(2)
    expect(versions.nth(0)).to_contain_text("Afterwards changed: password")
    oldest = versions.nth(1)
    oldest.locator("button[data-copy='Copy password']").click()
    assert page.evaluate("navigator.clipboard.readText()") == "original-password"
    oldest.locator("button[data-action='restore']").click()
    expect(page.locator("#notice")).to_contain_text("Restored the version")
    page.locator("li[data-entry='Bank'] button.entry").click()
    page.click("text=Show")
    expect(page.locator("#password")).to_have_text("original-password")
    expect(page.locator("#history")).to_have_text("History (3)")
    page.click("#edit")
    page.click("#save")
    page.locator("li[data-entry='Bank'] button.entry").click()
    expect(page.locator("#history")).to_have_text("History (3)")
    ok("an entry's history shows, copies and restores an overwritten password; unchanged saves add nothing")

    # --- step-up: after the window, creating a setup link asks for the passkey again
    time.sleep(REAUTH_WINDOW_S + 1)
    open_settings(page)
    page.click("#add-device")
    page.wait_for_selector("#confirm-identity")
    page.click("#confirm-identity")
    page.wait_for_selector("#setup-token")
    page.click("#done")
    ok("an old session is asked to confirm with the passkey (step-up)")

    # --- delete the phone's passkey: it can't unlock anymore
    phone_row = page.locator("#passkeys li", has_text="phone.localhost")
    phone_row.locator("button[data-action='delete']").click()
    expect(page.locator("#notice")).to_contain_text("was deleted")
    assert len(passkey_rows(page)) == 1
    lock(phone.page)
    phone.page.click("#unlock")
    expect(phone.page.locator(".banner")).to_contain_text("The passkey login failed")
    with db(backend) as conn:
        keys = conn.execute("SELECT cast(b.content AS TEXT) FROM refs r JOIN blobs b ON b.id = r.blob_id WHERE r.name = 'keys'").fetchone()[0]
    assert keys.count('"wrapped_key"') == 2, "one recovery slot and the laptop's passkey slot remain"
    ok("deleting a passkey removes it and its slot")

    # --- replace the recovery key: the old one stops working, the new one works
    open_settings(page)
    page.click("#replace-recovery-key")
    new_recovery_key = page.inner_text("#recovery-key").strip()
    assert new_recovery_key != recovery_key
    page.check("#saved-recovery-key")
    page.click("#create-vault")
    expect(page.locator("#notice")).to_contain_text("recovery key was replaced")
    other = new_device(browser, f"http://other.localhost:{port}").page
    other.goto("/")
    other.fill("#setup-input", backend.setup_token("setup-token", "create", "alice"))
    other.click("#use-setup")
    other.fill("#recovery-key-input", recovery_key)
    other.click("#unlock-recovery")
    expect(other.locator(".banner")).to_contain_text("Wrong recovery key")
    other.fill("#recovery-key-input", new_recovery_key)
    other.click("#unlock-recovery")
    other.wait_for_selector("#create-passkey")
    open_settings(page)
    for key, expected in [(new_recovery_key, "opens your vault"), (recovery_key, "does NOT open"), ("abc", "64 hex characters")]:
        page.fill("#test-recovery-key", key)
        page.click("#test-recovery")
        expect(page.locator("#recovery-test-result")).to_contain_text(expected)
    ok("a replaced recovery key stops working; the new one works; Settings tests a recovery key")

    # --- add a passkey on this device (a new security key; the old one is gone)
    lock(page)
    unlock(page)
    laptop.replace_authenticator()
    open_settings(page)
    page.click("#add-passkey")
    page.fill("#passkey-name", "New key")
    page.click("#create-passkey")
    page.wait_for_selector("#confirm-passkey, #notice, #confirm-identity, .banner.error")
    if page.is_visible("#confirm-passkey"):
        page.click("#confirm-passkey")
    assert not page.is_visible(".banner.error"), page.inner_text(".banner.error")
    expect(page.locator("#notice")).to_contain_text('"New key" was added')
    lock(page)
    unlock(page)
    ok("a passkey added in settings unlocks the vault")

    # --- cleanup: what the tree doesn't reach goes once it's a day old; the root, the vault and its versions stay
    status, orphan = page.evaluate(
        """async () => {
          const data = crypto.getRandomValues(new Uint8Array(100));
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
          const response = await fetch(`/api/v1/blobs/${hash}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: data });
          return [response.status, hash];
        }"""
    )
    assert status == 201, status
    committed = laptop.committed + phone.committed
    with db(backend) as conn:
        # The first root, kept aside for the rollback test below: cleanup deletes it, as nothing reaches it any more.
        first_root = conn.execute("SELECT user_id, id, size, content, created_at FROM blobs WHERE lower(hex(id)) = ?", (laptop.committed[0],)).fetchone()
        conn.execute("UPDATE blobs SET created_at = created_at - 2 * 24 * 3600 * 1000")
        before = {row[0] for row in conn.execute("SELECT lower(hex(id)) FROM blobs")}
    open_settings(page)
    page.click("#cleanup")
    page.wait_for_selector("#cleanup-report")
    report = page.inner_text("#cleanup-report")
    tree = page.evaluate(TREE, {"recoveryKey": new_recovery_key})
    with db(backend) as conn:
        remaining = {row[0] for row in conn.execute("SELECT lower(hex(id)) FROM blobs")}
        refs = {row[0] for row in conn.execute("SELECT lower(hex(blob_id)) FROM refs")}
    reached = {entry["id"] for entry in tree["entries"]}
    names = [entry["name"] for entry in tree["entries"]]
    assert "vault" in names and any(name.startswith("vault@") for name in names), names
    assert orphan not in remaining, "the orphan is deleted"
    assert remaining == refs | reached, f"exactly the keys, the root and what it lists remain: {sorted(remaining ^ (refs | reached))}"
    assert not (set(committed) - {tree["root"]}) & remaining, "earlier roots are deleted"
    deleted = int(re.search(r"(\d+) \(", page.inner_text("#cleanup-deleted")).group(1))
    assert deleted == len(before - remaining), report
    page.click("#done")
    expect(page.locator("#last-cleanup")).to_contain_text("(manual)")
    lock(page)
    unlock(page)
    expect(page.locator("li[data-entry='Generated']")).to_be_visible()
    ok(f"cleanup deleted {deleted} blobs the tree doesn't reach, and kept the vault with {len(names) - 1} earlier versions")

    # --- rollback: the server serves an older root (the first, empty one); saving pauses until acknowledged
    with db(backend) as conn:
        conn.execute("INSERT OR IGNORE INTO blobs (user_id, id, size, content, created_at) VALUES (?, ?, ?, ?, ?)", first_root)
        conn.execute("UPDATE refs SET blob_id = ? WHERE name = 'vault'", (first_root[1],))
    lock(page)
    unlock(page)
    expect(page.locator("#rollback-warning")).to_be_visible()
    page.click("#new-entry")
    page.fill("#title", "After rollback")
    page.click("#save")
    expect(page.locator(".banner.error")).to_contain_text("Saving is paused")
    page.click("#acknowledge-rollback")
    expect(page.locator("#rollback-warning")).to_have_count(0)
    page.click("#save")
    expect(page.locator("li[data-entry='After rollback']")).to_be_visible()
    ok("an older vault from the server shows a warning and pauses saving until acknowledged")

    # --- cleanup never deletes anything when a document is missing on the server
    with db(backend) as conn:
        keys_blob = conn.execute("SELECT blob_id FROM refs WHERE name = 'keys'").fetchone()[0]
        conn.execute("UPDATE blobs SET created_at = created_at - 2 * 24 * 3600 * 1000")
        conn.execute("DELETE FROM refs WHERE name = 'keys'")
        before = conn.execute("SELECT count(*) FROM blobs").fetchone()[0]
    open_settings(page)
    page.click("#cleanup")
    expect(page.locator("#cleanup-report")).to_contain_text("missing on the server")
    with db(backend) as conn:
        assert conn.execute("SELECT count(*) FROM blobs").fetchone()[0] == before, "nothing deleted"
        assert conn.execute("SELECT count(*) FROM blobs WHERE id = ?", (keys_blob,)).fetchone()[0] == 1, "the keys blob is still there"
    ok("cleanup stops without deleting anything when the keys ref is missing")


if __name__ == "__main__":
    sys.exit(harness(run, extra_env={"BACKEND_REAUTH_WINDOW": f"{REAUTH_WINDOW_S}s"}))
