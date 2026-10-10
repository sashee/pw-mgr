import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { blake2b } from "../../../public/js/import-kdbx/blake2b.js";
import { argon2 } from "../../../public/js/import-kdbx/argon2.js";

// Generated from Python's hashlib, argon2-cffi and pycryptodome (see web/test/unit/import-kdbx/README.md).
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const fromHex = (text) => new Uint8Array(Buffer.from(text, "hex"));

test("BLAKE2b matches hashlib", () => {
  for (const v of vectors.blake2b) assert.equal(hex(blake2b(new TextEncoder().encode(v.input), v.outlen)), v.hex, `${v.input.slice(0, 10)}/${v.outlen}`);
});

test("Argon2d, Argon2i and Argon2id match argon2-cffi", () => {
  for (const v of vectors.argon2) {
    const out = argon2({ type: v.type, password: fromHex(v.password), salt: fromHex(v.salt), iterations: v.t, memoryKiB: v.m_kib, parallelism: v.p, outlen: v.outlen });
    assert.equal(hex(out), v.hex, `argon2${v.type} t=${v.t} m=${v.m_kib} p=${v.p} outlen=${v.outlen}`);
  }
});

test("Argon2 with a secret and associated data matches RFC 9106 §5", () => {
  const params = { password: new Uint8Array(32).fill(1), salt: new Uint8Array(16).fill(2), secret: new Uint8Array(8).fill(3), ad: new Uint8Array(12).fill(4), iterations: 3, memoryKiB: 32, parallelism: 4, outlen: 32 };
  assert.equal(hex(argon2({ ...params, type: "d" })), "512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb");
  assert.equal(hex(argon2({ ...params, type: "i" })), "c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8");
  assert.equal(hex(argon2({ ...params, type: "id" })), "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
});

import { chacha20, chacha20Stream } from "../../../public/js/import-kdbx/chacha20.js";
import { salsa20Stream } from "../../../public/js/import-kdbx/salsa20.js";
import { aesKdf } from "../../../public/js/import-kdbx/aes-kdf.js";
import { keyFromFile, KeyFileError } from "../../../public/js/import-kdbx/keyfile.js";

test("ChaCha20 matches pycryptodome, including RFC 8439's example", () => {
  for (const v of vectors.chacha20) assert.equal(hex(chacha20(fromHex(v.key), fromHex(v.nonce), fromHex(v.plaintext), v.counter)), v.hex);
  // The keystream continues across calls of any size.
  const v = vectors.chacha20[1];
  const stream = chacha20Stream(fromHex(v.key), fromHex(v.nonce));
  const pieces = [1, 63, 64, 65, 7, 100].map((n) => stream.next(n));
  assert.equal(pieces.map(hex).join(""), v.hex);
});

test("Salsa20 with KeePass's inner-stream nonce matches pycryptodome", () => {
  const v = vectors.salsa20[0];
  const stream = salsa20Stream(fromHex(v.key), fromHex(v.nonce));
  assert.equal([3, 61, 70, 66].map((n) => hex(stream.next(n))).join(""), v.hex);
});

test("AES-KDF matches repeated AES-256-ECB", async () => {
  for (const v of vectors.aeskdf) assert.equal(hex(await aesKdf(fromHex(v.key), fromHex(v.seed), v.rounds)), v.hex, `${v.rounds} rounds`);
});

test("key files: XML 1.0 and 2.0, 32 bytes, 64 hex characters, anything else hashed", async () => {
  const key = new Uint8Array(32).map((_, i) => i * 7);
  const keyHex = Buffer.from(key).toString("hex").toUpperCase();
  const hash = (await crypto.subtle.digest("SHA-256", key)).slice(0, 4);
  const hashHex = Buffer.from(hash).toString("hex").toUpperCase();
  const xml1 = `<?xml version="1.0" encoding="utf-8"?>\n<KeyFile><Meta><Version>1.00</Version></Meta><Key><Data>${Buffer.from(key).toString("base64")}</Data></Key></KeyFile>`;
  const xml2 = (h) => `<?xml version="1.0" encoding="utf-8"?>\n<KeyFile>\n\t<Meta>\n\t\t<Version>2.0</Version>\n\t</Meta>\n\t<Key>\n\t\t<Data Hash="${h}">\n\t\t\t${keyHex.slice(0, 32).match(/.{8}/g).join(" ")}\n\t\t\t${keyHex.slice(32).match(/.{8}/g).join(" ")}\n\t\t</Data>\n\t</Key>\n</KeyFile>`;
  const enc = (text) => new TextEncoder().encode(text);
  assert.deepEqual(await keyFromFile(enc(xml1)), key);
  assert.deepEqual(await keyFromFile(enc(xml2(hashHex))), key);
  await assert.rejects(keyFromFile(enc(xml2("00000000"))), KeyFileError);
  assert.deepEqual(await keyFromFile(key), key);
  assert.deepEqual(await keyFromFile(enc(Buffer.from(key).toString("hex"))), key);
  const other = enc("just some file\n");
  assert.deepEqual(await keyFromFile(other), new Uint8Array(await crypto.subtle.digest("SHA-256", other)));
});
