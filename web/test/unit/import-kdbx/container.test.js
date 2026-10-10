import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compositeKey, decrypt, describe, innerKeystream, KdbxError, readHeader } from "../../../public/js/import-kdbx/container.js";
import { keyFromFile } from "../../../public/js/import-kdbx/keyfile.js";
import { runKdf } from "../../../public/js/import-kdbx/kdf.js";

// pykeepass's sample databases (see README.md); `nix-shell` sets the path.
const DIR = process.env.PYKEEPASS_TESTS;
const read = (name) => new Uint8Array(readFileSync(join(DIR, name)));

/** Opens a database the way the import does: header, composite key, KDF, decryption. */
async function open(file, password, keyFile) {
  const bytes = read(file);
  const header = readHeader(bytes);
  const key = await compositeKey(password, keyFile ? await keyFromFile(read(keyFile)) : null);
  const { xml, innerStream } = await decrypt(bytes, header, await runKdf(header.kdf, key));
  return { header, xml: new TextDecoder().decode(xml), innerStream };
}

const CASES = [
  ["test3.kdbx", "password", "test3.key", "KDBX 3.1, AES-KDF, AES-256"],
  ["test4.kdbx", "password", "test4.key", "KDBX 4.0, Argon2d, ChaCha20"],
  ["test4_aes.kdbx", "password", "test4.key", "KDBX 4.0, Argon2d, AES-256"],
  ["test4_aeskdf.kdbx", "password", "test4.key", "KDBX 4.0, AES-KDF, AES-256"],
  ["test4_chacha20.kdbx", "password", "test4.key", "KDBX 4.0, Argon2d, ChaCha20"],
  ["test4_hex.kdbx", "password", "test4_hex.key", null],
  ["test4_keyx.kdbx", "password", "test4_keyx.keyx", null],
  ["test4_argon2id.kdbx", "password", null, "KDBX 4.0, Argon2id, AES-256"],
  ["test4_aes_uncompressed.kdbx", "password", null, null],
  ["test4_chacha20_uncompressed.kdbx", "password", null, null],
  ["test4_blankpass.kdbx", "", "test4.key", null],
];

for (const [file, password, keyFile, expected] of CASES) {
  test(`opens ${file}`, { skip: !DIR && "PYKEEPASS_TESTS isn't set" }, async () => {
    const { header, xml, innerStream } = await open(file, password, keyFile);
    if (expected) assert.equal(describe(header), expected);
    assert.match(xml, /^(﻿)?<\?xml/);
    assert.match(xml, /<KeePassFile>[\s\S]*<Root>[\s\S]*<\/KeePassFile>\s*$/);
    assert.ok(["Salsa20", "ChaCha20"].includes(innerStream.name), innerStream.name);
    await innerKeystream(innerStream);
  });
}

test("wrong credentials and unsupported files are reported as such", { skip: !DIR && "PYKEEPASS_TESTS isn't set" }, async () => {
  await assert.rejects(open("test4.kdbx", "wrong", "test4.key"), (e) => e instanceof KdbxError && e.kind === "credentials");
  await assert.rejects(open("test3.kdbx", "wrong", "test3.key"), (e) => e instanceof KdbxError && e.kind === "credentials");
  await assert.rejects(open("test4_blankpass.kdbx", null, "test4.key"), (e) => e.kind === "credentials", "an empty password is a key component");
  assert.throws(() => readHeader(read("test4_twofish.kdbx")), (e) => e.kind === "format" && /Twofish/.test(e.message));
  assert.throws(() => readHeader(new TextEncoder().encode("hello, this isn't a database")), (e) => e.kind === "format");
  const damaged = read("test4.kdbx");
  damaged[damaged.length - 100] ^= 1;
  await assert.rejects(
    (async () => {
      const header = readHeader(damaged);
      const key = await compositeKey("password", await keyFromFile(read("test4.key")));
      await decrypt(damaged, header, await runKdf(header.kdf, key));
    })(),
    (e) => e.kind === "damaged",
  );
});
