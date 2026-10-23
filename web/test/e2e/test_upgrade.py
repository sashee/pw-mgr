"""End-to-end, transitional (web SPEC §7.5): a vault from before the stream format is rewritten in it when it is
unlocked, its history included, and cleanup then removes the old blobs. Goes with the upgrade, once every vault is
upgraded.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_upgrade.py    # after `make deps`
"""

import sqlite3
import sys

from playwright.sync_api import expect

from harness import Backend, add_entry, create_vault, harness, lock, new_device, unlock

# Writes the vault again as three versions in the format before streams (e2ee-store SDK SPEC §3.5), the way the app
# wrote them then: the newest with the two others as its history, each with one entry more. Returns their blob IDs,
# newest first. The format is rebuilt here from the SDK's primitives, as the SDK only reads it now.
DOWNGRADE = """
async ({ recoveryKey }) => {
  const { labels } = await import("/sdk/labels.js");
  const { decodeKeys, unwrap } = await import("/sdk/keys.js");
  const { contentKey, openDocument } = await import("/sdk/envelope.js");
  const { aesGcmEncrypt, hexDecode, hkdfAesKey, te } = await import("/sdk/crypto.js");
  const api = await import("/sdk/api.js");
  const L = labels("pw-mgr");
  const keys = decodeKeys(L, await api.getBlob(await api.getRef("keys"))).doc;
  const masterKey = await unwrap(L, "recovery", hexDecode(recoveryKey), keys.recovery);
  const legacyKey = await hkdfAesKey(masterKey, L.content);
  const seal = async (doc) => {
    const json = te.encode(JSON.stringify(doc));
    const padded = new Uint8Array(Math.ceil(json.length / 4096) * 4096).fill(0x20);
    padded.set(json);
    const { nonce, ciphertext } = await aesGcmEncrypt(legacyKey, padded, te.encode(L.vault));
    const blob = new Uint8Array(nonce.length + ciphertext.length);
    blob.set(nonce);
    blob.set(ciphertext, nonce.length);
    return api.putBlob(blob);
  };
  const current = await api.getRef("vault");
  const doc = await openDocument(await contentKey(L, masterKey), L.vault, await api.getBlob(current));
  const ids = [];
  for (let n = 1; n <= doc.entries.length; n++) {
    ids.unshift(await seal({ ...doc, revision: doc.revision + n, entries: doc.entries.slice(0, n), history: [...ids] }));
  }
  if (!(await api.putRef("vault", ids[0], current)).ok) throw new Error("the vault ref changed");
  return ids;
}
"""

# The current vault and its history, opened in the stream format. → [[revision, number of entries], …], newest first.
READ_STREAM = """
async ({ recoveryKey }) => {
  const { labels } = await import("/sdk/labels.js");
  const { decodeKeys, unwrap } = await import("/sdk/keys.js");
  const { contentKey, openDocument } = await import("/sdk/envelope.js");
  const { hexDecode } = await import("/sdk/crypto.js");
  const api = await import("/sdk/api.js");
  const L = labels("pw-mgr");
  const keys = decodeKeys(L, await api.getBlob(await api.getRef("keys"))).doc;
  const key = await contentKey(L, await unwrap(L, "recovery", hexDecode(recoveryKey), keys.recovery));
  const open = async (id) => openDocument(key, L.vault, await api.getBlob(id));
  const current = await open(await api.getRef("vault"));
  const versions = [current, ...(await Promise.all(current.history.map(open)))];
  return versions.map((doc) => [doc.revision, doc.entries.length]);
}
"""


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


def blob_ids(backend: Backend) -> set[str]:
    with sqlite3.connect(backend.database) as conn:
        return {row[0] for row in conn.execute("SELECT lower(hex(id)) FROM blobs")}


def vault_ref(backend: Backend) -> str:
    with sqlite3.connect(backend.database) as conn:
        return conn.execute("SELECT lower(hex(blob_id)) FROM refs WHERE name = 'vault'").fetchone()[0]


def run(browser, backend: Backend, port: int) -> None:
    page = new_device(browser, f"http://localhost:{port}").page
    recovery_key = create_vault(page, backend.setup_token("user", "create", "alice"))
    for title in ["First", "Second", "Third"]:
        add_entry(page, title)
    old = page.evaluate(DOWNGRADE, {"recoveryKey": recovery_key})
    assert vault_ref(backend) == old[0]

    # --- unlocking upgrades: the same entries, a new revision, and the history rewritten
    lock(page)
    unlock(page)
    for title in ["First", "Second", "Third"]:
        expect(page.locator(f"li[data-entry='{title}']")).to_be_visible()
    expect(page.locator(".banner.error")).to_have_count(0)
    upgraded = vault_ref(backend)
    assert upgraded not in old, "the vault ref moved to an upgraded blob"
    versions = page.evaluate(READ_STREAM, {"recoveryKey": recovery_key})
    revision = versions[1][0]
    assert versions == [[revision + 1, 3], [revision, 3], [revision - 1, 2], [revision - 2, 1]], versions
    ok("unlocking rewrote the vault and its history in the stream format, with the same entries")

    # --- the next unlock has nothing to upgrade, and saving works as before
    lock(page)
    unlock(page)
    assert vault_ref(backend) == upgraded, "nothing was upgraded again"
    expect(page.locator(".banner.error")).to_have_count(0)
    add_entry(page, "Fourth")
    ok("after the upgrade, unlocking changes nothing and saving works")

    # --- cleanup removes the blobs of the old format once they are past the grace period
    with sqlite3.connect(backend.database) as conn:
        conn.execute("UPDATE blobs SET created_at = created_at - 2 * 24 * 3600 * 1000")
    page.click("#settings")
    page.click("#cleanup")
    page.wait_for_selector("#cleanup-report")
    remaining = blob_ids(backend)
    assert not set(old) & remaining, "the old-format blobs are deleted"
    lock(page)
    unlock(page)
    expect(page.locator("li[data-entry='Fourth']")).to_be_visible()
    ok("cleanup deleted the old-format blobs, and the vault still opens")


if __name__ == "__main__":
    sys.exit(harness(run))
