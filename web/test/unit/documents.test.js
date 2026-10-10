import { test } from "node:test";
import assert from "node:assert/strict";

import { blankEntry, commit, deleteEntry, entryErrors, linkableUrl, newVault, readVault, searchEntries, upsertEntry, urlHost } from "../../public/js/lib/vault.js";

const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);
const entry = (id, title, more = {}) => ({ ...blankEntry(id), title, ...more });

test("upsert adds, then replaces keeping created_at and unknown fields", () => {
  const v1 = upsertEntry(entry("a", "GitHub", { custom: 1 }))(newVault(T0), T0);
  assert.equal(v1.entries.length, 1);
  assert.equal(v1.entries[0].created_at, "2026-10-10T09:00:00.000Z");
  const v2 = upsertEntry({ id: "a", title: "GitHub 2", username: "", password: "", urls: [], notes: "" })(v1, T0 + 1000);
  assert.equal(v2.entries.length, 1);
  assert.equal(v2.entries[0].title, "GitHub 2");
  assert.equal(v2.entries[0].created_at, "2026-10-10T09:00:00.000Z");
  assert.equal(v2.entries[0].updated_at, "2026-10-10T09:00:01.000Z");
  assert.equal(v2.entries[0].custom, 1);
});

test("delete removes the entry and ignores missing ones", () => {
  const v = upsertEntry(entry("a", "A"))(newVault(T0), T0);
  assert.deepEqual(deleteEntry("a")(v).entries, []);
  assert.deepEqual(deleteEntry("zzz")(v).entries, v.entries);
});

test("commit increments the revision and keeps 19 history entries", () => {
  let vault = newVault(T0);
  for (let i = 0; i < 25; i++) vault = commit(vault, (v) => v, T0 + i, `blob-${i}`);
  assert.equal(vault.revision, 26);
  assert.equal(vault.history.length, 19);
  assert.equal(vault.history[0], "blob-24");
  assert.equal(vault.history[18], "blob-6");
});

test("re-applying an operation to a newer vault keeps both changes", () => {
  const base = upsertEntry(entry("a", "A"))(newVault(T0), T0);
  const theirs = upsertEntry(entry("b", "B"))(base, T0);
  const mine = upsertEntry(entry("c", "C"));
  assert.deepEqual(mine(theirs, T0).entries.map((e) => e.id), ["a", "b", "c"]);
});

test("vault documents are validated and newer versions are read-only", () => {
  assert.throws(() => readVault({ format: "other" }));
  assert.equal(readVault(newVault(T0)).writable, true);
  assert.equal(readVault({ ...newVault(T0), version: 2, extra: true }).writable, false);
  assert.equal(readVault({ ...newVault(T0), extra: true }).doc.extra, true, "unknown fields survive");
});

test("entries need a title and bounded notes", () => {
  assert.deepEqual(entryErrors(entry("a", "Ok")), []);
  assert.deepEqual(entryErrors(entry("a", "  ")), ["A title is required"]);
  assert.equal(entryErrors(entry("a", "x".repeat(201))).length, 1);
  assert.equal(entryErrors(entry("a", "x", { notes: "n".repeat(64 * 1024 + 1) })).length, 1);
});

test("search covers title, username, URLs and notes, sorted by title", () => {
  const entries = [entry("1", "beta", { username: "alice" }), entry("2", "Alpha", { urls: ["https://example.com"] }), entry("3", "gamma", { notes: "PIN 1234" })];
  assert.deepEqual(searchEntries(entries, "").map((e) => e.title), ["Alpha", "beta", "gamma"]);
  assert.deepEqual(searchEntries(entries, "ALICE").map((e) => e.id), ["1"]);
  assert.deepEqual(searchEntries(entries, "example").map((e) => e.id), ["2"]);
  assert.deepEqual(searchEntries(entries, "pin").map((e) => e.id), ["3"]);
});

test("only http(s) URLs become links", () => {
  assert.equal(linkableUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(linkableUrl("http://localhost:8080"), "http://localhost:8080/");
  assert.equal(linkableUrl("javascript:alert(1)"), null);
  assert.equal(linkableUrl("data:text/html,x"), null);
  assert.equal(linkableUrl("example.com"), null);
  assert.equal(urlHost("https://github.com/login"), "github.com");
  assert.equal(urlHost("not a url"), "");
});

import { changedFields, contentOf, ENTRY_HISTORY } from "../../public/js/lib/vault.js";

test("changing an entry keeps its previous version in the entry's own history", () => {
  const v1 = upsertEntry(entry("a", "Mail", { password: "one", custom: 7 }))(newVault(T0), T0);
  const v2 = upsertEntry({ ...v1.entries[0], password: "two" })(v1, T0 + 1000);
  const saved = v2.entries[0];
  assert.equal(saved.password, "two");
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].password, "one");
  assert.equal(saved.history[0].updated_at, "2026-10-10T09:00:00.000Z", "the version keeps when it was saved");
  assert.equal(saved.history[0].custom, 7, "unknown fields are part of the version");
  assert.equal(saved.history[0].id, undefined);
  assert.equal(saved.history[0].history, undefined, "versions don't nest");
});

test("saving unchanged content changes nothing", () => {
  const v1 = upsertEntry(entry("a", "Mail", { password: "one" }))(newVault(T0), T0);
  assert.equal(upsertEntry({ ...v1.entries[0] })(v1, T0 + 1000), v1);
});

test("an entry keeps at most 10 earlier versions, newest first", () => {
  let vault = upsertEntry(entry("a", "Mail", { password: "p0" }))(newVault(T0), T0);
  for (let i = 1; i <= 15; i++) vault = upsertEntry({ ...vault.entries[0], password: `p${i}` })(vault, T0 + i);
  const history = vault.entries[0].history;
  assert.equal(history.length, ENTRY_HISTORY);
  assert.deepEqual(history.map((v) => v.password), ["p14", "p13", "p12", "p11", "p10", "p9", "p8", "p7", "p6", "p5"]);
});

test("the history comes from the vault the save is applied to, not the editor's copy", () => {
  const base = upsertEntry(entry("a", "Mail", { password: "one" }))(newVault(T0), T0);
  const editorCopy = base.entries[0];
  const elsewhere = upsertEntry({ ...editorCopy, password: "two" })(base, T0 + 1);
  const mine = upsertEntry({ ...editorCopy, password: "three" })(elsewhere, T0 + 2);
  assert.deepEqual(mine.entries[0].history.map((v) => v.password), ["two", "one"]);
});

test("restoring a version is a change like any other", () => {
  let vault = upsertEntry(entry("a", "Mail", { password: "old", urls: ["https://a"] }))(newVault(T0), T0);
  vault = upsertEntry({ ...vault.entries[0], password: "overwritten", urls: [] })(vault, T0 + 1);
  const old = vault.entries[0].history[0];
  assert.deepEqual(changedFields(old, vault.entries[0]), ["password", "urls"]);
  vault = upsertEntry({ ...vault.entries[0], ...contentOf(old) })(vault, T0 + 2);
  assert.equal(vault.entries[0].password, "old");
  assert.deepEqual(vault.entries[0].urls, ["https://a"]);
  assert.deepEqual(vault.entries[0].history.map((v) => v.password), ["overwritten", "old"]);
});
