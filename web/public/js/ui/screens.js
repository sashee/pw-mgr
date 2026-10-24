// The screens (SPEC §9.1). Each returns an element; actions are passed in, nothing here talks to the server.

import { blankEntry, changedFields, entryErrors, linkableUrl, searchEntries, urlHost } from "../lib/vault.js";
import { parseRecoveryKey } from "../../sdk/recovery-key.js";
import { parseSetupInput } from "../../sdk/setup-link.js";
import { CLASSES, describe, generatePassword, MAX_LENGTH, MIN_LENGTH, normalizeOptions } from "../lib/password.js";
import { formatBytes, summary } from "../../sdk/maintenance.js";
import { copySecret } from "./clipboard.js";
import { busy, h, replaceChildren } from "./dom.js";

const section = (title, ...children) => h("section", { class: "card" }, h("h2", {}, title), ...children);

/** A button that runs an async action, disabled while it runs. */
const actionButton = (label, action, onError, props = {}) => {
  const button = h("button", { type: "button", ...props }, label);
  button.addEventListener("click", () => busy(button, action, onError));
  return button;
};

/** A copy button that says "Copied" for 2 seconds. */
function copyButton(label, getText, onError) {
  const button = h("button", { type: "button", class: "copy", "data-copy": label }, label);
  button.addEventListener("click", async () => {
    try {
      await copySecret(getText());
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 2000);
    } catch (error) {
      onError(error);
    }
  });
  return button;
}

export const loading = (text) => section(text, h("p", { class: "muted" }, "Please wait…"));

export const message = ({ title, text, actions = [] }) => section(title, h("p", {}, text), h("div", { class: "actions" }, actions));

export function unlock({ hasSession, onPasskey, onRecovery, onSetup, onError }) {
  // For browsers without an address bar (the Android app): paste the setup link or token here.
  const setupInput = h("input", { id: "setup-input", autocomplete: "off", spellcheck: "false", placeholder: "Setup link or token" });
  const problem = h("p", { class: "error", role: "alert" });
  const useSetup = async () => {
    const token = parseSetupInput(setupInput.value);
    problem.textContent = token ? "" : "That isn't a setup link or token.";
    if (token) await onSetup(token);
  };
  return h(
    "div",
    {},
    section(
      "Unlock your vault",
      h("p", {}, "Use your passkey to unlock."),
      h("div", { class: "actions" }, actionButton("Unlock with passkey", onPasskey, onError, { class: "primary", id: "unlock" }), hasSession && h("button", { type: "button", onclick: onRecovery }, "Use recovery key")),
    ),
    section(
      "New here or on a new device?",
      h("p", { class: "muted" }, "Paste the setup link or token you got. On an existing vault you'll also need your recovery key."),
      h("label", {}, "Setup link or token", setupInput),
      problem,
      h("div", { class: "actions" }, actionButton("Continue", useSetup, onError, { id: "use-setup" })),
    ),
  );
}

export function createPasskey({ title, intro, defaultName, onCreate, onSkip, onError }) {
  const name = h("input", { id: "passkey-name", value: defaultName, maxlength: 64, required: true });
  return section(
    title,
    h("p", {}, intro),
    h("label", {}, "Passkey name", name),
    h("div", { class: "actions" }, actionButton("Create passkey", () => onCreate(name.value.trim() || defaultName), onError, { class: "primary", id: "create-passkey" }), onSkip && h("button", { type: "button", onclick: onSkip }, "Skip")),
  );
}

export const confirmPasskey = ({ onConfirm, onError }) =>
  section(
    "One more step",
    h("p", {}, "Your browser didn't return the passkey's key yet. Use the new passkey once more to set it up."),
    h("div", { class: "actions" }, actionButton("Use the new passkey", onConfirm, onError, { class: "primary", id: "confirm-passkey" })),
  );

export function showRecoveryKey({ keyText, onConfirm, onCancel, confirmLabel = "Create vault", onError }) {
  const confirmButton = actionButton(confirmLabel, onConfirm, onError, { class: "primary", id: "create-vault", disabled: true });
  const saved = h("input", { type: "checkbox", id: "saved-recovery-key", onchange: (e) => (confirmButton.disabled = !e.target.checked) });
  return section(
    "Your recovery key",
    h("p", {}, "Save this key somewhere safe, outside this browser. You need it to set up a new device or if you lose your passkeys. It is shown only once."),
    h("code", { class: "recovery-key", id: "recovery-key" }, keyText),
    h("div", { class: "actions" }, copyButton("Copy recovery key", () => keyText, onError)),
    h("label", { class: "check" }, saved, "I have saved my recovery key"),
    h("div", { class: "actions" }, confirmButton, onCancel && h("button", { type: "button", onclick: onCancel }, "Cancel")),
  );
}

export function enterRecoveryKey({ intro, onSubmit, onError }) {
  const input = h("textarea", { id: "recovery-key-input", rows: 2, autocomplete: "off", spellcheck: "false" });
  const problem = h("p", { class: "error", role: "alert" });
  const submit = async () => {
    const key = parseRecoveryKey(input.value);
    problem.textContent = key ? "" : "A recovery key is 64 hex characters.";
    if (key) await onSubmit(key);
  };
  return section(
    "Enter your recovery key",
    h("p", {}, intro),
    h("label", {}, "Recovery key", input),
    problem,
    h("div", { class: "actions" }, actionButton("Unlock", submit, onError, { class: "primary", id: "unlock-recovery" })),
  );
}

// ---------------------------------------------------------------- vault

export function vault({ entries, onNew, onEdit, onDelete, onHistory, onError }) {
  let query = "";
  let selectedId = null;
  const list = h("ul", { class: "entries", id: "entries" });
  const detail = h("div", { class: "detail", id: "detail" });
  const search = h("input", { type: "search", id: "search", placeholder: "Search", oninput: (e) => ((query = e.target.value), render()) });

  const select = (id) => {
    selectedId = id;
    render();
  };

  function row(entry) {
    return h(
      "li",
      { class: entry.id === selectedId ? "selected" : "", "data-entry": entry.title },
      h("button", { type: "button", class: "entry", onclick: () => select(entry.id) }, h("strong", {}, entry.title), h("span", { class: "muted" }, [entry.username, urlHost(entry.urls?.[0] ?? "")].filter(Boolean).join(" · "))),
      h("span", { class: "row-actions" }, entry.username && copyButton("Copy username", () => entry.username, onError), entry.password && copyButton("Copy password", () => entry.password, onError)),
    );
  }

  function render() {
    const shown = searchEntries(entries, query);
    replaceChildren(list, shown.length ? shown.map(row) : h("li", { class: "muted empty" }, entries.length ? "No matches" : "No entries yet"));
    const selected = entries.find((e) => e.id === selectedId);
    replaceChildren(detail, selected ? entryDetail(selected, { onEdit, onDelete, onHistory, onError }) : h("p", { class: "muted" }, "Select an entry"));
  }

  render();
  return h("div", { class: "vault" }, h("div", { class: "toolbar" }, search, h("button", { type: "button", class: "primary", id: "new-entry", onclick: onNew }, "New entry")), h("div", { class: "columns" }, list, detail));
}

function entryDetail(entry, { onEdit, onDelete, onHistory, onError }) {
  let shown = false;
  const password = h("code", { class: "password", id: "password" }, "••••••••");
  const toggle = h("button", { type: "button", onclick: () => ((shown = !shown), (password.textContent = shown ? entry.password : "••••••••"), (toggle.textContent = shown ? "Hide" : "Show")) }, "Show");
  const field = (label, ...value) => h("div", { class: "field" }, h("span", { class: "label" }, label), h("div", { class: "value" }, ...value));
  const deleteButton = actionButton("Delete", async () => {
    if (window.confirm(`Delete "${entry.title}"?`)) await onDelete(entry.id);
  }, onError);
  return h(
    "article",
    {},
    h("h2", {}, entry.title),
    entry.username && field("Username", h("span", { id: "username" }, entry.username), copyButton("Copy username", () => entry.username, onError)),
    entry.password && field("Password", password, toggle, copyButton("Copy password", () => entry.password, onError)),
    entry.urls?.length > 0 &&
      field(
        "URLs",
        h("ul", { class: "urls" }, entry.urls.map((url) => h("li", {}, linkableUrl(url) ? h("a", { href: linkableUrl(url), target: "_blank", rel: "noopener noreferrer" }, url) : url))),
      ),
    entry.notes && field("Notes", h("pre", { class: "notes" }, entry.notes)),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", id: "edit", onclick: () => onEdit(entry) }, "Edit"),
      entry.history?.length > 0 && h("button", { type: "button", id: "history", onclick: () => onHistory(entry) }, `History (${entry.history.length})`),
      deleteButton,
    ),
  );
}

export function editor({ entry, isNew, generatorOptions, onGeneratorOptions, onSave, onCancel, onError }) {
  const value = entry ?? blankEntry(crypto.randomUUID());
  // No spellcheck anywhere: with Chrome's enhanced spellcheck, the text would be sent to Google.
  const title = h("input", { id: "title", value: value.title, required: true, maxlength: 200, spellcheck: "false" });
  const username = h("input", { id: "username-input", value: value.username, autocomplete: "off", spellcheck: "false" });
  const password = h("input", { id: "password-input", type: "password", value: value.password, autocomplete: "new-password", spellcheck: "false" });
  const urls = h("textarea", { id: "urls", rows: 2, placeholder: "One URL per line", spellcheck: "false" });
  urls.value = (value.urls ?? []).join("\n");
  const notes = h("textarea", { id: "notes", rows: 6, spellcheck: "false" });
  notes.value = value.notes ?? "";
  const problems = h("ul", { class: "error", role: "alert" });
  const toggle = h("button", { type: "button", onclick: () => reveal(password.type === "password") }, "Show");
  const reveal = (shown) => {
    password.type = shown ? "text" : "password";
    toggle.textContent = shown ? "Hide" : "Show";
  };

  const generator = passwordGenerator({
    options: generatorOptions,
    onOptions: onGeneratorOptions,
    onUse: (generated) => {
      password.value = generated;
      reveal(true);
      generatorPanel.hidden = true;
    },
  });
  const generatorPanel = h("div", { hidden: true }, generator);
  const openGenerator = () => {
    generatorPanel.hidden = !generatorPanel.hidden;
    if (!generatorPanel.hidden) generator.regenerate();
  };

  const save = async () => {
    const updated = {
      ...value,
      title: title.value.trim(),
      username: username.value,
      password: password.value,
      urls: urls.value.split("\n").map((u) => u.trim()).filter(Boolean),
      notes: notes.value,
    };
    const errors = entryErrors(updated);
    replaceChildren(problems, errors.map((e) => h("li", {}, e)));
    if (errors.length === 0) await onSave(updated);
  };
  return section(
    isNew ? "New entry" : "Edit entry",
    h("label", {}, "Title", title),
    h("label", {}, "Username", username),
    h("label", {}, "Password", h("span", { class: "inline" }, password, toggle, h("button", { type: "button", id: "generate", onclick: openGenerator }, "Generate…"))),
    generatorPanel,
    h("label", {}, "URLs", urls),
    h("label", {}, "Notes", notes),
    problems,
    h("div", { class: "actions" }, actionButton("Save", save, onError, { class: "primary", id: "save" }), h("button", { type: "button", onclick: onCancel }, "Cancel")),
  );
}

// ---------------------------------------------------------------- settings (e2ee-store/sdk/SPEC.md §6.6–§6.11)

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

export function settings({ host, passkeys, slots, lastCleanup, onAddPasskey, onSetUp, onDeletePasskey, onAddDevice, onReplaceRecoveryKey, onTestRecoveryKey, onCleanup, onImport, onExplore, onBack, onError }) {
  const canUnlockCount = passkeys.filter((p) => slots.includes(p.id)).length;
  const passkeyRow = (p) => {
    const canUnlock = slots.includes(p.id);
    return h(
      "li",
      { "data-passkey": p.name },
      h("strong", {}, p.name),
      h("span", { class: "muted" }, ` · ${p.rp_id} · created ${when(p.created_at)} · last used ${when(p.last_used_at)}`),
      h("div", { class: "badges" }, p.current && h("span", { class: "badge" }, "this session"), h("span", { class: canUnlock ? "badge" : "badge warn" }, canUnlock ? "can unlock" : "not set up")),
      h(
        "div",
        { class: "actions" },
        !canUnlock && p.rp_id === host && actionButton("Set up", () => onSetUp(p), onError, { "data-action": "set-up" }),
        !canUnlock && p.rp_id !== host && h("span", { class: "muted" }, `Set it up on ${p.rp_id}`),
        actionButton("Delete", async () => {
          const last = canUnlock && canUnlockCount === 1;
          const warning = last ? " It's the last passkey that can unlock the vault: afterwards you'll need the recovery key." : "";
          if (window.confirm(`Delete the passkey "${p.name}"?${warning}`)) await onDeletePasskey(p);
        }, onError, { "data-action": "delete" }),
      ),
    );
  };
  return h(
    "div",
    { id: "settings-screen" },
    h("div", { class: "toolbar" }, h("button", { type: "button", id: "back", onclick: onBack }, "← Back to the vault")),
    section(
      "Passkeys",
      h("ul", { class: "passkeys", id: "passkeys" }, passkeys.map(passkeyRow)),
      h("div", { class: "actions" }, actionButton("Add a passkey on this device", onAddPasskey, onError, { id: "add-passkey" })),
    ),
    section(
      "Add a device",
      h("p", {}, "Creates a setup link for another device, valid for 15 minutes. On that device you'll also need your recovery key."),
      h("div", { class: "actions" }, actionButton("Create setup link", onAddDevice, onError, { id: "add-device" })),
    ),
    section(
      "Recovery key",
      recoveryKeyTest(onTestRecoveryKey, onError),
      h("p", {}, "Replace your recovery key, e.g. if you lost the old one. The old key stops working."),
      h("div", { class: "actions" }, actionButton("Create a new recovery key", onReplaceRecoveryKey, onError, { id: "replace-recovery-key" })),
    ),
    section(
      "Import",
      h("p", {}, "Move your entries over from a KeePass database (.kdbx)."),
      h("div", { class: "actions" }, actionButton("Import from KeePass", onImport, onError, { id: "import-keepass" })),
    ),
    section(
      "Storage",
      h("p", { class: "muted", id: "last-cleanup" }, lastCleanup ? `Last cleanup: ${summary(lastCleanup)}` : "No cleanup has run on this device yet."),
      h("div", { class: "actions" }, actionButton("Clean up now", onCleanup, onError, { id: "cleanup" })),
      h("p", {}, "See how the vault is stored: its files and directories, read-only."),
      h("div", { class: "actions" }, actionButton("Explore files", onExplore, onError, { id: "explore-files" })),
    ),
  );
}

export function setupLink({ token, expiresAt, links, onDone, onError }) {
  const fragment = `/#setup=${token}`;
  const countdown = h("p", { class: "muted", id: "setup-expiry" });
  const tick = () => {
    const left = Math.max(0, Date.parse(expiresAt) - Date.now());
    countdown.textContent = left > 0 ? `Valid for ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")} more.` : "Expired.";
    if (left > 0 && (countdown.isConnected || !countdown.dataset.started)) {
      countdown.dataset.started = "1";
      setTimeout(tick, 1000);
    }
  };
  tick();
  const row = (label, text, id) => h("div", { class: "field" }, h("span", { class: "label" }, label), h("div", { class: "value" }, h("code", { class: "wrap", id }, text), copyButton("Copy", () => text, onError)));
  return section(
    "Setup link",
    h("p", {}, "On the new device, paste this on the start page (or open the link), then enter your recovery key."),
    row("Token", token, "setup-token"),
    row("For an iroh address (append to it)", fragment, "setup-fragment"),
    links.map((link) => row("Link", link, null)),
    countdown,
    h("p", { class: "muted" }, "Anyone with this link and your recovery key can open your vault. Only send it to yourself."),
    h("div", { class: "actions" }, h("button", { type: "button", id: "done", onclick: onDone }, "Done")),
  );
}

export const confirmIdentity = ({ onConfirm, onCancel, onError }) =>
  section(
    "Confirm it's you",
    h("p", {}, "This needs a recent login. Use your passkey to continue."),
    h("div", { class: "actions" }, actionButton("Use passkey", onConfirm, onError, { class: "primary", id: "confirm-identity" }), h("button", { type: "button", onclick: onCancel }, "Cancel")),
  );

export function cleanupProgress() {
  const status = h("p", { id: "cleanup-status" }, "Starting…");
  return { element: section("Cleaning up", status), update: (text) => (status.textContent = text) };
}

export function cleanupReport({ report, onDone }) {
  const line = (label, value) => h("li", {}, h("span", { class: "label" }, `${label}: `), value);
  const count = ({ count, bytes }) => `${count} (${formatBytes(bytes)})`;
  return section(
    report.error ? "Cleanup stopped" : "Cleanup finished",
    h(
      "ul",
      { class: "report", id: "cleanup-report" },
      line("Blobs found", `${report.blobs_total} (${formatBytes(report.bytes_total)})`),
      line("Kept (current vault, keys and history)", count(report.kept)),
      line("Deleted", h("span", { id: "cleanup-deleted" }, count(report.deleted))),
      line("Too recent to delete (under 24 hours)", count(report.too_recent)),
      line("Passkey slots removed", String(report.slots_removed)),
      line("Failed", String(report.failed.length)),
      report.failed.map((f) => h("li", { class: "error" }, `${f.id.slice(0, 12)}…: ${f.error}`)),
      report.error && h("li", { class: "error" }, `Stopped: ${report.error}`),
    ),
    h("div", { class: "actions" }, h("button", { type: "button", id: "done", onclick: onDone }, "Done")),
  );
}

// ---------------------------------------------------------------- password generator (SPEC §9.4)

/**
 * KeePassXC-style generator: a live preview, length slider, character classes as toggle buttons and the
 * advanced options. Every change regenerates the preview and is reported through `onOptions`.
 * Returns the panel element, with a `regenerate()` method.
 */
function passwordGenerator({ options: initial, onOptions, onUse }) {
  let options = normalizeOptions(initial);
  const preview = h("code", { class: "generated", id: "generated" });
  const strengthText = h("span", { class: "strength", id: "generator-strength" });
  const problem = h("p", { class: "error", role: "alert" });
  const useButton = h("button", { type: "button", class: "primary", id: "use-password", onclick: () => onUse(preview.textContent) }, "Use this password");

  function regenerate() {
    try {
      preview.textContent = generatePassword(options);
      problem.textContent = "";
      useButton.disabled = false;
    } catch (error) {
      preview.textContent = "";
      problem.textContent = error.message;
      useButton.disabled = true;
    }
    const { bits, strength } = describe(options);
    strengthText.textContent = `${strength} · ${bits} bits`;
    strengthText.dataset.strength = strength.toLowerCase();
  }

  const update = (changes) => {
    options = normalizeOptions({ ...options, ...changes });
    onOptions(options);
    regenerate();
  };

  const slider = h("input", { type: "range", id: "generate-length-slider", min: MIN_LENGTH, max: MAX_LENGTH, value: options.length });
  const number = h("input", { type: "number", id: "generate-length", min: MIN_LENGTH, max: MAX_LENGTH, value: options.length });
  slider.addEventListener("input", () => {
    number.value = slider.value;
    update({ length: slider.value });
  });
  number.addEventListener("change", () => {
    update({ length: number.value });
    number.value = slider.value = options.length;
  });

  const classButton = (c) => {
    const button = h("button", { type: "button", class: "toggle", "data-class": c.id, "aria-pressed": String(options.classes.includes(c.id)), title: c.chars }, c.label);
    button.addEventListener("click", () => {
      const on = !options.classes.includes(c.id);
      button.setAttribute("aria-pressed", String(on));
      update({ classes: on ? [...options.classes, c.id] : options.classes.filter((id) => id !== c.id) });
    });
    return button;
  };
  const checkbox = (id, key, label) =>
    h("label", { class: "check" }, h("input", { type: "checkbox", id, checked: options[key], onchange: (e) => update({ [key]: e.target.checked }) }), label);
  const text = (id, key, label, placeholder) =>
    h("label", {}, label, h("input", { id, value: options[key], placeholder, autocomplete: "off", spellcheck: "false", oninput: (e) => update({ [key]: e.target.value }) }));

  const panel = h(
    "div",
    { class: "generator card", id: "generator" },
    h("div", { class: "preview" }, preview, h("button", { type: "button", id: "regenerate", title: "Generate another", onclick: regenerate }, "↻")),
    h("p", { class: "muted" }, "Strength: ", strengthText),
    problem,
    h("div", { class: "length" }, h("span", { class: "label" }, "Length"), slider, number),
    h("div", { class: "classes", role: "group", "aria-label": "Character types" }, CLASSES.map(classButton)),
    h(
      "details",
      { class: "advanced" },
      h("summary", {}, "Advanced"),
      checkbox("generate-exclude-look-alike", "excludeLookAlike", "Exclude look-alike characters (0 O o 1 l I |)"),
      checkbox("generate-every-group", "everyGroup", "Pick characters from every group"),
      text("generate-include", "include", "Also choose from", "e.g. €£"),
      text("generate-exclude", "exclude", "Do not include", "e.g. ^~"),
    ),
    h("div", { class: "actions" }, useButton),
  );
  panel.regenerate = regenerate;
  return panel;
}

// ---------------------------------------------------------------- entry history

const FIELD_LABELS = { title: "title", username: "username", password: "password", urls: "URLs", notes: "notes" };

/** Earlier versions of an entry, newest first, each with what changed after it and a restore button. */
export function entryHistory({ entry, onRestore, onBack, onError }) {
  const versionView = (version, index) => {
    const newer = index === 0 ? entry : entry.history[index - 1];
    const changed = changedFields(version, newer);
    let shown = false;
    const password = h("code", { class: "password" }, "••••••••");
    const toggle = h("button", { type: "button", onclick: () => ((shown = !shown), (password.textContent = shown ? version.password : "••••••••"), (toggle.textContent = shown ? "Hide" : "Show")) }, "Show");
    const field = (label, ...value) => h("div", { class: "field" }, h("span", { class: "label" }, label), h("div", { class: "value" }, ...value));
    return h(
      "li",
      { class: "version", "data-version": index },
      h("strong", {}, `Saved ${when(version.updated_at)}`),
      h("p", { class: "muted" }, changed.length ? `Afterwards changed: ${changed.map((f) => FIELD_LABELS[f]).join(", ")}` : "No differences"),
      field("Title", version.title),
      version.username && field("Username", version.username, copyButton("Copy username", () => version.username, onError)),
      version.password && field("Password", password, toggle, copyButton("Copy password", () => version.password, onError)),
      version.urls?.length > 0 && field("URLs", h("ul", { class: "urls" }, version.urls.map((url) => h("li", {}, url)))),
      version.notes && field("Notes", h("pre", { class: "notes" }, version.notes)),
      h(
        "div",
        { class: "actions" },
        actionButton("Restore this version", async () => {
          if (window.confirm("Restore this version? The current version goes into the history.")) await onRestore(version);
        }, onError, { "data-action": "restore" }),
      ),
    );
  };
  return h(
    "div",
    { id: "history-screen" },
    h("div", { class: "toolbar" }, h("button", { type: "button", id: "back", onclick: onBack }, "← Back to the vault")),
    section(
      `History of "${entry.title}"`,
      h("p", { class: "muted" }, "Earlier versions of this entry, newest first. The last 10 are kept."),
      h("ul", { class: "versions", id: "versions" }, entry.history.map(versionView)),
    ),
  );
}

/** Checks the recovery key the user wrote down against the vault (SPEC §9.1). The key isn't kept. */
function recoveryKeyTest(onTest, onError) {
  const input = h("input", { id: "test-recovery-key", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "64 hex characters" });
  const result = h("p", { id: "recovery-test-result", role: "status" });
  const test = async () => {
    const key = parseRecoveryKey(input.value);
    input.value = "";
    if (!key) return (result.textContent = "A recovery key is 64 hex characters.");
    const outcome = await onTest(key);
    result.textContent = {
      ok: "This recovery key opens your vault.",
      wrong: "This key does NOT open your vault. Check what you wrote down, or create a new recovery key.",
      missing: "The vault has no recovery slot on the server. Create a new recovery key.",
    }[outcome];
    result.className = outcome === "ok" ? "" : "error";
  };
  return h(
    "div",
    {},
    h("p", {}, "Check that the recovery key you saved still opens the vault."),
    h("label", {}, "Recovery key", input),
    h("div", { class: "actions" }, actionButton("Test recovery key", test, onError, { id: "test-recovery" })),
    result,
  );
}
