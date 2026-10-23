// The SDK's flows (e2ee-store/sdk/SPEC.md §6), configured for the password manager: its namespace (SPEC §4). Its data
// is the file `vault` in the SDK's tree (SPEC §5).

import { makeFlows } from "../sdk/flows.js";
import { labels } from "../sdk/labels.js";

/** Fixed forever: every key and blob of existing vaults is bound to it. */
export const LABELS = labels("pw-mgr");

export const flows = makeFlows({ labels: LABELS });
