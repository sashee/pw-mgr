# Password Manager Specification

Status: **Draft v0.4** (2026-10-10)

## 1. Purpose & scope

A web-based password manager. It runs entirely in the browser and stores its data, end-to-end encrypted, in the generic backend (`backend/SPEC.md`). The backend sees only opaque blobs and refs. Everything in this document is implemented in the frontend.

Scope for v1:

- One vault per user, made of entries. Each entry has a title, username, password, URLs and notes. A secure note is simply an entry that uses only the title and notes.
- The vault is unlocked with a passkey through the WebAuthn PRF extension.
- A recovery key is shown when the vault is created. It is also how a new device gets into the vault.
- Import from KeePass (`.kdbx`).
- Copy buttons for the username and the password.
- A cleanup button that shows what was removed.

Non-goals for v1:

- More than one vault per user.
- Other import formats, export, attachments, TOTP, folders and tags.
- Offline use, browser autofill, and live sync between open sessions.
- Sharing data between users.
- Rotating the master key.

## 2. Key decisions

| #   | Topic            | Decision |
|-----|------------------|----------|
| P1  | Format           | A custom JSON document, not KDBX. The whole vault is one encrypted blob. |
| P2  | Keys             | One random master key (MK) per user. The vault blob is encrypted with it. The keys blob is the only plaintext blob: it holds the MK wrapped once per passkey and once for the recovery key. |
| P3  | Refs             | Two refs: `vault` points to the vault blob and `keys` points to the keys blob. Both are updated with compare-and-swap. |
| P4  | Recovery key     | 32 random bytes, shown once as 64 hex characters with a copy button. It is used for recovery and for setting up new devices. |
| P5  | Concurrency      | Every change is one operation applied to the latest document with compare-and-swap. On conflict the operation is re-applied to the new document, so the last save of an entry wins. |
| P6  | History          | Each entry keeps its own last 10 versions, which can be viewed, copied and restored. The vault document also lists the IDs of the previous 19 vault blobs, a safety net for the whole vault. Maintenance runs on the client, automatically or from a button, and deletes everything that isn't referenced. |
| P7  | Locking          | Locking logs out and reloads the page. This happens on the Lock button, after 15 minutes of inactivity and when the session expires. |
| P8  | Tech stack       | Plain JavaScript (ES modules), HTML and CSS. No runtime dependencies and no build step. WebCrypto for cryptography. |
| P9  | KeePass import   | A read-only KDBX 3.1/4.x reader written for this app. It decrypts the file in the browser; the file is never uploaded. The primitives WebCrypto lacks (Argon2, ChaCha20, Salsa20) are implemented here, so there is still no dependency. It is meant for a one-time migration: a self-contained, lazy-loaded module that can be deleted without touching the rest of the app (§8.5). |

## 3. Architecture

- **Serving:** the backend serves the files in `web/public/` from its `static_dir`, so the app always runs on the same origin as the API.
- **Origins:** on the iroh path that's `http://localhost:PORT` or `http://<label>.localhost:PORT`; on the direct path it's `https://<public host>`.
- **Routing:** the app has no URL routes. Screen state lives in memory. The URL fragment is used only for setup links (§7.2).
- **Pure core:** the logic lives in pure modules (`js/lib/`) that have no DOM access and make no network calls. Network, WebAuthn, the DOM, timers and workers stay in thin edge modules.

```
web/
  SPEC.md
  public/                 served as static_dir
    index.html
    style.css
    js/
      main.js             startup, screen state machine
      flows.js            the flows of §7 on top of the API, WebAuthn and lib/ (no DOM)
      api.js              backend client (fetch, error mapping, Date header)
      passkeys.js         WebAuthn ceremonies + PRF
      lib/                pure modules
        crypto.js         HKDF, AES-GCM, base64url, hex, SHA-256
        envelope.js       vault blob encryption
        keys.js           keys document, wrap/unwrap, operations
        vault.js          vault document validation and operations
        recovery-key.js   generation and parsing
        password.js       password generator
        maintenance.js    cleanup plan and report
        save.js           compare-and-swap with retries (§7.4); I/O passed in
        setup-link.js     parse and build setup fragments
      ui/                 screens and components
      import-kdbx/        KeePass import: self-contained, lazy-loaded, removable (§8)
        index.js          the only entry point: openImportScreen(container, ctx)
        screen.js         import UI (pickers, progress, preview)
        operation.js      the importEntries vault operation
        container.js      headers, key derivation, decryption, integrity checks
        keyfile.js        key file formats
        aes-kdf.js        AES-KDF on top of WebCrypto AES-CBC
        argon2.js         Argon2d / Argon2id
        blake2b.js        BLAKE2b (used by Argon2)
        chacha20.js       ChaCha20 (KDBX 4 cipher and inner stream)
        salsa20.js        Salsa20 (KDBX 3.1 inner stream)
        entries.js        KeePass XML → vault entries
        kdf-worker.js     runs the key derivation off the main thread
  test/
    unit/                 node --test
      import-kdbx/        tests for the import module only
    e2e/                  Playwright (Python, like monitoring-platform): test_flows.py; import tests in their own file
```

## 4. Cryptography

### 4.1 Keys

All derivations use HKDF-SHA256 with an empty salt.

| Key             | Origin | Purpose |
|-----------------|--------|---------|
| Master key (MK) | 32 random bytes, generated when the vault is created | Root key. It is never stored unwrapped. |
| Content key     | `HKDF(ikm = MK, info = "pw-mgr/content/v1")` | Encrypts the vault blob |
| Passkey KEK     | `HKDF(ikm = PRF output, info = "pw-mgr/kek/passkey/v1")` | Wraps the MK for one passkey |
| Recovery KEK    | `HKDF(ikm = recovery key, info = "pw-mgr/kek/recovery/v1")` | Wraps the MK for the recovery key |

- **Algorithms:** all derived keys are AES-256-GCM `CryptoKey`s and are non-extractable. Every encryption uses a fresh random 12-byte nonce.
- **The MK in memory:** while the vault is unlocked, the MK is held as raw bytes, because it has to be wrapped again whenever a passkey is added. Locking discards it by reloading the page.
- **PRF input:** a constant, `prf.eval.first = UTF-8("pw-mgr/prf/v1")`. Login uses discoverable credentials, so the client doesn't know which credential will answer and can't choose a different input per credential. The PRF output is still unique to each passkey.
- **No key stretching:** the recovery key is 32 random bytes, so HKDF is enough.

### 4.2 Vault blob

```
nonce (12 bytes) ‖ AES-256-GCM ciphertext ‖ tag (16 bytes)
```

- **Encryption:** the content key, with AAD `UTF-8("pw-mgr/vault/v1")`.
- **Plaintext:** the UTF-8 JSON vault document (§6), padded with spaces (`0x20`) to a multiple of 4096 bytes. JSON ignores trailing whitespace, and the padding hides small changes in size.
- **Nothing in plaintext:** apart from the nonce, nothing is readable without the MK. That includes the format version and the links to earlier versions. The format of this blob is identified by the keys document's `version` (§4.3).
- **Integrity:** every downloaded blob is checked with `SHA-256(bytes) == blob ID` before use. A mismatch or a failed decryption is an integrity error and is shown to the user; the data is never used.

### 4.3 Keys blob

The keys blob is plaintext JSON. Its secret parts are the wrapped keys.

```json
{
  "format": "pw-mgr/keys",
  "version": 1,
  "recovery": { "nonce": "…", "wrapped_key": "…", "created_at": "…" },
  "passkeys": {
    "<credential id>": { "nonce": "…", "wrapped_key": "…", "created_at": "…" }
  }
}
```

- **Keyslots:** each slot holds the MK encrypted with AES-256-GCM using the KEK for its kind (§4.1).
  - The AAD is `UTF-8("pw-mgr/keys/v1/<kind>")`, where `kind` is `recovery` or `passkey`.
  - Nonces and wrapped keys are base64url. A wrapped key is the 32-byte MK plus the 16-byte tag.
- **Slot names:** passkey slots are named by the credential ID as the browser returns it in `credential.id` (base64url).
- **Wrong keys:** a wrong key fails GCM authentication. For example, a mistyped recovery key produces "wrong recovery key".
- **Versioning:**
  - `version` covers both this document and the vault blob format.
  - Unknown fields are preserved when the document is rewritten.
  - A `version` greater than 1 makes the app refuse to write anything and ask to be updated.

### 4.4 Recovery key

- **Generation:** 32 random bytes, shown as 64 lowercase hex characters with a copy button.
- **Input:** whitespace is removed and the text is lowercased. Anything that isn't exactly 64 hex characters is rejected before any decryption is attempted.
- **Uses:**
  - recovery after losing all passkeys
  - setting up a new device that has no usable passkey (§7.8)

## 5. Storage layout

| Ref     | Points to | Changes |
|---------|-----------|---------|
| `keys`  | The keys blob (plaintext JSON, §4.3) | Created with the vault. Updated by compare-and-swap when passkeys or the recovery key change. |
| `vault` | The current vault blob (encrypted, §4.2) | Created with the vault. Updated by compare-and-swap on every save. |

- **Other blobs:** all other blobs are older vault versions (listed in the vault's `history`) or replaced keys blobs. Maintenance deletes the ones nothing needs (§7.11).
- **Existence:** the `keys` ref is the sign that a vault exists. It is written first when the vault is created (§7.3).

## 6. Vault document

```json
{
  "format": "pw-mgr/vault",
  "version": 1,
  "revision": 42,
  "saved_at": "2026-10-09T21:00:00.000Z",
  "history": ["<blob id of revision 41>", "<blob id of revision 40>"],
  "entries": [
    {
      "id": "3f1c2a9e-…",
      "title": "GitHub",
      "username": "alice",
      "password": "…",
      "urls": ["https://github.com/login"],
      "notes": "",
      "created_at": "2026-10-01T10:00:00.000Z",
      "updated_at": "2026-10-09T21:00:00.000Z",
      "history": [
        { "title": "GitHub", "username": "alice", "password": "…", "urls": [], "notes": "", "created_at": "…", "updated_at": "2026-10-05T08:00:00.000Z" }
      ]
    }
  ]
}
```

- **`revision`** starts at 1 and increases by exactly 1 with every save.
- **`history`** holds the blob IDs of earlier versions, newest first, at most 19 of them. Together with the current version, 20 versions are kept.
- **`id`** is a UUIDv4 from `crypto.randomUUID()`.
- **`title`** is required, 1–200 characters. All other string fields may be empty, and `notes` can be up to 64 KiB.
- **Entry `history`** (optional) holds the entry's earlier versions, newest first, at most 10. Each version is a copy of the entry as it was (all fields, including unknown ones and its `updated_at`), without `id` and without its own history.
- **`urls`** is a list of strings. Any string is stored, but only `http:` and `https:` URLs are shown as links (§9.2).
- **Order:** entries are stored in any order. The UI sorts them by title.
- **Forward compatibility:**
  - Unknown fields on the document and on entries are preserved when the vault is rewritten.
  - A document with `version` greater than 1 opens read-only, with a message saying the app needs updating.

## 7. Flows

### 7.1 Unlock with a passkey

1. `POST /auth/login/start`. The client adds `extensions.prf.eval.first = PRF_INPUT` to the options and calls `navigator.credentials.get()`. This is the only prompt.
2. It reads the PRF output from `getClientExtensionResults().prf.results.first`. If there is none, it stops: "This passkey can't unlock the vault (no PRF support)".
3. It deletes `clientExtensionResults.prf` from the credential JSON and calls `POST /auth/login/finish`, which creates the session.
4. It loads the keys blob (`GET /refs/keys`, then the blob) and unwraps the MK from `passkeys[credential.id]`.
   - If there is no such slot: "This passkey isn't set up for the vault yet". The client offers to unlock with the recovery key, which then sets the passkey up (§7.9).
5. It loads the vault blob, verifies and decrypts it, and checks for rollback (§7.5).
   - If `keys` exists but `vault` doesn't, a vault creation was interrupted. The client creates an empty vault with `If-None-Match: *`.

When the app starts, it calls `GET /me`.
- **401:** it shows the unlock screen.
- **Valid session but no MK in memory** (after a reload or an interrupted setup): it shows the unlock screen with a second option, "Use recovery key". A passkey unlock still logs in again, which replaces the session.

### 7.2 Setup links

A setup link has the form `<origin>/#setup=<token>`, where the token is the backend's setup token.

When the app starts with a fragment:

1. It reads the token and immediately removes the fragment with `history.replaceState`, so it doesn't stay in history or on screen.
2. `POST /auth/setup-token`. A 401 means "This link has expired or was already used".
3. `GET /refs/keys`:
   - **No `keys` ref:** create the vault (§7.3).
   - **`keys` exists:** ask for the recovery key and unwrap the MK from `recovery`.
4. With the MK in memory, it registers a passkey on this host and sets it up (§7.6, steps 2–6). The setup-token session is fresh, so no step-up is needed. The user can skip this step, but then the next unlock on this host needs the recovery key again.

### 7.3 Creating the vault

1. Register a passkey on this host and get its PRF output (§7.6, steps 2–5).
2. Generate the MK and the recovery key.
3. Show the recovery key with a copy button. The user has to tick "I have saved my recovery key" before continuing. Nothing has been stored yet, so closing the tab here leaves no trace.
4. Build the keys document (with the recovery slot and this passkey's slot) and the first vault (`revision: 1`, empty `history`, no entries). Upload both blobs.
5. `PUT keys` with `If-None-Match: *`. This is the commit.
   - A 412 means another device created a vault in the meantime. The client discards its own and switches to unlocking. Maintenance removes the orphaned blobs.
6. `PUT vault` with `If-None-Match: *`. If the client is interrupted before this step, the next unlock creates the empty vault (§7.1, step 5).

### 7.4 Saving changes

Both documents change only through operations: pure functions of the form `(document, now) → document`.

| Document | Operations |
|----------|------------|
| Vault    | `upsertEntry(entry)` adds the entry or replaces the one with the same `id`, and sets `updated_at`. If the content (title, username, password, URLs, notes) changed, the previous version goes to the front of the entry's `history`, cut to 10; the history is taken from the vault the operation is applied to, never from the caller's copy. Saving unchanged content changes nothing. `deleteEntry(id)` removes the entry and its history; deleting an entry that is already gone does nothing. |
| Keys     | `setPasskey(credentialId, slot)`, `removePasskey(credentialId)`, `setRecovery(slot)`, `prune(existingCredentialIds)` |

Because operations are plain functions, a module can define its own without any change to the core. The KeePass import does this (§8.4).

A save applies an operation:

1. Apply the operation to the loaded document.
   - For the vault this also sets `revision + 1` and `saved_at = now`, and puts the loaded blob's ID at the front of `history` (cut to 19 entries).
2. Serialize the result (and encrypt it, for the vault), upload it, then `PUT <ref>` with `If-Match: "<loaded blob id>"`.
3. On 412, fetch the document named in `current`, verify it (and decrypt it, for the vault), then apply the same operation to it and retry. The client tries at most 5 times, then shows an error; when editing an entry, the form stays open.
4. On success, the new document becomes the loaded state.

- **Conflicts:** the last save of an entry wins. If the entry being saved changed on another device after editing began (its `updated_at` differs), the save still goes through, and a notice says "This entry was also changed on another device; your version was saved". The other version stays in `history`.
- **When remote changes arrive:** there is no polling. A client sees other devices' changes when it unlocks, and through the 412 when it saves.
- **Network errors:** the UI never updates optimistically. It shows a saving indicator, and on failure it keeps the form open and offers a retry.

### 7.5 Rollback detection

- The client stores the highest vault `revision` it has seen in `localStorage`, under a key per user ID.
- If a loaded vault has a lower revision, it shows a warning: "The server returned an older version of your vault".
- Saving is blocked until the user acknowledges the warning, which resets the stored value.

### 7.6 Adding a passkey on this host

From Settings → Passkeys → Add:

1. `POST /me/passkeys/register/start`. On 403 `reauth_required`, unlock again with a passkey (§7.1) and retry.
2. Add `extensions.prf.eval.first = PRF_INPUT` to the options, then call `navigator.credentials.create()`. The user picks a name; the default is "Passkey on `<host>`".
3. The passkey can be used only if `prf.enabled === true` or PRF results came back. Otherwise the client doesn't call `finish` and tells the user that this authenticator can't unlock the vault.
4. Remove `clientExtensionResults.prf` and call `POST /me/passkeys/register/finish`.
5. If `create()` already returned a PRF output, use it. Otherwise log in with the new passkey to get one: the login options are given `allowCredentials: [new id]` and the PRF input. This is a second prompt, and the new login becomes the session.
6. Wrap the MK with the passkey KEK and save the keys document with `setPasskey`.

**Setting up an existing passkey:** a passkey on this host can exist without a slot, for example when step 6 was interrupted. Its "Set up" action runs steps 5–6.

**Passkeys on other hosts:** these can only be set up on their own host. A passkey's RP ID is its host, so it can't be used from here.

### 7.7 Removing a passkey

1. Ask for confirmation.
   - If this is the last passkey with a slot, the warning says: "Afterwards you'll need the recovery key".
   - The backend refuses to delete a user's very last passkey (409 `last_passkey`).
2. `DELETE /me/passkeys/{id}`. On `reauth_required`, unlock again and retry.
3. If the session still exists, save the keys document with `removePasskey`. Deleting the passkey that created the current session ends that session. In that case the client locks, and maintenance removes the slot later.

### 7.8 Adding a device

From Settings → Add device. The new device may use another host, e.g. the HTTPS path when this device uses iroh.

1. `POST /me/setup-tokens`, handling step-up as in §7.6.
2. Show the setup links, each with a copy button and a countdown to expiry:
   - every link from the response
   - the fragment on its own, `/#setup=<token>`, to add to a local iroh address
3. On the new device, the user opens the link and enters the recovery key (§7.2). Then they register a passkey there.

A setup link alone doesn't open the vault; the recovery key is also needed.

### 7.9 Recovery

**When all passkeys are lost:**

1. The user gets a setup link from the admin (`backend setup-token create`) or from another device where they are still logged in.
2. They open it, which starts §7.2.
3. The app asks for the recovery key and unwraps the MK from `recovery`.
4. The app registers a new passkey and sets it up.

**From the unlock screen:** a user who has a session but no MK uses "Use recovery key" for the same steps 3–4. Afterwards, the app offers to set up the current passkey or to add a new one.

### 7.10 Replacing the recovery key

From Settings → Recovery key → Create new:

1. Generate a new key and show it; the user confirms as in §7.3.
2. Save the keys document with `setRecovery`.

The old key stops working, but this does not re-encrypt anything. Rotating the master key is future work.

### 7.11 Maintenance

The server never cleans anything up, so the client does. Maintenance runs in two ways:

- **Automatically** in the background after an unlock, at most once every 24 hours per device. `localStorage` records the last run.
- **Manually** from Settings → Storage → "Clean up now". This runs immediately, whenever the last run was, and shows its progress and the report.

**Steps:**

1. **Prune the keys document:** save it with `prune`, which removes passkey slots whose credential ID is not in `GET /me/passkeys`. Nothing is saved if nothing changed.
2. **Build the keep set:** the current `keys` blob, the current `vault` blob, and every ID in the vault's `history`.
3. **Delete old blobs:**
   - List all blobs.
   - Delete every blob that is not in the keep set and whose `created_at` is more than 24 hours before the server's time (taken from the `Date` header of the list response).
   - The grace period protects blobs that another device has uploaded but not yet referenced. It also applies to manual runs.
   - Blobs uploaded by saves that lost a compare-and-swap race (§7.4) were never committed, so they are deleted too.

**Plan and report:**

- `plan(keys, vault, blobs, passkeys, now)` is a pure function. It returns the slots to prune, the blobs to keep, the blobs to delete, and the blobs that are too recent to delete.
- Running the plan produces a report:

| Field          | Meaning |
|----------------|---------|
| `started_at`, `finished_at`, `trigger` | When the run happened, and whether it was `automatic` or `manual` |
| `slots_removed` | Passkey slots pruned from the keys document |
| `blobs_total`, `bytes_total` | All blobs found |
| `kept`         | Current vault, current keys, and history versions, with their bytes |
| `deleted`      | Blobs deleted, with their bytes |
| `too_recent`   | Unreferenced blobs that were left alone because of the grace period |
| `failed`       | Blobs whose deletion failed, with the error |
| `error`        | Set if the run stopped early (e.g. lost session); the counts show how far it got |

- Each run is best-effort. An automatic run that fails is retried at the next unlock.
- **Where the report is shown:**
  - After a manual run, the report is shown as a list.
  - The last report of either kind is stored in `localStorage` (counts and timestamps only), so Settings → Storage can always show something like "Last cleanup: 2026-10-10 09:12 (automatic): 14 deleted (2.1 MB), 3 too recent, 0 failed".

### 7.12 Locking

The client locks on:
- the Lock button
- 15 minutes without pointer or keyboard input
- any 401 from the API

Locking runs `POST /auth/logout` (ignoring errors) and then `location.reload()`. The reload drops the MK and every decrypted value from memory. Unlocking again is one passkey prompt.

## 8. KeePass import

### 8.1 Supported files

| Aspect | Supported | Not supported (clear error message) |
|--------|-----------|-------------------------------------|
| Format | KDBX 3.1, KDBX 4.0 and 4.1 | KDB (KeePass 1), KDBX before 3.1 |
| Outer cipher | AES-256-CBC, ChaCha20 | Twofish (plugin) |
| KDF | AES-KDF, Argon2d, Argon2id | others |
| Compression | none, gzip | – |
| Inner stream | Salsa20 (3.1), ChaCha20 (4.x) | Arc4 |
| Credentials | password, key file, or both | Windows user account |
| Key files | XML v1.0 and v2.0, 32-byte binary, 64 hex characters, any other file (SHA-256 of its contents) | – |

- **Format reference:** KeePass's KDBX documentation and the KeePassXC sources.
- **What WebCrypto covers:** SHA-256, SHA-512, HMAC and AES-CBC.
- **AES-KDF:** this is repeated single-block AES-ECB, which WebCrypto doesn't offer. It is computed with AES-CBC over blocks of zeros, chunked to bound memory: each ciphertext block is the encryption of the previous one.
- **gzip:** decompressed with `DecompressionStream("gzip")`.
- **XML:** parsed with `DOMParser`.

### 8.2 Reading a file

1. The user picks a `.kdbx` file and enters the password and/or picks a key file. Nothing leaves the browser.
   - An empty password field with a key file is tried both as "no password" and as "an empty password". KeePass treats these differently, and either can occur.
2. The header is parsed. The KDF runs in a module Web Worker (`import-kdbx/kdf-worker.js`) with a progress bar, so the page stays responsive.
   - Argon2 in plain JavaScript is much slower than native code. A database tuned to unlock in 1 second in KeePassXC can take tens of seconds here.
   - If that's too slow in practice, the options are to lower the KDF settings in KeePassXC before importing, or to move Argon2 to WebAssembly. WebAssembly needs `'wasm-unsafe-eval'` added to the backend's `static_csp`.
3. Integrity is checked before anything is used:
   - **KDBX 4:** the header HMAC and every block's HMAC.
   - **KDBX 3.1:** the stream start bytes and every block's hash.
   
   A failure on the first check means "Wrong password or key file". A later failure means "The file is damaged".
4. The payload is decrypted and decompressed, and its XML is parsed. Protected values are decoded with the inner stream (Salsa20 or ChaCha20), applied to every protected value in document order. That includes values in history entries and the recycle bin, even though they aren't imported, because the stream position depends on them.
5. The XML is mapped to entries (§8.3), and the preview is shown (§8.4).

After the import, or when it's cancelled, all references to the file, the password, the key file and the decrypted XML are dropped, and the worker is terminated.

### 8.3 Mapping to entries

| KeePass | Vault entry |
|---------|-------------|
| `Title` | `title`. Empty becomes "(untitled)"; longer than 200 characters is cut. |
| `UserName` | `username` |
| `Password` | `password` |
| `URL`, then custom fields `KP2A_URL`, `KP2A_URL_*` (KeePassXC's extra URLs) | `urls`, empty values skipped, in that order |
| `Notes` | `notes` |
| `Times/CreationTime`, `Times/LastModificationTime` | `created_at`, `updated_at` |
| Group path (without the root group) and all other custom fields, including KeePassXC's `otp` (TOTP) field, so TOTP secrets survive as text | Appended to `notes` after a line `--- Imported from KeePass ---`: first `Group: A/B`, then one `Name: value` line per field. Protected custom fields are included too; notes aren't masked in the UI. |
| History, attachments, icons, colours, tags, auto-type, expiry | Not imported |

- **Recycle bin:** entries in the recycle bin group are skipped.
- **Field references:** references like `{REF:U@I:…}` are kept as literal text.
- **Long notes:** if the notes would exceed 64 KiB, they are cut, and the entry is listed in the preview.

### 8.4 Preview and saving

The preview shows:

- the file's format (e.g. "KDBX 4.1, Argon2d, ChaCha20")
- the number of entries to import
- duplicates that will be skipped, recycle-bin entries skipped, and attachments not imported
- entries with field references, and entries whose notes were cut
- a "Skip duplicates" toggle, on by default. An entry counts as a duplicate when an existing entry has the same title, username, password and first URL.

On confirm, the import is saved as one vault operation, `importEntries(entries, skipDuplicates)`, which produces one revision.
- The operation is defined in `import-kdbx/operation.js` and saved through `ctx.save` (§8.5).
- It gives the imported entries new IDs. The duplicate check runs against the vault the operation is applied to, so it stays correct when the save is re-applied after a conflict.
- Importing the same file twice with "Skip duplicates" on adds nothing the second time.

### 8.5 Isolation and removal

The import is expected to run once, so it is built to be deleted afterwards.

- **One way in:** the Settings button "Import from KeePass" runs `await import("./import-kdbx/index.js")` and calls `openImportScreen(container, ctx)`. Nothing else in the app refers to `import-kdbx/`.
- **Narrow interface:** `ctx` contains only:
  - `entries`: the current entries, read-only, for the preview's duplicate count
  - `save(operation)`: the app's normal save with compare-and-swap retries (§7.4)
  - `close()`
- **One-way dependency:** the module may use the app's shared `lib/` and `ui/` modules (e.g. the DOM helper). Nothing outside the folder imports from it.
- **Lazy loading:** the module, including the worker and Argon2, is downloaded only when the import screen opens. Normal use doesn't load it.
- **Removing it:**
  1. Delete `js/import-kdbx/`, `test/unit/import-kdbx/` and `test/e2e/test_import_kdbx.py`.
  2. Remove the Settings button and its handler in `main.js`.
  3. Remove the import's test tools from `shell.nix` (pykeepass, argon2-cffi, pycryptodome, `PYKEEPASS_TESTS`), and the test from the Makefile's `e2e` target.
  4. Delete §8 and the import parts of §9.1, §10 and §12 from this spec.
  
  Existing vaults are unaffected, because imported entries are ordinary entries.

## 9. User interface

### 9.1 Screens

| Screen       | Contents |
|--------------|----------|
| Unlock       | A "Unlock with passkey" button. "Use recovery key" appears only when a session exists. Help text: "Lost your passkeys or using a new device? Get a setup link, then use your recovery key." |
| Setup        | Progress through §7.2 and §7.3: link check, recovery key (shown with a copy button, or entered), passkey registration |
| Vault        | Search box, "New entry" button, the entry list, and the selected entry's details (side by side on wide screens, stacked on narrow ones) |
| Entry editor | Title, username, password (with show/hide and generate), URLs (one per line), notes. Save, Cancel, and Delete (with confirmation). |
| Import       | Provided by the import module (§8.5): file and key file pickers, password field, KDF progress bar, then the preview with a confirm button |
| Settings     | Passkeys (name, host, created, last used, "this session", "can unlock", with Add / Set up / Delete), Add device, Recovery key, Import from KeePass, Storage (last cleanup summary and "Clean up now"), Lock |

- **Always visible:** a Lock button and a banner area for warnings (rollback, integrity, read-only).
- **Layout:** the layout works on phones, because the Android app is one of the main clients.

### 9.2 Entries and copy buttons

- **List rows:** each row shows the title, the username and the host of the first URL. Every row has **Copy username** and **Copy password** buttons, so a credential can be used without opening the entry.
- **Detail view:**
  - The username has a copy button.
  - The password is masked (`••••••••`) and has a show/hide toggle and a copy button.
  - URLs are links (`target="_blank" rel="noopener noreferrer"`), but only for `http:` and `https:`. Other schemes are shown as plain text, so a stored `javascript:` URL can never run.
  - Notes are shown as preformatted text.
- **Feedback:** a copy button shows "Copied" for 2 seconds.
- **Search:** a case-insensitive substring match on the title, username, URLs and notes.
- **Rendering safety:** vault data is only ever inserted with `textContent`, attribute setters or `href` after the scheme check. It is never inserted with `innerHTML`.

### 9.2.1 Entry history

An entry with earlier versions shows a "History (n)" button in its detail view. It opens a list of the versions, newest first.

- **Each version shows:**
  - when it was saved
  - which fields changed afterwards (e.g. "Afterwards changed: password"), so the version before an accidental overwrite is easy to find
  - its fields, with the password masked, a show/hide toggle, and copy buttons for the username and password
- **Restoring:** "Restore this version" (after a confirmation) saves the version's content as a normal change. The current version goes into the history, so a restore can be undone too.
- **Deleted entries:** deleting an entry also deletes its history. Only the vault-level history (P6) still has it.

### 9.3 Clipboard

- Copying uses `navigator.clipboard.writeText`. It works on both paths because `localhost` is a secure context.
- **Clearing after 30 seconds** (best effort):
  - After 30 seconds, the app writes an empty string to the clipboard, if the page has focus and nothing else was copied from the app in the meantime.
  - The app can't read the clipboard without a permission prompt, so this may also clear something the user copied from another app. This is accepted.

### 9.4 Password generator

Modelled on KeePassXC's. "Generate…" in the entry editor opens a panel; "Use this password" puts the result in
the password field.

- **Preview:** a live preview with a regenerate button. Every change below generates a new password.
- **Strength:** shown as entropy in bits (length × log2 of the pool size), with KeePassXC's bands: Poor
  under 40, Weak under 75, Good under 100, Excellent from 100.
- **Length:** a slider and a number field, 4–128, 20 by default.
- **Character classes:** toggle buttons.

| Class | Characters | Default |
|-------|------------|---------|
| Upper case | `A-Z` | on |
| Lower case | `a-z` | on |
| Numbers | `0-9` | on |
| Braces | `{ [ ( ) ] }` | on |
| Punctuation | `. , : ;` | on |
| Quotes | `" '` | off |
| Dashes and slashes | `\ / \| _ -` | on |
| Math | `< > * + ! ? =` | on |
| Logograms | `` # $ % & @ ^ ` ~ `` | on |

- **Advanced options:**
  - Exclude look-alike characters (`0 O o 1 l I |`).
  - Pick characters from every group (on by default): at least one character of each selected class.
  - "Also choose from": extra characters, which form a group of their own.
  - "Do not include": characters to leave out.
- **Errors:** with no character left to choose from, or a length shorter than the number of groups while
  "every group" is on, the panel says so and "Use this password" is disabled.
- **Randomness:** characters come from `crypto.getRandomValues` with rejection sampling, so there is no
  modulo bias. The guaranteed characters are shuffled into random positions.
- **Remembered settings:** the settings are kept in `localStorage` on this device. They aren't secret.
- **Not included:** passphrases (word lists) and extended ASCII.

## 10. Security notes

- **What is protected:**
  - The contents of entries, including titles, usernames and URLs, are hidden from the server and from leaked database copies. So is the vault history.
  - Blob tampering is detected by content addressing plus GCM.
  - A rolled-back vault is detected by the revision check.
- **What is not protected:**
  - A server that serves malicious JavaScript. This is inherent to web apps, and the frontend is served by the same backend.
  - XSS in the app.
  - Malware on the device.
  - An attacker who already has the MK. Without key rotation, removing a passkey doesn't lock them out.
- **What the server sees:**
  - when and how often the vault and the keys blob change
  - the vault's size, padded to 4 KiB steps
  - from the plaintext keys blob: which credential IDs have slots, and when the recovery key changes
- **Tampering with the keys blob:** the server can delete or replay slots, which can only cause a failed unlock. It can't create a working slot, because that needs a KEK.
- **XSS defenses:**
  - no dependencies
  - the strict CSP sent by the backend for static files (backend spec §8.6)
  - only `textContent` for rendering
  - the URL scheme allowlist
  - `Referrer-Policy: no-referrer`
- **Recovery key:** it is used whenever a new device is set up, so it gets pasted more often than a pure recovery secret would. Only paste it into this app.
  - The key plus a session gives full access. The key plus a stolen database also gives full access.
  - Replacing it (§7.10) doesn't help against someone who already used it, because there is no key rotation.
- **KeePass import:**
  - The `.kdbx` file and its credentials never leave the browser.
  - The decrypted data exists only in memory until it is encrypted into the vault.
- **Memory:** while the vault is unlocked, the MK and all plaintext are in JavaScript memory. Locking reloads the page to drop them.
- **Clipboard:** other applications on the device can read copied secrets until they are cleared.

## 11. Backend usage

- **Endpoints used:**
  - `auth/*`
  - `me`, `me/passkeys/*` and `me/setup-tokens`
  - blobs: PUT, GET, DELETE and list
  - refs: GET and PUT with preconditions
- **Backend changes needed:** one generic addition, security headers and a CSP for static files (backend spec §8.6). Nothing in the backend is specific to the password manager.
- **Content type:** the client always sends `Content-Type: application/octet-stream` for blob uploads, and `Origin` is set automatically by the browser.

## 12. Testing

- **Unit tests** (`node --test`; Node has WebCrypto) for the pure modules:
  - **Crypto:** known-answer tests for every derivation; wrap/unwrap round trips; a tampered nonce, ciphertext or AAD fails.
  - **Vault blob:** encrypting and decrypting; padding.
  - **Vault and keys documents:** validation; every operation; re-applying operations on conflict; `history` is cut to 19; unknown fields are preserved; `version > 1` is refused.
  - **Recovery key:** generation and parsing (whitespace, uppercase input, wrong length, characters that aren't hex).
  - **Password generator:** length, sets and guaranteed characters.
  - **Maintenance:** the plan, including the grace period and pruned slots, and the report for successful, partial and failed runs.
  - **Setup links:** parsing and building fragments.
  - **KDBX primitives:** checked against vectors generated from independent implementations (Python's
    `hashlib`, `argon2-cffi` and `pycryptodome`), plus RFC 9106's Argon2 vectors. Covers BLAKE2b, Argon2d/i/id,
    ChaCha20 (including RFC 8439's example), Salsa20 and AES-KDF.
  - **KDBX containers:** the sample databases that ship with pykeepass, read from the Nix store rather than
    copied:
    - KDBX 3.1 and 4.0; AES-KDF, Argon2d and Argon2id; AES and ChaCha20; gzip on and off.
    - Binary, hex and XML 1.0/2.0 key files, and an empty password plus a key file.
    - Also checked: a wrong password, Twofish, a non-KDBX file and a flipped bit.
  - The XML mapping needs `DOMParser`, which Node and workers don't have. So the browser test
    (`test/e2e/test_import_kdbx.py`) runs it and compares every entry with what pykeepass reads, mapped by the
    same rules. It also covers a database generated with pykeepass that has a recycle bin, extra URLs, a
    protected custom field, an attachment, history and long notes.
  - All import tests live in their own files (`test/unit/import-kdbx/`, `test/e2e/test_import_kdbx.py`), so they can be deleted together with the module.
  - A test checks that nothing outside `js/import-kdbx/` imports from it. Only the dynamic import in Settings is allowed.
- **End-to-end tests** with Playwright and Chromium:
  - Chromium's virtual authenticator with PRF enabled (CDP `WebAuthn.addVirtualAuthenticator`, `hasPrf: true`).
  - The real backend built from `backend/`, reached through `socat` on `http://localhost` and `http://a.localhost`.
  - **Scenarios:**
    - bootstrap from a CLI setup token; unlock; create, edit and delete entries
    - copy buttons (with clipboard permission granted)
    - two contexts editing at the same time
    - adding and removing passkeys; step-up
    - adding a device on another host with a setup link plus the recovery key
    - recovery; replacing the recovery key
    - an interrupted vault creation (`keys` without `vault`)
    - a tampered blob gives an integrity error; rollback warning
    - auto-lock
    - "Clean up now" deletes only what it should and shows the report
    - importing a fixture shows the right preview and entries, and a second import adds nothing
- **Manual checks:** the Android app over iroh, Firefox, and Safari on the HTTPS path. Also import a real KeePassXC database and time the KDF.

## 13. Future work

- Other imports (Bitwarden, CSV) and export.
- A "recently deleted" view, built on the vault-level history (P6).
- Master key rotation, e.g. after a passkey or the recovery key is lost to an attacker.
- Password history per entry, TOTP, attachments (separate encrypted blobs), and folders/tags (which could use the imported KeePass group paths).
- An offline read-only cache.
