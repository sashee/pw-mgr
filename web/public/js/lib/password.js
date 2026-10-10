// The password generator (SPEC §9.4), modelled on KeePassXC's: character classes, length, look-alike
// exclusion, extra and excluded characters, and "pick from every group". Pure: the random source is a parameter.

export const CLASSES = [
  { id: "upper", label: "A-Z", chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
  { id: "lower", label: "a-z", chars: "abcdefghijklmnopqrstuvwxyz" },
  { id: "digits", label: "0-9", chars: "0123456789" },
  { id: "braces", label: "{ [ ( ) ] }", chars: "{[()]}" },
  { id: "punctuation", label: ". , : ;", chars: ".,:;" },
  { id: "quotes", label: "\" '", chars: "\"'" },
  { id: "dashes", label: "\\ / | _ -", chars: "\\/|_-" },
  { id: "math", label: "< > * + ! ? =", chars: "<>*+!?=" },
  { id: "logograms", label: "# $ % & @ ^ ` ~", chars: "#$%&@^`~" },
];

export const LOOK_ALIKE = "0Oo1lI|";
export const MIN_LENGTH = 4;
export const MAX_LENGTH = 128;
export const DEFAULTS = {
  length: 20,
  classes: ["upper", "lower", "digits", "braces", "punctuation", "dashes", "math", "logograms"],
  excludeLookAlike: false,
  everyGroup: true,
  include: "",
  exclude: "",
};

export class GeneratorError extends Error {}

export const cryptoRandom32 = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0];

/** A uniform integer in [0, n) from 32-bit random values: values above the last multiple of n are redrawn. */
export function uniform(n, random32) {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const x = random32();
    if (x < limit) return x % n;
  }
}

export const clampLength = (length) => Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.trunc(Number(length)) || DEFAULTS.length));

/** Fills in anything missing (e.g. settings saved by an older version) from the defaults. */
export const normalizeOptions = (options) => {
  const merged = { ...DEFAULTS, ...options };
  return { ...merged, length: clampLength(merged.length), classes: merged.classes.filter((id) => CLASSES.some((c) => c.id === id)) };
};

/**
 * The character groups to draw from: the selected classes plus the extra characters, minus excluded and
 * (optionally) look-alike characters. Every character appears in one group only; empty groups are dropped.
 */
export function characterGroups(options) {
  const removed = new Set([...(options.exclude ?? ""), ...(options.excludeLookAlike ? LOOK_ALIKE : "")]);
  const selected = CLASSES.filter((c) => options.classes.includes(c.id)).map((c) => c.chars);
  const seen = new Set();
  return [...selected, options.include ?? ""]
    .map((chars) =>
      [...chars].filter((c) => {
        const keep = !removed.has(c) && !seen.has(c) && c.trim() !== "";
        seen.add(c);
        return keep;
      }),
    )
    .filter((group) => group.length > 0);
}

/** Bits of entropy of a password of `length` drawn uniformly from `poolSize` characters. */
export const entropyBits = (length, poolSize) => (poolSize > 1 ? length * Math.log2(poolSize) : 0);

/** KeePassXC's bands. */
export const strength = (bits) => (bits < 40 ? "Poor" : bits < 75 ? "Weak" : bits < 100 ? "Good" : "Excellent");

/** Throws `GeneratorError` when the options can't produce a password. */
export function generatePassword(options = DEFAULTS, random32 = cryptoRandom32) {
  const { length, everyGroup } = normalizeOptions(options);
  const groups = characterGroups(normalizeOptions(options));
  if (groups.length === 0) throw new GeneratorError("Select at least one kind of character");
  if (everyGroup && length < groups.length) throw new GeneratorError(`At least ${groups.length} characters are needed to pick from every group`);
  const all = groups.flat();
  const pick = (chars) => chars[uniform(chars.length, random32)];
  const guaranteed = everyGroup ? groups.map(pick) : [];
  const chars = [...guaranteed, ...Array.from({ length: length - guaranteed.length }, () => pick(all))];
  // Fisher–Yates, so the guaranteed characters aren't always at the start.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = uniform(i + 1, random32);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** What the generator panel shows next to the preview. */
export function describe(options) {
  const normalized = normalizeOptions(options);
  const bits = entropyBits(normalized.length, characterGroups(normalized).flat().length);
  return { bits: Math.round(bits), strength: strength(bits) };
}
