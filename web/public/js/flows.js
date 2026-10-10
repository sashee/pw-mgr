// The flows of SPEC §7, on top of the API, WebAuthn and the pure modules. No DOM here.
//
// A session is { masterKey, contentKey, keys: { doc, blobId, writable }, vault: { doc, blobId, writable } }.

import * as api from "./api.js";
import * as passkeys from "./passkeys.js";
import { UserFacingError } from "./passkeys.js";
import { randomBytes } from "./lib/crypto.js";
import { contentKey as deriveContentKey, openVault, sealVault } from "./lib/envelope.js";
import { decodeKeys, emptyKeys, encodeKeys, prune, removePasskey, setPasskey, setRecovery, unwrap, wrap } from "./lib/keys.js";
import { makeReport, planBlobs, prunableSlots } from "./lib/maintenance.js";
import { generateRecoveryKey } from "./lib/recovery-key.js";
import { saveWithRetry } from "./lib/save.js";
import { commit, newVault, readVault } from "./lib/vault.js";

const io = { putBlob: api.putBlob, putRef: api.putRef, getBlob: api.getBlob };
const now = () => Date.now();

export async function loadKeys() {
  const blobId = await api.getRef("keys");
  if (!blobId) return null;
  return { ...decodeKeys(await api.getBlob(blobId)), blobId };
}

async function decryptVault(contentKey, data) {
  try {
    return readVault(await openVault(contentKey, data));
  } catch (error) {
    throw new api.IntegrityError(`the vault doesn't decrypt (${error.message})`);
  }
}

const loadVault = async (contentKey, blobId) => ({ ...(await decryptVault(contentKey, await api.getBlob(blobId))), blobId });

/** Opens the vault with the master key; creates the empty vault if a creation was interrupted. */
export async function open(masterKey, keys) {
  const contentKey = await deriveContentKey(masterKey);
  const user = await api.me();
  const blobId = await api.getRef("vault");
  if (blobId) return { masterKey, contentKey, keys, user, vault: await loadVault(contentKey, blobId) };
  const doc = newVault(now());
  const created = await api.putBlob(await sealVault(contentKey, doc));
  const write = await api.putRef("vault", created, null);
  if (!write.ok) return open(masterKey, keys);
  return { masterKey, contentKey, keys, user, vault: { doc, blobId: created, writable: true } };
}

/** Step-up (backend SPEC §6.5): a passkey login creates a fresh session. PRF isn't needed for it. */
export async function reauthenticate() {
  const { options } = await api.loginStart();
  const { credential } = await passkeys.get(options);
  await api.loginFinish(credential);
}

/**
 * Logs in with a passkey and unlocks with its PRF output.
 * → { kind: "unlocked", session } | { kind: "no-vault" } | { kind: "no-slot", credentialId, prfOutput, keys }
 */
export async function unlockWithPasskey() {
  const { options } = await api.loginStart();
  const { credential, credentialId, prfOutput } = await passkeys.get(options);
  if (!prfOutput) throw new UserFacingError("This passkey can't unlock the vault: it doesn't support the PRF extension.");
  await api.loginFinish(credential);
  const keys = await loadKeys();
  if (!keys) return { kind: "no-vault" };
  const slot = keys.doc.passkeys[credentialId];
  if (!slot) return { kind: "no-slot", credentialId, prfOutput, keys };
  return { kind: "unlocked", session: await open(await unwrap("passkey", prfOutput, slot), keys) };
}

export async function unlockWithRecoveryKey(keys, recoveryKey) {
  if (!keys.doc.recovery) throw new UserFacingError("This vault has no recovery key.");
  return open(await unwrap("recovery", recoveryKey, keys.doc.recovery), keys);
}

/**
 * Registers a passkey on this host (SPEC §7.6 steps 1–4).
 * → { credentialId, prfOutput } where prfOutput is null if the browser only gives it at sign-in.
 */
export async function registerPasskey(name) {
  const { options } = await api.registerStart();
  const created = await passkeys.create(options);
  if (!created.prfEnabled) throw new UserFacingError("This authenticator can't unlock the vault: it doesn't support the PRF extension.");
  await api.registerFinish(name, created.credential);
  return { credentialId: created.credentialId, prfOutput: created.prfOutput };
}

/** Signs in with one particular passkey to get its PRF output (SPEC §7.6 step 5). */
export async function prfFromPasskey(credentialId) {
  const { options } = await api.loginStart();
  const signed = await passkeys.get(options, credentialId);
  if (!signed.prfOutput) throw new UserFacingError("The passkey didn't return a PRF output.");
  await api.loginFinish(signed.credential);
  return signed.prfOutput;
}

const saveKeys = async (session, operation) => {
  if (!session.keys.writable) throw new UserFacingError("The keys were written by a newer version of the app; update it first.");
  const saved = await saveWithRetry(io, {
    ref: "keys",
    loaded: session.keys,
    apply: (doc) => operation(doc, now()),
    encode: async (doc) => encodeKeys(doc),
    decode: async (data) => decodeKeys(data).doc,
  });
  return { ...session, keys: { doc: saved.doc, blobId: saved.blobId, writable: true } };
};

export const addPasskeySlot = async (session, credentialId, prfOutput) =>
  saveKeys(session, setPasskey(credentialId, await wrap("passkey", prfOutput, session.masterKey, now())));

export const removePasskeySlot = (session, credentialId) => saveKeys(session, removePasskey(credentialId));

export const replaceRecoveryKey = async (session, recoveryKey) =>
  saveKeys(session, setRecovery(await wrap("recovery", recoveryKey, session.masterKey, now())));

/** All blob metadata, page by page, with the server's clock from the last page. */
async function listAllBlobs() {
  const blobs = [];
  let page = await api.listBlobs();
  blobs.push(...page.blobs);
  while (page.next) {
    page = await api.listBlobs(page.next);
    blobs.push(...page.blobs);
  }
  return { blobs, serverNow: page.serverNow };
}

/**
 * Cleanup (SPEC §7.11): prunes slots of deleted passkeys, then deletes blobs that neither the current keys
 * nor the current vault (with its history) need. Never throws: failures end up in the report.
 * → { session, report }
 */
export async function maintain(session, trigger, onProgress = () => {}) {
  const startedAt = now();
  let current = session;
  let slotsRemoved = 0;
  let plan = null;
  const deleted = [];
  const failed = [];
  let error = null;
  try {
    onProgress("Checking passkeys");
    const passkeyIds = (await api.passkeys()).passkeys.map((p) => p.id);
    const stale = prunableSlots(current.keys.doc, passkeyIds);
    if (stale.length > 0) {
      current = await saveKeys(current, prune(passkeyIds));
      slotsRemoved = stale.length;
    }
    // Keep what the server has now, which may be newer than this session's copy.
    onProgress("Reading the current vault");
    const keysId = await api.getRef("keys");
    const vaultId = await api.getRef("vault");
    const vault = vaultId === current.vault.blobId ? current.vault : await loadVault(current.contentKey, vaultId);
    onProgress("Listing blobs");
    const { blobs, serverNow } = await listAllBlobs();
    plan = planBlobs({ keep: [keysId, vaultId, ...(vault.doc.history ?? [])], blobs, now: serverNow });
    for (const [index, blob] of plan.toDelete.entries()) {
      onProgress(`Deleting ${index + 1} of ${plan.toDelete.length}`);
      try {
        await api.deleteBlob(blob.id);
        deleted.push(blob);
      } catch (e) {
        if (e.status === 401) throw e;
        failed.push({ id: blob.id, error: e.message });
      }
    }
  } catch (e) {
    error = e.message ?? String(e);
  }
  return { session: current, report: makeReport({ trigger, startedAt, finishedAt: now(), slotsRemoved, plan, deleted, failed, error }) };
}

/** The secrets of a new vault. Nothing is stored until `createVault`. */
export const newSecrets = () => ({ masterKey: randomBytes(32), recoveryKey: generateRecoveryKey() });

/**
 * Creates the vault (SPEC §7.3): writing `keys` is the commit.
 * → { kind: "created", session } | { kind: "exists" } when another device got there first.
 */
export async function createVault({ masterKey, recoveryKey, credentialId, prfOutput }) {
  const t = now();
  const keysDoc = setRecovery(await wrap("recovery", recoveryKey, masterKey, t))(
    setPasskey(credentialId, await wrap("passkey", prfOutput, masterKey, t))(emptyKeys()),
  );
  const contentKey = await deriveContentKey(masterKey);
  const vaultDoc = newVault(t);
  const keysId = await api.putBlob(encodeKeys(keysDoc));
  const vaultId = await api.putBlob(await sealVault(contentKey, vaultDoc));
  if (!(await api.putRef("keys", keysId, null)).ok) return { kind: "exists" };
  const vaultWrite = await api.putRef("vault", vaultId, null);
  const keys = { doc: keysDoc, blobId: keysId, writable: true };
  if (!vaultWrite.ok) return { kind: "created", session: await open(masterKey, keys) };
  return { kind: "created", session: { masterKey, contentKey, keys, user: await api.me(), vault: { doc: vaultDoc, blobId: vaultId, writable: true } } };
}

/**
 * Saves a vault operation (SPEC §7.4); re-applied on top of other devices' changes.
 * → { session, base } where `base` is the vault document the operation was finally applied to.
 */
export async function saveVault(session, operation) {
  if (!session.vault.writable) throw new UserFacingError("This vault was written by a newer version of the app; it's read-only here.");
  const saved = await saveWithRetry(io, {
    ref: "vault",
    loaded: session.vault,
    apply: (doc, blobId) => commit(doc, operation, now(), blobId),
    encode: (doc) => sealVault(session.contentKey, doc),
    decode: async (data) => (await decryptVault(session.contentKey, data)).doc,
  });
  return { session: { ...session, vault: { doc: saved.doc, blobId: saved.blobId, writable: true } }, base: saved.previous.doc };
}
