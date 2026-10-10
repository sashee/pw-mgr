// AES-KDF (KDBX 3.1 and optionally 4): each 16-byte half of the composite key is encrypted `rounds` times
// with AES-256-ECB under the seed, then SHA-256 of the result.
//
// WebCrypto has no ECB mode, but CBC over blocks of zeros is the same thing: with IV = x and plaintext
// blocks of zero, Cᵢ = E(0 ⊕ Cᵢ₋₁) = E(Cᵢ₋₁), so the last ciphertext block is E applied `n` times to x.
// The work is done in chunks to bound memory; the trailing padding block of each chunk is ignored.

const subtle = globalThis.crypto.subtle;
const CHUNK_BLOCKS = 1 << 16; // 1 MiB of zeros per call

async function encryptRepeatedly(key, block, rounds, onProgress) {
  let x = block;
  let left = rounds;
  while (left > 0) {
    const n = Math.min(left, CHUNK_BLOCKS);
    const out = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: x }, key, new Uint8Array(n * 16)));
    x = out.slice((n - 1) * 16, n * 16);
    left -= n;
    onProgress(n);
  }
  return x;
}

/** The transformed key: SHA-256(AES-ECB^rounds(composite halves)). */
export async function aesKdf(compositeKey, seed, rounds, onProgress = () => {}) {
  const key = await subtle.importKey("raw", seed, "AES-CBC", false, ["encrypt"]);
  let done = 0;
  const report = (n) => onProgress((done += n) / (2 * Math.max(rounds, 1)));
  const [left, right] = await Promise.all([
    encryptRepeatedly(key, compositeKey.slice(0, 16), rounds, report),
    encryptRepeatedly(key, compositeKey.slice(16, 32), rounds, report),
  ]);
  const both = new Uint8Array(32);
  both.set(left);
  both.set(right, 16);
  return new Uint8Array(await subtle.digest("SHA-256", both));
}
