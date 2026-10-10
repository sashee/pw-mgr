"""The password manager's browser-test helpers, on top of e2ee-store's harness (e2ee_store_harness, which
must be on PYTHONPATH). Used by the test_*.py scripts next to it."""

import os

import e2ee_store_harness
from e2ee_store_harness import Backend, Device, new_device  # noqa: F401 (used by the tests)
from playwright.sync_api import expect

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
# The app's static files with the SDK inside: web/public (with its sdk link) in development, the package in Nix.
STATIC = os.environ.get("STATIC_DIR", os.path.join(ROOT, "web", "public"))


def harness(run, extra_env: dict | None = None) -> int:
    return e2ee_store_harness.harness(run, STATIC, extra_env)


def create_passkey(page) -> bool:
    """Creates a passkey; returns whether the extra sign-in for the PRF output was needed."""
    page.click("#create-passkey")
    # Some authenticators only return PRF output at sign-in: then the app asks for one more prompt.
    page.wait_for_selector("#confirm-passkey, #recovery-key, #new-entry")
    if not page.is_visible("#confirm-passkey"):
        return False
    page.click("#confirm-passkey")
    return True


def add_entry(page, title: str, username: str = "", password: str = "", urls: str = "") -> None:
    page.click("#new-entry")
    page.fill("#title", title)
    page.fill("#username-input", username)
    page.fill("#password-input", password)
    page.fill("#urls", urls)
    page.click("#save")
    expect(page.locator(f"li[data-entry='{title}']")).to_be_visible()


def unlock(page) -> None:
    page.goto("/")
    page.click("#unlock")
    page.wait_for_selector("#new-entry")



def create_vault(page, token: str) -> str:
    """Opens a setup link on a fresh device, creates the vault and returns the recovery key."""
    page.goto(f"/#setup={token}")
    page.wait_for_selector("#create-passkey")
    create_passkey(page)
    recovery_key = page.inner_text("#recovery-key").strip()
    page.check("#saved-recovery-key")
    page.click("#create-vault")
    page.wait_for_selector("#new-entry")
    return recovery_key


def lock(page) -> None:
    page.click("#lock")
    page.wait_for_selector("#unlock")


def join(page, token: str, recovery_key: str) -> None:
    """A new device: pastes the setup token, enters the recovery key and creates its own passkey."""
    page.goto("/")
    page.fill("#setup-input", token)
    page.click("#use-setup")
    page.fill("#recovery-key-input", recovery_key)
    page.click("#unlock-recovery")
    page.wait_for_selector("#create-passkey")
    create_passkey(page)
    page.wait_for_selector("#new-entry")
