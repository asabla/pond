// App shell: routing, status, the catalog tree and agent activity. Views live in views/.
import * as lake from "./lake.js";
import { $, h, toast } from "./dom.js";
import { registerWebMcp } from "./webmcp.js";
import { createDataView } from "./views/data.js";
import { createQueryView } from "./views/query.js";
import { createJobsView } from "./views/jobs.js";
import { createFilesView } from "./views/files.js";
import { createAdminView } from "./views/admin.js";

const RETRY_MS = 3000;
const WITH_TREE = new Set(["data", "query"]);

const state = {
  route: { view: "data", parts: [] },
  offline: null, // { url, error } while MiniLake (or Pond itself) is unreachable
  context: null, // { name, id, dir, container } when pond manages MiniLake for a directory
  config: null,
};

/* ---------- Routing ---------- */

// Routes are #/<view>/<part>/<part>…; parts are URI-encoded one by one.
function parseRoute() {
  const [view, ...parts] = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return { view: views[view] ? view : "data", parts };
}

export function navigate(view, ...parts) {
  const hash = `#/${[view, ...parts].map((p) => encodeURIComponent(p).replaceAll("%2F", "/")).join("/")}`;
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  state.route = parseRoute();
  const { view, parts } = state.route;
  for (const a of document.querySelectorAll(".tabs a")) a.setAttribute("aria-current", String(a.dataset.view === view));
  $("#layout").classList.toggle("no-tree", !WITH_TREE.has(view));
  const main = $("#main");
  for (const [name, v] of Object.entries(views)) {
    v.el.hidden = name !== view;
    if (name === view && !v.el.isConnected) main.append(v.el);
  }
  views[view].show(parts);
  renderTree();
}

/* ---------- Status ---------- */

function setPill(id, pillState, title) {
  const pill = $(id);
  pill.dataset.state = pillState;
  if (title) pill.title = title;
}

function renderContext(context) {
  state.context = context;
  const chip = $("#context");
  chip.hidden = !context;
  if (!context) return;
  chip.textContent = context.name;
  chip.title = `Context: ${context.dir}`;
  document.title = `${context.name} · Pond`;
}

async function loadStatus() {
  try {
    const cfg = await lake.config({ refresh: true });
    state.config = cfg;
    renderContext(cfg.context);
    if (cfg.error) {
      state.offline = { url: cfg.minilake_url, error: cfg.error };
      setPill("#pill-lake", "err", `Cannot reach ${cfg.minilake_url}: ${cfg.error}`);
      setPill("#pill-mcp", "", "Unknown while MiniLake is unreachable");
      return;
    }
    state.offline = null;
    setPill("#pill-lake", "ok", `${cfg.minilake_url} · warehouse ${cfg.warehouse_id}`);
    setPill("#pill-mcp", cfg.mcp ? "ok" : "warn",
      cfg.mcp ? `${location.origin}/mcp` : "MiniLake MCP is off. Start MiniLake with MINILAKE_MCP=1 and the [mcp] extra.");
  } catch (err) {
    state.offline = { url: null, error: String(err.message || err) };
    setPill("#pill-lake", "err", `Pond server unreachable: ${state.offline.error}`);
    setPill("#pill-mcp", "", "Unknown while Pond is unreachable");
  }
}

let retryTimer;

// While MiniLake is down, keep retrying so the page comes alive on its own once it is back.
async function connect() {
  clearTimeout(retryTimer);
  const wasOffline = Boolean(state.offline);
  await loadStatus();
  if (state.offline) {
    tree.catalogs = [];
    render();
    retryTimer = setTimeout(connect, RETRY_MS);
    return;
  }
  await refreshTree();
  if (wasOffline) render();
}

/* ---------- Catalog tree ---------- */

const tree = { catalogs: null, schemas: {}, children: {}, open: new Set(), errors: {}, filter: "" };

async function refreshTree() {
  const open = tree.open;
  Object.assign(tree, { catalogs: null, schemas: {}, children: {}, errors: {} });
  renderTree();
  try {
    tree.catalogs = await lake.listCatalogs();
  } catch (err) {
    tree.errors.root = err.message;
    tree.catalogs = [];
  }
  // Re-open what was open so a refresh after a change does not collapse the tree.
  for (const key of open) {
    const [c, s] = key.split(".");
    if (!tree.catalogs.some((x) => x.name === c)) open.delete(key);
    else if (s) await loadChildren(c, s);
    else await loadSchemas(c);
  }
  renderTree();
  views.data.treeChanged?.();
}

async function loadSchemas(catalog) {
  if (tree.schemas[catalog]) return tree.schemas[catalog];
  try {
    tree.schemas[catalog] = await lake.listSchemas(catalog);
  } catch (err) {
    tree.errors[catalog] = err.message;
    tree.schemas[catalog] = [];
  }
  return tree.schemas[catalog];
}

async function loadChildren(catalog, schema) {
  const key = `${catalog}.${schema}`;
  if (tree.children[key]) return tree.children[key];
  try {
    const [tables, volumes] = await Promise.all([lake.listTables(catalog, schema), lake.listVolumes(catalog, schema)]);
    tree.children[key] = { tables, volumes };
  } catch (err) {
    tree.errors[key] = err.message;
    tree.children[key] = { tables: [], volumes: [] };
  }
  return tree.children[key];
}

async function loadEverything() {
  for (const c of tree.catalogs ?? []) {
    for (const s of await loadSchemas(c.name)) await loadChildren(c.name, s.name);
  }
}

async function expand(key) {
  tree.open.add(key);
  const [c, s] = key.split(".");
  renderTree();
  if (s) await loadChildren(c, s);
  else await loadSchemas(c);
  renderTree();
}

function toggle(key) {
  if (tree.open.has(key)) {
    tree.open.delete(key);
    renderTree();
  } else expand(key);
}

function highlight(text) {
  const q = tree.filter;
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function node({ label, glyph, meta, open, current, onclick, ontoggle, title }) {
  return h("div", { class: "node", "aria-current": String(Boolean(current)), title },
    ontoggle
      ? h("button", { class: "caret", "aria-expanded": String(open), "aria-label": open ? "Collapse" : "Expand", onclick: ontoggle }, "▶")
      : h("span", { class: "caret" }),
    h("button", { class: "node-label", onclick },
      h("span", { class: "glyph" }, glyph), h("span", { class: "label" }, highlight(label)), meta && h("span", { class: "meta" }, meta)));
}

function renderTree() {
  const root = $("#tree");
  if (!WITH_TREE.has(state.route.view)) return;
  if (state.offline) return root.replaceChildren(h("li", { class: "tree-note" }, h("span", { class: "loading" }), " Waiting for MiniLake…"));
  if (tree.catalogs === null) return root.replaceChildren(h("li", { class: "tree-note" }, h("span", { class: "loading" })));
  if (tree.errors.root) return root.replaceChildren(h("li", { class: "tree-note err" }, tree.errors.root));
  if (!tree.catalogs.length) {
    return root.replaceChildren(h("li", { class: "tree-note" }, "No catalogs yet. ",
      h("a", { href: "#/data" }, "Create one")));
  }

  const q = tree.filter;
  const match = (name) => !q || name.toLowerCase().includes(q);
  const selected = state.route.view === "data" ? state.route.parts.join("/") : null;
  const items = [];

  for (const c of tree.catalogs) {
    const schemaItems = [];
    for (const s of tree.schemas[c.name] ?? []) {
      const key = `${c.name}.${s.name}`;
      const kids = tree.children[key];
      const parentMatch = match(s.name) || match(c.name);
      const tables = (kids?.tables ?? []).filter((t) => parentMatch || match(t.name));
      const volumes = (kids?.volumes ?? []).filter((v) => parentMatch || match(v.name));
      if (q && !tables.length && !volumes.length && !parentMatch) continue;
      const open = q ? true : tree.open.has(key);
      schemaItems.push(h("li", { role: "treeitem" },
        node({ label: s.name, glyph: "▤", open, current: selected === key, onclick: () => (expand(key), navigate("data", key)), ontoggle: () => toggle(key) }),
        open && h("ul", { role: "group" },
          tree.errors[key] && h("li", { class: "tree-note err" }, tree.errors[key]),
          !kids && h("li", { class: "tree-note" }, h("span", { class: "loading" })),
          kids && !kids.tables.length && !kids.volumes.length && h("li", { class: "tree-note" }, "Empty"),
          tables.map((t) => h("li", { role: "treeitem" }, node({
            label: t.name, glyph: t.table_type === "VIEW" ? "◇" : "▦", meta: t.data_source_format?.toLowerCase(),
            current: selected === t.full_name, title: t.full_name, onclick: () => navigate("data", t.full_name),
          }))),
          volumes.map((v) => h("li", { role: "treeitem" }, node({
            label: v.name, glyph: "◫", meta: "volume", current: selected === `volume/${v.full_name}`,
            title: `Volume ${v.full_name}`, onclick: () => navigate("data", "volume", v.full_name),
          }))))));
    }
    if (q && !schemaItems.length && !match(c.name)) continue;
    const open = q ? true : tree.open.has(c.name);
    items.push(h("li", { role: "treeitem" },
      node({ label: c.name, glyph: "◉", open, current: selected === c.name, onclick: () => (expand(c.name), navigate("data", c.name)), ontoggle: () => toggle(c.name) }),
      open && h("ul", { role: "group" },
        tree.errors[c.name] && h("li", { class: "tree-note err" }, tree.errors[c.name]),
        !tree.schemas[c.name] && h("li", { class: "tree-note" }, h("span", { class: "loading" })),
        schemaItems)));
  }
  root.replaceChildren(...(items.length ? items : [h("li", { class: "tree-note" }, `Nothing matches “${q}”.`)]));
}

async function reveal(fullName) {
  const [c, s] = fullName.split(".");
  if (!c) return;
  tree.open.add(c);
  await loadSchemas(c);
  if (s) {
    tree.open.add(`${c}.${s}`);
    await loadChildren(c, s);
  }
  renderTree();
  document.querySelector(`.node[aria-current="true"]`)?.scrollIntoView({ block: "nearest" });
}

/* ---------- Agent activity ---------- */

let activityCount = 0;

function logAgent(tool, input, error) {
  activityCount += 1;
  const btn = $("#activity-btn");
  btn.hidden = false;
  $("#activity-count").textContent = String(activityCount);
  btn.classList.remove("pulse");
  void btn.offsetWidth;
  btn.classList.add("pulse");
  // Never echo secret values into the page.
  const shown = input && Object.fromEntries(Object.entries(input).map(([k, v]) => [k, k === "value" ? "••••" : v]));
  const args = shown && Object.keys(shown).length ? JSON.stringify(shown, null, 1) : null;
  $("#activity-log").prepend(h("li", { class: error ? "err" : null },
    h("code", {}, tool), h("span", { class: "muted" }, ` · ${new Date().toLocaleTimeString()}`),
    args && h("pre", {}, args.length > 600 ? `${args.slice(0, 600)}…` : args), error && h("pre", {}, error)));
  toast(error ? `Agent: ${tool} failed` : `Agent used ${tool}`, "agent");
}

/* ---------- Wiring ---------- */

const ui = {
  lake,
  state,
  navigate,
  refreshTree,
  reveal,
  logAgent,
  get context() {
    return state.context;
  },
  snapshot() {
    return {
      context: state.context && { name: state.context.name, dir: state.context.dir },
      view: state.route.view,
      route: state.route.parts.join("/"),
      ...views[state.route.view].snapshot?.(),
    };
  },
};

const views = {
  data: createDataView(ui),
  query: createQueryView(ui),
  jobs: createJobsView(ui),
  files: createFilesView(ui),
  admin: createAdminView(ui),
};
ui.views = views;

$("#refresh-tree").addEventListener("click", () => connect());
$("#activity-btn").addEventListener("click", (e) => {
  const panel = $("#activity");
  panel.hidden = !panel.hidden;
  e.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
});

let filterTimer;
$("#filter").addEventListener("input", (e) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    tree.filter = e.target.value.trim().toLowerCase();
    if (tree.filter) await loadEverything();
    renderTree();
  }, 120);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    navigate("query");
  } else if (e.key === "Escape") {
    $("#activity").hidden = true;
  }
});

window.addEventListener("hashchange", render);

const webmcp = registerWebMcp(ui);
setPill("#pill-webmcp", webmcp.ok ? "ok" : "", webmcp.message);

render();
await connect();
