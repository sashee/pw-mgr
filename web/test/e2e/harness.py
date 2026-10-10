"""Shared end-to-end harness: the real backend behind socat (as the iroh shim reaches it) and Chromium with
virtual authenticators that support PRF. Used by the test_*.py scripts next to it."""

import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import dataclass

from playwright.sync_api import expect, sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BINARY = os.environ.get("BACKEND_BIN", os.path.join(ROOT, "backend", "target", "debug", "backend"))
STATIC = os.path.join(ROOT, "web", "public")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(condition, what: str, seconds: float = 30) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.05)
    raise TimeoutError(f"{what} within {seconds}s")


def healthy(port: int) -> bool:
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{port}/healthz", headers={"Host": f"localhost:{port}"})
        with urllib.request.urlopen(request, timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


class Backend:
    def __init__(self, work: str):
        self.env = {
            **os.environ,
            "BACKEND_SOCKET": os.path.join(work, "backend.sock"),
            "BACKEND_DATABASE": os.path.join(work, "backend.sqlite3"),
            "BACKEND_STATIC_DIR": STATIC,
        }
        self.database = self.env["BACKEND_DATABASE"]
        self.config = ["--config", os.path.join(work, "none.toml")]

    def cli(self, *args: str) -> str:
        return subprocess.run([BINARY, *self.config, *args], env=self.env, check=True, capture_output=True, text=True).stdout

    def setup_token(self, *args: str) -> str:
        return re.search(r"#setup=(\S+)", self.cli(*args)).group(1)

    def blob_contents(self) -> list[bytes]:
        with sqlite3.connect(self.database) as db:
            return [row[0] for row in db.execute("SELECT content FROM blobs")]


# Like the Android app's WebAuthn: PRF is enabled at registration, but its output only comes at sign-in.
NO_PRF_AT_CREATE = """
(() => {
  const create = navigator.credentials.create.bind(navigator.credentials);
  navigator.credentials.create = async (options) => {
    const credential = await create(options);
    const results = credential.getClientExtensionResults.bind(credential);
    credential.getClientExtensionResults = () => ({ ...results(), prf: { enabled: true } });
    if (credential.toJSON) {
      const toJSON = credential.toJSON.bind(credential);
      credential.toJSON = () => ({ ...toJSON(), clientExtensionResults: { prf: { enabled: true } } });
    }
    return credential;
  };
})();
"""


AUTHENTICATOR = {
    "protocol": "ctap2",
    "ctap2Version": "ctap2_1",
    "transport": "internal",
    "hasResidentKey": True,
    "hasUserVerification": True,
    "isUserVerified": True,
    "hasPrf": True,
}


@dataclass
class Device:
    """A browser profile with its own platform authenticator that supports PRF."""

    page: object
    sent: list
    cdp: object
    authenticator: str
    committed: list  # vault blob IDs this device committed (successful writes of the `vault` ref)

    def replace_authenticator(self) -> None:
        """Swaps in a new, empty authenticator: like losing the old security key and using a new one."""
        self.cdp.send("WebAuthn.removeVirtualAuthenticator", {"authenticatorId": self.authenticator})
        self.authenticator = self.cdp.send("WebAuthn.addVirtualAuthenticator", {"options": AUTHENTICATOR})["authenticatorId"]


def new_device(browser, base: str, prf_at_create: bool = True) -> Device:
    context = browser.new_context(base_url=base)
    if not prf_at_create:
        context.add_init_script(NO_PRF_AT_CREATE)
    context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
    page = context.new_page()
    page.on("dialog", lambda dialog: dialog.accept())
    cdp = context.new_cdp_session(page)
    cdp.send("WebAuthn.enable")
    authenticator = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": AUTHENTICATOR})["authenticatorId"]
    sent: list[bytes] = []
    page.on("request", lambda request: sent.append(request.post_data_buffer or b"") if "/api/v1/" in request.url else None)
    committed: list[str] = []

    def record_commit(response) -> None:
        if response.request.method == "PUT" and response.url.endswith("/api/v1/refs/vault") and response.status in (200, 201):
            committed.append(json.loads(response.request.post_data)["blob"])

    page.on("response", record_commit)
    return Device(page, sent, cdp, authenticator, committed)


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


def harness(run, extra_env: dict | None = None) -> int:
    """Starts the backend and the shim, runs `run(browser, backend, port)`, and stops everything."""
    work = tempfile.mkdtemp()
    backend = Backend(work)
    backend.env.update(extra_env or {})
    port = free_port()
    log_path = os.path.join(work, "server.log")
    with open(log_path, "w") as log:
        backend.cli("user", "list")  # creates and migrates the database
        server = subprocess.Popen([BINARY, *backend.config, "serve"], env=backend.env, stdout=log, stderr=log)
        wait_for(lambda: os.path.exists(backend.env["BACKEND_SOCKET"]), "the socket to appear")
        shim = subprocess.Popen(["socat", f"TCP-LISTEN:{port},bind=127.0.0.1,fork,reuseaddr", f"UNIX-CONNECT:{backend.env['BACKEND_SOCKET']}"], stderr=subprocess.DEVNULL)
    failed = False
    try:
        wait_for(lambda: healthy(port), "the backend answering through socat")
        with sync_playwright() as playwright:
            # No sandbox: Chromium's needs user namespaces, which the Nix build sandbox doesn't offer.
            browser = playwright.chromium.launch(executable_path=shutil.which("chromium"), args=["--no-sandbox", "--disable-dev-shm-usage"])
            try:
                run(browser, backend, port)
            finally:
                browser.close()
    except Exception:
        failed = True
        raise
    finally:
        shim.terminate()
        server.terminate()
        server.wait(timeout=10)
        if failed:
            print("--- backend log ---\n" + open(log_path).read(), flush=True)
    assert not os.path.exists(backend.env["BACKEND_SOCKET"]), "the socket is removed on shutdown"
    print("passed")
    return 0
