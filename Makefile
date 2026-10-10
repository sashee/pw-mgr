SHELL := bash

# Two kinds of targets:
# - hermetic ones (check, package) go through nix-build (nix/default.nix), in the Nix sandbox;
# - the development loop (test, e2e, run, …) runs inside the pinned nix shell (shell.nix). --pure keeps host
#   libraries out of Chromium's way. Already inside `nix-shell`? Then the commands run directly.
ifdef IN_NIX_SHELL
RUN := bash -c
else
RUN := nix-shell --pure shell.nix --run
endif
NIX_BUILD := nix-build --max-jobs auto

BACKEND := backend/target/debug/backend
PORT ?= 8080

.PHONY: all check package test test-backend test-web lint fmt build e2e run iroh user setup-token clean

# Everything, hermetic: both packages, lint, the Rust suite, the frontend's unit tests and the browser tests,
# in the Nix sandbox. This is what CI runs.
all: check

check:
	$(NIX_BUILD) nix --no-out-link

# Just the packages (building the backend still runs the Rust suite). result/ and result-2/ link to them.
package:
	$(NIX_BUILD) nix -A backend -A web

# ---------------------------------------------------------------- development loop (incremental, dev shell)

test: test-backend test-web

test-backend:
	$(RUN) 'cd backend && cargo test'

test-web:
	$(RUN) 'node --test "web/test/unit/**/*.test.js"'

lint:
	$(RUN) 'cd backend && cargo fmt --check && cargo clippy --all-targets -- -D warnings'

fmt:
	$(RUN) 'cd backend && cargo fmt'

build:
	$(RUN) 'cd backend && cargo build'

# The real backend behind socat, driven by Chromium with a PRF-capable virtual authenticator.
e2e: build
	$(RUN) 'BACKEND_BIN=$(BACKEND) python3 web/test/e2e/test_flows.py && BACKEND_BIN=$(BACKEND) python3 web/test/e2e/test_settings.py && BACKEND_BIN=$(BACKEND) python3 web/test/e2e/test_import_kdbx.py'

# Local development: the backend on ./data/backend.sock (config.toml), reachable at
# http://localhost:$(PORT) through socat, the way the iroh shim reaches it.
run: build
	$(RUN) 'dev/run.sh $(PORT)'

# Exposes ./data/backend.sock over iroh for the Android app; run it next to `make run`. Prints the
# ticket to paste into the app.
iroh:
	nix-build nix/iroh-ssh.nix -o data/iroh-ssh
	dev/iroh.sh

# make user NAME=alice — prints a setup token; open http://localhost:$(PORT)/#setup=<token>
user:
	$(RUN) '$(BACKEND) user create $(NAME)'

# make setup-token NAME=alice — a new token for an existing user (e.g. a second device)
setup-token:
	$(RUN) '$(BACKEND) setup-token create $(NAME)'

clean:
	$(RUN) 'cd backend && cargo clean'
