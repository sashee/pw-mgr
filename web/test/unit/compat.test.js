import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { b64urlDecode, hexEncode, hkdfBytes } from "../../public/sdk/crypto.js";
import { contentKey, openDocument } from "../../public/sdk/envelope.js";
import { decodeKeys, encodeKeys, unwrap } from "../../public/sdk/keys.js";
import { LABELS } from "../../public/js/flows.js";
import { readVault } from "../../public/js/lib/vault.js";

// The keys as the app wrote them before its crypto moved into the SDK (master key 0x11…, PRF output 0x22… for
// "cred-1", recovery key 0x33…), and its vault as the upgrade to the stream format rewrote it, made from the SDK SPEC
// with node:crypto alone (salt 0x05…). Existing vaults must keep opening, so the labels can never change.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/vault.json", import.meta.url)));
const bytes = (value) => new Uint8Array(32).fill(value);

test("existing vaults still open", async () => {
  const keys = decodeKeys(LABELS, encodeKeys(fixture.keys));
  assert.equal(keys.writable, true);
  const masterKey = await unwrap(LABELS, "passkey", bytes(0x22), keys.doc.passkeys["cred-1"]);
  assert.deepEqual(masterKey, bytes(0x11));
  assert.deepEqual(await unwrap(LABELS, "recovery", bytes(0x33), keys.doc.recovery), bytes(0x11));
  const vault = readVault(await openDocument(await contentKey(LABELS, masterKey), LABELS.vault, b64urlDecode(fixture.vault)));
  assert.equal(vault.doc.entries[0].password, "hunter2");
  assert.equal(hexEncode(await hkdfBytes(masterKey, LABELS.stateId, 16)), fixture.stateId, "the device state stays where it was");
});

test("the PRF input is unchanged, so passkeys keep giving the same key", () => {
  assert.equal(LABELS.prf, "pw-mgr/prf/v1");
});
