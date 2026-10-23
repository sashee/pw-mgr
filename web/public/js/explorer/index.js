// The file explorer's only entry point (web SPEC §9.5). Settings loads this module with a dynamic import, so none of it
// is downloaded during normal use. Delete the folder (and the Settings button) to remove it.
//
// ctx: { root: { revision, blobId }, list(path) → [entry], read(entry) → Uint8Array, close(), onError(error) }

import { replaceChildren } from "../ui/dom.js";
import { explorerScreen } from "./screen.js";

export function openExplorer(container, ctx) {
  replaceChildren(container, explorerScreen(ctx));
}
