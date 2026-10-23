# Password Manager Specification

Status: **Draft v0.5** (2026-10-10)

## 1. Purpose & scope

A web-based password manager. It runs entirely in the browser and is built on [e2ee-store](https://github.com/sashee/e2ee-store) (pinned in `nix/e2ee-store.nix`):

- its backend (`backend/SPEC.md` there, "backend SPEC") stores the data as opaque blobs and refs;
- its SDK (`sdk/SPEC.md` there, "SDK SPEC") encrypts it end to end and handles passkeys, keys, saving, recovery and cleanup.

This document covers what the password manager adds. Everything in it is implemented in the frontend.

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
| P1  | Format           | A custom JSON document, not KDBX: the file `vault` in the SDK's encrypted tree. |
| P2  | Keys             | One random master key (MK) per user. Everything in the tree is encrypted with keys derived from it. The keys blob is the only plaintext blob: it holds the MK wrapped once per passkey and once for the recovery key. |
| P3  | Refs             | Two refs: `vault` points to the tree's root directory and `keys` points to the keys blob. Both are updated with compare-and-swap. |
| P4  | Recovery key     | 32 random bytes, shown once as 64 hex characters with a copy button. It is used for recovery and for setting up new devices. |
| P5  | Concurrency      | Every change is one operation applied to the latest document with compare-and-swap. On conflict the operation is re-applied to the new document, so the last save of an entry wins. |
| P6  | History          | Each entry keeps its own last 10 versions, which can be viewed, copied and restored. The tree also keeps the previous 19 versions of the whole vault, as `vault@<revision>` files: a safety net. Maintenance runs on the client, automatically or from a button, and deletes everything the tree doesn't reach. |
| P7  | Locking          | Locking logs out and reloads the page. This happens on the Lock button, after 15 minutes of inactivity and when the session expires. |
| P8  | Tech stack       | Plain JavaScript (ES modules), HTML and CSS. No runtime dependencies and no build step. WebCrypto for cryptography. |
| P9  | KeePass import   | A read-only KDBX 3.1/4.x reader written for this app. It decrypts the file in the browser; the file is never uploaded. The primitives WebCrypto lacks (Argon2, ChaCha20, Salsa20) are implemented here, so there is still no dependency. It is meant for a one-time migration: a self-contained, lazy-loaded module that can be deleted without touching the rest of the app (§8.5). |
| P10 | SDK              | Keys, encryption and the flows are e2ee-store's SDK, with the namespace `pw-mgr` (§4). This app adds the vault document, the UI and the KeePass import. |

## 3. Architecture

- **Serving:** the backend serves the web package from its `static_dir`, so the app always runs on the same origin as the API. The package is `web/public/` plus the SDK at `sdk/`; in development, `web/public/sdk` links to it (`make deps`).
- **Origins:** on the iroh path that's `http://localhost:PORT` or `http://<label>.localhost:PORT`; on the direct path it's `https://<public host>`.
- **Routing:** the app has no URL routes. Screen state lives in memory. The URL fragment is used only for setup links (SDK SPEC §6.2).
- **Pure core:** the logic lives in pure modules (`js/lib/` and most of the SDK) that have no DOM access and make no network calls. Network, WebAuthn, the DOM, timers and workers stay in thin edge modules.

```
web/
  SPEC.md
  package.nix             the web package: public/ plus the SDK at sdk/
  public/                 served as static_dir
    index.html
    style.css
    sdk/                  development link to e2ee-store's SDK (not in git)
    js/
      main.js             startup, screen state machine
      flows.js            the SDK's flows, configured with this app's namespace and vault document
      lib/                pure modules
        vault.js          vault document validation and operations
        password.js       password generator
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
      fixtures/           a vault written before the SDK existed (§12)
      import-kdbx/        tests for the import module only
    e2e/                  Playwright (Python, like monitoring-platform) on e2ee-store's harness: test_flows.py; import tests in their own file
```

## 4. Cryptography

The SDK's (SDK SPEC §2, §3), with the namespace `pw-mgr`. The labels are therefore:

| Label         | Value |
|---------------|-------|
| PRF input     | `pw-mgr/prf/v1` |
| Keys format   | `pw-mgr/keys` |
| KEKs          | `pw-mgr/kek/passkey/v1`, `pw-mgr/kek/recovery/v1` |
| Keyslot AADs  | `pw-mgr/keys/v1/passkey`, `pw-mgr/keys/v1/recovery` |
| Content key   | `pw-mgr/stream/v1` |
| Directories, files | `pw-mgr/dir/v1`, `pw-mgr/file/v1` |
| State ID      | `pw-mgr/device-state-id/v1` |

The PRF input, keys format, KEKs, keyslot AADs and state ID were the app's own before the SDK existed. Existing vaults are bound to all of these, so they never change (§12).

## 5. Storage layout

The SDK's (SDK SPEC §4, §5): the `keys` ref points to the keys blob, and the `vault` ref to the root directory of the tree. The root holds:

| File | Content |
|------|---------|
| `vault` | The vault document (§6). It appears with the first save; until then the vault is empty. |
| `vault@<revision>` | The vault as it was in that revision of the root, the 19 newest of them (P6). |

Maintenance deletes everything else: earlier roots, older versions and replaced keys blobs.

## 6. Vault document

```json
{
  "format": "pw-mgr/vault",
  "version": 2,
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

- **Version 2** is this document as the file `vault` in the tree. The revision, the save time and the earlier versions are the tree's now: the root's `revision`, the file's `modified`, and the `vault@<revision>` files.
- **`id`** is a UUIDv4 from `crypto.randomUUID()`.
- **`title`** is required, 1–200 characters. All other string fields may be empty, and `notes` can be up to 64 KiB.
- **Entry `history`** (optional) holds the entry's earlier versions, newest first, at most 10. Each version is a copy of the entry as it was (all fields, including unknown ones and its `updated_at`), without `id` and without its own history.
- **`urls`** is a list of strings. Any string is stored, but only `http:` and `https:` URLs are shown as links (§9.2).
- **Order:** entries are stored in any order. The UI sorts them by title.
- **Forward compatibility:**
  - Unknown fields on the document and on entries are preserved when the vault is rewritten.
  - A document with `version` greater than 2 opens read-only, with a message saying the app needs updating.

## 7. Flows

The flows are the SDK's (SDK SPEC §6): unlock, setup links, creating the vault, saving, rollback detection, adding and removing passkeys, adding a device, recovery, replacing the recovery key, and maintenance. Passkeys get the default name "Passkey on `<host>`". This section covers what the password manager adds.

### 7.1 Vault operations

| Operation | Effect |
|-----------|--------|
| `upsertEntry(entry)` | Adds the entry or replaces the one with the same `id`, and sets `updated_at`. If the content (title, username, password, URLs, notes) changed, the previous version goes to the front of the entry's `history`, cut to 10; the history is taken from the vault the operation is applied to, never from the caller's copy. Saving unchanged content changes nothing. |
| `deleteEntry(id)` | Removes the entry and its history; deleting an entry that is already gone does nothing. |

Because operations are plain functions, a module can define its own without any change to the core. The KeePass import does this (§8.4).

**A save** (`saveSteps`) is one step of an SDK save (SDK SPEC §6.4):

1. It reads `vault` and applies the operation to it.
2. If the operation changed nothing, it writes nothing.
3. Otherwise it keeps the current `vault` as `vault@<revision>` (the revision being replaced), removes the oldest snapshots beyond 19, and uploads the new `vault`.

After a conflict the SDK runs it again on the newer tree, so the operation is applied to the newest vault. A `vault` from a newer version stops the save.

### 7.2 Concurrent edits

- **Conflicts:** the last save of an entry wins. If the entry being saved changed on another device after editing began (its `updated_at` differs from the version the save was finally applied to), the save still goes through, and a notice says "This entry was also changed on another device; your version was saved". The other version stays in `history`.
- **Which version a save was applied to:** if the new root's revision is more than one above the loaded one, another device saved in between. The version the operation was applied to is then the snapshot `vault@<new revision − 1>` that the save itself kept, and the notice compares against that.
- **Failed saves:** when editing an entry, the form stays open.
- **Network errors:** the UI never updates optimistically. It shows a saving indicator, and on failure it keeps the form open and offers a retry.

### 7.3 Rollback warning

- When the SDK's check of the root's revision finds a rollback (SDK SPEC §6.5), a warning is shown: "The server returned an older version of your vault", with both revisions.
- Saving and cleanup are paused until the user acknowledges the warning, which resets the stored revision.

### 7.4 Locking

The client locks on:
- the Lock button
- 15 minutes without pointer or keyboard input
- any 401 from the API

The inactivity timer runs from the moment the page loads, not only once the vault is open: on some paths (recovery key, vault creation) secrets are in memory earlier. The Lock button shows as soon as a secret is in memory.

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
  - `save(operation)`: the app's normal save with compare-and-swap retries (SDK SPEC §6.4)
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
| Setup        | Progress through SDK SPEC §6.2 and §6.3: link check, recovery key (shown with a copy button, or entered), passkey registration |
| Vault        | Search box, "New entry" button, the entry list, and the selected entry's details (side by side on wide screens, stacked on narrow ones) |
| Entry editor | Title, username, password (with show/hide and generate), URLs (one per line), notes. Save, Cancel, and Delete (with confirmation). |
| Import       | Provided by the import module (§8.5): file and key file pickers, password field, KDF progress bar, then the preview with a confirm button |
| Settings     | Passkeys (name, host, created, last used, "this session", "can unlock", with Add / Set up / Delete), Add device, Recovery key (test the saved key against the vault; create a new one), Import from KeePass, Storage (last cleanup summary and "Clean up now"), Lock |

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
- **No spellcheck:** the editor's fields have `spellcheck="false"`; with Chrome's enhanced spellcheck their text would otherwise be sent to Google.
- **Error messages:** errors from the server are shown with the client's own text for each error code, never the server's message, so a malicious server can't put its own words (e.g. a request for the recovery key) in front of the user.

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

The SDK's notes apply (SDK SPEC §8): what is and isn't protected, what the server sees, the keys blob, the recovery key and memory. In addition:

- **Entries:** their contents, including titles, usernames and URLs, are hidden from the server and from leaked database copies.
- **XSS defenses:**
  - no dependencies
  - the strict CSP sent by the backend for static files (backend SPEC §8.6)
  - only `textContent` for rendering
  - the URL scheme allowlist
  - `Referrer-Policy: no-referrer`
- **KeePass import:**
  - The `.kdbx` file and its credentials never leave the browser.
  - The decrypted data exists only in memory until it is encrypted into the vault.
- **Clipboard:** other applications on the device can read copied secrets until they are cleared.

## 11. Backend usage

Only through the SDK (SDK SPEC §7). Nothing in the backend or the SDK is specific to the password manager.

## 12. Testing

- **The SDK's own tests** (SDK SPEC §9) run in e2ee-store.
- **Unit tests** (`node --test`; Node has WebCrypto) for the pure modules, against the web package (so with the SDK it ships):
  - **Compatibility:** a keys blob written before the SDK existed still unlocks with the passkey's and the recovery key's secrets, and gives the same state ID; a root directory listing the file `vault` opens with them; the PRF input is unchanged (§4).
  - **Vault document:** validation; every operation; re-applying operations on conflict; unknown fields are preserved; `version > 2` is refused.
  - **Saving in the tree:** the replaced vault becomes `vault@<revision>`; an empty tree gets its first vault; a save that changes nothing writes nothing; snapshots beyond 19 go, oldest first; a newer vault isn't saved over.
  - **Password generator:** length, sets and guaranteed characters.
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
  - e2ee-store's harness (SDK SPEC §9): Chromium's virtual authenticator with PRF enabled (CDP `WebAuthn.addVirtualAuthenticator`, `hasPrf: true`).
  - e2ee-store's backend serving the web package, reached through `socat` on `http://localhost` and `http://a.localhost`.
  - **Scenarios:**
    - bootstrap from a CLI setup token; unlock; create, edit and delete entries
    - copy buttons (with clipboard permission granted)
    - two contexts editing at the same time
    - adding and removing passkeys; step-up
    - adding a device on another host with a setup link plus the recovery key
    - recovery; replacing the recovery key
    - an interrupted vault creation (`keys` without `vault`); `keys` missing while `vault` exists creates nothing
    - a tampered or swapped blob gives an integrity error and nothing is written; rollback warning, also for a vault ref the server lost
    - a vault or keys document from a newer version opens read-only, with no saves; newer keys also stop cleanup, while a newer vault doesn't, as cleanup only follows the tree
    - two devices creating the vault at once; a passkey without a slot is set up with the recovery key
    - entry fields with markup are shown as text
    - auto-lock: inactivity (on a fake clock), an expired session, deleting the session's own passkey
    - "Clean up now" deletes exactly what the tree doesn't reach and shows the report
    - importing a fixture shows the right preview and entries, and a second import adds nothing
- **Manual checks:** the Android app over iroh, Firefox, and Safari on the HTTPS path. Also import a real KeePassXC database and time the KDF.

## 13. Future work

- Other imports (Bitwarden, CSV) and export.
- A "recently deleted" view, built on the `vault@<revision>` snapshots (P6).
- Master key rotation, e.g. after a passkey or the recovery key is lost to an attacker.
- Password history per entry, TOTP, attachments (files in the tree), and folders/tags (which could use the imported KeePass group paths).
- An offline read-only cache.
