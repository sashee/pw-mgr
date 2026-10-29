# pw-mgr

A web-based password manager with end-to-end encryption.

- [e2ee-store](https://github.com/sashee/e2ee-store) is everything that isn't specific to this app: the Rust
  backend (passkey users and git-like per-user storage), the browser SDK (keys, encryption, saving, recovery,
  cleanup), and the NixOS module. It is pinned in `nix/e2ee-store.nix`.
- `web/` is the password manager, written in plain JavaScript and run entirely in the browser, on the SDK. See
  `web/SPEC.md`.

## Development

Everything is built with Nix, no flake: nixpkgs from `nix/pkgs.nix` (the `nixos-26.05` branch, which hosts follow too;
they build with their own), and e2ee-store pinned in `nix/e2ee-store.nix`:

```sh
make check               # both packages and every check in the Nix sandbox (what CI runs)
make package             # result/ = the backend, result-2/ = the frontend's static files
```

`nix-build nix -A checks.<name>` runs one check: `web-unit`, `e2e-flows`, `e2e-settings`, `e2e-safety`,
`e2e-locking`, `e2e-import-kdbx`, `e2e-explorer`, `vm`, and e2ee-store's `e2ee-store-sdk-unit`, `e2ee-store-browser`
and `e2ee-store-vm-s3`, which this repository reruns with its own nixpkgs. Building the backend runs e2ee-store's Rust
suite. e2ee-store's lint stays in its own repository, and its instance test is `vm` here, on the `pw-mgr` instance.

For development, the Makefile enters the dev shell (`shell.nix`) by itself. Nix builds the backend and
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

`nix/module.nix` is a plain NixOS module (no flake, like sashee/monitoring-platform), with the backend from the
e2ee-store version it pins. The packages are built with the host's own nixpkgs:

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

A host repository runs every check, with its own nixpkgs and its machine for the VM tests:
`import "${pw-mgr}/nix/tests" { inherit pkgs; machineModules = [ <host config> ]; }` gives one derivation per
check: pw-mgr's (`vm`, `web-unit`, `e2e-*`) and the e2ee-store ones it reruns (`e2ee-store-*`).

## PoC status

Done:
- the whole backend (e2ee-store's)
- the frontend:
  - setup link, then passkey with PRF, recovery key and vault
  - entries with search, copy buttons and a password generator
  - each entry's earlier versions (up to 10), to look at and restore
  - the vault's earlier versions, kept as `vault@<revision>` files (up to 19)
  - lock and unlock, also after 15 minutes without input; a second device joining with the recovery key
  - KeePass import: `.kdbx` 3.1 and 4.x, with a password, a key file or both, decrypted in the browser
  - Settings:
    - passkeys: add, set up, delete
    - add device (setup link)
    - replace the recovery key
    - cleanup with a report, also run automatically once a day
    - a read-only explorer of the files as they are stored
  - rollback warning
  - "changed on another device" notice

Not yet (`web/SPEC.md` §13): other imports (Bitwarden, CSV) and export, a "recently deleted" view built on the
vault's earlier versions, master key rotation, TOTP, attachments, folders or tags, and an offline read-only cache.
