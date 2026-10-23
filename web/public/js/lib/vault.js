// The vault document (SPEC §6), its operations (SPEC §7.1), and how a save writes it into the SDK's tree (SPEC §5).
// Pure: no clock, no randomness, and no I/O but through the transaction the SDK passes in.

import { UserFacingError } from "../../sdk/passkeys.js";

export const FORMAT = "pw-mgr/vault";
/** 2: the vault is the file `vault` in the SDK's tree; its revision and history are the tree's (SPEC §5). */
export const VERSION = 2;
/** How many earlier versions of the vault are kept, as `vault@<revision>` files. */
export const HISTORY = 19;
const TITLE_MAX = 200;
const NOTES_MAX = 64 * 1024;

const iso = (ms) => new Date(ms).toISOString();

export const newVault = () => ({ format: FORMAT, version: VERSION, entries: [] });

/** Returns the document, or throws if it isn't one. `writable` is false for newer versions. */
export function readVault(doc) {
  if (doc?.format !== FORMAT || !Number.isInteger(doc.version) || !Array.isArray(doc.entries)) throw new Error("Not a vault document");
  return { doc, writable: doc.version <= VERSION };
}

export const encodeVault = (doc) => new TextEncoder().encode(JSON.stringify(doc));
export const decodeVault = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** Problems with an entry's fields, as messages; empty when it's valid. */
export function entryErrors(entry) {
  const errors = [];
  const title = entry.title ?? "";
  if (title.trim().length === 0) errors.push("A title is required");
  if ([...title].length > TITLE_MAX) errors.push(`The title can be at most ${TITLE_MAX} characters`);
  if (new TextEncoder().encode(entry.notes ?? "").length > NOTES_MAX) errors.push("Notes can be at most 64 KiB");
  if (!Array.isArray(entry.urls) || entry.urls.some((u) => typeof u !== "string")) errors.push("URLs must be text");
  return errors;
}

/** A new entry's shape; `id` comes from the caller (crypto.randomUUID). */
export const blankEntry = (id) => ({ id, title: "", username: "", password: "", urls: [], notes: "" });

/** Adds the entry or replaces the one with the same id. Unknown fields on the entry are kept. */
/** The fields a person edits; a change to any of them makes a new version of the entry. */
export const CONTENT_FIELDS = ["title", "username", "password", "urls", "notes"];
/** How many earlier versions an entry keeps (KeePass's default). */
export const ENTRY_HISTORY = 10;

const fieldValue = (entry, field) => JSON.stringify(entry[field] ?? (field === "urls" ? [] : ""));

/** The content fields that differ between two versions. */
export const changedFields = (older, newer) => CONTENT_FIELDS.filter((f) => fieldValue(older, f) !== fieldValue(newer, f));

/** Just the content fields of a version, e.g. to restore it. */
export const contentOf = (version) => Object.fromEntries(CONTENT_FIELDS.map((f) => [f, version[f] ?? (f === "urls" ? [] : "")]));

/** An entry as it was: everything but its id and its own history. */
const snapshot = ({ id: _id, history: _history, ...version }) => version;

/**
 * Adds the entry or replaces the one with the same id. Unknown fields on the entry are kept.
 * When the content changes, the previous version goes to the front of the entry's own `history` (at most
 * ENTRY_HISTORY). The history always comes from the vault this is applied to: the caller's copy may be stale.
 * Saving unchanged content changes nothing.
 */
export const upsertEntry = (entry) => (vault, now) => {
  const { history: _stale, ...fields } = entry;
  const existing = vault.entries.find((e) => e.id === entry.id);
  if (!existing) return { ...vault, entries: [...vault.entries, { ...fields, created_at: fields.created_at ?? iso(now), updated_at: iso(now) }] };
  if (changedFields(existing, fields).length === 0) return vault;
  const history = [snapshot(existing), ...(existing.history ?? [])].slice(0, ENTRY_HISTORY);
  const saved = { ...existing, ...fields, history, created_at: existing.created_at ?? iso(now), updated_at: iso(now) };
  return { ...vault, entries: vault.entries.map((e) => (e.id === entry.id ? saved : e)) };
};

export const deleteEntry = (id) => (vault) => ({ ...vault, entries: vault.entries.filter((e) => e.id !== id) });

export const sortEntries = (entries) => [...entries].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

/** Case-insensitive substring search over title, username, URLs and notes. */
export function searchEntries(entries, query) {
  const q = query.trim().toLowerCase();
  const matches = (e) => [e.title, e.username, ...(e.urls ?? []), e.notes].some((field) => (field ?? "").toLowerCase().includes(q));
  return sortEntries(q ? entries.filter(matches) : entries);
}

/** Only http(s) URLs become links, so a stored `javascript:` URL can never run. */
export function linkableUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function urlHost(text) {
  try {
    return new URL(text).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- in the tree (SPEC §5)

/** The vault's path in the tree; its earlier versions are next to it, as `vault@<revision>`. */
export const VAULT = ["vault"];
export const snapshotName = (revision) => `vault@${revision}`;
const snapshotRevision = (name) => {
  const match = /^vault@(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
};

/** The snapshots among a directory's entries beyond the newest `keep`, oldest first. */
export function staleSnapshots(entries, keep = HISTORY) {
  const snapshots = entries.filter((e) => snapshotRevision(e.name) !== null).sort((a, b) => snapshotRevision(a.name) - snapshotRevision(b.name));
  return snapshots.slice(0, Math.max(0, snapshots.length - keep));
}

/**
 * The steps of a save (SPEC §7.1): the vault the operation makes of the current one becomes `vault`, the current one is
 * kept as `vault@<revision>`, and snapshots beyond HISTORY go. An operation that changes nothing writes nothing. After a
 * conflict they run again on the newer tree, so the operation must make sense on any version of the vault.
 */
export const saveSteps = (operation, now) => [
  async (tx) => {
    const bytes = await tx.read(VAULT);
    const { doc, writable } = bytes === null ? { doc: newVault(), writable: true } : readVault(decodeVault(bytes));
    if (!writable) throw new UserFacingError("Another device saved this vault with a newer version of the app; update this one first.");
    const next = operation(doc, now);
    if (next === doc) return tx;
    const current = await tx.entry(VAULT);
    const kept = current ? tx.put([snapshotName(tx.revision)], current) : tx;
    const trimmed = staleSnapshots(await kept.list([])).reduce((t, old) => t.remove([old.name]), kept);
    return trimmed.put(VAULT, trimmed.upload(encodeVault(next), { modified: now }));
  },
];

// ---------------------------------------------------------------- transitional: the vault before the tree (SPEC §7.5)

const fromVersion1 = ({ revision: _revision, saved_at: _savedAt, history: _history, ...doc }) => ({ ...doc, version: VERSION });

/**
 * For the SDK's `upgradeVault`: the vault document of version 1 becomes the file `vault`, and each version its history
 * lists becomes `vault@<its revision>`. The root continues from the document's revision, so devices see no rollback.
 */
export async function convertLegacy(doc, openOld) {
  const history = await Promise.all((doc.history ?? []).map(openOld));
  const file = (old) => (tx) => tx.upload(encodeVault(fromVersion1(old)), { modified: old.saved_at });
  return {
    revision: doc.revision + 1,
    steps: [(tx) => tx.put(VAULT, file(doc)(tx)), ...history.map((old) => (tx) => tx.put([snapshotName(old.revision)], file(old)(tx)))],
  };
}
