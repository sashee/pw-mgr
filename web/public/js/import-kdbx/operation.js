// The vault operation that adds imported entries (web SPEC §8.4). A plain operation, saved through the app's
// normal compare-and-swap save; it lives here so the app's core knows nothing about importing.

/** Same title, username, password and first URL. */
export const duplicateKey = (entry) => JSON.stringify([entry.title, entry.username, entry.password, entry.urls?.[0] ?? ""]);

/** How many of `entries` would be skipped as duplicates of `existing` (or of each other). */
export function countDuplicates(existing, entries) {
  const seen = new Set(existing.map(duplicateKey));
  return entries.filter((e) => {
    const key = duplicateKey(e);
    const duplicate = seen.has(key);
    seen.add(key);
    return duplicate;
  }).length;
}

/**
 * Adds the entries. With `skipDuplicates`, entries that duplicate one already in the vault (the vault this
 * is applied to, so it stays right when the save is re-applied after a conflict) or an earlier imported one
 * are left out. The entries already carry their new IDs.
 */
export const importEntries = (entries, skipDuplicates) => (vault) => {
  const seen = new Set(vault.entries.map(duplicateKey));
  const added = entries.filter((e) => {
    const key = duplicateKey(e);
    const keep = !skipDuplicates || !seen.has(key);
    seen.add(key);
    return keep;
  });
  return { ...vault, entries: [...vault.entries, ...added] };
};
