// The file explorer's screen (web SPEC §9.5): the vault's tree as it is stored, read-only. A directory lists its
// entries; a file shows its fields and its content, with secrets masked until asked for. Nothing here writes.

import { h, replaceChildren } from "../ui/dom.js";
import { contentView, entryRows, short } from "./view.js";

const card = (title, ...content) => h("section", { class: "card" }, h("h2", {}, title), ...content);
const shown = (path) => `/${path.join("/")}`;

export function explorerScreen(ctx) {
  const root = h("div", { id: "explorer" });
  const show = (...nodes) => replaceChildren(root, ...nodes);
  const attempt = (action) => () => action().catch(ctx.onError);

  const toolbar = () => h("div", { class: "toolbar" }, h("button", { type: "button", id: "explorer-back", onclick: ctx.close }, "← Back to settings"));

  /** The way back up: the root, then each directory on the path. */
  const breadcrumbs = (path) =>
    h(
      "nav",
      { class: "breadcrumbs", id: "explorer-path" },
      [[], ...path.map((_, i) => path.slice(0, i + 1))].map((p) =>
        h("button", { type: "button", class: "crumb", onclick: attempt(() => openDirectory(p)) }, p.length === 0 ? "/" : p.at(-1)),
      ),
    );

  async function openDirectory(path) {
    const entries = await ctx.list(path);
    const row = (entry) => {
      const target = [...path, entry.name];
      const open = entry.kind === "dir" ? () => openDirectory(target) : () => openFile(path, entry);
      const facts = entry.kind === "dir" ? ["directory"] : [`${entry.size} bytes`, new Date(entry.modified).toLocaleString()];
      return h(
        "li",
        { "data-name": entry.name },
        h("button", { type: "button", class: "entry", onclick: attempt(open) }, entry.kind === "dir" ? `${entry.name}/` : entry.name),
        h("span", { class: "muted" }, ` · ${[...facts, short(entry.id)].join(" · ")}`),
      );
    };
    show(
      toolbar(),
      card(
        "Files",
        breadcrumbs(path),
        path.length === 0 && h("p", { class: "muted", id: "explorer-root" }, `Root directory at revision ${ctx.root.revision}, blob ${short(ctx.root.blobId)}`),
        entries.length === 0 ? h("p", { class: "muted" }, "This directory is empty.") : h("ul", { class: "explorer-list", id: "explorer-entries" }, entries.map(row)),
      ),
    );
  }

  async function openFile(directory, entry) {
    const bytes = await ctx.read(entry);
    const render = (reveal) => {
      const view = contentView(bytes, { reveal });
      show(
        toolbar(),
        card(
          entry.name,
          breadcrumbs(directory),
          h("dl", { class: "explorer-fields", id: "explorer-fields" }, entryRows(entry).map(([label, value]) => [h("dt", {}, label), h("dd", {}, h("code", { class: "wrap" }, value))])),
          view.secrets &&
            h(
              "div",
              { class: "actions" },
              h("button", { type: "button", id: "explorer-reveal", onclick: () => render(!reveal) }, reveal ? "Hide secrets" : "Show secrets"),
            ),
          h("pre", { class: "explorer-content", id: "explorer-content", "data-kind": view.kind }, view.text),
        ),
      );
    };
    render(false);
  }

  attempt(() => openDirectory([]))();
  return root;
}
