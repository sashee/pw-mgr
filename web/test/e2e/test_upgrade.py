"""End-to-end, transitional (web SPEC §7.5): a vault from before the tree is rewritten as one when it is unlocked, its
history becoming snapshots, and cleanup then removes the old blobs. Goes with the upgrade, once every vault is upgraded.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_upgrade.py    # after `make deps`
"""

import sqlite3
import sys

from playwright.sync_api import expect

from harness import Backend, add_entry, create_vault, harness, lock, new_device, unlock

# The SDK's flows in the page, unlocked with the recovery key.
SESSION = """
  const { makeFlows } = await import("/sdk/flows.js");
  const { labels } = await import("/sdk/labels.js");
  const { hexDecode, te, td } = await import("/sdk/crypto.js");
  const L = labels("pw-mgr");
  const flows = makeFlows({ labels: L });
  const session = await flows.unlockWithRecoveryKey(await flows.loadKeys(), hexDecode(recoveryKey));
  const readJson = async (entry) => JSON.parse(td.decode(new Uint8Array(await new Response((await flows.read(session, entry)).stream).arrayBuffer())));
"""

# Writes the vault again as it was stored before the tree: three versions of the document, each a blob labelled
# `vault`, the newest listing the other two as its history, each with one entry more. Returns their blob IDs, newest first.
DOWNGRADE = (
    "async ({ recoveryKey }) => {"
    + SESSION
    + """
  const { seal } = await import("/sdk/stream.js");
  const api = await import("/sdk/api.js");
  const doc = await readJson((await flows.list(session, [])).find((e) => e.name === "vault"));
  const ids = [];
  for (let n = 1; n <= doc.entries.length; n++) {
    const old = { ...doc, version: 1, revision: session.root.revision + n, saved_at: new Date().toISOString(), entries: doc.entries.slice(0, n), history: [...ids] };
    ids.unshift(await api.putBlob(await seal(session.contentKey, L.vault, te.encode(JSON.stringify(old)))));
  }
  if (!(await api.putRef("vault", ids[0], session.root.blobId)).ok) throw new Error("the vault ref changed");
  return ids;
}"""
)

# The root directory's revision, and every file in it with its document.
TREE = (
    "async ({ recoveryKey }) => {"
    + SESSION
    + """
  const entries = await flows.list(session, []);
  return { revision: session.root.revision, files: await Promise.all(entries.map(async (e) => ({ name: e.name, id: e.id, doc: await readJson(e) }))) };
}"""
)


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


def db(backend: Backend):
    return sqlite3.connect(backend.database)


def vault_ref(backend: Backend) -> str:
    with db(backend) as conn:
        return conn.execute("SELECT lower(hex(blob_id)) FROM refs WHERE name = 'vault'").fetchone()[0]


def run(browser, backend: Backend, port: int) -> None:
    page = new_device(browser, f"http://localhost:{port}").page
    recovery_key = create_vault(page, backend.setup_token("user", "create", "alice"))
    for title in ["First", "Second", "Third"]:
        add_entry(page, title)
    revision = page.evaluate(TREE, {"recoveryKey": recovery_key})["revision"]
    old = page.evaluate(DOWNGRADE, {"recoveryKey": recovery_key})
    assert vault_ref(backend) == old[0]

    # --- unlocking upgrades: the same entries, the history as snapshots, and the revision going on from the old one
    lock(page)
    unlock(page)
    for title in ["First", "Second", "Third"]:
        expect(page.locator(f"li[data-entry='{title}']")).to_be_visible()
    expect(page.locator(".banner.error")).to_have_count(0)
    upgraded = vault_ref(backend)
    assert upgraded not in old, "the vault ref moved to a root directory"
    tree = page.evaluate(TREE, {"recoveryKey": recovery_key})
    assert tree["revision"] == revision + 4, tree["revision"]
    files = {f["name"]: f["doc"] for f in tree["files"]}
    assert sorted(files) == ["vault", f"vault@{revision + 1}", f"vault@{revision + 2}"], sorted(files)
    assert [len(files[name]["entries"]) for name in sorted(files)] == [3, 1, 2]
    assert files["vault"]["version"] == 2 and not {"revision", "saved_at", "history"} & set(files["vault"]), files["vault"].keys()
    ok("unlocking rewrote the vault as a tree: the same entries, and its history as snapshots")

    # --- the next unlock has nothing to upgrade, and saving keeps the replaced version as a snapshot
    lock(page)
    unlock(page)
    assert vault_ref(backend) == upgraded, "nothing was upgraded again"
    expect(page.locator(".banner.error")).to_have_count(0)
    add_entry(page, "Fourth")
    saved = page.evaluate(TREE, {"recoveryKey": recovery_key})
    names = sorted(f["name"] for f in saved["files"])
    assert f"vault@{revision + 4}" in names, names
    ok("after the upgrade, unlocking changes nothing, and a save keeps the version it replaced")

    # --- cleanup removes the blobs of the old layout once they are past the grace period
    with db(backend) as conn:
        conn.execute("UPDATE blobs SET created_at = created_at - 2 * 24 * 3600 * 1000")
    page.click("#settings")
    page.click("#cleanup")
    page.wait_for_selector("#cleanup-report")
    with db(backend) as conn:
        remaining = {row[0] for row in conn.execute("SELECT lower(hex(id)) FROM blobs")}
        refs = {row[0] for row in conn.execute("SELECT lower(hex(blob_id)) FROM refs")}
    assert not set(old) & remaining, "the old layout's blobs are deleted"
    assert remaining == refs | {f["id"] for f in saved["files"]}, "exactly the keys, the root and its files remain"
    lock(page)
    unlock(page)
    expect(page.locator("li[data-entry='Fourth']")).to_be_visible()
    ok("cleanup deleted the old layout's blobs, and the vault still opens")


if __name__ == "__main__":
    sys.exit(harness(run))
