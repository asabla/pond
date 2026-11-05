// Files: the lake's file system (DBFS root, including /Volumes) and the workspace.
import { h, grid, table, action, button, formDialog, confirmDialog, toast, loading, errorBox, empty, download, fmtTime, fmtBytes } from "../dom.js";

const TEXT_PREVIEW_BYTES = 64 * 1024;
const TEXT_EXT = /\.(txt|md|py|sql|sh|ya?ml|toml|ini|cfg|log|csv|tsv|json|jsonl|ndjson|xml|html|js|ts|r|scala)$/i;

const joinPath = (...parts) => `/${parts.join("/").split("/").filter(Boolean).join("/")}`;
const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
// /Volumes/<catalog>/<schema>/<volume>/... → [catalog, schema]
const volumeOf = (path) => {
  const m = path.match(/^\/Volumes\/([^/]+)\/([^/]+)\/[^/]+\//);
  return m ? [m[1], m[2]] : null;
};

export function createFilesView(ui) {
  const { lake } = ui;
  const el = h("section", { class: "view", "aria-label": "Files" });
  let token = 0;
  let current = { root: "dbfs", path: "/", selected: null };

  el.addEventListener("dragover", (e) => {
    if (current.root === "dbfs" && [...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      el.classList.add("dropping");
    }
  });
  // dragleave also fires when moving between children; only clear when leaving the view.
  el.addEventListener("dragleave", (e) => !el.contains(e.relatedTarget) && el.classList.remove("dropping"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dropping");
    if (current.root === "dbfs" && e.dataTransfer.files.length) upload([...e.dataTransfer.files]);
  });

  const page = (...children) => el.replaceChildren(h("div", { class: "page" }, ...children));

  async function show(parts) {
    const t = ++token;
    const [root, ...rest] = parts;
    const next = { root: root === "workspace" ? "workspace" : "dbfs", path: joinPath(...rest), selected: null };
    if (next.root !== current.root || next.path !== current.path) current = next;
    page(loading());
    try {
      if (current.root === "workspace") await workspacePage(() => t === token);
      else await dbfsPage(() => t === token);
    } catch (err) {
      if (t === token) page(rootTabs(), errorBox(err.message));
    }
  }

  const go = (root, path) => ui.navigate("files", root, ...path.split("/").filter(Boolean));

  function rootTabs() {
    return h("div", { class: "subtabs" },
      [["dbfs", "Files", "Volumes and DBFS"], ["workspace", "Workspace", "Scripts and notebooks"]].map(([key, label, title]) =>
        h("a", { href: `#/files/${key}`, title, "aria-current": String(current.root === key) }, label)));
  }

  function crumbs() {
    const segs = current.path.split("/").filter(Boolean);
    return h("div", { class: "crumbs path-crumbs" },
      h("a", { href: `#/files/${current.root}` }, current.root === "dbfs" ? "dbfs:" : "workspace:"),
      segs.map((seg, i) => ["/", h("a", { href: `#/files/${current.root}/${segs.slice(0, i + 1).map(encodeURIComponent).join("/")}` }, seg)]));
  }

  /* ---------- DBFS / Volumes ---------- */

  async function dbfsPage(live) {
    let entries;
    try {
      entries = await lake.listDir(current.path);
    } catch (err) {
      // A file path: show its folder with the file selected.
      const parent = parentOf(current.path);
      const siblings = await lake.listDir(parent).catch(() => null);
      const file = siblings?.find((e) => e.path === current.path && !e.is_directory);
      if (!file) throw err;
      current = { ...current, path: parent, selected: file };
      entries = siblings;
    }
    if (!live()) return;
    entries.sort((a, b) => (b.is_directory - a.is_directory) || a.name.localeCompare(b.name));
    const input = h("input", { type: "file", multiple: true, hidden: true, onchange: (e) => upload([...e.target.files]) });

    page(
      rootTabs(),
      h("div", { class: "title-row" }, crumbs(), h("div", { class: "actions" },
        current.path !== "/" && action("Delete folder", () => remove({ path: current.path, is_directory: true }), "danger-ghost"),
        button("New folder", newFolder),
        button("Upload", () => input.click(), "primary"), input)),
      current.path === "/" && h("p", { class: "lede" }, "Files in this context's lake. Volumes live under /Volumes/catalog/schema/volume. Drop files here to upload them."),
      table(entries, [
        ["Name", (e) => h("span", { class: "file-name" }, h("span", { class: "glyph" }, e.is_directory ? "▸" : "·"), e.is_directory ? `${e.name}/` : e.name)],
        ["Size", (e) => (e.is_directory ? "" : fmtBytes(e.file_size))],
        ["Modified", (e) => fmtTime(e.last_modified)],
        ["", (e) => h("span", { class: "row-actions" },
          !e.is_directory && action("Download", async () => download(e.name, await lake.readFile(e.path)), "ghost"),
          action("Delete", () => remove(e), "ghost danger-text"))],
      ], {
        onRow: (e) => (e.is_directory ? go("dbfs", e.path) : select(e)),
        empty: "Empty folder. Drop files here or use Upload.",
      }),
      h("div", { id: "file-preview" }),
    );
    if (current.selected) select(current.selected);
  }

  async function select(entry) {
    current.selected = entry;
    const box = el.querySelector("#file-preview");
    box.replaceChildren(h("div", { class: "section" }, loading()));
    const dataFormat = lake.formatOf(entry.name);
    const vol = volumeOf(entry.path);
    let body;
    try {
      if (dataFormat) {
        body = grid(await lake.runSql(await lake.selectFromFile(entry.path, 50)));
      } else if (TEXT_EXT.test(entry.name) || entry.file_size < 4096) {
        const { text, truncated } = await lake.readHead(entry.path, TEXT_PREVIEW_BYTES);
        body = h("pre", { class: "logs" }, text, truncated && "\n… (truncated)");
      } else body = empty("No preview for this file type.");
    } catch (err) {
      body = errorBox(err.message);
    }
    if (current.selected !== entry) return;
    box.replaceChildren(h("div", { class: "section preview" },
      h("div", { class: "title-row" }, h("h2", {}, entry.name, h("span", {}, fmtBytes(entry.file_size))), h("div", { class: "actions" },
        dataFormat && button("Query", async () => ui.views.query.open(await lake.selectFromFile(entry.path))),
        dataFormat && button("Create table", () => tableDialog(entry, vol), "primary"),
        action("Download", async () => download(entry.name, await lake.readFile(entry.path))))),
      h("p", { class: "context-dir mono" }, entry.path),
      body));
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function tableDialog(entry, vol) {
    const options = [];
    for (const c of await lake.listCatalogs()) for (const s of await lake.listSchemas(c.name)) options.push(`${c.name}.${s.name}`);
    if (!options.length) return toast("Create a catalog first.", "err");
    const v = await formDialog({
      title: `Create table from ${entry.name}`,
      fields: [
        { name: "target", label: "Schema", type: "select", options, value: vol ? vol.join(".") : options[0] },
        { name: "table", label: "Table", value: lake.tableNameFor(entry.name), required: true, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        { name: "mode", label: "If the table exists", type: "select", options: [
          { value: "create", label: "Fail" }, { value: "replace", label: "Replace it" }, { value: "append", label: "Append rows" }] },
      ],
      submit: "Create table",
    });
    if (!v) return;
    const [catalog, schema] = v.target.split(".");
    try {
      const res = await lake.tableFromFile({ path: entry.path, catalog, schema, table: v.table, mode: v.mode });
      toast(`Loaded ${res.rows} rows into ${res.table}`);
      await ui.refreshTree();
      ui.navigate("data", res.table);
    } catch (err) {
      toast(err.message, "err");
    }
  }

  async function upload(files) {
    try {
      for (const f of files) {
        toast(`Uploading ${f.name}…`);
        await lake.uploadFile(joinPath(current.path, f.name), f);
      }
      toast(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast(err.message, "err");
    }
    show([current.root, ...current.path.split("/").filter(Boolean)]);
  }

  async function newFolder() {
    const v = await formDialog({ title: `New folder in ${current.path}`, fields: [{ name: "name", label: "Name", required: true, pattern: "[^/]+" }], submit: "Create" });
    if (!v) return;
    try {
      await lake.makeDir(joinPath(current.path, v.name));
    } catch (err) {
      return toast(err.message, "err");
    }
    go("dbfs", joinPath(current.path, v.name));
  }

  async function remove(entry, { byAgent = false } = {}) {
    const ok = await confirmDialog({
      title: `${byAgent ? "Agent wants to delete" : "Delete"} ${entry.is_directory ? "folder" : "file"} ${baseName(entry.path)}?`,
      body: entry.is_directory ? `${entry.path} and everything in it will be deleted.` : `${entry.path} will be deleted.`,
      typeToConfirm: entry.is_directory ? baseName(entry.path) : undefined,
    });
    if (!ok) return false;
    if (entry.is_directory) await lake.deleteTree(entry.path);
    else await lake.deleteFile(entry.path);
    toast(`Deleted ${entry.path}`);
    if (entry.path === current.path) go("dbfs", parentOf(entry.path));
    else if (!el.hidden) show([current.root, ...current.path.split("/").filter(Boolean)]);
    return true;
  }

  /* ---------- Workspace ---------- */

  async function workspacePage(live) {
    let objects;
    let file = null;
    objects = await lake.listWorkspace(current.path);
    // MiniLake lists a file path as itself; treat that as opening the file. Other errors
    // (a missing folder, MiniLake down) propagate to the error box.
    if (objects.length === 1 && objects[0].path === current.path && objects[0].object_type !== "DIRECTORY") {
      file = current.path;
      current.path = parentOf(file);
      objects = await lake.listWorkspace(current.path);
    }
    if (!live()) return;
    objects.sort((a, b) => ((b.object_type === "DIRECTORY") - (a.object_type === "DIRECTORY")) || a.path.localeCompare(b.path));
    page(
      rootTabs(),
      h("div", { class: "title-row" }, crumbs(), h("div", { class: "actions" }, button("New script", newScript, "primary"))),
      current.path === "/" && h("p", { class: "lede" }, "Scripts and notebooks. Pond keeps the scripts it runs as jobs in /Shared/pond."),
      table(objects, [
        ["Name", (o) => h("span", { class: "file-name" }, h("span", { class: "glyph" }, o.object_type === "DIRECTORY" ? "▸" : "·"),
          baseName(o.path) + (o.object_type === "DIRECTORY" ? "/" : ""))],
        ["Type", (o) => (o.object_type === "DIRECTORY" ? "" : `${o.object_type.toLowerCase()}${o.language ? ` · ${o.language.toLowerCase()}` : ""}`)],
        ["Size", (o) => fmtBytes(o.size)],
        ["", (o) => action("Delete", async () => {
          if (!(await confirmDialog({ title: `Delete ${baseName(o.path)}?`, body: `${o.path}${o.object_type === "DIRECTORY" ? " and everything in it" : ""} will be deleted from the workspace.` }))) return;
          await lake.deleteWorkspace(o.path, true);
          toast(`Deleted ${o.path}`);
          show(["workspace", ...current.path.split("/").filter(Boolean)]);
        }, "ghost danger-text")],
      ], { onRow: (o) => go("workspace", o.path), empty: "Empty folder." }),
      h("div", { id: "file-preview" }),
    );
    if (file) openWorkspaceFile(file, objects.find((o) => o.path === file));
  }

  async function openWorkspaceFile(path, info) {
    const box = el.querySelector("#file-preview");
    box.replaceChildren(h("div", { class: "section" }, loading()));
    const source = await lake.exportWorkspace(path).catch((err) => (box.replaceChildren(errorBox(err.message)), null));
    if (source == null) return;
    const editor = h("textarea", { class: "editor code-editor", spellcheck: "false", "aria-label": path }, source);
    const isPython = /\.py$/.test(path) || info?.language === "PYTHON";
    box.replaceChildren(h("div", { class: "section preview" },
      h("div", { class: "title-row" }, h("h2", {}, baseName(path)), h("div", { class: "actions" },
        action("Save", async () => {
          await lake.importWorkspace(path, editor.value, info?.language ?? "PYTHON");
          toast("Saved");
        }),
        isPython && action("Run", async () => {
          await lake.importWorkspace(path, editor.value, info?.language ?? "PYTHON");
          const { run_id } = await lake.submitFile(baseName(path), path, []);
          ui.navigate("jobs", "run", run_id);
        }, "primary"))),
      h("p", { class: "context-dir mono" }, path),
      editor));
  }

  async function newScript() {
    const v = await formDialog({
      title: `New script in ${current.path}`,
      fields: [{ name: "name", label: "File name", required: true, value: "script.py", pattern: "[^/]+" }],
      submit: "Create",
    });
    if (!v) return;
    const path = joinPath(current.path, v.name);
    try {
      await lake.importWorkspace(path, "# New script\n");
      go("workspace", path);
    } catch (err) {
      toast(err.message, "err");
    }
  }

  return {
    el,
    show,
    remove,
    snapshot: () => ({ files_root: current.root, path: current.path, selected_file: current.selected?.path ?? null }),
  };
}
