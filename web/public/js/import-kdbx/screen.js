// The import screen (web SPEC §8.2, §8.4): pick the file and credentials, derive the key in a worker, preview,
// then save through `ctx.save`. Nothing leaves the browser; references to the data are dropped at the end.

import { busy, h, replaceChildren } from "../ui/dom.js";
import { compositeKey, decrypt, describe, innerKeystream, KdbxError, readHeader } from "./container.js";
import { mapEntries } from "./entries.js";
import { KeyFileError, keyFromFile } from "./keyfile.js";
import { countDuplicates, importEntries } from "./operation.js";

/** Runs the KDF in a module worker. Returns { promise, cancel }. */
function deriveInWorker(kdf, key, onProgress) {
  const worker = new Worker(new URL("./kdf-worker.js", import.meta.url), { type: "module" });
  const promise = new Promise((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => {
      if ("progress" in data) return onProgress(data.progress);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.key);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || "The key derivation failed"));
    });
  });
  worker.postMessage({ kdf, compositeKey: key });
  return { promise, cancel: () => worker.terminate() };
}

const card = (title, ...content) => h("section", { class: "card" }, h("h2", {}, title), ...content);

export function importScreen(ctx) {
  const root = h("div", { id: "import-screen" });
  const show = (...nodes) => replaceChildren(root, ...nodes);
  let cancelDerivation = () => {};

  function showForm(problem = "") {
    // No `accept=".kdbx"`: the Android app hands accept values to the system picker as MIME types, and an
    // extension there would hide every file.
    const file = h("input", { type: "file", id: "kdbx-file" });
    const password = h("input", { type: "password", id: "kdbx-password", autocomplete: "off" });
    const keyFile = h("input", { type: "file", id: "kdbx-keyfile" });
    const error = h("p", { class: "error", role: "alert", id: "kdbx-error" }, problem);
    const open = h("button", { type: "button", class: "primary", id: "kdbx-open" }, "Open");
    open.addEventListener("click", () =>
      busy(open, () => openDatabase(file.files[0], password.value, keyFile.files[0]), (e) => (error.textContent = e.message)),
    );
    show(
      card(
        "Import from KeePass",
        h("p", {}, "Choose your .kdbx file and unlock it. It's decrypted here in the browser and never uploaded."),
        h("label", {}, "KeePass database (.kdbx)", file),
        h("label", {}, "Master password", password),
        h("label", {}, "Key file (if you use one)", keyFile),
        error,
        h("div", { class: "actions" }, open, h("button", { type: "button", id: "import-cancel", onclick: () => ctx.close(null) }, "Cancel")),
      ),
    );
  }

  async function openDatabase(file, password, keyFile) {
    if (!file) throw new Error("Choose a .kdbx file first.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let header;
    let keyFileKey = null;
    try {
      header = readHeader(bytes);
      keyFileKey = keyFile ? await keyFromFile(new Uint8Array(await keyFile.arrayBuffer())) : null;
    } catch (error) {
      if (error instanceof KdbxError || error instanceof KeyFileError) throw error;
      throw new Error(`Can't read the file: ${error.message}`);
    }

    const progress = h("progress", { id: "kdbx-progress", max: 1, value: 0 });
    const status = h("p", { class: "muted", id: "kdbx-status" }, "Deriving the key…");
    show(
      card(
        "Opening the KeePass database",
        h("p", { id: "kdbx-format" }, describe(header)),
        progress,
        status,
        h("div", { class: "actions" }, h("button", { type: "button", id: "kdbx-stop", onclick: () => (cancelDerivation(), showForm("Stopped.")) }, "Stop")),
      ),
    );

    // An empty password field can mean "no password" or "an empty password": with a key file, try both.
    const candidates = password !== "" ? [password] : keyFileKey ? [null, ""] : [""];
    let decrypted = null;
    try {
      for (const [index, candidate] of candidates.entries()) {
        const derivation = deriveInWorker(header.kdf, await compositeKey(candidate, keyFileKey), (fraction) => {
          progress.value = fraction;
          status.textContent = `Deriving the key… ${Math.round(fraction * 100)}%`;
        });
        cancelDerivation = derivation.cancel;
        const transformed = await derivation.promise;
        try {
          status.textContent = "Decrypting…";
          decrypted = await decrypt(bytes, header, transformed);
          break;
        } catch (error) {
          if (!(error instanceof KdbxError && error.kind === "credentials" && index < candidates.length - 1)) throw error;
        }
      }
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(decrypted.xml), "application/xml");
      if (doc.getElementsByTagName("parsererror").length > 0) throw new KdbxError("damaged", "The file is damaged (its XML doesn't parse)");
      const { entries, stats } = mapEntries(doc, await innerKeystream(decrypted.innerStream), () => crypto.randomUUID(), Date.now());
      showPreview(describe(header), entries, stats);
    } catch (error) {
      showForm(error instanceof KdbxError ? error.message : `Couldn't open the database: ${error.message}`);
    }
  }

  function showPreview(format, entries, stats) {
    const duplicates = countDuplicates(ctx.entries, entries);
    const skip = h("input", { type: "checkbox", id: "kdbx-skip-duplicates", checked: true });
    const importButton = h("button", { type: "button", class: "primary", id: "kdbx-import" });
    const error = h("p", { class: "error", role: "alert" });
    const toImport = () => entries.length - (skip.checked ? duplicates : 0);
    const label = () => {
      importButton.textContent = toImport() > 0 ? `Import ${toImport()} entries` : "Nothing to import";
      importButton.disabled = toImport() === 0;
    };
    skip.addEventListener("change", label);
    label();
    importButton.addEventListener("click", () =>
      busy(
        importButton,
        async () => {
          const imported = toImport();
          await ctx.save(importEntries(entries, skip.checked));
          ctx.close({ imported });
        },
        (e) => (error.textContent = e.message),
      ),
    );
    const line = (text, id) => h("li", id ? { id } : {}, text);
    show(
      card(
        "Ready to import",
        h("p", { id: "kdbx-format" }, format),
        h(
          "ul",
          { id: "kdbx-summary" },
          line(`Entries found: ${entries.length}`, "kdbx-found"),
          line(`Already in your vault (duplicates): ${duplicates}`, "kdbx-duplicates"),
          stats.recycleBin > 0 && line(`In the recycle bin, skipped: ${stats.recycleBin}`, "kdbx-recycle-bin"),
          stats.attachments > 0 && line(`Attachments, not imported: ${stats.attachments}`, "kdbx-attachments"),
          stats.references > 0 && line(`Entries with field references ({REF:…}), imported as plain text: ${stats.references}`, "kdbx-references"),
          stats.notesCut.length > 0 && line(`Notes cut to 64 KiB: ${stats.notesCut.join(", ")}`, "kdbx-notes-cut"),
        ),
        h("p", { class: "muted" }, "Groups and custom fields are added to each entry's notes."),
        h("label", { class: "check" }, skip, "Skip duplicates"),
        error,
        h("div", { class: "actions" }, importButton, h("button", { type: "button", id: "import-cancel", onclick: () => ctx.close(null) }, "Cancel")),
      ),
    );
  }

  showForm();
  return root;
}
