# pw-mgr

A web-based password manager with end-to-end encryption.

- [e2ee-store](https://github.com/sashee/e2ee-store) is everything that isn't specific to this app: the Rust
  backend (passkey users and git-like per-user storage), the browser SDK (keys, encryption, saving, recovery,
  cleanup), and the NixOS module. It is pinned in `nix/e2ee-store.nix`.
- `web/` is the password manager, written in plain JavaScript and run entirely in the browser, on the SDK. See
  `web/SPEC.md`.

## Development

Everything is built with Nix (nixpkgs pinned in `nix/pkgs.nix`, e2ee-store in `nix/e2ee-store.nix`, no flake):

```sh
make check               # both packages and every check in the Nix sandbox (what CI runs)
make package             # result/ = the backend, result-2/ = the frontend's static files
```

`nix-build nix -A checks.<name>` runs one check: `web-unit`, `e2e-flows`, `e2e-settings`, `e2e-safety`,
`e2e-locking`, `e2e-import-kdbx`, `e2e-upgrade`, `vm`. Building the backend runs e2ee-store's Rust suite; its other checks run in its own repository.

For development, the Makefile enters the pinned dev shell (`shell.nix`) by itself. Nix builds the backend and
the SDK into `data/` (`make deps`, which every target below runs), and `web/public/sdk` links to the SDK:

```sh
make test                # frontend unit tests
make e2e                 # the browser tests
make run                 # backend on ./data/backend.sock, reachable at http://localhost:8080 via socat
make user NAME=alice     # create a user; open http://localhost:8080/#setup=<token>
make setup-token NAME=alice   # a new setup link for an existing user (e.g. another device)
```

Local settings are in `config.toml` (backend SPEC §10).

To work on e2ee-store at the same time, use a checkout of it instead of the pinned builds: `make -C ../e2ee-store
build`, then e.g. `make run BACKEND=../e2ee-store/backend/target/debug/backend SDK=../e2ee-store/sdk/src`.

To use the phone through the Android app (sashee/iroh-webview-app), run `make iroh` next to `make run`. It
exposes `./data/backend.sock` over iroh with a persistent identity (`./data/iroh-secret`) and prints the ticket
to paste into the app. The app has no address bar, so paste the setup token on the app's start screen.

## Deployment

`nix/module.nix` is a plain NixOS module (no flake, like sashee/monitoring-platform): the `pw-mgr` instance of
e2ee-store's module. The packages are built with the host's own nixpkgs:

```nix
imports = [ "${pw-mgr}/nix/module.nix" ];
services.pw-mgr.enable = true;
services.pw-mgr.settings.public_hosts = [ "pw.example.com" ];   # optional; backend SPEC §10
```

The backend listens on `/run/pw-mgr/backend.sock`. Only members of the `pw-mgr` group can connect, so whatever
exposes it (`iroh-uds-listen`, a reverse proxy) joins that group. The data is in `/var/lib/pw-mgr`. Run admin
commands as root through the wrapper, which switches to the service user: `sudo pw-mgr user create alice`.

`nix/tests/lib.nix` is the module's VM test (e2ee-store's, on the `pw-mgr` instance). It takes the machine as an
argument, so a host repository runs it against its own configuration. Here, `checks.vm` runs it on a minimal
machine.

## PoC status

Done:
- the whole backend
- the frontend:
  - setup link, then passkey with PRF, recovery key and vault
  - entries with copy buttons and a password generator
  - lock and unlock; a second device joining with the recovery key
  - Settings:
    - passkeys: add, set up, delete
    - add device (setup link)
    - replace the recovery key
    - cleanup with a report, also run automatically once a day
  - rollback warning
  - "changed on another device" notice

Not yet:
- KeePass import
