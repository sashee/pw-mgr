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
`e2e-import-kdbx`. The Rust suite runs as part of building the backend.

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
- deployment as a NixOS module
