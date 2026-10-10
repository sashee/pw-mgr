// Salsa20/20: 256-bit key, 64-bit nonce, 64-bit block counter. KDBX 3.1 uses it as the inner stream that
// protects values.

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

function block(state, out) {
  const x = new Int32Array(state);
  const qr = (a, b, c, d) => {
    x[b] ^= rotl((x[a] + x[d]) | 0, 7);
    x[c] ^= rotl((x[b] + x[a]) | 0, 9);
    x[d] ^= rotl((x[c] + x[b]) | 0, 13);
    x[a] ^= rotl((x[d] + x[c]) | 0, 18);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(5, 9, 13, 1); qr(10, 14, 2, 6); qr(15, 3, 7, 11);
    qr(0, 1, 2, 3); qr(5, 6, 7, 4); qr(10, 11, 8, 9); qr(15, 12, 13, 14);
  }
  const view = new DataView(out.buffer, out.byteOffset, 64);
  for (let i = 0; i < 16; i++) view.setInt32(i * 4, (x[i] + state[i]) | 0, true);
}

/** A keystream that continues across calls: `next(n)` returns the next n bytes. */
export function salsa20Stream(key, nonce) {
  if (key.length !== 32 || nonce.length !== 8) throw new Error("Salsa20 needs a 32-byte key and an 8-byte nonce");
  const k = new DataView(key.buffer, key.byteOffset, 32);
  const n = new DataView(nonce.buffer, nonce.byteOffset, 8);
  const word = (i) => k.getInt32(i * 4, true);
  // "expand 32-byte k"
  const state = new Int32Array([0x61707865, word(0), word(1), word(2), word(3), 0x3320646e, n.getInt32(0, true), n.getInt32(4, true), 0, 0, 0x79622d32, word(4), word(5), word(6), word(7), 0x6b206574]);
  const buffer = new Uint8Array(64);
  let used = 64;
  return {
    next(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        if (used === 64) {
          block(state, buffer);
          state[8] = (state[8] + 1) | 0;
          if (state[8] === 0) state[9] = (state[9] + 1) | 0;
          used = 0;
        }
        out[i] = buffer[used++];
      }
      return out;
    },
  };
}
