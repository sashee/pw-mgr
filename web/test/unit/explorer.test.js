// The file explorer (web SPEC §9.5): what it shows of entries and files, and that it stays a separate, deletable module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { contentView, entryRows, hexPreview, MASK, maskSecrets, short } from "../../public/js/explorer/view.js";

const encode = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

test("passwords are masked wherever they are, and nothing else is", () => {
  const vault = {
    format: "pw-mgr/vault",
    entries: [
      { id: "a", title: "GitHub", password: "hunter2", notes: "password: see below", history: [{ password: "old one", title: "GitHub" }] },
      { id: "b", title: "No password", password: "" },
    ],
  };
  const masked = maskSecrets(vault);
  assert.equal(masked.entries[0].password, MASK);
  assert.equal(masked.entries[0].history[0].password, MASK);
  assert.equal(masked.entries[0].notes, "password: see below", "only fields named password");
  assert.equal(masked.entries[1].password, "", "an empty password has nothing to hide");
  assert.deepEqual(vault.entries[0].password, "hunter2", "the document itself is unchanged");
  assert.deepEqual([maskSecrets(null), maskSecrets(7), maskSecrets(["x"])], [null, 7, ["x"]]);
});

test("JSON is pretty-printed and masked unless revealed; other files are shown as text or in hex", () => {
  const doc = { entries: [{ password: "hunter2" }] };
  const masked = contentView(encode(doc));
  assert.equal(masked.kind, "json");
  assert.equal(masked.secrets, true);
  assert.ok(!masked.text.includes("hunter2") && masked.text.includes(MASK));
  assert.equal(masked.text, JSON.stringify(maskSecrets(doc), null, 2));
  assert.ok(contentView(encode(doc), { reveal: true }).text.includes("hunter2"));
  assert.equal(contentView(encode({ entries: [] })).secrets, false, "nothing to reveal");

  assert.deepEqual(contentView(encode("plain text, not JSON")), { kind: "text", text: "plain text, not JSON", secrets: false });
  const binary = contentView(Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 128) % 256));
  assert.equal(binary.kind, "binary");
  assert.match(binary.text, /^00000000 {2}80 a5 ca ef/);
  assert.match(binary.text, /… 44 B more$/);
  assert.equal(hexPreview(Uint8Array.from([1, 2, 255])), "00000000  01 02 ff");
});

test("entries are shown with every field in full; lists shorten IDs", () => {
  const file = { name: "vault", kind: "file", id: "a".repeat(64), salt: "b".repeat(32), size: 2048, sha256: "c".repeat(64), modified: "2026-10-23T12:00:00.000Z", app: { x: 1 } };
  const rows = Object.fromEntries(entryRows(file));
  assert.deepEqual(Object.keys(rows), ["Kind", "Size", "Modified", "Blob ID", "Salt", "SHA-256 of the content", "App data"]);
  assert.equal(rows["Blob ID"], file.id);
  assert.equal(rows["App data"], '{"x":1}');
  const dir = Object.fromEntries(entryRows({ name: "d", kind: "dir", id: "a".repeat(64), salt: "b".repeat(32) }));
  assert.deepEqual(Object.keys(dir), ["Kind", "Blob ID", "Salt"]);
  assert.equal(short("a".repeat(64)), `${"a".repeat(12)}…`);
  assert.equal(short("abc"), "abc");
});

// Like the KeePass import (§8.5): deletable, so only main.js refers to it, through one dynamic import.
const JS = new URL("../../public/js/", import.meta.url).pathname;
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".js") ? [path] : [];
  });

test("only main.js refers to the explorer, through a dynamic import, and the explorer only reads", () => {
  for (const file of files(JS).filter((f) => !relative(JS, f).startsWith("explorer/"))) {
    const source = readFileSync(file, "utf8");
    const mentions = source.match(/explorer\/[^"'`]*/g) ?? [];
    if (relative(JS, file) === "main.js") {
      assert.deepEqual(mentions, ["explorer/index.js"]);
      assert.match(source, /await import\("\.\/explorer\/index\.js"\)/);
    } else {
      assert.deepEqual(mentions, [], relative(JS, file));
    }
  }
  for (const file of files(join(JS, "explorer"))) {
    const source = readFileSync(file, "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const path of imports) assert.match(path, /^(\.\/|\.\.\/ui\/|\.\.\/\.\.\/sdk\/maintenance\.js$)/, `${relative(JS, file)} imports ${path}`);
    assert.doesNotMatch(source, /\bsave\b|upload|remove\(|mkdir/, `${relative(JS, file)} doesn't write`);
  }
});
