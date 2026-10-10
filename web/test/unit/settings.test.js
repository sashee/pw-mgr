import { test } from "node:test";
import assert from "node:assert/strict";

import { CLASSES, characterGroups, clampLength, DEFAULTS, describe, entropyBits, generatePassword, GeneratorError, normalizeOptions, strength, uniform } from "../../public/js/lib/password.js";
import { formatBytes, isDue, makeReport, planBlobs, prunableSlots, summary } from "../../public/js/lib/maintenance.js";
import { rollbackCheck } from "../../public/js/lib/vault.js";

test("generated passwords have the length and a character of every selected class", () => {
  const options = { ...DEFAULTS, classes: CLASSES.map((c) => c.id), length: 12 };
  for (let i = 0; i < 300; i++) {
    const password = generatePassword(options);
    assert.equal(password.length, 12);
    for (const { chars } of CLASSES) assert.ok([...password].some((c) => chars.includes(c)), password);
  }
});

test("only selected classes are used", () => {
  const password = generatePassword({ ...DEFAULTS, classes: ["digits", "quotes"], length: 64 });
  assert.match(password, /^[0-9"']{64}$/);
  assert.ok(/["']/.test(password) && /[0-9]/.test(password));
});

test("excluded, look-alike and extra characters", () => {
  const options = { ...DEFAULTS, classes: ["upper", "lower", "digits", "dashes"], excludeLookAlike: true, exclude: "ABC", include: "€ä", length: 128 };
  const groups = characterGroups(options);
  const pool = groups.flat().join("");
  for (const c of "0Oo1lI|ABC") assert.ok(!pool.includes(c), c);
  assert.ok(pool.includes("€") && pool.includes("ä"));
  for (let i = 0; i < 50; i++) assert.ok([...generatePassword(options)].some((c) => "€ä".includes(c)), "the extra characters are a group of their own");
  assert.equal(new Set(pool).size, pool.length, "no character is in two groups");
  assert.equal(characterGroups({ ...DEFAULTS, classes: ["upper"], include: "AB c" }).length, 2, "duplicates and spaces are dropped");
});

test("without every group, the length may be shorter than the number of groups", () => {
  const options = { ...DEFAULTS, classes: CLASSES.map((c) => c.id), length: 4 };
  assert.throws(() => generatePassword(options), GeneratorError);
  assert.equal(generatePassword({ ...options, everyGroup: false }).length, 4);
  assert.throws(() => generatePassword({ ...DEFAULTS, classes: [] }), GeneratorError);
  assert.throws(() => generatePassword({ ...DEFAULTS, classes: ["digits"], exclude: "0123456789" }), GeneratorError);
});

test("length is clamped and options are completed", () => {
  assert.equal(clampLength(1), 4);
  assert.equal(clampLength(500), 128);
  assert.equal(clampLength("abc"), 20);
  assert.deepEqual(normalizeOptions({ length: 30, classes: ["digits", "gone"] }), { ...DEFAULTS, length: 30, classes: ["digits"] });
});

test("entropy and strength follow the pool size", () => {
  assert.equal(entropyBits(10, 1), 0);
  assert.equal(Math.round(entropyBits(20, 62)), 119);
  assert.deepEqual(describe({ ...DEFAULTS, classes: ["digits"], length: 10 }), { bits: 33, strength: "Poor" });
  assert.equal(strength(74.9), "Weak");
  assert.equal(strength(99), "Good");
  assert.equal(strength(100), "Excellent");
  assert.equal(describe(DEFAULTS).strength, "Excellent");
});

test("uniform redraws values that would bias the result", () => {
  // n = 3: the largest multiple of 3 below 2^32 is 4294967295; that exact value must be redrawn.
  const values = [4294967295, 4294967294, 5];
  assert.equal(uniform(3, () => values.shift()), 4294967294 % 3);
});

const blob = (id, created_at, size = 10) => ({ id, size, created_at });
const NOW = Date.parse("2026-10-12T12:00:00Z");

test("cleanup keeps referenced and history blobs, and young blobs", () => {
  const blobs = [blob("keys", "2026-10-01T00:00:00Z"), blob("vault", "2026-10-01T00:00:00Z"), blob("old-history", "2026-10-01T00:00:00Z"), blob("orphan", "2026-10-11T11:59:59Z"), blob("young", "2026-10-11T12:00:01Z")];
  const plan = planBlobs({ keep: ["keys", "vault", "old-history"], blobs, now: NOW });
  assert.deepEqual(plan.kept.map((b) => b.id), ["keys", "vault", "old-history"]);
  assert.deepEqual(plan.toDelete.map((b) => b.id), ["orphan"]);
  assert.deepEqual(plan.tooRecent.map((b) => b.id), ["young"]);
});

test("stale passkey slots are found", () => {
  assert.deepEqual(prunableSlots({ passkeys: { a: {}, b: {} } }, ["b", "c"]), ["a"]);
});

test("the report counts and summarises a run", () => {
  const plan = planBlobs({ keep: ["k"], blobs: [blob("k", "2026-10-01T00:00:00Z", 100), blob("x", "2026-10-01T00:00:00Z", 2048), blob("y", "2026-10-12T11:00:00Z", 5)], now: NOW });
  const report = makeReport({ trigger: "manual", startedAt: NOW, finishedAt: NOW + 1000, slotsRemoved: 1, plan, deleted: plan.toDelete, failed: [] });
  assert.equal(report.blobs_total, 3);
  assert.equal(report.bytes_total, 2153);
  assert.deepEqual(report.deleted, { count: 1, bytes: 2048 });
  assert.deepEqual(report.too_recent, { count: 1, bytes: 5 });
  assert.match(summary(report), /\(manual\): 1 deleted \(2\.0 KB\), 1 too recent, 0 failed$/);
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("the automatic run is due after 24 hours or a failed run", () => {
  const ok = makeReport({ trigger: "automatic", startedAt: NOW, finishedAt: NOW });
  assert.equal(isDue(null, NOW), true);
  assert.equal(isDue(ok, NOW + 23 * 3600 * 1000), false);
  assert.equal(isDue(ok, NOW + 24 * 3600 * 1000), true);
  assert.equal(isDue({ ...ok, error: "offline" }, NOW + 1), true);
});

test("rollback is a revision lower than the highest seen", () => {
  assert.deepEqual(rollbackCheck(null, 3), { rolledBack: false, highest: 3 });
  assert.deepEqual(rollbackCheck(3, 5), { rolledBack: false, highest: 5 });
  assert.deepEqual(rollbackCheck(5, 5), { rolledBack: false, highest: 5 });
  assert.deepEqual(rollbackCheck(5, 4), { rolledBack: true, highest: 5 });
});
