// The vault blob (SPEC §4.2): nonce ‖ AES-256-GCM(content key, padded JSON) ‖ tag. Nothing else in clear.

import { aesGcmDecrypt, aesGcmEncrypt, hkdfAesKey, td, te } from "./crypto.js";

const AAD = te.encode("pw-mgr/vault/v1");
const BLOCK = 4096;
const NONCE = 12;

export const contentKey = (masterKey) => hkdfAesKey(masterKey, "pw-mgr/content/v1");

/** Pads with spaces to a multiple of 4096 bytes; JSON ignores trailing whitespace. */
export function pad(data) {
  const length = Math.max(BLOCK, Math.ceil(data.length / BLOCK) * BLOCK);
  const out = new Uint8Array(length).fill(0x20);
  out.set(data);
  return out;
}

export async function sealVault(key, doc) {
  const { nonce, ciphertext } = await aesGcmEncrypt(key, pad(te.encode(JSON.stringify(doc))), AAD);
  const out = new Uint8Array(NONCE + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, NONCE);
  return out;
}

/** Throws `DecryptError` if the blob doesn't decrypt with this key. */
export async function openVault(key, blob) {
  const plaintext = await aesGcmDecrypt(key, blob.subarray(0, NONCE), blob.subarray(NONCE), AAD);
  return JSON.parse(td.decode(plaintext));
}
