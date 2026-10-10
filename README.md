# pw-mgr

A web-based password manager with end-to-end encryption.

- `backend/` is a generic Rust backend: passkey users and git-like per-user storage (blobs + refs). It has no
  password-manager code, so it can be moved out later. See `backend/SPEC.md`.
- `web/` is the password manager, written in plain JavaScript and run entirely in the browser. See `web/SPEC.md`.

## Development

Everything is built with Nix (nixpkgs pinned in `nix/pkgs.nix`, no flake):

```sh
make check               # both packages and every check in the Nix sandbox (what CI runs)
make package             # result/ = the backend, result-2/ = the frontend's static files
```

`nix-build nix -A checks.<name>` runs one check: `lint`, `web-unit`, `e2e-flows`, `e2e-settings`,
`e2e-import-kdbx`, `vm`. The Rust suite runs as part of building the backend.

For development, the Makefile enters the pinned dev shell (`shell.nix`) by itself:

```sh
make test                # backend + frontend unit tests, incremental
make e2e                 # the browser tests against a debug build
make run                 # backend on ./data/backend.sock, reachable at http://localhost:8080 via socat
make user NAME=alice     # create a user; open http://localhost:8080/#setup=<token>
make setup-token NAME=alice   # a new setup link for an existing user (e.g. another device)
```

Local settings are in `config.toml` (backend SPEC §10).

To use the phone through the Android app (sashee/iroh-webview-app), run `make iroh` next to `make run`. It
exposes `./data/backend.sock` over iroh with a persistent identity (`./data/iroh-secret`) and prints the ticket
to paste into the app. The app has no address bar, so paste the setup token on the app's start screen.

## Deployment

`nix/module.nix` is a plain NixOS module (no flake, like sashee/monitoring-platform). The packages are built with
the host's own nixpkgs:

```nix
imports = [ "${pw-mgr}/nix/module.nix" ];
services.pw-mgr.enable = true;
services.pw-mgr.settings.public_hosts = [ "pw.example.com" ];   # optional; backend SPEC §10
```

The backend listens on `/run/pw-mgr/backend.sock`. Only members of the `pw-mgr` group can connect, so whatever
exposes it (`iroh-uds-listen`, a reverse proxy) joins that group. The data is in `/var/lib/pw-mgr`. Run admin
commands as root through the wrapper, which switches to the service user: `sudo pw-mgr user create alice`.

`nix/tests/lib.nix` is the module's VM test. It takes the machine as an argument, so a host repository runs it
against its own configuration. Here, `checks.vm` runs it on a minimal machine.

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
