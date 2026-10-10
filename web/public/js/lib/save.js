// Saving a document by compare-and-swap (SPEC §7.4). The I/O is passed in, so the retry logic is testable.

export const MAX_ATTEMPTS = 5;

export class TooManyConflictsError extends Error {
  constructor() {
    super("Too many other changes at the same time; try again");
    this.name = "TooManyConflictsError";
  }
}

/**
 * Applies `apply(doc, blobId)` to the loaded document and writes it; on a conflict, applies the same change
 * to the newest version and tries again.
 *
 * io.putBlob(bytes) → blob id
 * io.putRef(ref, blobId, expectedBlobId) → { ok: true } | { ok: false, current: blobId | null }
 * io.getBlob(blobId) → bytes (hash-verified)
 */
export async function saveWithRetry(io, { ref, loaded, apply, encode, decode, attempts = MAX_ATTEMPTS }) {
  let base = loaded;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const doc = apply(base.doc, base.blobId);
    const blobId = await io.putBlob(await encode(doc));
    const result = await io.putRef(ref, blobId, base.blobId);
    if (result.ok) return { doc, blobId, previous: base };
    if (!result.current) throw new Error(`The ${ref} ref disappeared`);
    base = { doc: await decode(await io.getBlob(result.current)), blobId: result.current };
  }
  throw new TooManyConflictsError();
}
