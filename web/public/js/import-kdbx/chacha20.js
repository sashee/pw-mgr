// ChaCha20 (RFC 8439): 256-bit key, 96-bit nonce, 32-bit block counter. Used for the KDBX 4 outer cipher
// and the KDBX 4 inner stream that protects values.

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) | 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0; s[b] = rotl(s[b] ^ s[c], 7);
}

function block(state, out) {
  const x = new Int32Array(state);
  for (let i = 0; i < 10; i++) {
    quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
    quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
  }
  const view = new DataView(out.buffer, out.byteOffset, 64);
  for (let i = 0; i < 16; i++) view.setInt32(i * 4, (x[i] + state[i]) | 0, true);
}

/**
 * A keystream that continues across calls: `next(n)` returns the next n bytes.
 * The state is local to the returned object, which is what a stream cipher needs.
 */
export function chacha20Stream(key, nonce, counter = 0) {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("ChaCha20 needs a 32-byte key and a 12-byte nonce");
  const k = new DataView(key.buffer, key.byteOffset, 32);
  const n = new DataView(nonce.buffer, nonce.byteOffset, 12);
  const state = new Int32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...Array.from({ length: 8 }, (_, i) => k.getInt32(i * 4, true)), counter | 0, n.getInt32(0, true), n.getInt32(4, true), n.getInt32(8, true)]);
  const buffer = new Uint8Array(64);
  let used = 64;
  return {
    next(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        if (used === 64) {
          block(state, buffer);
          state[12] = (state[12] + 1) | 0;
          used = 0;
        }
        out[i] = buffer[used++];
      }
      return out;
    },
  };
}

/** XORs `data` with the keystream (encryption and decryption are the same). */
export const chacha20 = (key, nonce, data, counter = 0) => xor(data, chacha20Stream(key, nonce, counter).next(data.length));

export const xor = (data, keystream) => data.map((b, i) => b ^ keystream[i]);
