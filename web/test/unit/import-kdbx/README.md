# KeePass import tests

- `vectors.json` holds test vectors for the primitives. They were generated from independent
  implementations: Python's `hashlib` (BLAKE2b), `argon2-cffi` (Argon2), `pycryptodome` (ChaCha20, Salsa20,
  AES for AES-KDF). Regenerate them with `python3 make_vectors.py > vectors.json` inside `nix-shell`.
- The container tests use the sample databases that ship with pykeepass (from the Nix store, not copied into
  this repository), and pykeepass itself as the reference reader.
- Like the module, everything here can be deleted once the import isn't needed anymore (web SPEC §8.5).
