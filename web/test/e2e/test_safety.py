"""End-to-end: what keeps the data safe when the server misbehaves or devices race (web SPEC §12):

  entry fields are rendered as text, never as HTML
  a tampered or swapped vault blob is an integrity error: nothing is used, nothing is written
  a vault ref the server lost: the device that saw the vault warns instead of quietly starting over
  `keys` missing while `vault` exists: no new vault, which would make the existing one unreadable
  a newer vault or keys format opens read-only: no saves; newer keys also stop cleanup
  an interrupted vault creation (`keys` without `vault`) is completed on unlock
  two devices creating the vault at once: one wins, the other's passkey is set up with the recovery key

The server's misbehaviour is simulated by editing its database directly.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_safety.py    # after `make deps`
"""

import sqlite3
import sys

from playwright.sync_api import expect

from harness import Backend, create_passkey, create_vault, harness, lock, new_device, unlock

# Rewrites a document with another `version`, the way a newer app would, through the real API and the SDK: the keys,
# or the vault file in the tree, which needs the master key that the recovery key unwraps. Returns the ref's blob before.
REWRITE = """
async ({ ref, recoveryKey, version }) => {
  const { labels } = await import("/sdk/labels.js");
  const { decodeKeys, encodeKeys } = await import("/sdk/keys.js");
  const { makeFlows } = await import("/sdk/flows.js");
  const { hexDecode } = await import("/sdk/crypto.js");
  const api = await import("/sdk/api.js");
  const L = labels("pw-mgr");
  const current = await api.getRef(ref);
  if (ref === "keys") {
    const id = await api.putBlob(encodeKeys({ ...decodeKeys(L, await api.getBlob(current)).doc, version }));
    if (!(await api.putRef(ref, id, current)).ok) throw new Error("the ref changed");
  } else {
    const flows = makeFlows({ labels: L });
    const session = await flows.unlockWithRecoveryKey(await flows.loadKeys(), hexDecode(recoveryKey));
    const rewrite = async (tx) => {
      const doc = JSON.parse(new TextDecoder().decode(await tx.read(["vault"])));
      return tx.put(["vault"], tx.upload(new TextEncoder().encode(JSON.stringify({ ...doc, version }))));
    };
    await flows.save(session, [rewrite]);
  }
  return current;
}
"""


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


class Store:
    """One user's refs and blobs, edited in the backend's database: what a misbehaving server could do."""

    def __init__(self, backend: Backend, username: str):
        self.path = backend.database
        with self.db() as conn:
            self.user = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()[0]

    def db(self):
        return sqlite3.connect(self.path)

    def ref(self, name: str) -> bytes | None:
        with self.db() as conn:
            row = conn.execute("SELECT blob_id FROM refs WHERE user_id = ? AND name = ?", (self.user, name)).fetchone()
        return row and row[0]

    def set_ref(self, name: str, blob_id: bytes) -> None:
        with self.db() as conn:
            conn.execute("INSERT OR REPLACE INTO refs (user_id, name, blob_id, updated_at) VALUES (?, ?, ?, 0)", (self.user, name, blob_id))

    def delete_ref(self, name: str) -> None:
        with self.db() as conn:
            conn.execute("DELETE FROM refs WHERE user_id = ? AND name = ?", (self.user, name))

    def blob(self, blob_id: bytes) -> bytes:
        with self.db() as conn:
            return conn.execute("SELECT content FROM blobs WHERE user_id = ? AND id = ?", (self.user, blob_id)).fetchone()[0]

    def set_blob(self, blob_id: bytes, content: bytes) -> None:
        with self.db() as conn:
            conn.execute("UPDATE blobs SET content = ? WHERE user_id = ? AND id = ?", (content, self.user, blob_id))

    def age_blobs(self) -> None:
        """Makes every blob old enough for cleanup to delete if nothing needs it."""
        with self.db() as conn:
            conn.execute("UPDATE blobs SET created_at = created_at - 2 * 24 * 3600 * 1000 WHERE user_id = ?", (self.user,))

    def snapshot(self) -> tuple:
        with self.db() as conn:
            blobs = conn.execute("SELECT id FROM blobs WHERE user_id = ? ORDER BY id", (self.user,)).fetchall()
            refs = conn.execute("SELECT name, blob_id FROM refs WHERE user_id = ? ORDER BY name", (self.user,)).fetchall()
        return blobs, refs

    def passkey_slots(self) -> int:
        return self.blob(self.ref("keys")).count(b'"wrapped_key"') - 1  # minus the recovery slot


def save_new_entry(page, title: str) -> None:
    page.click("#new-entry")
    page.fill("#title", title)
    page.click("#save")


def run(browser, backend: Backend, port: int) -> None:
    page = new_device(browser, f"http://localhost:{port}").page
    recovery_key = create_vault(page, backend.setup_token("user", "create", "alice"))
    alice = Store(backend, "alice")

    # --- entry fields are text, never HTML
    markup = '<img src=x onerror="window.injected=1">'
    page.click("#new-entry")
    page.fill("#title", markup)
    page.fill("#username-input", markup)
    page.fill("#notes", markup)
    page.click("#save")
    row = page.locator(f"li[data-entry='{markup}']")
    expect(row).to_contain_text(markup)
    row.locator("button.entry").click()
    expect(page.locator("#detail")).to_contain_text(markup)
    assert page.locator("#app img").count() == 0, "markup in an entry became an element"
    assert page.evaluate("window.injected") is None, "markup in an entry ran"
    ok("entry fields are rendered as text, never as HTML")

    # --- a tampered vault blob, then a valid blob that isn't the vault: integrity errors, nothing written
    lock(page)
    vault = alice.ref("vault")
    original = alice.blob(vault)
    before = alice.snapshot()
    alice.set_blob(vault, original[:-1] + bytes([original[-1] ^ 1]))
    page.click("#unlock")
    expect(page.locator(".banner.error")).to_contain_text("Integrity check failed")
    alice.set_blob(vault, original)
    alice.set_ref("vault", alice.ref("keys"))
    page.click("#unlock")
    expect(page.locator(".banner.error")).to_contain_text("the vault doesn't decrypt")
    expect(page.locator("#new-entry")).to_have_count(0)
    alice.set_ref("vault", vault)
    assert alice.snapshot() == before, "nothing was written"
    unlock(page)
    ok("a tampered or swapped vault blob is an integrity error, and nothing is written")

    # --- the server lost the vault ref: a device that has seen the vault warns and pauses saving
    lock(page)
    alice.delete_ref("vault")
    unlock(page)
    expect(page.locator("#rollback-warning")).to_be_visible()
    save_new_entry(page, "On the empty vault")
    expect(page.locator(".banner.error")).to_contain_text("Saving is paused")
    alice.set_ref("vault", vault)
    lock(page)
    unlock(page)
    expect(page.locator("#rollback-warning")).to_have_count(0)
    expect(page.locator(f"li[data-entry='{markup}']")).to_be_visible()
    ok("a lost vault ref shows the rollback warning on a device that saw the vault, and saving pauses")

    # --- `keys` missing while `vault` exists: a new device must not create a vault
    keys = alice.ref("keys")
    alice.delete_ref("keys")
    other = new_device(browser, f"http://other.localhost:{port}").page
    other.goto(f"/#setup={backend.setup_token('setup-token', 'create', 'alice')}")
    expect(other.locator("#app")).to_contain_text("keys are missing")
    expect(other.locator("#create-passkey")).to_have_count(0)
    assert alice.ref("keys") is None, "no new keys were written"
    lock(page)
    page.click("#unlock")
    expect(page.locator("#app")).to_contain_text("keys are missing")
    alice.set_ref("keys", keys)
    unlock(page)
    ok("with the keys missing but the vault there, no new vault is created, and unlocking says why")

    # --- a newer keys format: read-only
    old_keys = page.evaluate(REWRITE, {"ref": "keys", "recoveryKey": recovery_key, "version": 2})
    lock(page)
    unlock(page)
    expect(page.locator("#read-only-warning")).to_be_visible()
    before = alice.snapshot()
    save_new_entry(page, "Under newer keys")
    expect(page.locator(".banner.error")).to_contain_text("read-only")
    page.click("text=Cancel")
    page.click("#settings")
    page.click("#cleanup")
    page.wait_for_selector("#cleanup-report")
    expect(page.locator("#cleanup-report")).to_contain_text("newer version")
    page.click("#done")
    assert alice.snapshot() == before, "nothing was written or deleted"
    alice.set_ref("keys", bytes.fromhex(old_keys))
    ok("keys from a newer version open the vault read-only, and stop cleanup")

    # --- a newer vault format: read-only; cleanup still runs, as it only follows the tree
    lock(page)
    unlock(page)
    expect(page.locator("#read-only-warning")).to_have_count(0)
    old_vault = page.evaluate(REWRITE, {"ref": "vault", "recoveryKey": recovery_key, "version": 3})
    lock(page)
    unlock(page)
    expect(page.locator("#read-only-warning")).to_be_visible()
    expect(page.locator(f"li[data-entry='{markup}']")).to_be_visible()
    before = alice.snapshot()
    save_new_entry(page, "In a newer vault")
    expect(page.locator(".banner.error")).to_contain_text("read-only")
    page.click("text=Cancel")
    assert alice.snapshot() == before, "nothing was written"
    current_vault = alice.ref("vault")
    page.click("#settings")
    page.click("#cleanup")
    page.wait_for_selector("#cleanup-report")
    expect(page.locator("#cleanup-report")).not_to_contain_text("newer version")
    page.click("#done")
    assert alice.ref("vault") == current_vault, "cleanup left the vault alone"
    lock(page)
    unlock(page)
    expect(page.locator("#read-only-warning")).to_be_visible()
    expect(page.locator(f"li[data-entry='{markup}']")).to_be_visible()
    alice.set_ref("vault", bytes.fromhex(old_vault))
    ok("a vault from a newer version opens read-only, and cleanup keeps everything it needs")

    # --- an interrupted vault creation (`keys` without `vault`) is completed on unlock
    bob_page = new_device(browser, f"http://bob.localhost:{port}").page
    create_vault(bob_page, backend.setup_token("user", "create", "bob"))
    bob = Store(backend, "bob")
    lost = bob.ref("vault")
    bob.delete_ref("vault")
    lock(bob_page)
    unlock(bob_page)
    expect(bob_page.locator("#rollback-warning")).to_have_count(0)
    assert bob.ref("vault") not in (None, lost), "a new empty vault was written"
    ok("an interrupted vault creation is completed on unlock")

    # --- two devices create the vault at once: one wins; the other joins with the winner's recovery key
    first = new_device(browser, f"http://first.localhost:{port}").page
    second = new_device(browser, f"http://second.localhost:{port}").page
    for device, token in [(first, backend.setup_token("user", "create", "carol")), (second, backend.setup_token("setup-token", "create", "carol"))]:
        device.goto(f"/#setup={token}")
        device.wait_for_selector("#create-passkey")
        create_passkey(device)
        device.check("#saved-recovery-key")
    winner_key = first.inner_text("#recovery-key").strip()
    first.click("#create-vault")
    first.wait_for_selector("#new-entry")
    second.click("#create-vault")
    expect(second.locator("#app")).to_contain_text("A vault already exists")
    second.click("text=Continue")
    second.click("#unlock")
    expect(second.locator("#app")).to_contain_text("isn't set up for the vault yet")
    second.fill("#recovery-key-input", winner_key)
    second.click("#unlock-recovery")
    second.wait_for_selector("#new-entry")
    lock(second)
    unlock(second)
    assert Store(backend, "carol").passkey_slots() == 2, "both devices' passkeys can unlock the winner's vault"
    ok("of two devices creating the vault at once, one wins; the other's passkey is set up with the recovery key")


if __name__ == "__main__":
    sys.exit(harness(run))
