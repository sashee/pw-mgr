import { test } from "node:test";
import assert from "node:assert/strict";

import { aesGcmDecrypt, aesGcmEncrypt, b64urlDecode, b64urlEncode, DecryptError, hexDecode, hexEncode, hkdfAesKey, sha256Hex, te } from "../../public/js/lib/crypto.js";
import { contentKey, openVault, pad, sealVault } from "../../public/js/lib/envelope.js";
import { WrongKeyError, unwrap, wrap } from "../../public/js/lib/keys.js";

test("encodings round-trip and reject other alphabets", () => {
  const data = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255]);
  assert.equal(b64urlEncode(data), "AAH6-_z9_v8");
  assert.deepEqual(b64urlDecode("AAH6-_z9_v8"), data);
  assert.throws(() => b64urlDecode("AAH6+/z9"));
  assert.equal(hexEncode(data), "0001fafbfcfdfeff");
  assert.deepEqual(hexDecode("0001fafbfcfdfeff"), data);
  assert.throws(() => hexDecode("0001FA"));
  assert.throws(() => hexDecode("abc"));
});

test("sha256 matches the known answer", async () => {
  assert.equal(await sha256Hex(te.encode("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("HKDF derives the same key for the same inputs and different ones otherwise", async () => {
  const ikm = new Uint8Array(32).fill(1);
  const aad = te.encode("aad");
  const { nonce, ciphertext } = await aesGcmEncrypt(await hkdfAesKey(ikm, "info-a"), te.encode("secret"), aad);
  assert.equal(new TextDecoder().decode(await aesGcmDecrypt(await hkdfAesKey(ikm, "info-a"), nonce, ciphertext, aad)), "secret");
  await assert.rejects(aesGcmDecrypt(await hkdfAesKey(ikm, "info-b"), nonce, ciphertext, aad), DecryptError);
});

test("tampering with the nonce, ciphertext or AAD fails", async () => {
  const key = await hkdfAesKey(new Uint8Array(32), "k");
  const aad = te.encode("aad");
  const { nonce, ciphertext } = await aesGcmEncrypt(key, te.encode("secret"), aad);
  const flip = (a, i) => Uint8Array.from(a, (b, j) => (j === i ? b ^ 1 : b));
  await assert.rejects(aesGcmDecrypt(key, flip(nonce, 0), ciphertext, aad), DecryptError);
  await assert.rejects(aesGcmDecrypt(key, nonce, flip(ciphertext, 3), aad), DecryptError);
  await assert.rejects(aesGcmDecrypt(key, nonce, ciphertext, te.encode("other")), DecryptError);
});

test("the vault blob is padded to 4 KiB and round-trips", async () => {
  assert.equal(pad(new Uint8Array(1)).length, 4096);
  assert.equal(pad(new Uint8Array(4096)).length, 4096);
  assert.equal(pad(new Uint8Array(4097)).length, 8192);
  const key = await contentKey(new Uint8Array(32).fill(7));
  const doc = { format: "pw-mgr/vault", entries: [{ title: "ü" }] };
  const blob = await sealVault(key, doc);
  assert.equal(blob.length, 12 + 4096 + 16, "nonce, one padded block, tag");
  assert.deepEqual(await openVault(key, blob), doc);
  await assert.rejects(openVault(await contentKey(new Uint8Array(32)), blob), DecryptError);
});

test("keyslots unwrap only with the right secret and kind", async () => {
  const masterKey = new Uint8Array(32).fill(9);
  const prf = new Uint8Array(32).fill(3);
  const slot = await wrap("passkey", prf, masterKey, 0);
  assert.equal(slot.created_at, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(await unwrap("passkey", prf, slot), masterKey);
  await assert.rejects(unwrap("passkey", new Uint8Array(32), slot), WrongKeyError);
  await assert.rejects(unwrap("recovery", prf, slot), WrongKeyError, "the kind is bound through the AAD and the KEK");
});
