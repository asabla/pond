// Data: catalogs → schemas → tables and volumes. Create, drop, preview, and import files.
import { h, grid, table, action, button, snippet, formDialog, confirmDialog, toast, loading, errorBox, empty, fmtTime, fmtBytes, guard } from "../dom.js";

const PREVIEW_ROWS = 100;
const NAME = "^[A-Za-z_][A-Za-z0-9_]*$";
const NAME_HINT = "Letters, digits and underscores.";

export function createDataView(ui) {
  const { lake } = ui;
  const el = h("section", { class: "view", "aria-label": "Data" });
  let token = 0;
  let current = { kind: "home" };

  // Dropping a file anywhere on the Data view starts an import into the schema in view.
  el.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      el.classList.add("dropping");
    }
  });
  el.addEventListener("dragleave", (e) => e.target === el && el.classList.remove("dropping"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dropping");
    const file = e.dataTransfer.files[0];
    if (file) guard(importDialog)(file);
  });

  const page = (...children) => el.replaceChildren(h("div", { class: "page" }, ...children));

  function header({ crumbs = [], title, badges = [], actions = [], sub }) {
    return [
      crumbs.length > 0 && h("div", { class: "crumbs" },
        crumbs.map(([label, target], i) => [i > 0 && "/", h("a", { href: `#/data/${target ?? ""}` }, label)])),
      h("div", { class: "title-row" },
        h("h1", {}, title), badges.filter(Boolean).map((b) => h("span", { class: `badge ${b.accent ? "accent" : ""}` }, b.text ?? b)),
        h("div", { class: "actions" }, actions)),
      sub && h("p", { class: "context-dir mono" }, sub),
    ];
  }

  const section = (title, count, ...body) =>
    h("div", { class: "section" }, h("h2", {}, title, count != null && h("span", {}, String(count))), ...body);

  /* ---------- Pages ---------- */

  async function show(parts) {
    const t = ++token;
    const [first, second] = parts;
    if (!first) current = { kind: "home" };
    else if (first === "volume") current = { kind: "volume", name: second };
    else {
      const n = first.split(".").length;
      current = { kind: ["catalog", "schema", "table"][n - 1] ?? "home", name: first };
    }
    if (current.name) ui.reveal(current.name);
    if (ui.state.offline) return renderOffline();
    page(loading());
    try {
      const render = { home, catalog, schema, table: tablePage, volume }[current.kind];
      await render(current.name, () => t === token);
    } catch (err) {
      if (t === token) page(errorBox(err.message));
    }
  }

  async function home(_, live) {
    const catalogs = await lake.listCatalogs();
    if (!live()) return;
    const ctx = ui.context;
    page(
      header({
        title: ctx ? ctx.name : "Your lake",
        badges: [ctx && { text: "context", accent: true }],
        sub: ctx?.dir,
        actions: [button("Import file", guard(() => importDialog())), button("New catalog", newCatalog, "primary")],
      }),
      h("p", { class: "lede" }, "Catalogs hold schemas, which hold tables and volumes. Drop a CSV, JSON or Parquet file anywhere here to turn it into a table."),
      section("Catalogs", catalogs.length,
        catalogs.length
          ? h("div", { class: "cards" }, catalogs.map((c) => h("a", { class: "card", href: `#/data/${c.name}` }, h("b", {}, c.name), h("span", {}, c.comment || "catalog"))))
          : empty("No catalogs yet. ", h("button", { class: "linkish", onclick: newCatalog }, "Create the first one"), ".")),
      connectSection(),
    );
  }

  function connectSection() {
    const ctx = ui.context;
    const mcpUrl = `${location.origin}/mcp`;
    return section("Connect an agent", null,
      h("p", { class: "help" }, ctx
        ? "MCP for Claude Code, Claude Desktop, Codex and other MCP clients. Each context has its own MCP server, so register it under the context's name."
        : "MCP for Claude Code, Claude Desktop, Codex and other MCP clients. Pond forwards to MiniLake's MCP server."),
      snippet(`claude mcp add --transport http ${ctx ? `pond-${ctx.name}` : "pond"} ${mcpUrl}`),
      h("p", { class: "help" }, "WebMCP: agents in the browser can use this page directly: browse, query, import, run jobs and manage files. What they do shows up here, and destructive actions ask you first."));
  }

  async function catalog(name, live) {
    const [info, schemas] = await Promise.all([
      lake.listCatalogs().then((cs) => cs.find((c) => c.name === name)),
      lake.listSchemas(name),
    ]);
    if (!live()) return;
    if (!info) return page(errorBox(`Catalog ${name} does not exist.`));
    page(
      header({
        crumbs: [["lake", ""]],
        title: name,
        badges: ["catalog"],
        actions: [action("Delete catalog", () => dropObject("catalog", name), "danger-ghost"), button("New schema", () => newSchema(name), "primary")],
      }),
      info.comment && h("p", { class: "lede" }, info.comment),
      section("Schemas", schemas.length, table(schemas, [
        ["Name", (s) => h("a", { href: `#/data/${s.full_name}` }, s.name)],
        ["Comment", (s) => s.comment ?? ""],
        ["Created", (s) => fmtTime(s.created_at)],
      ], { onRow: (s) => ui.navigate("data", s.full_name) })),
    );
  }

  async function schema(fullName, live) {
    const [c, s] = fullName.split(".");
    const [tables, volumes] = await Promise.all([lake.listTables(c, s), lake.listVolumes(c, s)]);
    if (!live()) return;
    page(
      header({
        crumbs: [["lake", ""], [c, c]],
        title: s,
        badges: ["schema"],
        actions: [
          action("Delete schema", () => dropObject("schema", fullName), "danger-ghost"),
          button("New volume", () => newVolume(c, s)),
          button("Import file", guard(() => importDialog(null, { catalog: c, schema: s })), "primary"),
        ],
      }),
      section("Tables", tables.length, table(tables, [
        ["Name", (t) => h("a", { href: `#/data/${t.full_name}` }, t.name)],
        ["Type", (t) => t.table_type ?? ""],
        ["Format", (t) => t.data_source_format ?? ""],
        ["Columns", (t) => String(t.columns?.length ?? "")],
      ], { onRow: (t) => ui.navigate("data", t.full_name), empty: "No tables. Import a file or create one with SQL." })),
      section("Volumes", volumes.length, table(volumes, [
        ["Name", (v) => h("a", { href: `#/data/volume/${v.full_name}` }, v.name)],
        ["Path", (v) => h("span", { class: "mono" }, lake.volumePath(v.full_name))],
        ["Comment", (v) => v.comment ?? ""],
      ], { onRow: (v) => ui.navigate("data", "volume", v.full_name), empty: "No volumes. Volumes hold files: uploads, exports, inputs for jobs." })),
    );
  }

  async function tablePage(fullName, live) {
    const [t, preview] = await Promise.allSettled([lake.getTable(fullName), lake.previewTable(fullName, PREVIEW_ROWS)]);
    if (!live()) return;
    if (t.status === "rejected") throw t.reason;
    renderTable(t.value, preview);
  }

  function renderTable(t, preview, byAgent = false) {
    const columns = t.columns ?? [];
    const query = `SELECT *\nFROM ${lake.quoteName(t.full_name)}\nLIMIT 100`;
    const details = [
      ["Full name", t.full_name], ["Type", t.table_type], ["Format", t.data_source_format],
      ["Location", t.storage_location], ["Owner", t.owner], ["Table id", t.table_id], ["Comment", t.comment],
    ].filter(([, v]) => v);
    let previewBody;
    if (preview.status === "rejected") previewBody = errorBox(preview.reason.message);
    else if (!preview.value.rows.length) previewBody = empty("Table is empty.");
    else previewBody = grid(preview.value);

    page(
      header({
        crumbs: [["lake", ""], [t.catalog_name, t.catalog_name], [t.schema_name, `${t.catalog_name}.${t.schema_name}`]],
        title: t.name,
        badges: [t.table_type, t.data_source_format && { text: t.data_source_format, accent: true }, byAgent && { text: "opened by agent" }],
        actions: [
          action("Drop", () => dropObject("table", t.full_name), "danger-ghost"),
          button("Append file", guard(() => importDialog(null, { catalog: t.catalog_name, schema: t.schema_name, table: t.name, mode: "append" }))),
          columns.length > 1 && button("Open as graph", () => ui.views.graph.newGraph({ edgeTable: t.full_name })),
          button("Query", () => ui.views.query.open(query), "primary"),
        ],
      }),
      section("Columns", columns.length, h("div", { class: "grid-wrap" }, h("table", { class: "grid col-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Nullable"), h("th", {}, "Comment"))),
        h("tbody", {}, columns.map((c) => h("tr", {},
          h("td", {}, c.name), h("td", {}, c.type_text ?? ""), h("td", {}, c.nullable === false ? "no" : "yes"),
          h("td", { class: c.comment ? null : "null" }, c.comment ?? ""))))))),
      section("Preview", preview.value && `first ${Math.min(PREVIEW_ROWS, preview.value.rows.length)} rows`, previewBody),
      section("Details", null, h("dl", { class: "kv" }, details.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))),
    );
  }

  async function volume(fullName, live) {
    const [c, s, v] = fullName.split(".");
    const path = lake.volumePath(fullName);
    const files = await lake.listDir(path).catch((err) => (err.code === "NOT_FOUND" || /not found|does not exist/i.test(err.message) ? [] : Promise.reject(err)));
    if (!live()) return;
    page(
      header({
        crumbs: [["lake", ""], [c, c], [s, `${c}.${s}`]],
        title: v,
        badges: ["volume"],
        sub: path,
        actions: [
          action("Delete volume", () => dropObject("volume", fullName), "danger-ghost"),
          button("Open in Files", () => ui.navigate("files", "dbfs", ...path.split("/").filter(Boolean)), "primary"),
        ],
      }),
      section("Files", files.length, table(files, [
        ["Name", (f) => (f.is_directory ? `${f.name}/` : f.name)],
        ["Size", (f) => (f.is_directory ? "" : fmtBytes(f.file_size))],
        ["Modified", (f) => fmtTime(f.last_modified)],
      ], { onRow: (f) => ui.navigate("files", "dbfs", ...f.path.split("/").filter(Boolean)), empty: "No files yet. Upload them in Files, or import a file into a table." })),
    );
  }

  function renderOffline() {
    const off = ui.state.offline;
    const ctx = ui.context;
    page(
      header({ title: ctx ? ctx.name : "Your lake", badges: [ctx && { text: "context", accent: true }], sub: ctx?.dir }),
      h("div", { class: "section offline" },
        h("h2", {}, off.url ? "MiniLake is not responding" : "Pond is not running"),
        off.url && ctx
          ? [h("p", { class: "help" }, "The MiniLake container for this context stopped answering. Its logs usually say why:"),
            snippet(`docker logs ${ctx.container}`),
            h("p", { class: "help" }, "Restarting ", h("code", {}, "pond"), " in ", h("code", {}, ctx.dir), " starts a fresh container on the same data.")]
          : off.url
            ? h("p", { class: "help" }, `Pond is looking for MiniLake at ${off.url} and nothing answered. Start it, or run `, h("code", {}, "pond"), " without ", h("code", {}, "--minilake"), " to let pond run it.")
            : h("p", { class: "help" }, "This page cannot reach the pond process that serves it. Run ", h("code", {}, "pond"), " in the directory again."),
        h("p", { class: "help muted" }, h("span", { class: "loading" }), ` Retrying · ${off.error}`)),
    );
  }

  /* ---------- Actions ---------- */

  async function newCatalog() {
    const v = await formDialog({
      title: "New catalog",
      fields: [{ name: "name", label: "Name", required: true, pattern: NAME, hint: NAME_HINT }, { name: "comment", label: "Comment" }],
      submit: "Create catalog",
    });
    if (!v) return;
    await run(async () => {
      await lake.createCatalog(v.name, v.comment);
      toast(`Created catalog ${v.name}`);
      await ui.refreshTree();
      ui.navigate("data", v.name);
    });
  }

  async function newSchema(catalogName) {
    const v = await formDialog({
      title: `New schema in ${catalogName}`,
      fields: [{ name: "name", label: "Name", required: true, pattern: NAME, hint: NAME_HINT }, { name: "comment", label: "Comment" }],
      submit: "Create schema",
    });
    if (!v) return;
    await run(async () => {
      await lake.createSchema(catalogName, v.name, v.comment);
      toast(`Created schema ${catalogName}.${v.name}`);
      await ui.refreshTree();
      ui.navigate("data", `${catalogName}.${v.name}`);
    });
  }

  async function newVolume(c, s) {
    const v = await formDialog({
      title: `New volume in ${c}.${s}`,
      intro: "A volume is a folder for files in Unity Catalog, at /Volumes/catalog/schema/volume.",
      fields: [{ name: "name", label: "Name", required: true, pattern: NAME, hint: NAME_HINT }, { name: "comment", label: "Comment" }],
      submit: "Create volume",
    });
    if (!v) return;
    await run(async () => {
      await lake.createVolume(c, s, v.name, v.comment);
      toast(`Created volume ${c}.${s}.${v.name}`);
      await ui.refreshTree();
      ui.navigate("data", "volume", `${c}.${s}.${v.name}`);
    });
  }

  const DROPS = {
    catalog: { fn: (n) => lake.deleteCatalog(n), what: "the catalog and every schema, table and volume in it" },
    schema: { fn: (n) => lake.deleteSchema(n), what: "the schema and every table and volume in it" },
    table: { fn: (n) => lake.deleteTable(n), what: "the table and its data" },
    volume: { fn: (n) => lake.deleteVolume(n), what: "the volume and the files in it" },
  };

  // Returns false when the user cancels; used by both the buttons and the WebMCP tool.
  async function dropObject(kind, fullName, { byAgent = false } = {}) {
    const ok = await confirmDialog({
      title: `${byAgent ? "Agent wants to drop" : "Drop"} ${kind} ${fullName}?`,
      body: `This permanently deletes ${DROPS[kind].what}, in this context only.`,
      confirm: `Drop ${kind}`,
      typeToConfirm: fullName.split(".").pop(),
    });
    if (!ok) return false;
    await DROPS[kind].fn(fullName);
    toast(`Dropped ${kind} ${fullName}`);
    await ui.refreshTree();
    const parent = fullName.split(".").slice(0, -1).join(".");
    ui.navigate("data", ...(parent ? [parent] : []));
    return true;
  }

  async function importDialog(file, defaults = {}) {
    const catalogs = await lake.listCatalogs();
    if (!catalogs.length) return toast("Create a catalog first, then import into one of its schemas.", "err");
    const fromView = current.name?.split(".") ?? [];
    const catalogName = defaults.catalog ?? (catalogs.some((c) => c.name === fromView[0]) ? fromView[0] : catalogs[0].name);
    const schemas = await lake.listSchemas(catalogName);
    const options = [];
    for (const c of catalogs) {
      const ss = c.name === catalogName ? schemas : await lake.listSchemas(c.name);
      for (const s of ss) options.push(`${c.name}.${s.name}`);
    }
    if (!options.length) return toast("Create a schema first.", "err");
    const target = defaults.schema ? `${defaults.catalog}.${defaults.schema}` : fromView.length >= 2 ? `${fromView[0]}.${fromView[1]}` : options[0];

    const v = await formDialog({
      title: "Import file",
      intro: "CSV, TSV, JSON, JSON Lines or Parquet. The file is kept in the schema's “imports” volume and loaded into a table.",
      fields: [
        !file && { name: "file", label: "File", type: "file", required: true, accept: ".csv,.tsv,.json,.jsonl,.ndjson,.parquet" },
        { name: "target", label: "Schema", type: "select", options, value: target },
        { name: "table", label: "Table", value: defaults.table ?? (file ? lake.tableNameFor(file.name) : ""), placeholder: "Defaults to the file name", pattern: NAME },
        { name: "mode", label: "If the table exists", type: "select", value: defaults.mode ?? "create", options: [
          { value: "create", label: "Fail" }, { value: "replace", label: "Replace it" }, { value: "append", label: "Append rows" }] },
      ].filter(Boolean),
      submit: "Import",
      validate: (x) => {
        const f = file ?? x.file;
        if (!f) return "Choose a file.";
        if (!lake.formatOf(f.name)) return `${f.name} is not CSV, TSV, JSON, JSON Lines or Parquet.`;
      },
    });
    if (!v) return;
    const f = file ?? v.file;
    const [c, s] = v.target.split(".");
    const tableName = v.table || lake.tableNameFor(f.name);
    await run(async () => {
      toast(`Importing ${f.name}…`);
      const res = await lake.importFile({ file: f, catalog: c, schema: s, table: tableName, mode: v.mode });
      toast(`Loaded ${res.rows} rows into ${res.table}`);
      await ui.refreshTree();
      ui.navigate("data", res.table);
    });
  }

  async function run(fn) {
    try {
      await fn();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  return {
    el,
    show,
    dropObject,
    treeChanged() {
      if (current.kind === "home" && !el.hidden) show([]);
    },
    // Used by WebMCP's open_table: shows the table and hands back what was shown.
    async openTable(fullName) {
      ui.navigate("data", fullName);
      const [t, preview] = await Promise.allSettled([lake.getTable(fullName), lake.previewTable(fullName, PREVIEW_ROWS)]);
      if (t.status === "rejected") throw t.reason;
      ++token;
      renderTable(t.value, preview, true);
      return { table: t.value, preview: preview.value, previewError: preview.reason?.message };
    },
    snapshot: () => ({ selected: current.name ?? null, kind: current.kind }),
  };
}
