"""End-to-end: the real backend behind socat (as the iroh shim reaches it), Chromium with a virtual
authenticator that supports PRF, and the frontend's core path (e2ee-store/sdk/SPEC.md §6, web SPEC §7):

  setup link → passkey → recovery key → vault → entries, copy buttons, deleting → lock → unlock
  second device on another host: setup link → recovery key → its own passkey → same vault
  concurrent edits on both devices keep both changes

Also checks what the server sees: no PRF output in any request, and no plaintext in any stored blob.

    BACKEND_BIN=data/backend/bin/backend PYTHONPATH=data/sdk/share/e2ee-store/testing python web/test/e2e/test_flows.py    # after `make deps`
"""

import re
import sys

from playwright.sync_api import expect

from harness import Backend, add_entry, create_passkey, harness, new_device, unlock

SECRETS = ["s3cret-pa55word", "GitHub", "alice@example.com", "Second entry", "Third entry"]


def run(browser, backend: Backend, port: int) -> None:
    laptop = f"http://localhost:{port}"
    phone = f"http://phone.localhost:{port}"

    # --- first device: create the vault from the admin's setup link
    token = backend.setup_token("user", "create", "alice")
    laptop_device = new_device(browser, laptop)
    page, sent = laptop_device.page, laptop_device.sent
    page.goto(f"/#setup={token}")
    page.wait_for_selector("#create-passkey")
    assert "#setup" not in page.url, "the fragment is removed right away"
    laptop_needed_signin = create_passkey(page)
    recovery_key = page.inner_text("#recovery-key").strip()
    assert re.fullmatch(r"[0-9a-f]{64}", recovery_key), recovery_key
    expect(page.locator("#create-vault")).to_be_disabled()
    page.check("#saved-recovery-key")
    page.click("#create-vault")
    page.wait_for_selector("#new-entry")
    print(f"  ok    vault created from a setup link (PRF output {'at sign-in' if laptop_needed_signin else 'at registration'})")

    add_entry(page, "GitHub", "alice@example.com", "s3cret-pa55word", "https://github.com/login\njavascript:alert(1)")
    row = page.locator("li[data-entry='GitHub']")
    row.locator("button[data-copy='Copy password']").click()
    assert page.evaluate("navigator.clipboard.readText()") == "s3cret-pa55word"
    row.locator("button[data-copy='Copy username']").click()
    assert page.evaluate("navigator.clipboard.readText()") == "alice@example.com"
    row.locator("button.entry").click()
    expect(page.locator("#password")).to_have_text("••••••••")
    assert page.locator("#detail a").count() == 1, "only the http(s) URL is a link"
    print("  ok    entries are saved and the copy buttons copy")

    add_entry(page, "Throwaway")
    page.locator("li[data-entry='Throwaway'] button.entry").click()
    page.locator("#detail button", has_text="Delete").click()  # the harness accepts the confirmation
    expect(page.locator("li[data-entry='Throwaway']")).to_have_count(0)

    # --- lock and unlock with the passkey
    page.click("#lock")
    page.wait_for_selector("#unlock")
    unlock(page)
    expect(page.locator("li[data-entry='GitHub']")).to_be_visible()
    expect(page.locator("li[data-entry='Throwaway']")).to_have_count(0)
    print("  ok    a deleted entry stays deleted; locked, then unlocked with the passkey")

    # --- second device on another host: setup link + recovery key, then its own passkey
    phone_token = backend.setup_token("setup-token", "create", "alice")
    phone_device = new_device(browser, phone, prf_at_create=False)
    phone_page, phone_sent = phone_device.page, phone_device.sent
    phone_page.goto(f"/#setup={phone_token}")
    phone_page.fill("#recovery-key-input", recovery_key)
    phone_page.click("#unlock-recovery")
    phone_page.wait_for_selector("#create-passkey")
    assert create_passkey(phone_page), "without PRF output at registration, the app asks for one more prompt"
    phone_page.wait_for_selector("#new-entry")
    expect(phone_page.locator("li[data-entry='GitHub']")).to_be_visible()
    print("  ok    a second device on another host joins with the recovery key (PRF output at sign-in, like the Android app)")

    # --- both devices edit from the same version: the second save is re-applied, nothing is lost
    add_entry(phone_page, "Second entry", "bob")
    add_entry(page, "Third entry", "carol")
    phone_page.click("#lock")
    phone_page.wait_for_selector("#unlock")
    unlock(phone_page)
    for title in ["GitHub", "Second entry", "Third entry"]:
        expect(phone_page.locator(f"li[data-entry='{title}']")).to_be_visible()
    print("  ok    concurrent edits from two devices are both kept")

    # --- a wrong recovery key is refused
    wrong_token = backend.setup_token("setup-token", "create", "alice")
    other = new_device(browser, f"http://other.localhost:{port}").page
    # Pasted into the unlock screen, as on the Android app, which has no address bar.
    other.goto("/")
    other.fill("#setup-input", f"/#setup={wrong_token}")
    other.click("#use-setup")
    other.fill("#recovery-key-input", "0" * 64)
    other.click("#unlock-recovery")
    expect(other.locator(".banner")).to_contain_text("Wrong recovery key")
    print("  ok    a pasted setup link works; a wrong recovery key is refused")

    # --- what the server saw
    for body in sent + phone_sent:
        assert b'"results"' not in body, f"PRF output was sent to the server: {body[:200]!r}"
    blobs = backend.blob_contents()
    assert blobs, "blobs were stored"
    for blob in blobs:
        for secret in SECRETS:
            assert secret.encode() not in blob, f"{secret!r} is stored in plaintext"
    print(f"  ok    no PRF output reached the server; {len(blobs)} stored blobs contain no plaintext")


if __name__ == "__main__":
    sys.exit(harness(run))
