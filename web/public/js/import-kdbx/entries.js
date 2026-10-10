// KeePass XML → vault entries (web SPEC §8.3). Takes a parsed Document (DOMParser) and the inner keystream.

const STANDARD = new Set(["Title", "UserName", "Password", "URL", "Notes"]);
const EXTRA_URL = /^KP2A_URL(?:_(\d+))?$/;
const TITLE_MAX = 200;
const NOTES_MAX = 64 * 1024;
// Seconds from 0001-01-01 to 1970-01-01: KDBX 4 stores times as seconds since 0001-01-01.
const EPOCH_OFFSET = 62135596800n;

const children = (element, name) => Array.from(element?.children ?? []).filter((c) => c.tagName === name);
const child = (element, name) => children(element, name)[0] ?? null;
const text = (element) => element?.textContent ?? "";

function base64(textValue) {
  return Uint8Array.from(atob(textValue.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

/**
 * Unprotects every `Protected="True"` value in document order, as the inner stream requires: values in
 * history entries and the recycle bin count too, even though they aren't imported.
 */
function unprotect(doc, keystream) {
  const values = new Map();
  for (const element of doc.getElementsByTagName("*")) {
    if ((element.getAttribute("Protected") ?? "").toLowerCase() !== "true") continue;
    const cipher = base64(text(element));
    const keys = keystream.next(cipher.length);
    values.set(element, new TextDecoder().decode(cipher.map((b, i) => b ^ keys[i])));
  }
  return values;
}

/** KDBX 3.1 writes ISO 8601; KDBX 4 writes base64 of an int64 count of seconds since 0001-01-01. */
export function parseTime(value) {
  if (!value) return null;
  if (/^\d{4}-\d\d-\d\d/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  try {
    const bytes = base64(value);
    if (bytes.length !== 8) return null;
    const seconds = new DataView(bytes.buffer).getBigInt64(0, true);
    const ms = Number(seconds - EPOCH_OFFSET) * 1000;
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
  } catch {
    return null;
  }
}

const iso = (ms, fallback) => new Date(ms ?? fallback).toISOString();

const cutChars = (value, max) => [...value].slice(0, max).join("");

function cutNotes(notes) {
  const encoder = new TextEncoder();
  if (encoder.encode(notes).length <= NOTES_MAX) return [notes, false];
  let chars = [...notes];
  while (encoder.encode(chars.join("")).length > NOTES_MAX) chars = chars.slice(0, Math.floor(chars.length * 0.9));
  return [chars.join(""), true];
}

/** One KeePass entry as a vault entry, plus what the preview reports about it. */
function mapEntry(element, groupPath, valueOf, newId, now) {
  const fields = children(element, "String").map((s) => [text(child(s, "Key")), valueOf(child(s, "Value"))]);
  const field = (key) => fields.find(([k]) => k === key)?.[1] ?? "";
  const extraUrls = fields
    .filter(([k]) => EXTRA_URL.test(k))
    .sort(([a], [b]) => Number(a.match(EXTRA_URL)[1] ?? 0) - Number(b.match(EXTRA_URL)[1] ?? 0))
    .map(([, v]) => v);
  const custom = fields.filter(([k]) => !STANDARD.has(k) && !EXTRA_URL.test(k));
  const extra = [...(groupPath ? [`Group: ${groupPath}`] : []), ...custom.map(([k, v]) => `${k}: ${v}`)];
  const ownNotes = field("Notes");
  const [notes, notesCut] = cutNotes(extra.length ? `${ownNotes ? `${ownNotes}\n\n` : ""}--- Imported from KeePass ---\n${extra.join("\n")}` : ownNotes);
  const rawTitle = field("Title");
  const times = child(element, "Times");
  const created = parseTime(text(child(times, "CreationTime")));
  const modified = parseTime(text(child(times, "LastModificationTime")));
  return {
    entry: {
      id: newId(),
      title: rawTitle.trim() ? cutChars(rawTitle, TITLE_MAX) : "(untitled)",
      username: field("UserName"),
      password: field("Password"),
      urls: [field("URL"), ...extraUrls].map((u) => u.trim()).filter(Boolean),
      notes,
      created_at: iso(created, now),
      updated_at: iso(modified ?? created, now),
    },
    attachments: children(element, "Binary").length,
    references: fields.some(([, v]) => /\{REF:/i.test(v)),
    notesCut,
  };
}

/**
 * All entries outside the recycle bin, with group paths (without the root group).
 * → { entries, stats: { recycleBin, attachments, references, notesCut: [titles] } }
 */
export function mapEntries(doc, keystream, newId, now) {
  const root = doc.documentElement;
  if (root?.tagName !== "KeePassFile") throw new Error("The decrypted data isn't a KeePass XML document");
  const protectedValues = unprotect(doc, keystream);
  const valueOf = (element) => (protectedValues.has(element) ? protectedValues.get(element) : text(element));

  const meta = child(root, "Meta");
  const recycleBinOn = text(child(meta, "RecycleBinEnabled")).toLowerCase() === "true";
  const recycleBin = recycleBinOn ? text(child(meta, "RecycleBinUUID")).trim() : null;
  const rootGroup = child(child(root, "Root"), "Group");

  const mapped = [];
  let recycled = 0;
  const countEntries = (group) => children(group, "Entry").length + children(group, "Group").reduce((n, g) => n + countEntries(g), 0);
  const walk = (group, path) => {
    for (const entry of children(group, "Entry")) mapped.push(mapEntry(entry, path.join("/"), valueOf, newId, now));
    for (const sub of children(group, "Group")) {
      if (recycleBin && text(child(sub, "UUID")).trim() === recycleBin) {
        recycled += countEntries(sub);
        continue;
      }
      walk(sub, [...path, text(child(sub, "Name"))]);
    }
  };
  if (rootGroup) walk(rootGroup, []);

  return {
    entries: mapped.map((m) => m.entry),
    stats: {
      recycleBin: recycled,
      attachments: mapped.reduce((n, m) => n + m.attachments, 0),
      references: mapped.filter((m) => m.references).length,
      notesCut: mapped.filter((m) => m.notesCut).map((m) => m.entry.title),
    },
  };
}
