// The file explorer's pure parts (web SPEC §9.5): how an entry's fields and a file's content are shown.

import { formatBytes } from "../../sdk/maintenance.js";

/** Fields whose values are secrets, wherever they appear (entries, their history). */
const SECRET_FIELDS = new Set(["password"]);
export const MASK = "••••••••";
const HEX_PREVIEW_BYTES = 256;

/** `value` with every non-empty secret field masked. */
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, SECRET_FIELDS.has(key) && typeof inner === "string" && inner !== "" ? MASK : maskSecrets(inner)]),
  );
}

const utf8 = (bytes) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const json = (text) => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
};

/** Offsets and bytes in hex, 16 to a line. */
export function hexPreview(bytes, limit = HEX_PREVIEW_BYTES) {
  const shown = bytes.subarray(0, limit);
  const lines = Array.from({ length: Math.ceil(shown.length / 16) }, (_, i) => {
    const row = Array.from(shown.subarray(i * 16, i * 16 + 16), (b) => b.toString(16).padStart(2, "0")).join(" ");
    return `${(i * 16).toString(16).padStart(8, "0")}  ${row}`;
  });
  return bytes.length > limit ? [...lines, `… ${formatBytes(bytes.length - limit)} more`].join("\n") : lines.join("\n");
}

/**
 * How a file's bytes are shown → { kind, text, secrets }: JSON pretty-printed, with secrets masked unless `reveal`;
 * other UTF-8 text as it is; anything else as a hex preview of its first bytes. `secrets` says whether masking hid
 * anything.
 */
export function contentView(bytes, { reveal = false } = {}) {
  const text = utf8(bytes);
  const parsed = text === null ? null : json(text);
  if (parsed) {
    const masked = maskSecrets(parsed.value);
    const secrets = JSON.stringify(masked) !== JSON.stringify(parsed.value);
    return { kind: "json", text: JSON.stringify(reveal ? parsed.value : masked, null, 2), secrets };
  }
  if (text !== null) return { kind: "text", text, secrets: false };
  return { kind: "binary", text: hexPreview(bytes), secrets: false };
}

/** The start of a long hex value, for lists. */
export const short = (hex) => (hex && hex.length > 12 ? `${hex.slice(0, 12)}…` : (hex ?? ""));

/** An entry's fields as [label, value] rows, in full. */
export function entryRows(entry) {
  const rows = [
    ["Kind", entry.kind === "dir" ? "directory" : "file"],
    entry.kind === "file" && ["Size", `${formatBytes(entry.size)} (${entry.size} bytes)`],
    entry.kind === "file" && ["Modified", new Date(entry.modified).toLocaleString()],
    ["Blob ID", entry.id],
    ["Salt", entry.salt],
    entry.kind === "file" && ["SHA-256 of the content", entry.sha256],
    entry.app !== undefined && ["App data", JSON.stringify(entry.app)],
  ];
  return rows.filter(Boolean);
}
