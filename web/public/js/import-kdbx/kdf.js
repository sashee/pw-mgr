// Runs a database's key derivation. Used by the worker (kdf-worker.js) and directly by tests.

import { aesKdf } from "./aes-kdf.js";
import { argon2 } from "./argon2.js";

/** The transformed key for `kdf` (as read from the header by container.js). */
export async function runKdf(kdf, compositeKey, onProgress = () => {}) {
  if (kdf.name === "AES-KDF") return aesKdf(compositeKey, kdf.seed, kdf.rounds, onProgress);
  if (kdf.name === "Argon2d" || kdf.name === "Argon2id") {
    return argon2({
      type: kdf.name === "Argon2d" ? "d" : "id",
      password: compositeKey,
      salt: kdf.salt,
      secret: kdf.secret,
      ad: kdf.ad,
      iterations: kdf.iterations,
      memoryKiB: kdf.memoryKiB,
      parallelism: kdf.parallelism,
      version: kdf.version,
      outlen: 32,
      onProgress,
    });
  }
  throw new Error(`Unsupported key derivation ${kdf.name}`);
}
