SHELL := bash

# Every target runs inside the pinned nix shell (shell.nix); --pure keeps host libraries out of
# Chromium's way. Already inside `nix-shell`? Then the commands run directly.
ifdef IN_NIX_SHELL
RUN := bash -c
else
RUN := nix-shell --pure shell.nix --run
endif

BACKEND := backend/target/debug/backend
PORT ?= 8080

.PHONY: all test test-backend test-web lint fmt build e2e run iroh user setup-token clean

# Everything that must pass, fastest first.
all: lint test e2e

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
