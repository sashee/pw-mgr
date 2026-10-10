// BLAKE2b (RFC 7693), unkeyed, one-shot. 64-bit words are pairs of 32-bit numbers (low, high) in a
// Uint32Array, so everything stays in exact integer arithmetic. Used by Argon2.

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// v[a] += v[b] + m (64-bit, word indices are pair indices × 2)
function add(v, a, b) {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

function addM(v, a, m, i) {
  const lo = v[a] + m[i];
  v[a + 1] = v[a + 1] + m[i + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

// v[d] = (v[d] ^ v[a]) >>> n (rotate right, 64-bit)
function xorRotr(v, d, a, n) {
  const lo = v[d] ^ v[a];
  const hi = v[d + 1] ^ v[a + 1];
  if (n === 32) {
    v[d] = hi;
    v[d + 1] = lo;
  } else if (n < 32) {
    v[d] = (lo >>> n) | (hi << (32 - n));
    v[d + 1] = (hi >>> n) | (lo << (32 - n));
  } else {
    v[d] = (hi >>> (n - 32)) | (lo << (64 - n));
    v[d + 1] = (lo >>> (n - 32)) | (hi << (64 - n));
  }
}

function g(v, a, b, c, d, m, x, y) {
  add(v, a, b);
  addM(v, a, m, x);
  xorRotr(v, d, a, 32);
  add(v, c, d);
  xorRotr(v, b, c, 24);
  add(v, a, b);
  addM(v, a, m, y);
  xorRotr(v, d, a, 16);
  add(v, c, d);
  xorRotr(v, b, c, 63);
}

function compress(h, block, counter, last) {
  const v = new Uint32Array(32);
  v.set(h);
  v.set(IV, 16);
  v[24] ^= counter >>> 0;
  v[25] ^= Math.floor(counter / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  const m = new Uint32Array(32);
  for (let i = 0; i < 32; i++) m[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10];
    g(v, 0, 8, 16, 24, m, s[0] * 2, s[1] * 2);
    g(v, 2, 10, 18, 26, m, s[2] * 2, s[3] * 2);
    g(v, 4, 12, 20, 28, m, s[4] * 2, s[5] * 2);
    g(v, 6, 14, 22, 30, m, s[6] * 2, s[7] * 2);
    g(v, 0, 10, 20, 30, m, s[8] * 2, s[9] * 2);
    g(v, 2, 12, 22, 24, m, s[10] * 2, s[11] * 2);
    g(v, 4, 14, 16, 26, m, s[12] * 2, s[13] * 2);
    g(v, 6, 8, 18, 28, m, s[14] * 2, s[15] * 2);
  }
  for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
}

/** BLAKE2b with an `outlen`-byte digest (1–64) of `input` (Uint8Array). */
export function blake2b(input, outlen = 64) {
  if (outlen < 1 || outlen > 64) throw new RangeError("BLAKE2b output length must be 1–64");
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010000 ^ outlen;
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  const block = new Uint8Array(128);
  for (let i = 0; i < blocks; i++) {
    const last = i === blocks - 1;
    const chunk = input.subarray(i * 128, (i + 1) * 128);
    block.fill(0);
    block.set(chunk);
    compress(h, block, last ? input.length : (i + 1) * 128, last);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    out[i * 4] = h[i];
    out[i * 4 + 1] = h[i] >>> 8;
    out[i * 4 + 2] = h[i] >>> 16;
    out[i * 4 + 3] = h[i] >>> 24;
  }
  return out.slice(0, outlen);
}
