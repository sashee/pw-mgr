// The vault document (SPEC §6) and its operations (SPEC §7.1). Pure: no clock, no randomness, no I/O.

export const FORMAT = "pw-mgr/vault";
export const VERSION = 1;
export const HISTORY = 19;
const TITLE_MAX = 200;
const NOTES_MAX = 64 * 1024;

const iso = (ms) => new Date(ms).toISOString();

export const newVault = (now) => ({ format: FORMAT, version: VERSION, revision: 1, saved_at: iso(now), history: [], entries: [] });

/** Returns the document, or throws if it isn't one. `writable` is false for newer versions. */
export function readVault(doc) {
  if (doc?.format !== FORMAT || !Number.isInteger(doc.version) || !Number.isInteger(doc.revision) || !Array.isArray(doc.entries)) {
    throw new Error("Not a vault document");
  }
  return { doc: { history: [], ...doc }, writable: doc.version <= VERSION };
}

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

/** Applies an operation as a new revision on top of the blob it was loaded from. */
export const commit = (vault, operation, now, loadedBlobId) => ({
  ...operation(vault, now),
  revision: vault.revision + 1,
  saved_at: iso(now),
  history: [loadedBlobId, ...(vault.history ?? [])].slice(0, HISTORY),
});

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

/**
 * Transitional (§7.5): for the SDK's `upgradeVault`, the vault with the history that its commit keeps rewritten in the
 * stream format. That is all but the oldest version: the commit puts the loaded blob, rewritten too, in front.
 */
export const resealHistory = async (vault, reseal) => ({ ...vault, history: await Promise.all((vault.history ?? []).slice(0, HISTORY - 1).map((id) => reseal(id))) });

/** The vault document as the SDK's flows see it (e2ee-store/sdk/SPEC.md §5). */
export const vaultDocument = {
  empty: newVault,
  read: readVault,
  commit,
  revision: (vault) => vault.revision,
  keep: (vault) => vault.history ?? [],
};
