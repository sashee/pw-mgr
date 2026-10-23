import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { b64urlDecode, hexEncode, hkdfBytes, sha256Hex, td } from "../../public/sdk/crypto.js";
import { contentKey, openDocument } from "../../public/sdk/envelope.js";
import { decodeKeys, encodeKeys, unwrap } from "../../public/sdk/keys.js";
import { open } from "../../public/sdk/stream.js";
import { parseDir } from "../../public/sdk/tree.js";
import { LABELS } from "../../public/js/flows.js";
import { decodeVault, readVault } from "../../public/js/lib/vault.js";

// The keys as the app wrote them before its crypto moved into the SDK (master key 0x11…, PRF output 0x22… for
// "cred-1", recovery key 0x33…), and its vault in the SDK's tree: a root directory listing the file `vault`, made from
// the SDK SPEC with node:crypto alone (salts 0x06… and 0x07…). Existing vaults must keep opening, so the labels can
// never change.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/tree.json", import.meta.url)));
// Transitional (SPEC §7.5): the same vault before the tree, as one document in a blob labelled `vault`.
const legacy = JSON.parse(readFileSync(new URL("./fixtures/vault.json", import.meta.url)));
const bytes = (value) => new Uint8Array(32).fill(value);

async function masterKeyOf(keysDoc) {
  const keys = decodeKeys(LABELS, encodeKeys(keysDoc));
  assert.equal(keys.writable, true);
  const masterKey = await unwrap(LABELS, "passkey", bytes(0x22), keys.doc.passkeys["cred-1"]);
  assert.deepEqual(masterKey, bytes(0x11));
  assert.deepEqual(await unwrap(LABELS, "recovery", bytes(0x33), keys.doc.recovery), bytes(0x11));
  return masterKey;
}

test("existing vaults still open", async () => {
  const masterKey = await masterKeyOf(fixture.keys);
  const key = await contentKey(LABELS, masterKey);
  const root = parseDir(td.decode(await open(key, LABELS.dir, b64urlDecode(fixture.root))), { root: true });
  const [entry] = root.entries;
  assert.equal(entry.name, "vault");
  const file = b64urlDecode(fixture.file);
  assert.equal(await sha256Hex(file), entry.id);
  const plaintext = await open(key, LABELS.file, file, b64urlDecode(Buffer.from(entry.salt, "hex").toString("base64url")));
  assert.equal(await sha256Hex(plaintext), entry.sha256);
  const vault = readVault(decodeVault(plaintext));
  assert.equal(vault.doc.entries[0].password, "hunter2");
  assert.equal(hexEncode(await hkdfBytes(masterKey, LABELS.stateId, 16)), fixture.stateId, "the device state stays where it was");
});

test("a vault from before the tree still opens for the upgrade (transitional)", async () => {
  const masterKey = await masterKeyOf(legacy.keys);
  const vault = await openDocument(await contentKey(LABELS, masterKey), LABELS.vault, b64urlDecode(legacy.vault));
  assert.equal(vault.entries[0].password, "hunter2");
  assert.equal(vault.revision, 1);
});

test("the PRF input is unchanged, so passkeys keep giving the same key", () => {
  assert.equal(LABELS.prf, "pw-mgr/prf/v1");
});
