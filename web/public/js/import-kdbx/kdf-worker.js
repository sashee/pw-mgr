// Runs the KDBX key derivation off the main thread, so the page stays responsive (web SPEC §8.2).
// In: { kdf, compositeKey }. Out: { progress } messages, then { key } or { error }.

import { runKdf } from "./kdf.js";

self.addEventListener("message", async ({ data }) => {
  try {
    let reported = 0;
    const key = await runKdf(data.kdf, data.compositeKey, (fraction) => {
      if (fraction - reported >= 0.01) {
        reported = fraction;
        self.postMessage({ progress: fraction });
      }
    });
    self.postMessage({ key });
  } catch (error) {
    self.postMessage({ error: error.message ?? String(error) });
  }
});
