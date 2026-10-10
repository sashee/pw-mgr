// The KDBX container (web SPEC §8.1–§8.2): header, composite key, integrity checks, decryption,
// decompression and the inner header. Read-only. The key derivation itself is passed in (`kdf.js`, usually in
// a worker), so this module stays quick to run on the main thread.
//
// References: KeePass's KDBX 4 documentation (keepass.info/help/kb/kdbx_4.html) and the KeePassXC sources.

import { chacha20, chacha20Stream } from "./chacha20.js";
import { salsa20Stream } from "./salsa20.js";

const subtle = globalThis.crypto.subtle;

export class KdbxError extends Error {
  /** kind: "format" (not a supported file), "credentials" (wrong password or key file), "damaged". */
  constructor(kind, message) {
    super(message);
    this.name = "KdbxError";
    this.kind = kind;
  }
}

const SIGNATURE_1 = 0x9aa2d903;
const SIGNATURE_2 = 0xb54bfb67;
const SIGNATURE_2_KDB = 0xb54bfb65;

const CIPHERS = {
  "31c1f2e6bf714350be5805216afc5aff": "AES-256",
  d6038a2b8b6f4cb5a524339a31dbb59a: "ChaCha20",
  ad68f29f576f4bb9a36ad47af965346c: "Twofish",
};
const KDFS = {
  c9d9f39a628a4460bf740d08c18a4fea: "AES-KDF",
  "7c02bb8279a74ac0927d114a00648238": "AES-KDF", // KeePassXC's AES-KDF for KDBX 4
  ef636ddf8c29444b91f7a9a403e30a0c: "Argon2d",
  "9e298b1956db4773b23dfc3ec6f0a1e6": "Argon2id",
};
const INNER_STREAMS = { 0: "none", 1: "Arc4", 2: "Salsa20", 3: "ChaCha20" };

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => new Uint8Array(await subtle.digest("SHA-256", data));
const sha512 = async (data) => new Uint8Array(await subtle.digest("SHA-512", data));
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u32At = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
const u64At = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);

const u64le = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};

/** A reader over a byte array that turns running past the end into a "damaged" error. */
function reader(bytes, start = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  const need = (n) => {
    if (at + n > bytes.length) throw new KdbxError("damaged", "The file is damaged (it ends too early)");
  };
  return {
    get offset() {
      return at;
    },
    u8: () => (need(1), view.getUint8(at++)),
    u16: () => (need(2), (at += 2), view.getUint16(at - 2, true)),
    u32: () => (need(4), (at += 4), view.getUint32(at - 4, true)),
    i32: () => (need(4), (at += 4), view.getInt32(at - 4, true)),
    u64: () => (need(8), (at += 8), view.getBigUint64(at - 8, true)),
    bytes: (n) => (need(n), (at += n), bytes.subarray(at - n, at)),
    done: () => at >= bytes.length,
  };
}

/** KDBX 4's typed key-value map (used for the KDF parameters). */
function readVariantDictionary(bytes) {
  const r = reader(bytes);
  const version = r.u16();
  if (version >> 8 !== 1) throw new KdbxError("format", "Unsupported KDF parameter format");
  const map = new Map();
  for (;;) {
    const type = r.u8();
    if (type === 0) return map;
    const name = new TextDecoder().decode(r.bytes(r.i32()));
    const value = r.bytes(r.i32());
    const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const decoded = {
      0x04: () => v.getUint32(0, true),
      0x05: () => v.getBigUint64(0, true),
      0x08: () => value[0] !== 0,
      0x0c: () => v.getInt32(0, true),
      0x0d: () => v.getBigInt64(0, true),
      0x18: () => new TextDecoder().decode(value),
      0x42: () => value.slice(),
    }[type];
    map.set(name, decoded ? decoded() : value.slice());
  }
}

function kdfFromDictionary(map) {
  const uuid = map.get("$UUID");
  const name = uuid && KDFS[hex(uuid)];
  if (!name) throw new KdbxError("format", "This database uses an unsupported key derivation function");
  const num = (key) => Number(map.get(key));
  if (name === "AES-KDF") return { name, rounds: num("R"), seed: map.get("S") };
  return {
    name,
    salt: map.get("S"),
    parallelism: num("P"),
    memoryKiB: num("M") / 1024,
    iterations: num("I"),
    version: num("V"),
    secret: map.get("K") ?? new Uint8Array(0),
    ad: map.get("A") ?? new Uint8Array(0),
  };
}

/** Parses the outer header. Throws `KdbxError("format")` for anything that isn't a supported KDBX file. */
export function readHeader(bytes) {
  if (bytes.length < 12) throw new KdbxError("format", "This isn't a KeePass database");
  const r = reader(bytes);
  const sig1 = r.u32();
  const sig2 = r.u32();
  if (sig1 !== SIGNATURE_1) throw new KdbxError("format", "This isn't a KeePass database");
  if (sig2 === SIGNATURE_2_KDB) throw new KdbxError("format", "KeePass 1 databases (.kdb) aren't supported; save it as .kdbx first");
  if (sig2 !== SIGNATURE_2) throw new KdbxError("format", "This isn't a KeePass 2 database");
  const minor = r.u16();
  const major = r.u16();
  if (major < 3 || major > 4) throw new KdbxError("format", `KDBX version ${major}.${minor} isn't supported`);

  const fields = new Map();
  for (;;) {
    const id = r.u8();
    const data = r.bytes(major === 3 ? r.u16() : r.u32());
    if (id === 0) break;
    fields.set(id, data);
  }
  const headerEnd = r.offset;
  const field = (id, what) => {
    const value = fields.get(id);
    if (!value) throw new KdbxError("damaged", `The header has no ${what}`);
    return value;
  };

  const cipher = CIPHERS[hex(field(2, "cipher"))];
  if (!cipher) throw new KdbxError("format", "This database uses an unsupported cipher");
  if (cipher === "Twofish") throw new KdbxError("format", "Twofish encryption isn't supported (AES-256 and ChaCha20 are)");
  const compression = u32At(field(3, "compression flag"));
  if (compression > 1) throw new KdbxError("format", "Unsupported compression");

  const header = {
    major,
    minor,
    cipher,
    gzip: compression === 1,
    masterSeed: field(4, "master seed"),
    iv: field(7, "encryption IV"),
    bytes: bytes.subarray(0, headerEnd),
    end: headerEnd,
  };
  if (major === 3) {
    const rounds = u64At(field(6, "rounds"));
    return {
      ...header,
      kdf: { name: "AES-KDF", seed: field(5, "transform seed"), rounds: Number(rounds) },
      protectedStreamKey: field(8, "protected stream key"),
      streamStartBytes: field(9, "stream start bytes"),
      innerStreamId: u32At(field(10, "inner stream id")),
    };
  }
  return { ...header, kdf: kdfFromDictionary(readVariantDictionary(field(11, "KDF parameters"))) };
}

/** A short description for the preview, e.g. "KDBX 4.0, Argon2d, ChaCha20". */
export const describe = (header) => `KDBX ${header.major}.${header.minor}, ${header.kdf.name}, ${header.cipher}`;

/** SHA-256 over the components: SHA-256(password) if there is one, then the key file's key. */
export async function compositeKey(password, keyFileKey) {
  const parts = [];
  if (password !== null) parts.push(await sha256(new TextEncoder().encode(password)));
  if (keyFileKey) parts.push(keyFileKey);
  return sha256(concat(...parts));
}

async function decryptPayload(cipher, key, iv, data) {
  if (cipher === "ChaCha20") return chacha20(key, iv, data);
  try {
    const aes = await subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, aes, data));
  } catch {
    // Bad padding: in KDBX 3.1 the first sign of a wrong key; in KDBX 4 the blocks were already authenticated.
    throw new KdbxError("credentials", "Wrong password or key file");
  }
}

async function gunzip(data) {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new KdbxError("damaged", "The file is damaged (it doesn't decompress)");
  }
}

async function hmacSha256(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

/** KDBX 3.1's hashed block stream: index, SHA-256, size, data; a final empty block. */
async function readHashedBlocks(data) {
  const r = reader(data);
  const blocks = [];
  for (let index = 0; ; index++) {
    if (r.u32() !== index) throw new KdbxError("damaged", "The file is damaged (blocks out of order)");
    const hash = r.bytes(32);
    const block = r.bytes(r.i32());
    if (block.length === 0) return concat(...blocks);
    if (!equal(await sha256(block), hash)) throw new KdbxError("damaged", "The file is damaged (a block's hash doesn't match)");
    blocks.push(block);
  }
}

/** KDBX 4's HMAC block stream: HMAC, size, data; a final empty block. */
async function readHmacBlocks(data, hmacBaseKey) {
  const r = reader(data);
  const blocks = [];
  for (let index = 0n; ; index++) {
    const mac = r.bytes(32);
    const size = r.i32();
    const block = r.bytes(size);
    const key = await sha512(concat(u64le(index), hmacBaseKey));
    const sizeBytes = new Uint8Array(4);
    new DataView(sizeBytes.buffer).setInt32(0, size, true);
    if (!equal(await hmacSha256(key, concat(u64le(index), sizeBytes, block)), mac)) {
      throw new KdbxError("damaged", "The file is damaged (a block's HMAC doesn't match)");
    }
    if (size === 0) return concat(...blocks);
    blocks.push(block);
  }
}

/** KDBX 4's inner header: the inner stream for protected values, and binaries (counted, not kept). */
function readInnerHeader(data) {
  const r = reader(data);
  const inner = { innerStreamId: null, protectedStreamKey: null, binaries: 0 };
  for (;;) {
    const id = r.u8();
    const value = r.bytes(r.u32());
    if (id === 0) return { ...inner, xml: data.subarray(r.offset) };
    if (id === 1) inner.innerStreamId = u32At(value);
    if (id === 2) inner.protectedStreamKey = value;
    if (id === 3) inner.binaries++;
  }
}

/**
 * Decrypts the database with the transformed key (the KDF's output).
 * → { xml: Uint8Array, innerStream: { id, name, key } }
 * Throws `KdbxError("credentials")` for a wrong password or key file, `KdbxError("damaged")` otherwise.
 */
export async function decrypt(bytes, header, transformedKey) {
  const encryptionKey = await sha256(concat(header.masterSeed, transformedKey));
  const stream = (id, key) => {
    if (!(id in INNER_STREAMS) || id === 1) throw new KdbxError("format", "This database protects values with an unsupported stream cipher");
    return { id, name: INNER_STREAMS[id], key };
  };

  if (header.major === 3) {
    const plain = await decryptPayload(header.cipher, encryptionKey, header.iv, bytes.subarray(header.end));
    if (!equal(plain.subarray(0, 32), header.streamStartBytes)) throw new KdbxError("credentials", "Wrong password or key file");
    const blocks = await readHashedBlocks(plain.subarray(32));
    const xml = header.gzip ? await gunzip(blocks) : blocks;
    return { xml, innerStream: stream(header.innerStreamId, header.protectedStreamKey) };
  }

  const r = reader(bytes, header.end);
  const headerHash = r.bytes(32);
  const headerMac = r.bytes(32);
  if (!equal(await sha256(header.bytes), headerHash)) throw new KdbxError("damaged", "The file is damaged (the header hash doesn't match)");
  const hmacBaseKey = await sha512(concat(header.masterSeed, transformedKey, new Uint8Array([1])));
  const headerKey = await sha512(concat(u64le(0xffffffffffffffffn), hmacBaseKey));
  if (!equal(await hmacSha256(headerKey, header.bytes), headerMac)) throw new KdbxError("credentials", "Wrong password or key file");
  const encrypted = await readHmacBlocks(bytes.subarray(r.offset), hmacBaseKey);
  const plain = await decryptPayload(header.cipher, encryptionKey, header.iv, encrypted);
  const inner = readInnerHeader(header.gzip ? await gunzip(plain) : plain);
  return { xml: inner.xml, binaries: inner.binaries, innerStream: stream(inner.innerStreamId, inner.protectedStreamKey) };
}

/** The keystream that unprotects values, in document order (web SPEC §8.2 step 4). */
export async function innerKeystream({ id, key }) {
  if (id === 0) return { next: (n) => new Uint8Array(n) };
  if (id === 3) {
    const hash = await sha512(key);
    return chacha20Stream(hash.slice(0, 32), hash.slice(32, 44));
  }
  return salsa20Stream(await sha256(key), new Uint8Array([0xe8, 0x30, 0x09, 0x4b, 0x97, 0x20, 0x5d, 0x2a]));
}
