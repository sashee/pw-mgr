// KeePass key files: XML v1.0 (base64) and v2.0 (hex with a hash check), 32 raw bytes, 64 hex characters,
// or any other file (its SHA-256). The same order KeePass uses.

const subtle = globalThis.crypto.subtle;

export class KeyFileError extends Error {}

function decodeBase64(text) {
  return Uint8Array.from(atob(text.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

const isHex64 = (text) => /^[0-9a-fA-F]{64}$/.test(text);
const fromHex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));

/** The 32-byte key a key file contributes to the composite key. */
export async function keyFromFile(bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/<KeyFile[\s>]/.test(text)) {
    const version = text.match(/<Version>\s*([^<]*?)\s*<\/Version>/)?.[1];
    const data = text.match(/<Data(?:\s+Hash="([0-9A-Fa-f]+)")?\s*>([^<]*)<\/Data>/);
    if (!data) throw new KeyFileError("The XML key file has no key data");
    if (version?.startsWith("2.")) {
      const hex = data[2].replace(/\s+/g, "");
      if (!isHex64(hex)) throw new KeyFileError("The XML key file's key isn't 64 hex characters");
      const key = fromHex(hex);
      const hash = new Uint8Array(await subtle.digest("SHA-256", key)).subarray(0, 4);
      const expected = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
      if (data[1] && data[1].toLowerCase() !== expected) throw new KeyFileError("The XML key file is damaged (its hash doesn't match)");
      return key;
    }
    if (version === undefined || version.startsWith("1.")) {
      const key = decodeBase64(data[2]);
      if (key.length !== 32) throw new KeyFileError("The XML key file's key isn't 32 bytes");
      return key;
    }
    throw new KeyFileError(`Unsupported key file version ${version}`);
  }
  if (bytes.length === 32) return bytes.slice();
  if (bytes.length === 64 && isHex64(text)) return fromHex(text);
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}
