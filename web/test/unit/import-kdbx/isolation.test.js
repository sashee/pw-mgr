import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// web SPEC §8.5: the KeePass import is deletable; nothing outside its folder may depend on it, except the one
// dynamic import in main.js.
const JS = new URL("../../../public/js/", import.meta.url).pathname;

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".js") ? [path] : [];
  });

test("only main.js refers to import-kdbx, and only through a dynamic import", () => {
  for (const file of files(JS).filter((f) => !relative(JS, f).startsWith("import-kdbx/"))) {
    const source = readFileSync(file, "utf8");
    const mentions = source.match(/import-kdbx[^"'`]*/g) ?? [];
    if (relative(JS, file) === "main.js") {
      assert.deepEqual(mentions, ["import-kdbx/index.js"], "one reference, to the entry point");
      assert.match(source, /await import\("\.\/import-kdbx\/index\.js"\)/, "a dynamic import");
      assert.doesNotMatch(source, /^import .*import-kdbx/m, "no static import");
    } else {
      assert.deepEqual(mentions, [], relative(JS, file));
    }
  }
});

test("the import module only uses the app's shared modules, never main.js or flows.js", () => {
  for (const file of files(join(JS, "import-kdbx"))) {
    const imports = [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const path of imports.filter((p) => p.startsWith(".."))) assert.match(path, /^\.\.\/(lib|ui)\//, `${relative(JS, file)} imports ${path}`);
  }
});
