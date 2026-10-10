// The SDK's flows (e2ee-store/sdk/SPEC.md §6), configured for the password manager: its namespace (SPEC §4)
// and its vault document (SPEC §6).

import { makeFlows } from "../sdk/flows.js";
import { labels } from "../sdk/labels.js";
import { vaultDocument } from "./lib/vault.js";

/** Fixed forever: every key and blob of existing vaults is bound to it. */
export const LABELS = labels("pw-mgr");

export const flows = makeFlows({ labels: LABELS, document: vaultDocument });
