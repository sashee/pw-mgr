// Startup and the screen state machine. The only long-lived state is the unlocked session; locking reloads
// the page so the keys and plaintext leave memory (SPEC §7.4).

import * as api from "../sdk/api.js";
import { flows } from "./flows.js";
import { UserFacingError } from "../sdk/passkeys.js";
import { RollbackError, rollbackCheck } from "../sdk/save.js";
import { WrongKeyError } from "../sdk/keys.js";
import { isDue } from "../sdk/maintenance.js";
import { formatRecoveryKey, generateRecoveryKey } from "../sdk/recovery-key.js";
import { parseSetupFragment } from "../sdk/setup-link.js";
import { contentOf, decodeVault, deleteEntry, newVault, readVault, saveSteps, snapshotName, upsertEntry, VAULT } from "./lib/vault.js";
import { h, replaceChildren } from "./ui/dom.js";
import * as screens from "./ui/screens.js";

const INACTIVITY_LOCK_MS = 15 * 60 * 1000;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const warnings = document.getElementById("warnings");
const lockButton = document.getElementById("lock");
const settingsButton = document.getElementById("settings");

/**
 * The unlocked session (flows.js), plus `vault`: { doc, writable }, the document in its tree; and `rollback` when the
 * vault looked older than expected.
 */
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
// Filed under an ID derived from the master key, not the user ID the server reports (flows.js).
const revisionKey = () => `pw-mgr/${session.stateId}/highest-revision`;
const cleanupKey = () => `pw-mgr/${session.stateId}/last-cleanup`;
const GENERATOR_KEY = "pw-mgr/generator";

// ---------------------------------------------------------------- locking

async function lock() {
  session = null;
  await api.logout().catch(() => {});
  location.reload();
}

/** Shows the Lock button: from the moment a secret (the master key, a PRF output) is in memory. */
const holdingSecrets = () => {
  lockButton.hidden = false;
};

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

/** A vault whose keys are missing on the server (e2ee-store SDK SPEC §6.2). Creating a new one would get new keys, and
 * the existing vault could never be opened again. */
const showKeysMissing = () =>
  show(
    screens.message({
      title: "The vault's keys are missing",
      text: "This account has a vault, but its keys are missing on the server. Don't create a new vault: restore the server's data from a backup first.",
    }),
  );

async function handleUnlock(result) {
  if (result.kind === "unlocked") return openVault(result.session);
  if (result.kind === "no-vault") {
    return show(screens.message({ title: "No vault yet", text: "This account has no vault yet. Open a setup link to create one." }));
  }
  if (result.kind === "keys-missing") return showKeysMissing();
  // A passkey without a slot: the recovery key unlocks, then this passkey gets its slot.
  holdingSecrets();
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
        holdingSecrets();
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
  if (await api.getRef("vault")) return showKeysMissing();
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
  holdingSecrets();
  show(
    screens.showRecoveryKey({
      keyText: formatRecoveryKey(secrets.recoveryKey),
      onConfirm: action(async () => {
        const result = await flows.createVault({ ...secrets, ...passkey });
        if (result.kind === "created") return openVault(result.session);
        if (result.kind === "keys-missing") return showKeysMissing();
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

/** SPEC §7.3: compares the vault's revision with the highest this device has seen. */
function checkRevision(revision) {
  const seen = remembered.get(revisionKey());
  const { rolledBack, highest } = rollbackCheck(seen, revision);
  if (!rolledBack) remembered.set(revisionKey(), highest);
  return rolledBack ? { seen, got: revision } : null;
}

const readAll = async (opened) => new Uint8Array(await new Response((await opened).stream).arrayBuffer());

/** The document in the file `name` at the root of a session's tree; null if there is none. */
async function readDocument(s, name) {
  const entry = (await flows.list(s, [])).find((e) => e.name === name);
  return entry ? readVault(decodeVault(await readAll(flows.read(s, entry)))) : null;
}

/** The vault in a session's tree (SPEC §5): a new, empty one until the first save writes the file. */
async function loadVault(s) {
  const vault = (await readDocument(s, VAULT[0])) ?? { doc: newVault(), writable: true };
  return { doc: vault.doc, writable: vault.writable && s.root.writable };
}

function showWarnings() {
  const rollback = session?.rollback;
  // SPEC §6: a newer format opens read-only, and says so up front rather than at the first save.
  const readOnly = session && (!session.vault.writable || !session.keys.writable);
  replaceChildren(
    warnings,
    rollback &&
      h(
        "p",
        { class: "banner warn", role: "alert", id: "rollback-warning" },
        `The server returned an older version of your vault (revision ${rollback.got}; this device has seen ${rollback.seen}). Recent changes may be missing, so saving is paused. `,
        h("button", { type: "button", id: "acknowledge-rollback", onclick: acknowledgeRollback }, "Continue anyway"),
      ),
    readOnly &&
      h("p", { class: "banner warn", role: "status", id: "read-only-warning" }, "This vault was saved by a newer version of the app, so it's read-only here. Update the app to make changes."),
  );
}

function acknowledgeRollback() {
  remembered.set(revisionKey(), session.root.revision);
  session = { ...session, rollback: null };
  showWarnings();
}

async function openVault(unlocked) {
  const first = session === null;
  session = unlocked;
  session = { ...session, vault: await loadVault(session), rollback: checkRevision(session.root.revision) };
  showWarnings();
  holdingSecrets();
  settingsButton.hidden = false;
  if (first && !session.rollback && isDue(remembered.get(cleanupKey()), Date.now())) automaticCleanup();
  showVault();
}

/** Saves a vault operation and returns the document it was applied to (to detect concurrent edits). */
async function save(operation) {
  if (session.rollback) throw new UserFacingError("Saving is paused until you continue past the warning about an older vault.");
  if (!session.vault.writable) throw new UserFacingError("This vault was saved by a newer version of the app, so it's read-only here. Update the app to make changes.");
  try {
    const { session: saved } = await flows.save(session, saveSteps(operation, Date.now()));
    // A revision more than one ahead: another device saved in between, and the operation was applied to its version,
    // which this save kept as a snapshot.
    const conflicted = saved.root.revision > session.root.revision + 1;
    const base = (conflicted && (await readDocument(saved, snapshotName(saved.root.revision - 1)))?.doc) || session.vault.doc;
    session = { ...saved, vault: await loadVault(saved), rollback: checkRevision(saved.root.revision) };
    showWarnings();
    return base;
  } catch (error) {
    if (error instanceof RollbackError) {
      session = { ...session, rollback: { seen: session.root.revision, got: error.conflict.revision } };
      showWarnings();
    }
    throw error;
  }
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

/** Runs `fn`; if the server wants a recent login first (e2ee-store/backend/SPEC.md §6.5), asks for one and runs it again. */
async function withStepUp(fn) {
  try {
    return await fn();
  } catch (error) {
    // Too old a session, or one not created with a passkey (e.g. from a setup token): log in with a passkey.
    if (!(error instanceof api.ApiError && ["reauth_required", "passkey_session_required"].includes(error.code))) throw error;
    return new Promise((resolve, reject) => {
      show(
        screens.confirmIdentity({
          onConfirm: async () => {
            await flows.reauthenticate(session);
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
  if (keys) session = { ...session, keys };
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
      onTestRecoveryKey: (recoveryKey) => flows.testRecoveryKey(session, recoveryKey),
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
      // The file explorer is a separate module too, loaded only when used (web SPEC §9.5).
      onExplore: action(async () => {
        const { openExplorer } = await import("./explorer/index.js");
        openExplorer(app, {
          root: { revision: session.root.revision, blobId: session.root.blobId },
          list: (path) => flows.list(session, path),
          read: (entry) => readAll(flows.read(session, entry)),
          close: () => showSettings().catch(showError),
          onError: showError,
        });
      }),
      onBack: showVault,
      onError: showError,
    }),
  );
  if (!keys) showError(new UserFacingError("The vault's keys are missing on the server. Restore the server's data from a backup; this session still works until it's locked."));
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
  if (session.rollback) throw new UserFacingError("Cleanup is paused while the warning about an older vault is shown.");
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

// Any request that finds the session gone locks, whatever screen is showing.
api.setUnauthenticatedHandler(lock);
lockButton.addEventListener("click", lock);
settingsButton.addEventListener("click", () => {
  clearBanner();
  showSettings().catch(showError);
});

async function start() {
  // From the start, not just once the vault opens: secrets are in memory earlier on some paths.
  watchInactivity();
  const token = parseSetupFragment(location.hash);
  if (token) {
    history.replaceState(null, "", location.pathname + location.search);
    return setup(token);
  }
  return showUnlock();
}

start().catch(showError);
