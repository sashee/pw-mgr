"""End-to-end: the KeePass import (web SPEC §8), with pykeepass as the reference reader.

1. Every sample database that ships with pykeepass, plus one generated here (recycle bin, extra URLs,
   protected custom field, attachment, history, notes over 64 KiB), is opened in Chromium with the import
   module. The resulting entries must match what pykeepass reads, mapped by the same rules.
2. One database is imported through the UI: preview counts, the import itself, and "Skip duplicates" on a
   second import.

Everything here is deleted together with the import module (web SPEC §8.5).

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_import_kdbx.py    # after `make deps`
"""

import base64
import os
import sys
import tempfile

from playwright.sync_api import expect
from pykeepass import PyKeePass, create_database

from harness import Backend, create_vault, harness, new_device

SAMPLES = os.environ["PYKEEPASS_TESTS"]
STANDARD = {"Title", "UserName", "Password", "URL", "Notes"}


def ok(text: str) -> None:
    print(f"  ok    {text}", flush=True)


def make_fixture(directory: str) -> str:
    """A database with what the samples lack. Written by pykeepass, read by both."""
    path = os.path.join(directory, "fixture.kdbx")
    kp = create_database(path, password="fixture password")
    email = kp.add_group(kp.add_group(kp.root_group, "Internet"), "Email")
    mail = kp.add_entry(email, "Mail", "me@example.com", "first-secret", url="https://mail.example.com", notes="line 1\nline 2")
    mail.set_custom_property("KP2A_URL_1", "https://mail2.example.com")
    mail.set_custom_property("KP2A_URL", "https://mail1.example.com")
    mail.set_custom_property("PIN", "1234", protect=True)
    mail.add_attachment(kp.add_binary(b"attached"), "hello.txt")
    mail.save_history()
    mail.password = "second-secret"
    kp.add_entry(kp.root_group, "Long notes", "u", "p", notes="é" * 40000)
    kp.add_entry(kp.root_group, "Ref", "{REF:U@I:00000000000000000000000000000000}", "pw")
    kp.trash_entry(kp.add_entry(kp.root_group, "Deleted", "u", "p"))
    kp.save()
    return path


def expected_entries(kp: PyKeePass) -> list[dict]:
    """The mapping of web SPEC §8.3, implemented independently on top of pykeepass."""
    recycle = kp.recyclebin_group
    out = []

    def walk(group, path):
        for e in group.entries:
            # Every string field, from pykeepass's (already unprotected) XML: custom_properties hides `otp`.
            fields = [(s.find("Key").text or "", s.find("Value").text or "") for s in e._element.findall("String")]
            custom = [(k, v) for k, v in fields if k not in STANDARD]
            extra_urls = sorted((kv for kv in custom if kv[0] == "KP2A_URL" or kv[0].startswith("KP2A_URL_")), key=lambda kv: int(kv[0].split("_")[-1]) if kv[0] != "KP2A_URL" else 0)
            lines = ([f"Group: {'/'.join(path)}"] if path else []) + [f"{k}: {v}" for k, v in custom if not (k == "KP2A_URL" or k.startswith("KP2A_URL_"))]
            notes = e.notes or ""
            if lines:
                notes = (notes + "\n\n" if notes else "") + "--- Imported from KeePass ---\n" + "\n".join(lines)
            if len(notes.encode()) > 64 * 1024:
                notes = None  # cut: compared by length below
            title = e.title or ""
            out.append({
                "title": title[:200] if title.strip() else "(untitled)",
                "username": e.username or "",
                "password": e.password or "",
                "urls": [u.strip() for u in [e.url or "", *(v for _, v in extra_urls)] if u and u.strip()],
                "notes": notes,
            })
        for g in group.subgroups:
            if recycle is not None and g.uuid == recycle.uuid:
                continue
            walk(g, path + [g.name])

    walk(kp.root_group, [])
    return out


# In the browser: the import module's pipeline, without the UI.
OPEN_IN_BROWSER = """async ({ file, password, keyFile }) => {
  const container = await import("/js/import-kdbx/container.js");
  const { keyFromFile } = await import("/js/import-kdbx/keyfile.js");
  const { runKdf } = await import("/js/import-kdbx/kdf.js");
  const { mapEntries } = await import("/js/import-kdbx/entries.js");
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const data = bytes(file);
  const header = container.readHeader(data);
  const key = await container.compositeKey(password, keyFile ? await keyFromFile(bytes(keyFile)) : null);
  const { xml, innerStream } = await container.decrypt(data, header, await runKdf(header.kdf, key));
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), "application/xml");
  let n = 0;
  const { entries, stats } = mapEntries(doc, await container.innerKeystream(innerStream), () => `id-${n++}`, 0);
  return { format: container.describe(header), entries, stats };
}"""


def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def compare(name, actual, expected):
    assert len(actual) == len(expected), f"{name}: {len(actual)} entries, pykeepass has {len(expected)}"
    for got, want in zip(actual, expected):
        for field in ["title", "username", "password", "urls"]:
            assert got[field] == want[field], f"{name} {want['title']!r}: {field} {got[field]!r} != {want[field]!r}"
        if want["notes"] is None:
            assert len(got["notes"].encode()) <= 64 * 1024, f"{name} {want['title']!r}: notes not cut"
        else:
            assert got["notes"] == want["notes"], f"{name} {want['title']!r}: notes {got['notes']!r} != {want['notes']!r}"


def run(browser, backend: Backend, port: int) -> None:
    device = new_device(browser, f"http://localhost:{port}")
    page = device.page
    create_vault(page, backend.setup_token("user", "create", "alice"))
    fixture = make_fixture(tempfile.mkdtemp())

    cases = [
        ("test3.kdbx", "password", "test3.key"),
        ("test4.kdbx", "password", "test4.key"),
        ("test4_aes.kdbx", "password", "test4.key"),
        ("test4_aeskdf.kdbx", "password", "test4.key"),
        ("test4_chacha20.kdbx", "password", "test4.key"),
        ("test4_hex.kdbx", "password", "test4_hex.key"),
        ("test4_keyx.kdbx", "password", "test4_keyx.keyx"),
        ("test4_chacha20_uncompressed.kdbx", "password", None),
        (fixture, "fixture password", None),
    ]
    for file, password, key_file in cases:
        path = file if os.path.isabs(file) else os.path.join(SAMPLES, file)
        key_path = os.path.join(SAMPLES, key_file) if key_file else None
        kp = PyKeePass(path, password=password, keyfile=key_path)
        result = page.evaluate(OPEN_IN_BROWSER, {"file": b64(path), "password": password, "keyFile": b64(key_path) if key_path else None})
        compare(os.path.basename(path), result["entries"], expected_entries(kp))
        ok(f"{os.path.basename(path)} ({result['format']}): {len(result['entries'])} entries match pykeepass")

    stats = page.evaluate(OPEN_IN_BROWSER, {"file": b64(fixture), "password": "fixture password", "keyFile": None})["stats"]
    assert stats == {"recycleBin": 1, "attachments": 1, "references": 1, "notesCut": ["Long notes"]}, stats
    ok("the fixture's recycle bin, attachment, reference and long notes are reported")

    # --- through the UI: preview, import, and nothing new on a second import
    def import_through_ui(expect_found, expect_duplicates, expect_button):
        page.click("#settings")
        page.click("#import-keepass")
        page.set_input_files("#kdbx-file", os.path.join(SAMPLES, "test4.kdbx"))
        page.fill("#kdbx-password", "password")
        page.set_input_files("#kdbx-keyfile", os.path.join(SAMPLES, "test4.key"))
        page.click("#kdbx-open")
        page.wait_for_selector("#kdbx-import, #kdbx-error:not(:empty)", timeout=60_000)
        expect(page.locator("#kdbx-format")).to_have_text("KDBX 4.0, Argon2d, ChaCha20")
        expect(page.locator("#kdbx-found")).to_have_text(f"Entries found: {expect_found}")
        expect(page.locator("#kdbx-duplicates")).to_contain_text(str(expect_duplicates))
        expect(page.locator("#kdbx-import")).to_have_text(expect_button)

    import_through_ui(15, 2, "Import 13 entries")  # test4.kdbx has two identical "foobar_entry" entries
    expect(page.locator("#kdbx-attachments")).to_contain_text("1")
    expect(page.locator("#kdbx-references")).to_contain_text("3")
    page.click("#kdbx-import")
    expect(page.locator("#notice")).to_contain_text("Imported 13 entries from KeePass")
    expect(page.locator("li[data-entry='Тест']")).to_be_visible()
    page.locator("li[data-entry='subentry'] button.entry").click()
    expect(page.locator("#detail")).to_contain_text("Group: foobar_group/subgroup")
    ok("importing through the UI: preview counts, 13 entries saved")

    import_through_ui(15, 15, "Nothing to import")
    expect(page.locator("#kdbx-import")).to_be_disabled()
    page.uncheck("#kdbx-skip-duplicates")
    expect(page.locator("#kdbx-import")).to_have_text("Import 15 entries")
    page.click("#import-cancel")
    ok("a second import finds everything already there")

    page.click("#settings")
    page.click("#import-keepass")
    page.set_input_files("#kdbx-file", os.path.join(SAMPLES, "test4_aeskdf.kdbx"))
    page.fill("#kdbx-password", "wrong")
    page.set_input_files("#kdbx-keyfile", os.path.join(SAMPLES, "test4.key"))
    page.click("#kdbx-open")
    expect(page.locator("#kdbx-error")).to_have_text("Wrong password or key file", timeout=30_000)
    page.set_input_files("#kdbx-file", os.path.join(SAMPLES, "test4_twofish.kdbx"))
    page.click("#kdbx-open")
    expect(page.locator("#kdbx-error")).to_contain_text("Twofish")
    page.click("#import-cancel")
    ok("wrong credentials and unsupported files are explained")

    # The module is loaded only when used: a fresh page load doesn't fetch it.
    fetched = []
    page.on("request", lambda r: fetched.append(r.url) if "/import-kdbx/" in r.url else None)
    page.reload()
    page.wait_for_selector("#unlock")
    assert fetched == [], fetched
    ok("the import module isn't loaded during normal use")


if __name__ == "__main__":
    sys.exit(harness(run))
