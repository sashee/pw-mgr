// Argon2d / Argon2i / Argon2id (RFC 9106), version 0x13 (and 0x10). Plain JavaScript: 64-bit words are pairs
// of 32-bit numbers in Uint32Arrays, and the 32×32→64 multiplications use 16-bit halves, so the arithmetic
// is exact. Structured after the reference implementation (phc-winner-argon2).

import { blake2b } from "./blake2b.js";

const TYPES = { d: 0, i: 1, id: 2 };
const SYNC_POINTS = 4;
const WORDS = 256; // 32-bit words in a 1 KiB block
const ADDRESSES_IN_BLOCK = 128;

const le32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** H' from RFC 9106 §3.3: BLAKE2b extended to any output length. */
export function hPrime(outlen, input) {
  const prefixed = concat(le32(outlen), input);
  if (outlen <= 64) return blake2b(prefixed, outlen);
  const out = new Uint8Array(outlen);
  let v = blake2b(prefixed, 64);
  out.set(v.subarray(0, 32), 0);
  let at = 32;
  while (outlen - at > 64) {
    v = blake2b(v, 64);
    out.set(v.subarray(0, 32), at);
    at += 32;
  }
  out.set(blake2b(v, outlen - at), at);
  return out;
}

/** High 32 bits of the 64-bit product of two unsigned 32-bit numbers. */
function mulHi(a, b) {
  const al = a & 0xffff;
  const ah = a >>> 16;
  const bl = b & 0xffff;
  const bh = b >>> 16;
  const lh = al * bh;
  const hl = ah * bl;
  return (ah * bh + (lh >>> 16) + (hl >>> 16) + (((al * bl) >>> 16) + (lh & 0xffff) + (hl & 0xffff)) / 65536) >>> 0;
}

/**
 * The BlaMka G function on four 64-bit words of `v` (indices of the low halves):
 * a = a + b + 2·lo(a)·lo(b), with rotations as in BLAKE2b.
 */
function gb(v, a, b, c, d) {
  let al = v[a], ah = v[a + 1], bl = v[b], bh = v[b + 1];
  let cl = v[c], ch = v[c + 1], dl = v[d], dh = v[d + 1];
  let pl, ph, s, xl, xh;
  // Every value stays an unsigned 32-bit number (`>>> 0`): bitwise operators return signed ones.

  // a = a + b + 2·lo(a)·lo(b); d = rotr64(d ^ a, 32)
  pl = Math.imul(al, bl) >>> 0;
  ph = mulHi(al, bl);
  ph = ((ph << 1) | (pl >>> 31)) >>> 0;
  pl = (pl << 1) >>> 0;
  s = al + bl + pl;
  al = s >>> 0;
  ah = (ah + bh + ph + ((s / 4294967296) | 0)) >>> 0;
  xl = (dl ^ al) >>> 0;
  xh = (dh ^ ah) >>> 0;
  dl = xh;
  dh = xl;

  // c = c + d + 2·lo(c)·lo(d); b = rotr64(b ^ c, 24)
  pl = Math.imul(cl, dl) >>> 0;
  ph = mulHi(cl, dl);
  ph = ((ph << 1) | (pl >>> 31)) >>> 0;
  pl = (pl << 1) >>> 0;
  s = cl + dl + pl;
  cl = s >>> 0;
  ch = (ch + dh + ph + ((s / 4294967296) | 0)) >>> 0;
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xl >>> 24) | (xh << 8)) >>> 0;
  bh = ((xh >>> 24) | (xl << 8)) >>> 0;

  // a = a + b + 2·lo(a)·lo(b); d = rotr64(d ^ a, 16)
  pl = Math.imul(al, bl) >>> 0;
  ph = mulHi(al, bl);
  ph = ((ph << 1) | (pl >>> 31)) >>> 0;
  pl = (pl << 1) >>> 0;
  s = al + bl + pl;
  al = s >>> 0;
  ah = (ah + bh + ph + ((s / 4294967296) | 0)) >>> 0;
  xl = dl ^ al;
  xh = dh ^ ah;
  dl = ((xl >>> 16) | (xh << 16)) >>> 0;
  dh = ((xh >>> 16) | (xl << 16)) >>> 0;

  // c = c + d + 2·lo(c)·lo(d); b = rotr64(b ^ c, 63)
  pl = Math.imul(cl, dl) >>> 0;
  ph = mulHi(cl, dl);
  ph = ((ph << 1) | (pl >>> 31)) >>> 0;
  pl = (pl << 1) >>> 0;
  s = cl + dl + pl;
  cl = s >>> 0;
  ch = (ch + dh + ph + ((s / 4294967296) | 0)) >>> 0;
  xl = bl ^ cl;
  xh = bh ^ ch;
  bl = ((xh >>> 31) | (xl << 1)) >>> 0;
  bh = ((xl >>> 31) | (xh << 1)) >>> 0;

  v[a] = al;
  v[a + 1] = ah;
  v[b] = bl;
  v[b + 1] = bh;
  v[c] = cl;
  v[c + 1] = ch;
  v[d] = dl;
  v[d + 1] = dh;
}

/** BLAKE2_ROUND_NOMSG on 16 words given by their (64-bit) indices. */
function round(v, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) {
  gb(v, i0, i4, i8, i12);
  gb(v, i1, i5, i9, i13);
  gb(v, i2, i6, i10, i14);
  gb(v, i3, i7, i11, i15);
  gb(v, i0, i5, i10, i15);
  gb(v, i1, i6, i11, i12);
  gb(v, i2, i7, i8, i13);
  gb(v, i3, i4, i9, i14);
}

/**
 * The compression G: next = P(prev ⊕ ref) ⊕ prev ⊕ ref, additionally ⊕ the old next with `withXor`.
 * Offsets are in 32-bit words. `r` and `t` are 256-word scratch blocks.
 */
function fillBlock(prevMem, prevOff, refMem, refOff, nextMem, nextOff, withXor, r, t) {
  for (let i = 0; i < WORDS; i++) r[i] = prevMem[prevOff + i] ^ refMem[refOff + i];
  if (withXor) for (let i = 0; i < WORDS; i++) t[i] = r[i] ^ nextMem[nextOff + i];
  else t.set(r);
  // Rows: 64-bit words 16i … 16i+15 (×2 for 32-bit indices).
  for (let i = 0; i < 8; i++) {
    const b = 32 * i;
    round(r, b, b + 2, b + 4, b + 6, b + 8, b + 10, b + 12, b + 14, b + 16, b + 18, b + 20, b + 22, b + 24, b + 26, b + 28, b + 30);
  }
  // Columns: 64-bit words 2i, 2i+1, 2i+16, 2i+17, … 2i+112, 2i+113.
  for (let i = 0; i < 8; i++) {
    const b = 4 * i;
    round(r, b, b + 2, b + 32, b + 34, b + 64, b + 66, b + 96, b + 98, b + 128, b + 130, b + 160, b + 162, b + 192, b + 194, b + 224, b + 226);
  }
  for (let i = 0; i < WORDS; i++) nextMem[nextOff + i] = t[i] ^ r[i];
}

/** Which block (index within its lane) a position references (the reference's index_alpha). */
function indexAlpha(pass, slice, index, pseudoRandLo, sameLane, segmentLength, laneLength) {
  let area;
  if (pass === 0) {
    if (slice === 0) area = index - 1;
    else if (sameLane) area = slice * segmentLength + index - 1;
    else area = slice * segmentLength + (index === 0 ? -1 : 0);
  } else if (sameLane) {
    area = laneLength - segmentLength + index - 1;
  } else {
    area = laneLength - segmentLength + (index === 0 ? -1 : 0);
  }
  const x = mulHi(pseudoRandLo, pseudoRandLo);
  const relative = area - 1 - mulHi(area >>> 0, x);
  const start = pass !== 0 && slice !== SYNC_POINTS - 1 ? (slice + 1) * segmentLength : 0;
  return (start + relative) % laneLength;
}

/**
 * Argon2. `onProgress(fraction)` is called after every segment.
 * memoryKiB is rounded down to a multiple of 4·parallelism, as the reference does.
 */
export function argon2({ type, password, salt, secret = new Uint8Array(0), ad = new Uint8Array(0), iterations, memoryKiB, parallelism, outlen = 32, version = 0x13, onProgress = () => {} }) {
  const typeId = TYPES[type];
  if (typeId === undefined) throw new Error(`Unknown Argon2 type ${type}`);
  if (version !== 0x13 && version !== 0x10) throw new Error(`Unsupported Argon2 version ${version}`);
  if (parallelism < 1 || iterations < 1 || memoryKiB < 8 * parallelism) throw new Error("Invalid Argon2 parameters");

  const h0 = blake2b(
    concat(
      le32(parallelism), le32(outlen), le32(memoryKiB), le32(iterations), le32(version), le32(typeId),
      le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad,
    ),
    64,
  );
  const segmentLength = Math.floor(memoryKiB / (SYNC_POINTS * parallelism));
  const laneLength = segmentLength * SYNC_POINTS;
  const memoryBlocks = laneLength * parallelism;
  const mem = new Uint32Array(memoryBlocks * WORDS);
  const r = new Uint32Array(WORDS);
  const t = new Uint32Array(WORDS);
  const zero = new Uint32Array(WORDS);
  const input = new Uint32Array(WORDS);
  const address = new Uint32Array(WORDS);

  const loadBlock = (bytes, block) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < WORDS; i++) mem[block * WORDS + i] = view.getUint32(i * 4, true);
  };
  for (let lane = 0; lane < parallelism; lane++) {
    loadBlock(hPrime(1024, concat(h0, le32(0), le32(lane))), lane * laneLength);
    loadBlock(hPrime(1024, concat(h0, le32(1), le32(lane))), lane * laneLength + 1);
  }

  const nextAddresses = () => {
    input[12] = (input[12] + 1) >>> 0; // counter: 64-bit word 6
    if (input[12] === 0) input[13] = (input[13] + 1) >>> 0;
    fillBlock(zero, 0, input, 0, address, 0, false, r, t);
    fillBlock(zero, 0, address, 0, address, 0, false, r, t);
  };

  const totalSegments = iterations * SYNC_POINTS * parallelism;
  let done = 0;
  for (let pass = 0; pass < iterations; pass++) {
    for (let slice = 0; slice < SYNC_POINTS; slice++) {
      for (let lane = 0; lane < parallelism; lane++) {
        const independent = typeId === 1 || (typeId === 2 && pass === 0 && slice < 2);
        if (independent) {
          input.fill(0);
          input[0] = pass;
          input[2] = lane;
          input[4] = slice;
          input[6] = memoryBlocks;
          input[8] = iterations;
          input[10] = typeId;
        }
        let start = 0;
        if (pass === 0 && slice === 0) {
          start = 2;
          if (independent) nextAddresses();
        }
        let curr = lane * laneLength + slice * segmentLength + start;
        let prev = curr % laneLength === 0 ? curr + laneLength - 1 : curr - 1;
        for (let i = start; i < segmentLength; i++, curr++, prev++) {
          if (curr % laneLength === 1) prev = curr - 1;
          let randLo, randHi;
          if (independent) {
            if (i % ADDRESSES_IN_BLOCK === 0) nextAddresses();
            const k = (i % ADDRESSES_IN_BLOCK) * 2;
            randLo = address[k];
            randHi = address[k + 1];
          } else {
            randLo = mem[prev * WORDS];
            randHi = mem[prev * WORDS + 1];
          }
          const refLane = pass === 0 && slice === 0 ? lane : randHi % parallelism;
          const refIndex = indexAlpha(pass, slice, i, randLo, refLane === lane, segmentLength, laneLength);
          const withXor = version === 0x13 && pass > 0;
          fillBlock(mem, prev * WORDS, mem, (refLane * laneLength + refIndex) * WORDS, mem, curr * WORDS, withXor, r, t);
        }
        onProgress(++done / totalSegments);
      }
    }
  }

  // Final block: XOR of every lane's last block.
  const final = new Uint32Array(WORDS);
  for (let lane = 0; lane < parallelism; lane++) {
    const off = (lane * laneLength + laneLength - 1) * WORDS;
    for (let i = 0; i < WORDS; i++) final[i] ^= mem[off + i];
  }
  const bytes = new Uint8Array(1024);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < WORDS; i++) view.setUint32(i * 4, final[i], true);
  return hPrime(outlen, bytes);
}
