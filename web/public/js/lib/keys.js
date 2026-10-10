// The keys document (SPEC §4.3): the master key wrapped once per passkey and once for the recovery key.
// Operations are pure: (doc, now) → doc.

import { aesGcmDecrypt, aesGcmEncrypt, b64urlDecode, b64urlEncode, hkdfAesKey, td, te } from "./crypto.js";

const KEK_INFO = { passkey: "pw-mgr/kek/passkey/v1", recovery: "pw-mgr/kek/recovery/v1" };
export const FORMAT = "pw-mgr/keys";
export const VERSION = 1;

export class WrongKeyError extends Error {
  constructor(kind) {
    super(kind === "recovery" ? "Wrong recovery key" : "This passkey's key doesn't unlock the vault");
    this.name = "WrongKeyError";
  }
}

const aad = (kind) => te.encode(`pw-mgr/keys/v1/${kind}`);

/** Both kinds of secret (a PRF output, the recovery key) and the master key are 32 random bytes. */
function check32(value, what) {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(`${what} must be 32 bytes`);
}

/** Wraps the master key with the KEK derived from `secret` (a PRF output or the recovery key). */
export async function wrap(kind, secret, masterKey, now) {
  check32(secret, "The key-encryption secret");
  check32(masterKey, "The master key");
  const kek = await hkdfAesKey(secret, KEK_INFO[kind]);
  const { nonce, ciphertext } = await aesGcmEncrypt(kek, masterKey, aad(kind));
  return { nonce: b64urlEncode(nonce), wrapped_key: b64urlEncode(ciphertext), created_at: new Date(now).toISOString() };
}

export async function unwrap(kind, secret, slot) {
  check32(secret, "The key-encryption secret");
  const kek = await hkdfAesKey(secret, KEK_INFO[kind]);
  try {
    return await aesGcmDecrypt(kek, b64urlDecode(slot.nonce), b64urlDecode(slot.wrapped_key), aad(kind));
  } catch {
    throw new WrongKeyError(kind);
  }
}

export const emptyKeys = () => ({ format: FORMAT, version: VERSION, recovery: null, passkeys: {} });

/** Returns the document, or throws if it isn't one. `writable` is false for newer versions. */
export function readKeys(doc) {
  if (doc?.format !== FORMAT || !Number.isInteger(doc.version) || typeof doc.passkeys !== "object" || doc.passkeys === null) {
    throw new Error("Not a keys document");
  }
  return { doc, writable: doc.version <= VERSION };
}

export const encodeKeys = (doc) => te.encode(JSON.stringify(doc));
export const decodeKeys = (data) => readKeys(JSON.parse(td.decode(data)));

export const setPasskey = (credentialId, slot) => (doc) => ({ ...doc, passkeys: { ...doc.passkeys, [credentialId]: slot } });

export const removePasskey = (credentialId) => (doc) => {
  const { [credentialId]: _removed, ...passkeys } = doc.passkeys;
  return { ...doc, passkeys };
};

export const setRecovery = (slot) => (doc) => ({ ...doc, recovery: slot });

/** Drops slots of passkeys the server no longer has. */
export const prune = (existingCredentialIds) => (doc) => ({
  ...doc,
  passkeys: Object.fromEntries(Object.entries(doc.passkeys).filter(([id]) => existingCredentialIds.includes(id))),
});
