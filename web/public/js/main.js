// Startup and the screen state machine. The only long-lived state is the unlocked session; locking reloads
// the page so the keys and plaintext leave memory (SPEC §7.12).

import * as api from "./api.js";
import * as flows from "./flows.js";
import { UserFacingError } from "./passkeys.js";
import { WrongKeyError } from "./lib/keys.js";
import { isDue } from "./lib/maintenance.js";
import { formatRecoveryKey, generateRecoveryKey } from "./lib/recovery-key.js";
import { parseSetupFragment } from "./lib/setup-link.js";
import { contentOf, deleteEntry, rollbackCheck, upsertEntry } from "./lib/vault.js";
import { h, replaceChildren } from "./ui/dom.js";
import * as screens from "./ui/screens.js";

const INACTIVITY_LOCK_MS = 15 * 60 * 1000;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const warnings = document.getElementById("warnings");
const lockButton = document.getElementById("lock");
const settingsButton = document.getElementById("settings");

/** The unlocked session (flows.js), plus `rollback` when the vault looked older than expected. */
let session = null;

const show = (screen) => {
  replaceChildren(app, screen);
  window.scrollTo(0, 0);
};

function showError(error) {
  console.error(error);
  const text =
    error instanceof UserFacingError || error instanceof WrongKeyError || error instanceof api.IntegrityError || error instanceof api.ApiError
      ? error.message
      : `Something went wrong: ${error?.message ?? error}`;
  replaceChildren(banner, h("p", { class: "banner error", role: "alert" }, text, " ", h("button", { type: "button", onclick: clearBanner }, "Dismiss")));
}

function showNotice(text) {
  replaceChildren(banner, h("p", { class: "banner notice", role: "status", id: "notice" }, text, " ", h("button", { type: "button", onclick: clearBanner }, "Dismiss")));
}

const clearBanner = () => replaceChildren(banner);

/** Wraps an action so the banner is cleared first and errors land in it. */
const action = (fn) => async (...args) => {
  clearBanner();
  await fn(...args);
};

// ---------------------------------------------------------------- per-device memory (localStorage)

const remembered = {
  get: (key) => {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
};
const revisionKey = () => `pw-mgr/${session.user.id}/highest-revision`;
const cleanupKey = () => `pw-mgr/${session.user.id}/last-cleanup`;
const GENERATOR_KEY = "pw-mgr/generator";

// ---------------------------------------------------------------- locking

async function lock() {
  session = null;
  await api.logout().catch(() => {});
  location.reload();
}

function watchInactivity() {
  let timer = setTimeout(lock, INACTIVITY_LOCK_MS);
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(lock, INACTIVITY_LOCK_MS);
  };
  for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, reset, { passive: true });
}

const defaultPasskeyName = () => `Passkey on ${location.hostname}`;

// ---------------------------------------------------------------- unlock

async function showUnlock() {
  const me = await api.me();
  show(
    screens.unlock({
      hasSession: me !== null,
      onPasskey: action(async () => handleUnlock(await flows.unlockWithPasskey())),
      onRecovery: action(async () => recover(await flows.loadKeys(), null)),
      onSetup: action(setup),
      onError: showError,
    }),
  );
}

async function handleUnlock(result) {
  if (result.kind === "unlocked") return openVault(result.session);
  if (result.kind === "no-vault") {
    return show(screens.message({ title: "No vault yet", text: "This account has no vault yet. Open a setup link to create one." }));
  }
  // A passkey without a slot: the recovery key unlocks, then this passkey gets its slot.
  return recover(result.keys, { credentialId: result.credentialId, prfOutput: result.prfOutput });
}

/** Unlocks with the recovery key; `passkey` (if known) gets a slot afterwards, otherwise a new one is offered. */
function recover(keys, passkey) {
  if (!keys) return show(screens.message({ title: "No vault yet", text: "This account has no vault yet. Open a setup link to create one." }));
  show(
    screens.enterRecoveryKey({
      intro: passkey ? "This passkey isn't set up for the vault yet. Enter your recovery key to set it up." : "Enter your recovery key to open your vault on this device.",
      onSubmit: action(async (recoveryKey) => {
        const unlocked = await flows.unlockWithRecoveryKey(keys, recoveryKey);
        if (passkey) return openVault(await flows.addPasskeySlot(unlocked, passkey.credentialId, passkey.prfOutput));
        offerPasskey(unlocked);
      }),
      onError: showError,
    }),
  );
}

/** After a recovery-key unlock: set up a passkey on this device, or skip. */
function offerPasskey(unlocked) {
  show(
    screens.createPasskey({
      title: "Create a passkey on this device",
      intro: "With a passkey you can unlock here without the recovery key.",
      defaultName: defaultPasskeyName(),
      onCreate: action(async (name) => {
        const registered = await flows.registerPasskey(name);
        await withPrf(registered, async (prfOutput) => openVault(await flows.addPasskeySlot(unlocked, registered.credentialId, prfOutput)));
      }),
      onSkip: () => openVault(unlocked),
      onError: showError,
    }),
  );
}

/** Calls `next` with the new passkey's PRF output, asking for one more prompt if registration didn't give it. */
async function withPrf(registered, next) {
  if (registered.prfOutput) return next(registered.prfOutput);
  show(screens.confirmPasskey({ onConfirm: action(async () => next(await flows.prfFromPasskey(registered.credentialId))), onError: showError }));
}

// ---------------------------------------------------------------- setup links

async function setup(token) {
  show(screens.loading("Checking the setup link"));
  try {
    await api.exchangeSetupToken(token);
  } catch (error) {
    if (error.status === 401) {
      return show(screens.message({ title: "Setup link not valid", text: "This setup link has expired or was already used. Ask for a new one." }));
    }
    throw error;
  }
  const keys = await flows.loadKeys();
  if (keys) return recover(keys, null);
  show(
    screens.createPasskey({
      title: "Create your vault",
      intro: "First, create a passkey on this device. It unlocks your vault.",
      defaultName: defaultPasskeyName(),
      onCreate: action(async (name) => {
        const registered = await flows.registerPasskey(name);
        await withPrf(registered, (prfOutput) => showNewRecoveryKey({ ...registered, prfOutput }));
      }),
      onError: showError,
    }),
  );
}

function showNewRecoveryKey(passkey) {
  const secrets = flows.newSecrets();
  show(
    screens.showRecoveryKey({
      keyText: formatRecoveryKey(secrets.recoveryKey),
      onConfirm: action(async () => {
        const result = await flows.createVault({ ...secrets, ...passkey });
        if (result.kind === "created") return openVault(result.session);
        show(
          screens.message({
            title: "A vault already exists",
            text: "Another device created the vault in the meantime. Unlock it with your recovery key instead.",
            actions: [h("button", { type: "button", onclick: () => location.reload() }, "Continue")],
          }),
        );
      }),
      onError: showError,
    }),
  );
}

// ---------------------------------------------------------------- the vault

/** SPEC §7.5: compares the vault's revision with the highest this device has seen. */
function checkRevision(revision) {
  const seen = remembered.get(revisionKey());
  const { rolledBack, highest } = rollbackCheck(seen, revision);
  if (!rolledBack) remembered.set(revisionKey(), highest);
  return rolledBack ? { seen, got: revision } : null;
}

function showWarnings() {
  const rollback = session?.rollback;
  replaceChildren(
    warnings,
    rollback &&
      h(
        "p",
        { class: "banner warn", role: "alert", id: "rollback-warning" },
        `The server returned an older version of your vault (revision ${rollback.got}; this device has seen ${rollback.seen}). Recent changes may be missing, so saving is paused. `,
        h("button", { type: "button", id: "acknowledge-rollback", onclick: acknowledgeRollback }, "Continue anyway"),
      ),
  );
}

function acknowledgeRollback() {
  remembered.set(revisionKey(), session.vault.doc.revision);
  session = { ...session, rollback: null };
  showWarnings();
}

function openVault(unlocked) {
  const first = session === null;
  session = unlocked;
  session = { ...session, rollback: checkRevision(session.vault.doc.revision) };
  showWarnings();
  lockButton.hidden = false;
  settingsButton.hidden = false;
  if (first) {
    watchInactivity();
    if (isDue(remembered.get(cleanupKey()), Date.now())) automaticCleanup();
  }
  showVault();
}

/** Saves a vault operation and returns the document it was applied to (to detect concurrent edits). */
async function save(operation) {
  if (session.rollback) throw new UserFacingError("Saving is paused until you continue past the warning about an older vault.");
  const { session: saved, base } = await flows.saveVault(session, operation);
  session = { ...saved, rollback: null };
  checkRevision(session.vault.doc.revision);
  return base;
}

function showVault() {
  show(
    screens.vault({
      entries: session.vault.doc.entries,
      onNew: () => showEditor(null),
      onEdit: (entry) => showEditor(entry),
      onDelete: action(async (id) => {
        await save(deleteEntry(id));
        showVault();
      }),
      onHistory: (entry) => showHistory(entry),
      onError: showError,
    }),
  );
}

function showHistory(entry) {
  show(
    screens.entryHistory({
      entry,
      onRestore: action(async (version) => {
        await save(upsertEntry({ ...entry, ...contentOf(version) }));
        showVault();
        showNotice(`Restored the version of "${version.title}" saved ${new Date(version.updated_at).toLocaleString()}. The replaced version is in the history.`);
      }),
      onBack: showVault,
      onError: showError,
    }),
  );
}

function showEditor(entry) {
  show(
    screens.editor({
      entry,
      isNew: entry === null,
      // The generator's settings are remembered on this device; they aren't secret.
      generatorOptions: remembered.get(GENERATOR_KEY) ?? undefined,
      onGeneratorOptions: (options) => remembered.set(GENERATOR_KEY, options),
      onSave: action(async (updated) => {
        const base = await save(upsertEntry(updated));
        showVault();
        const before = base.entries.find((e) => e.id === updated.id);
        if (entry && before && before.updated_at !== entry.updated_at) {
          showNotice("This entry was also changed on another device; your version was saved. The other version is still in the vault's history.");
        }
      }),
      onCancel: showVault,
      onError: showError,
    }),
  );
}

// ---------------------------------------------------------------- settings

/** Runs `fn`; if the server wants a recent login first (backend SPEC §6.5), asks for one and runs it again. */
async function withStepUp(fn) {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof api.ApiError && error.code === "reauth_required")) throw error;
    return new Promise((resolve, reject) => {
      show(
        screens.confirmIdentity({
          onConfirm: async () => {
            await flows.reauthenticate();
            fn().then(resolve, reject);
          },
          onCancel: () => {
            showSettings().then(resolve, reject);
          },
          onError: showError,
        }),
      );
    });
  }
}

async function showSettings() {
  show(screens.loading("Loading settings"));
  // The keys may have changed on another device (e.g. it added its passkey's slot) since this session loaded them.
  const [{ passkeys }, keys] = await Promise.all([api.passkeys(), flows.loadKeys()]);
  session = { ...session, keys };
  show(
    screens.settings({
      host: location.hostname,
      passkeys,
      slots: Object.keys(session.keys.doc.passkeys),
      lastCleanup: remembered.get(cleanupKey()),
      onAddPasskey: action(async () => showAddPasskey()),
      onSetUp: action(async (passkey) => {
        session = await flows.addPasskeySlot(session, passkey.id, await flows.prfFromPasskey(passkey.id));
        await showSettings();
        showNotice(`"${passkey.name}" can now unlock the vault.`);
      }),
      onDeletePasskey: action((passkey) => withStepUp(() => deletePasskey(passkey))),
      onAddDevice: action(() => withStepUp(addDevice)),
      onReplaceRecoveryKey: action(async () => replaceRecoveryKey()),
      onCleanup: action(manualCleanup),
      // The KeePass import is a separate module, loaded only when used (web SPEC §8.5).
      onImport: action(async () => {
        const { openImportScreen } = await import("./import-kdbx/index.js");
        openImportScreen(app, {
          entries: session.vault.doc.entries,
          save: (operation) => save(operation),
          close: (result) => {
            showVault();
            if (result) showNotice(`Imported ${result.imported} entries from KeePass.`);
          },
        });
      }),
      onBack: showVault,
      onError: showError,
    }),
  );
}

function showAddPasskey() {
  show(
    screens.createPasskey({
      title: "Add a passkey on this device",
      intro: "The new passkey can unlock the vault on this device.",
      defaultName: defaultPasskeyName(),
      onCreate: action((name) =>
        withStepUp(async () => {
          const registered = await flows.registerPasskey(name);
          await withPrf(registered, async (prfOutput) => {
            session = await flows.addPasskeySlot(session, registered.credentialId, prfOutput);
            await showSettings();
            showNotice(`"${name}" was added.`);
          });
        }),
      ),
      onSkip: () => showSettings(),
      onError: showError,
    }),
  );
}

async function deletePasskey(passkey) {
  await api.deletePasskey(passkey.id);
  // Deleting the passkey this session was created with ends the session; cleanup removes its slot later.
  if (passkey.current) return lock();
  if (session.keys.doc.passkeys[passkey.id]) session = await flows.removePasskeySlot(session, passkey.id);
  await showSettings();
  showNotice(`"${passkey.name}" was deleted.`);
}

async function addDevice() {
  const created = await api.createSetupToken();
  show(screens.setupLink({ token: created.token, expiresAt: created.expires_at, links: created.links, onDone: () => showSettings().catch(showError), onError: showError }));
}

function replaceRecoveryKey() {
  const recoveryKey = generateRecoveryKey();
  show(
    screens.showRecoveryKey({
      keyText: formatRecoveryKey(recoveryKey),
      confirmLabel: "Use this recovery key",
      onConfirm: action(async () => {
        session = await flows.replaceRecoveryKey(session, recoveryKey);
        await showSettings();
        showNotice("The recovery key was replaced. The old one no longer works.");
      }),
      onCancel: () => showSettings().catch(showError),
      onError: showError,
    }),
  );
}

async function manualCleanup() {
  const progress = screens.cleanupProgress();
  show(progress.element);
  const { session: next, report } = await flows.maintain(session, "manual", progress.update);
  session = { ...session, keys: next.keys };
  remembered.set(cleanupKey(), report);
  show(screens.cleanupReport({ report, onDone: () => showSettings().catch(showError) }));
}

/** In the background after the first unlock, at most once a day per device; failures are retried next time. */
async function automaticCleanup() {
  const { session: next, report } = await flows.maintain(session, "automatic");
  if (session) {
    session = { ...session, keys: next.keys };
    remembered.set(cleanupKey(), report);
  }
}

// ---------------------------------------------------------------- start

api.setUnauthenticatedHandler(() => {
  if (session) lock();
});
lockButton.addEventListener("click", lock);
settingsButton.addEventListener("click", () => {
  clearBanner();
  showSettings().catch(showError);
});

async function start() {
  const token = parseSetupFragment(location.hash);
  if (token) {
    history.replaceState(null, "", location.pathname + location.search);
    return setup(token);
  }
  return showUnlock();
}

start().catch(showError);
