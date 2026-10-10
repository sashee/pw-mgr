// The KeePass import's only entry point (web SPEC §8.5). Settings loads this module with a dynamic import,
// so none of it is downloaded during normal use. Delete the folder (and the Settings button) to remove it.
//
// ctx: { entries: the vault's current entries, save(operation): the app's normal save, close(result | null) }

import { replaceChildren } from "../ui/dom.js";
import { importScreen } from "./screen.js";

export function openImportScreen(container, ctx) {
  replaceChildren(container, importScreen(ctx));
}
