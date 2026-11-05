// @ts-check
// The workbench: every running context in one page. A navigator lists each context's
// tables, queries, graphs, jobs and files; what you open becomes a tab; ⌘K finds
// anything; the activity rail shows what you and agents did.
//
// Views (views/*.js) are created once per tab, with a `ui` made for that tab, so a query
// in one context and a table in another can sit side by side.
import { createLake, LakeError } from "./lake.js";
import { listGraphs } from "./graph.js";
import { $, h, toast, store, snippet, reconcile, shellQuote } from "./dom.js";
import { registerWebMcp, agentTrust } from "./webmcp.js";
import { createHomeView } from "./views/home.js";
import { createDataView } from "./views/data.js";
import { createQueryView } from "./views/query.js";
import { createJobsView } from "./views/jobs.js";
import { createGraphView } from "./views/graph.js";
import { createFilesView } from "./views/files.js";
import { createAdminView } from "./views/admin.js";

const FACTORIES = {
  home: createHomeView, data: createDataView, query: createQueryView, graph: createGraphView,
  jobs: createJobsView, files: createFilesView, admin: createAdminView,
};
const VIEWS = Object.keys(FACTORIES);
const RETRY_MS = 3000;
const CONTEXTS_MS = 10000;
const SLOTS = 6; // context colours reuse the graph palette's six slots
const STATE_KEY = "pond.workbench";

/**
 * @typedef {object} Ctx
 * @property {string} id
 * @property {string} name
 * @property {string} dir
 * @property {boolean} running
 * @property {boolean} self
 * @property {string} [ui]
 * @property {string} [status]
 * @property {number} slot
 * @property {ReturnType<typeof createLake>} lake
 * @property {Date} [lastContact]
 * @property {any} config
 * @property {{ url: string | null, error: string } | null} offline
 * @property {Nav} nav
 */

/**
 * @typedef {object} Nav
 * @property {Set<string>} open
 * @property {any[] | null} catalogs
 * @property {Record<string, any[]>} schemas
 * @property {Record<string, { tables: any[], volumes: any[] }>} children
 * @property {any[] | null} queries
 * @property {any[] | null} graphs
 * @property {any[] | null} jobs
 * @property {Record<string, string>} errors
 */

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {Ctx} ctx
 * @property {string} view
 * @property {string[]} parts
 * @property {string} [title]
 * @property {boolean} [agent] the tab agents' queries run in
 * @property {any} [instance]
 * @property {HTMLElement} [el]
 */

const state = {
  /** @type {Ctx[]} */ contexts: [],
  /** @type {Tab[]} */ tabs: [],
  /** @type {Tab | null} */ active: null,
  filter: "",
  serverOffline: false,
  lastContact: null,
  activity: /** @type {{ at: Date, ctx: Ctx | null, actor: "you" | "agent", text: string, detail?: string, error?: boolean }[]} */ ([]),
  unseen: 0,
};

/* ---------- Contexts ---------- */

const newNav = () => ({ open: new Set(), catalogs: null, schemas: {}, children: {}, queries: null, graphs: null, jobs: null, errors: {} });

const self = () => state.contexts.find((c) => c.self) ?? state.contexts[0];
const byId = (id) => state.contexts.find((c) => c.id === id);

// A context keeps its colour for good: the slot comes from its id, not its position.
function slotOf(id) {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n % SLOTS;
}

async function loadContexts() {
  let listed = [];
  try {
    const res = await fetch("/pond/contexts", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Pond returned ${res.status}`);
    listed = (await res.json()).contexts ?? [];
    state.serverOffline = false;
    state.lastContact = new Date();
  } catch {
    state.serverOffline = true;
    renderConnection();
    return;
  }
  // A pond that doesn't manage a context (--minilake) still serves its own lake.
  if (!listed.some((c) => c.self)) {
    const cfg = await createLake("").config().catch(() => null);
    const name = cfg?.context?.name ?? new URL(cfg?.minilake_url ?? "http://lake").hostname;
    listed.unshift({ id: cfg?.context?.id ?? "self", name, dir: cfg?.context?.dir ?? cfg?.minilake_url ?? "", running: true, self: true });
  }
  const next = listed.map((c) => {
    const known = byId(c.id);
    if (known) return Object.assign(known, { running: c.running, status: c.status, ui: c.ui, name: c.name, dir: c.dir });
    const nav = newNav();
    for (const key of store(STATE_KEY)?.navOpen?.[c.id] ?? []) nav.open.add(key);
    return {
      ...c, slot: slotOf(c.id), lake: createLake(c.self ? "" : `/ctx/${encodeURIComponent(c.id)}`),
      config: null, offline: null, nav,
    };
  });
  state.contexts = next;
  renderConnection();
  renderNav();
  renderTabs();
}

/** @param {Ctx} ctx */
async function loadStatus(ctx) {
  if (!ctx.running) return;
  const was = ctx.offline;
  try {
    const health = await ctx.lake.health();
    if (health.error) throw new Error(health.error);
    const firstContact = !ctx.config;
    const cfg = !ctx.config || was ? await ctx.lake.config({ refresh: true }) : ctx.config;
    ctx.config = cfg;
    ctx.lastContact = new Date();
    if (firstContact) renderNav();
    ctx.offline = cfg.error ? { url: cfg.minilake_url, error: cfg.error } : null;
  } catch (err) {
    ctx.offline = { url: null, error: String(err.message || err) };
  }
  if (Boolean(was) !== Boolean(ctx.offline)) {
    renderNav();
    // Coming back: reload what the context's tabs show.
    if (!ctx.offline) {
      await refreshNav(ctx);
      for (const t of state.tabs) if (t.ctx === ctx && t.instance && t.view !== "query" && !t.instance.el.querySelector("textarea")) t.instance.show(t.parts);
    } else if (state.active?.ctx === ctx && state.active.instance && !["query", "jobs", "files"].includes(state.active.view)) state.active.instance.show(state.active.parts);
  }
  for (const tab of state.tabs) if (tab.ctx === ctx && tab.instance) updateAvailability(tab);
  renderConnection();
}

// Keep checking after a healthy start as well as during an outage.
const watching = new Set();
async function watch(ctx) {
  if (watching.has(ctx.id)) return;
  watching.add(ctx.id);
  const tick = async () => {
    if (!ctx.running || byId(ctx.id) !== ctx) { watching.delete(ctx.id); return; }
    try { await loadStatus(ctx); } finally { setTimeout(tick, RETRY_MS); }
  };
  await tick();
}

function updateAvailability(tab) {
  const offline = Boolean(state.serverOffline || !tab.ctx.running || tab.ctx.offline);
  tab.instance.el.dataset.offline = String(offline);
  for (const button of tab.instance.el.querySelectorAll("[data-lake-action]")) {
    if (offline && !button.disabled) { button.dataset.offlineDisabled = "true"; button.disabled = true; }
    else if (!offline && button.dataset.offlineDisabled) { delete button.dataset.offlineDisabled; button.disabled = false; }
  }
}

function renderConnection() {
  const ctx = state.active?.ctx ?? self();
  if (!ctx) return;
  const contextText = `${ctx.name} · ${ctx.dir}`;
  if ($("#active-context").textContent !== contextText) $("#active-context").textContent = contextText;
  const agentText = `Browser agent target: ${self()?.name} · ${self()?.dir}`;
  if ($("#agent-context").textContent !== agentText) $("#agent-context").textContent = agentText;
  const message = state.serverOffline ? "Pond connection lost. Retrying; editor drafts are kept."
    : !ctx.running ? "Stopped. Start this context in a terminal."
    : ctx.offline ? `MiniLake connection lost: ${ctx.offline.error.replace(/[. ]+$/, "")}. Retrying; editor drafts are kept.` : "Connected";
  for (const tab of state.tabs) if (tab.instance) updateAvailability(tab);
  const last = ctx.lastContact ?? state.lastContact;
  const status = $("#connection-status");
  const statusText = `${message}${(state.serverOffline || ctx.offline) && last ? ` Last contact: ${last.toLocaleTimeString()}.` : ""}`;
  if (status.textContent !== statusText) status.textContent = statusText;
}

/* ---------- Navigator data ---------- */

/** @param {Ctx} ctx */
async function refreshNav(ctx) {
  const open = ctx.nav.open;
  ctx.nav = { ...newNav(), open };
  renderNav();
  if (!ctx.running || ctx.offline) return;
  try {
    ctx.nav.catalogs = await ctx.lake.listCatalogs();
  } catch (err) {
    ctx.nav.errors.root = err.message;
    ctx.nav.catalogs = [];
  }
  // Re-open what was open, so a refresh after a change doesn't collapse the tree.
  for (const key of open) {
    if (!key.startsWith("t:") || key === "t:") continue;
    const [c, s] = key.slice(2).split(".");
    if (!ctx.nav.catalogs.some((x) => x.name === c)) open.delete(key);
    else if (s) await loadChildren(ctx, c, s);
    else await loadSchemas(ctx, c);
  }
  await Promise.all([...open].filter((k) => ["queries", "graphs", "jobs"].includes(k)).map((k) => loadGroup(ctx, k)));
  renderNav();
  for (const t of state.tabs) if (t.ctx === ctx && t.view === "home" && t.instance && !t.el?.hidden) t.instance.show(t.parts);
}

/** @param {Ctx} ctx @param {string} catalog */
async function loadSchemas(ctx, catalog) {
  if (ctx.nav.schemas[catalog]) return ctx.nav.schemas[catalog];
  try {
    ctx.nav.schemas[catalog] = await ctx.lake.listSchemas(catalog);
  } catch (err) {
    ctx.nav.errors[catalog] = err.message;
    ctx.nav.schemas[catalog] = [];
  }
  return ctx.nav.schemas[catalog];
}

/** @param {Ctx} ctx @param {string} catalog @param {string} schema */
async function loadChildren(ctx, catalog, schema) {
  const key = `${catalog}.${schema}`;
  if (ctx.nav.children[key]) return ctx.nav.children[key];
  try {
    const [tables, volumes] = await Promise.all([ctx.lake.listTables(catalog, schema), ctx.lake.listVolumes(catalog, schema)]);
    ctx.nav.children[key] = { tables, volumes };
  } catch (err) {
    ctx.nav.errors[key] = err.message;
    ctx.nav.children[key] = { tables: [], volumes: [] };
  }
  return ctx.nav.children[key];
}

/** @param {Ctx} ctx */
async function loadEverything(ctx) {
  if (!ctx.running || ctx.offline) return;
  if (!ctx.nav.catalogs) {
    ctx.nav.catalogs = await ctx.lake.listCatalogs().catch(() => []);
  }
  for (const c of ctx.nav.catalogs ?? []) {
    for (const s of await loadSchemas(ctx, c.name)) await loadChildren(ctx, c.name, s.name);
  }
  await Promise.all(["queries", "graphs", "jobs"].map((g) => loadGroup(ctx, g)));
}

const GROUPS = {
  queries: (ctx) => ctx.lake.listSavedQueries(),
  graphs: (ctx) => listGraphs(ctx.lake),
  jobs: (ctx) => ctx.lake.listJobs(),
};

/** @param {Ctx} ctx @param {string} group */
async function loadGroup(ctx, group) {
  if (ctx.nav[group]) return ctx.nav[group];
  try {
    ctx.nav[group] = await GROUPS[group](ctx);
  } catch (err) {
    ctx.nav.errors[group] = err.message;
    ctx.nav[group] = [];
  }
  return ctx.nav[group];
}

/** @param {Ctx} ctx @param {string} key */
async function toggleNav(ctx, key) {
  const nav = ctx.nav;
  if (nav.open.has(key)) {
    nav.open.delete(key);
    renderNav();
    persist();
    return;
  }
  nav.open.add(key);
  renderNav();
  persist();
  if (key.startsWith("t:")) {
    const [c, s] = key.slice(2).split(".");
    if (!nav.catalogs) nav.catalogs = await ctx.lake.listCatalogs().catch((err) => ((nav.errors.root = err.message), []));
    if (s) await loadChildren(ctx, c, s);
    else if (c) await loadSchemas(ctx, c);
  } else if (GROUPS[key]) await loadGroup(ctx, key);
  renderNav();
}

/** @param {Ctx} ctx @param {string} fullName */
async function reveal(ctx, fullName) {
  const [c, s] = fullName.split(".");
  if (!c) return;
  ctx.nav.open.add(`ctx`);
  ctx.nav.open.add("t:");
  ctx.nav.open.add(`t:${c}`);
  if (!ctx.nav.catalogs) ctx.nav.catalogs = await ctx.lake.listCatalogs().catch(() => []);
  await loadSchemas(ctx, c);
  if (s) {
    ctx.nav.open.add(`t:${c}.${s}`);
    await loadChildren(ctx, c, s);
  }
  renderNav();
  document.querySelector(`.nav [aria-current="true"]`)?.scrollIntoView({ block: "nearest" });
}

/* ---------- Tabs ---------- */

let tabSeq = 0;
const tabKey = (ctx, view, parts) => `${ctx.id}|${view}|${parts.join("/")}`;
// Views that browse within themselves: following a link replaces the tab's content.
const IN_PLACE = new Set(["home", "data", "files", "jobs", "admin"]);

/** @param {Tab} tab */
function titleOf(tab) {
  const [a, b] = tab.parts;
  switch (tab.view) {
    case "home": return tab.ctx.name;
    case "data": return a === "volume" ? b?.split(".").pop() ?? "Volume" : a?.split(".").pop() ?? "Catalogs";
    case "query": return tab.title ?? (tab.agent ? "Agent queries" : "Query");
    case "graph": return a ?? tab.title ?? "Graph";
    case "jobs": return a === "job" ? `Job ${b}` : a === "run" ? `Run #${b}` : "Jobs";
    case "files": return tab.parts.length > 1 ? tab.parts.at(-1) : a === "workspace" ? "Scripts" : "Files";
    case "admin": return "Settings";
    default: return tab.view;
  }
}

/**
 * Opens a view in a tab: an open tab showing the same thing is reused; a link followed
 * inside a tab of the same kind replaces what that tab shows; anything else gets a new tab.
 * @param {Ctx} ctx
 * @param {string} view
 * @param {string[]} [parts]
 * @param {{ from?: Tab, newTab?: boolean, activate?: boolean, history?: boolean }} [opts]
 * @returns {Tab}
 */
function open(ctx, view, parts = [], { from, newTab = false, activate = true, history = true } = {}) {
  if (!FACTORIES[view]) view = "home";
  const key = tabKey(ctx, view, parts);
  const same = state.tabs.find((t) => tabKey(t.ctx, t.view, t.parts) === key && !t.agent);
  if (same && !newTab) {
    if (activate) activateTab(same, { history });
    return same;
  }
  const host = from ?? state.active;
  if (!newTab && host && host.ctx === ctx && host.view === view && (from || IN_PLACE.has(view)) && !host.agent) {
    routeTab(host, parts, { history });
    if (activate && state.active !== host) activateTab(host, { history: false });
    return host;
  }
  const tab = { id: `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`, ctx, view, parts };
  const at = state.active ? state.tabs.indexOf(state.active) + 1 : state.tabs.length;
  state.tabs.splice(at, 0, tab);
  if (activate) activateTab(tab, { history });
  else renderTabs();
  persist();
  return tab;
}

/** @param {Tab} tab */
function ensureInstance(tab) {
  if (tab.instance) return tab.instance;
  tab.instance = FACTORIES[tab.view](tabUi(tab));
  tab.el = h("div", { class: "tab-panel", id: `panel-${tab.id}`, role: "tabpanel", "aria-labelledby": `tab-${tab.id}` }, tab.instance.el);
  tab.instance.el.hidden = false;
  $("#panels").append(tab.el);
  tab.instance.show(tab.parts);
  updateAvailability(tab);
  return tab.instance;
}

/** @param {Tab} tab @param {{ history?: boolean }} [opts] */
function activateTab(tab, { history = true } = {}) {
  const prev = state.active;
  state.active = tab;
  for (const t of state.tabs) {
    if (t.el) t.el.hidden = t !== tab;
    if (t.instance) t.instance.el.hidden = t !== tab;
  }
  const fresh = !tab.instance;
  ensureInstance(tab);
  if (!fresh && prev !== tab) tab.instance.activate?.(tab.parts);
  writeHash(tab, history);
  renderTabs();
  renderNav();
  persist();
  closeDrawer();
  renderConnection();
}

/** @param {Tab} tab @param {string[]} parts @param {{ history?: boolean }} [opts] */
function routeTab(tab, parts, { history = true } = {}) {
  tab.parts = parts;
  if (tab.instance) tab.instance.show(parts);
  writeHash(tab, history);
  renderTabs();
  renderNav();
  persist();
}

/** @param {Tab} tab */
function closeTab(tab) {
  const i = state.tabs.indexOf(tab);
  if (i < 0) return;
  tab.instance?.dispose?.();
  tab.el?.remove();
  if (!tab.agent) {
    const closed = store("pond.closedTabs") ?? [];
    closed.unshift({ id: tab.id, ctx: tab.ctx.id, view: tab.view, parts: tab.parts, title: tab.title });
    for (const old of closed.splice(20)) store(`pond.draft.${old.id}`, null);
    store("pond.closedTabs", closed);
    toast(`Closed ${titleOf(tab)}. Use Reopen closed tab to restore it.`);
  }
  state.tabs.splice(i, 1);
  if (state.active === tab) {
    const next = state.tabs[i] ?? state.tabs[i - 1];
    state.active = null;
    if (next) activateTab(next, { history: false });
    else open(self(), "home");
  }
  renderTabs();
  persist();
}

function reopenClosedTab() {
  const closed = store("pond.closedTabs") ?? [];
  const saved = closed.shift();
  if (!saved) return;
  const ctx = byId(saved.ctx);
  if (!ctx) return toast("Start the original context to reopen this item.", "err");
  store("pond.closedTabs", closed);
  const tab = { ...saved, ctx };
  state.tabs.push(tab);
  activateTab(tab);
}

function persist() {
  store(STATE_KEY, {
    tabs: state.tabs.filter((t) => !t.agent).map((t) => ({ id: t.id, ctx: t.ctx.id, view: t.view, parts: t.parts, title: t.title })),
    active: state.active?.id ?? null,
    navOpen: Object.fromEntries(state.contexts.map((c) => [c.id, [...c.nav.open]])),
  });
}

function restore() {
  const saved = store(STATE_KEY);
  if (!saved?.tabs) return false;
  for (const t of saved.tabs) {
    const ctx = byId(t.ctx);
    if (ctx && FACTORIES[t.view]) state.tabs.push({ id: t.id, ctx, view: t.view, parts: t.parts ?? [], title: t.title });
  }
  return state.tabs.length > 0 ? saved.active : false;
}

/* ---------- Routing ---------- */

// #/<context id>/<view>/<part>/<part>…, each part URI-encoded. The older #/<view>/… form
// still works and means this pond's own context.
function parseHash() {
  const decode = (p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p; // a hand-typed stray "%"
    }
  };
  const segs = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decode);
  if (!segs.length) return null;
  if (VIEWS.includes(segs[0])) return { ctx: self(), view: segs[0], parts: segs.slice(1) };
  const ctx = byId(segs[0]);
  if (!ctx) return null;
  return { ctx, view: VIEWS.includes(segs[1]) ? segs[1] : "home", parts: segs.slice(2) };
}

const hashFor = (ctx, view, parts) => `#/${[ctx.id, view, ...parts].map((p) => encodeURIComponent(p).replaceAll("%2F", "/")).join("/")}`;

/** @param {Tab} tab @param {boolean} push */
function writeHash(tab, push) {
  const hash = hashFor(tab.ctx, tab.view, tab.parts);
  document.title = `${titleOf(tab)} · ${tab.ctx.name} · Pond`;
  if (location.hash === hash) return;
  if (push) history.pushState(null, "", hash);
  else history.replaceState(null, "", hash);
  document.title = `${titleOf(tab)} · ${tab.ctx.name} · Pond`;
}

function followHash() {
  const route = parseHash();
  if (route) open(route.ctx, route.view, route.parts, { history: false });
}

/* ---------- The ui each view gets ---------- */

/**
 * Views written for one page get a ui bound to their tab: their navigate() opens tabs in
 * their context, and their lake is their context's.
 * @param {Tab} tab
 */
function tabUi(tab) {
  const ctx = tab.ctx;
  return {
    lake: ctx.lake,
    uid: tab.id,
    get context() {
      return ctx.config?.context ?? (ctx.self ? null : { name: ctx.name, dir: ctx.dir, id: ctx.id });
    },
    ctx,
    mcpUrl: ctx.self ? `${location.origin}/mcp` : ctx.ui ? `${ctx.ui}/mcp` : null,
    state: {
      get offline() {
        if (state.serverOffline) return { url: null, error: "Pond connection lost. Retrying; editor drafts are kept." };
        if (!ctx.running) return { url: ctx.ui, error: "Context stopped. Start it in a terminal." };
        return ctx.offline;
      },
      route: { get view() { return tab.view; }, get parts() { return tab.parts; } },
    },
    navigate: (view, ...parts) => open(ctx, view, parts.map(String), { from: tab }),
    open: (view, parts = [], opts = {}) => open(ctx, view, parts, opts),
    openIn: (other, view, parts = []) => open(other, view, parts),
    // A view that changes what it shows by itself (a graph it opened) keeps the tab's route in step.
    setRoute: (parts) => {
      tab.parts = parts;
      writeHash(tab, false);
      renderTabs();
      persist();
    },
    setTitle: (title) => {
      tab.title = title || undefined;
      renderTabs();
      persist();
    },
    refreshTree: () => refreshNav(ctx),
    refreshContext: (other) => refreshNav(other ?? ctx),
    reveal: (name) => reveal(ctx, name),
    contexts: () => state.contexts,
    importFile: (file) => ensureInstance(open(ctx, "data", [])).importDialog(file),
    openSavedQuery: (sq) => openSavedQuery(ctx, sq),
    views: humanViews(ctx),
    log: (text, opts = {}) => logActivity({ ctx, actor: "you", text, ...opts }),
    snapshot: () => snapshot(),
  };
}

/** @param {Ctx} ctx @param {string} view */
const latest = (ctx, view) => (state.active?.ctx === ctx && state.active.view === view && !state.active.agent
  ? state.active
  : [...state.tabs].reverse().find((t) => t.ctx === ctx && t.view === view && !t.agent));

// What views call on other views: a query or graph opens in a new tab of its own.
/** @param {Ctx} ctx */
function humanViews(ctx) {
  return {
    query: {
      open: (sql) => {
        const tab = open(ctx, "query", [], { newTab: true });
        ensureInstance(tab).setSql(sql);
        return tab.instance;
      },
    },
    graph: {
      newGraph: (...args) => ensureInstance(open(ctx, "graph", [], { newTab: true })).newGraph(...args),
      openAdhoc: (...args) => ensureInstance(open(ctx, "graph", [], { newTab: true })).openAdhoc(...args),
    },
  };
}

// The ui WebMCP drives: this pond's own context. Agents' SQL runs in a tab of its own, so
// it never replaces what the user is writing.
function agentUi() {
  const ctx = self();
  const instanceOf = (view) => {
    const tab = view === "query" ? agentQueryTab(ctx) : latest(ctx, view) ?? open(ctx, view, []);
    if (state.active !== tab) activateTab(tab, { history: false });
    return ensureInstance(tab);
  };
  return {
    get lake() {
      return self().lake;
    },
    navigate: (view, ...parts) => {
      if (view === "query") return instanceOf("query");
      const tab = latest(self(), view);
      if (tab && view !== "data" && view !== "files" && view !== "jobs") {
        if (state.active !== tab) activateTab(tab);
        if (parts.length) routeTab(tab, parts.map(String));
        return tab;
      }
      return open(self(), view, parts.map(String));
    },
    refreshTree: () => refreshNav(self()),
    logAgent: (tool, input, error) => logAgent(tool, input, error),
    snapshot: () => snapshot(),
    views: {
      get query() { return instanceOf("query"); },
      get graph() { return instanceOf("graph"); },
      get data() { return instanceOf("data"); },
      get files() { return instanceOf("files"); },
      get admin() { return instanceOf("admin"); },
    },
  };
}

/** @param {Ctx} ctx */
function agentQueryTab(ctx) {
  let tab = state.tabs.find((t) => t.agent && t.ctx === ctx);
  if (!tab) {
    tab = { id: `agent-${ctx.id}`, ctx, view: "query", parts: [], agent: true, title: "Agent queries" };
    state.tabs.push(tab);
  }
  return tab;
}

function snapshot() {
  const tab = state.active;
  return {
    context: { name: self()?.name, dir: self()?.dir },
    open_tab: tab && { context: tab.ctx.name, view: tab.view, route: tab.parts.join("/"), title: titleOf(tab) },
    tabs: state.tabs.map((t) => ({ context: t.ctx.name, view: t.view, title: titleOf(t) })),
    ...(tab?.ctx.self ? tab.instance?.snapshot?.() : {}),
  };
}

/* ---------- Activity ---------- */

function logActivity(entry) {
  state.activity.unshift({ at: new Date(), ...entry });
  state.activity.length = Math.min(state.activity.length, 200);
  if ($("#activity").hidden) state.unseen += 1;
  renderActivity();
}

function logAgent(tool, input, error) {
  // Never echo secret values into the page.
  const shown = input && Object.fromEntries(Object.entries(input).map(([k, v]) => [k, k === "value" ? "••••" : v]));
  const args = shown && Object.keys(shown).length ? JSON.stringify(shown, null, 1) : undefined;
  logActivity({ ctx: self(), actor: "agent", text: tool, detail: args && args.length > 600 ? `${args.slice(0, 600)}…` : args, error: Boolean(error) });
  if (error) logActivity({ ctx: self(), actor: "agent", text: `${tool} failed`, detail: error, error: true });
  toast(error ? `Agent: ${tool} failed` : `Agent used ${tool}`, "agent");
}

// Views confirm what they did with a toast; the same words go into the activity log.
document.addEventListener("pond:toast", (e) => {
  const { text, kind } = /** @type {CustomEvent} */ (e).detail;
  if (kind === "agent" || /…$/.test(text)) return;
  logActivity({ ctx: state.active?.ctx ?? null, actor: "you", text, error: kind === "err" });
});

const timeAgo = (d) => {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

function renderActivity() {
  const count = $("#activity-count");
  count.textContent = state.unseen ? String(state.unseen) : "";
  count.hidden = !state.unseen;
  const list = $("#activity-log");
  if (!state.activity.length) {
    list.replaceChildren(h("li", { class: "activity-empty" }, "What you and agents do in this page shows up here."));
    return;
  }
  list.replaceChildren(...state.activity.map((a) => h("li", { class: `act ${a.actor}${a.error ? " err" : ""}` },
    h("div", { class: "act-head" },
      h("span", { class: "act-actor" }, a.actor === "agent" ? "Agent" : "You"),
      a.ctx && h("span", { class: "ctx-mark", style: `--ctx: var(--series-${a.ctx.slot + 1})`, title: a.ctx.dir }, a.ctx.name),
      h("time", { datetime: a.at.toISOString(), title: a.at.toLocaleString() }, timeAgo(a.at))),
    h("div", { class: "act-text" }, a.text),
    a.detail && h("pre", { class: "act-detail" }, a.detail))));
}

function renderTrust() {
  const box = /** @type {HTMLInputElement} */ ($("#trust"));
  box.checked = !agentTrust.get();
}

/* ---------- Rendering: navigator ---------- */

const icon = (name) => h("span", { class: `ico ico-${name}`, "aria-hidden": "true" });

function highlight(text) {
  const q = state.filter;
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

const isCurrent = (ctx, view, parts) => {
  const t = state.active;
  return Boolean(t && t.ctx === ctx && t.view === view && t.parts.join("/") === parts.join("/"));
};

/**
 * One navigator row: a disclosure caret (or room for one) and a link-like button.
 * @param {{ label: any, icon?: string, meta?: any, open?: boolean, current?: boolean, onclick: (e: MouseEvent) => void,
 *   ontoggle?: () => void, title?: string, depth?: number }} props
 */
function row({ label, icon: ic, meta, open: isOpen, current, onclick, ontoggle, title, depth = 0 }) {
  return h("div", { "data-key": String(title ?? label), class: "row", style: `--depth: ${depth}`, "aria-current": String(Boolean(current)), title },
    ontoggle
      ? h("button", { class: "caret", "aria-expanded": String(Boolean(isOpen)), "aria-label": `${isOpen ? "Collapse" : "Expand"} ${typeof label === "string" ? label : title ?? "items"}`, onclick: ontoggle })
      : h("span", { class: "caret-space" }),
    h("button", { class: "row-label", onclick }, ic && icon(ic), h("span", { class: "label" }, typeof label === "string" ? highlight(label) : label),
      meta != null && meta !== "" && h("span", { class: "meta" }, meta)));
}

/** Opens from the navigator: a modifier click always opens a new tab. */
const navOpen = (ctx, view, parts) => (e) => open(ctx, view, parts, { newTab: Boolean(e?.metaKey || e?.ctrlKey || e?.button === 1) });

/** Opens something that has children in the navigator, and shows them. */
const navOpenExpand = (ctx, key, view, parts) => (e) => {
  if (!ctx.nav.open.has(key)) toggleNav(ctx, key);
  open(ctx, view, parts, { newTab: Boolean(e?.metaKey || e?.ctrlKey || e?.button === 1) });
};

/** @param {Ctx} ctx */
function tablesGroup(ctx) {
  const nav = ctx.nav;
  const q = state.filter;
  const match = (name) => !q || name.toLowerCase().includes(q);
  const groupOpen = q ? true : nav.open.has("t:");
  const items = [];
  if (groupOpen) {
    if (nav.errors.root) items.push(h("li", { class: "nav-note err" }, nav.errors.root));
    else if (!nav.catalogs) items.push(h("li", { class: "nav-note" }, h("span", { class: "loading" })));
    else if (!nav.catalogs.length) items.push(h("li", { class: "nav-note" }, "No catalogs yet"));
    for (const c of nav.catalogs ?? []) {
      const schemaItems = [];
      for (const s of nav.schemas[c.name] ?? []) {
        const key = `${c.name}.${s.name}`;
        const kids = nav.children[key];
        const parentMatch = match(s.name) || match(c.name);
        const tables = (kids?.tables ?? []).filter((t) => parentMatch || match(t.name));
        const volumes = (kids?.volumes ?? []).filter((v) => parentMatch || match(v.name));
        if (q && !tables.length && !volumes.length && !parentMatch) continue;
        const sOpen = q ? true : nav.open.has(`t:${key}`);
        schemaItems.push(h("li", {},
          row({ label: s.name, icon: "schema", depth: 2, open: sOpen, current: isCurrent(ctx, "data", [key]), onclick: navOpenExpand(ctx, `t:${key}`, "data", [key]), ontoggle: () => toggleNav(ctx, `t:${key}`) }),
          sOpen && h("ul", {},
            nav.errors[key] && h("li", { class: "nav-note err" }, nav.errors[key]),
            !kids && h("li", { class: "nav-note" }, h("span", { class: "loading" })),
            kids && !kids.tables.length && !kids.volumes.length && h("li", { class: "nav-note", style: "--depth: 3" }, "Empty"),
            tables.map((t) => h("li", {}, row({
              label: t.name, icon: t.table_type === "VIEW" ? "view" : "table", depth: 3, title: t.full_name,
              current: isCurrent(ctx, "data", [t.full_name]), onclick: navOpen(ctx, "data", [t.full_name]),
            }))),
            volumes.map((v) => h("li", {}, row({
              label: v.name, icon: "volume", depth: 3, title: `Volume ${v.full_name}`,
              current: isCurrent(ctx, "data", ["volume", v.full_name]), onclick: navOpen(ctx, "data", ["volume", v.full_name]),
            }))))));
      }
      if (q && !schemaItems.length && !match(c.name)) continue;
      const cOpen = q ? true : nav.open.has(`t:${c.name}`);
      items.push(h("li", {},
        row({ label: c.name, icon: "catalog", depth: 1, open: cOpen, current: isCurrent(ctx, "data", [c.name]), onclick: navOpenExpand(ctx, `t:${c.name}`, "data", [c.name]), ontoggle: () => toggleNav(ctx, `t:${c.name}`) }),
        cOpen && h("ul", {},
          nav.errors[c.name] && h("li", { class: "nav-note err" }, nav.errors[c.name]),
          !nav.schemas[c.name] && h("li", { class: "nav-note" }, h("span", { class: "loading" })),
          schemaItems)));
    }
  }
  return h("li", {},
    row({ label: "Tables", icon: "tables", open: groupOpen, onclick: navOpenExpand(ctx, "t:", "data", []), current: isCurrent(ctx, "data", []), ontoggle: () => toggleNav(ctx, "t:") }),
    groupOpen && h("ul", {}, items));
}

/**
 * A list group (saved queries, graphs, jobs) that loads when opened.
 * @param {Ctx} ctx
 * @param {{ key: "queries" | "graphs" | "jobs", label: string, icon: string, item: (x: any) => { label: string, onclick: (e: MouseEvent) => void, current: boolean, title?: string }, all?: (e?: MouseEvent) => void, allCurrent?: boolean, empty: string }} g
 */
function listGroup(ctx, { key, label, icon: ic, item, all, allCurrent, empty }) {
  const nav = ctx.nav;
  const q = state.filter;
  const list = nav[key];
  const rows = (list ?? []).map(item).filter((x) => !q || x.label.toLowerCase().includes(q));
  if (q && list && !rows.length) return null;
  const isOpen = q ? Boolean(list) : nav.open.has(key);
  return h("li", {},
    row({
      label, icon: ic, open: isOpen, meta: list ? list.length : "", current: allCurrent, ontoggle: () => toggleNav(ctx, key),
      onclick: (e) => {
        if (!ctx.nav.open.has(key) || !all) toggleNav(ctx, key);
        all?.(e);
      },
    }),
    isOpen && h("ul", {},
      nav.errors[key] && h("li", { class: "nav-note err" }, nav.errors[key]),
      !list && h("li", { class: "nav-note" }, h("span", { class: "loading" })),
      list && !list.length && h("li", { class: "nav-note", style: "--depth: 1" }, empty),
      rows.map((x) => h("li", {}, row({ ...x, depth: 1 })))));
}

/** @param {Ctx} ctx */
function contextSection(ctx) {
  const nav = ctx.nav;
  const isOpen = state.filter ? ctx.running : nav.open.has("ctx");
  const status = !ctx.running ? "stopped" : ctx.offline ? "offline" : "ok";
  const statusText = { ok: "Running", offline: "Not responding", stopped: "Stopped" }[status];
  const head = h("div", { class: "ctx-head", style: `--ctx: var(--series-${ctx.slot + 1})` },
    h("button", { class: "ctx-toggle", "aria-expanded": String(isOpen), onclick: () => {
      if (ctx.nav.open.has("ctx")) ctx.nav.open.delete("ctx");
      else {
        ctx.nav.open.add("ctx");
        if (ctx.running && !ctx.nav.catalogs) refreshNav(ctx);
      }
      renderNav();
      persist();
    } },
      h("span", { class: "ctx-swatch", "aria-hidden": "true" }),
      h("span", { class: "ctx-name" }, ctx.name),
      h("span", { class: `ctx-status ${status}`, title: ctx.offline?.error ?? ctx.status ?? statusText }, h("i"), statusText)),
    h("span", { class: "ctx-dir", title: ctx.dir }, shortDir(ctx.dir)));
  if (!isOpen) return h("section", { class: `ctx ${status}`, "data-key": ctx.id, "aria-label": `${ctx.name} · ${ctx.dir}` }, head);
  if (!ctx.running) {
    return h("section", { class: `ctx ${status}`, "data-key": ctx.id, "aria-label": `${ctx.name} · ${ctx.dir}` }, head,
      h("div", { class: "ctx-stopped" }, h("p", {}, "Start it to open its lake here:"), snippet(`pond ${shellQuote(ctx.dir)}`)));
  }
  const graphsItem = (g) => ({ label: g.name, icon: "graph", onclick: navOpen(ctx, "graph", [g.name]), current: isCurrent(ctx, "graph", [g.name]) });
  return h("section", { class: `ctx ${status}`, "data-key": ctx.id, "aria-label": `${ctx.name} · ${ctx.dir}` }, head,
    h("ul", { class: "ctx-tree" },
      !state.filter && h("li", {}, row({ label: "Overview", icon: "home", onclick: navOpen(ctx, "home", []), current: isCurrent(ctx, "home", []) })),
      tablesGroup(ctx),
      listGroup(ctx, {
        key: "queries", label: "Queries", icon: "query", empty: "No saved queries",
        item: (sq) => ({ label: sq.display_name, icon: "query", title: sq.query_text, current: false, onclick: (e) => openSavedQuery(ctx, sq, e) }),
      }),
      listGroup(ctx, { key: "graphs", label: "Graphs", icon: "graph", empty: "No saved graphs", item: graphsItem }),
      listGroup(ctx, {
        key: "jobs", label: "Jobs", icon: "job", empty: "No jobs", all: navOpen(ctx, "jobs", []), allCurrent: isCurrent(ctx, "jobs", []),
        item: (j) => ({ label: j.settings?.name ?? `Job ${j.job_id}`, icon: "job", onclick: navOpen(ctx, "jobs", ["job", String(j.job_id)]), current: isCurrent(ctx, "jobs", ["job", String(j.job_id)]) }),
      }),
      !state.filter && [
        h("li", {}, row({ label: "Files", icon: "files", onclick: navOpen(ctx, "files", ["dbfs"]), current: isCurrent(ctx, "files", ["dbfs"]) })),
        h("li", {}, row({ label: "Scripts", icon: "workspace", onclick: navOpen(ctx, "files", ["workspace"]), current: isCurrent(ctx, "files", ["workspace"]) })),
        h("li", {}, row({ label: "Settings", icon: "settings", onclick: navOpen(ctx, "admin", []), current: isCurrent(ctx, "admin", []) })),
      ]));
}

/** @param {Ctx} ctx @param {any} sq @param {MouseEvent} [e] */
function openSavedQuery(ctx, sq, e) {
  const existing = state.tabs.find((t) => t.ctx === ctx && t.view === "query" && (t.instance?.savedId?.() ?? store(`pond.draft.${t.id}`)?.identity?.savedId) === sq.id);
  if (existing && !(e?.metaKey || e?.ctrlKey)) return activateTab(existing);
  const tab = open(ctx, "query", [], { newTab: true });
  ensureInstance(tab).setSql(sq.query_text, { savedId: sq.id, name: sq.display_name });
}

// ~ for the home folder, and only the last folders of a long path: the end is what tells
// contexts apart.
function shortDir(dir) {
  const home = state.contexts.find((c) => c.config?.home)?.config?.home;
  const path = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  const segs = path.split("/");
  return segs.length > 4 ? `${segs[0] || "/"}/…/${segs.slice(-2).join("/")}` : path;
}

function stampFocus(nodes, prefix) {
  nodes.forEach((node, i) => {
    if (!(node instanceof HTMLElement)) return;
    const key = `${prefix}/${node.dataset.key || node.id || String(i)}`;
    if (node.matches("button,a,input,select,textarea")) node.dataset.focusKey = key;
    stampFocus([...node.children], key);
  });
}

function renderNav() {
  const root = $("#nav-contexts");
  if (!state.contexts.length) return root.replaceChildren(h("p", { class: "nav-note" }, h("span", { class: "loading" })));
  const sections = state.contexts.filter((c) => !state.filter || c.running).map(contextSection);
  stampFocus(sections, "nav");
  reconcile(root, sections);
}

/* ---------- Rendering: tabs ---------- */

function renderTabs() {
  const strip = $("#tabs");
  const tabs = state.tabs.filter((t) => !t.agent || state.active === t || t.instance);
  const many = new Set(state.tabs.map((t) => t.ctx.id)).size > 1;
  const items = tabs.map((t) => {
    const selected = t === state.active;
    const label = titleOf(t);
    return h("div", { "data-key": t.id, class: `tab${selected ? " selected" : ""}${t.agent ? " agent" : ""}`, style: `--ctx: var(--series-${t.ctx.slot + 1})` },
      h("button", {
        class: "tab-main", role: "tab", id: `tab-${t.id}`, "aria-selected": String(selected), "aria-controls": `panel-${t.id}`,
        tabindex: selected ? "0" : "-1", title: `${t.ctx.name} · ${label}`,
        onclick: () => activateTab(t),
        onauxclick: (e) => e.button === 1 && closeTab(t),
        onkeydown: (e) => tabKeys(e, t),
      },
      many && h("span", { class: "tab-context-name" }, `${t.ctx.name}: `),
      icon(t.agent ? "agent" : VIEW_ICONS[t.view]),
      h("span", { class: "tab-title" }, label)),
      h("button", { class: "tab-close", "aria-label": `Close ${label}`, title: "Close", onclick: () => closeTab(t) }));
  });
  items.push(h("button", { class: "tab-new", "aria-label": "New query", title: "New query", onclick: () => open(state.active?.ctx ?? self(), "query", [], { newTab: true }) }));
  items.push(h("button", { class: "btn ghost", disabled: !(store("pond.closedTabs")?.length), onclick: reopenClosedTab }, "Reopen closed tab"));
  stampFocus(items, "tabs");
  reconcile(strip, items);
  strip.querySelector(".tab.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const VIEW_ICONS = { home: "home", data: "table", query: "query", graph: "graph", jobs: "job", files: "files", admin: "settings" };

/** @param {KeyboardEvent} e @param {Tab} t */
function tabKeys(e, t) {
  const tabs = state.tabs.filter((x) => !x.agent || x.instance);
  const i = tabs.indexOf(t);
  const go = (j) => {
    const next = tabs[(j + tabs.length) % tabs.length];
    activateTab(next);
    /** @type {HTMLElement | null} */ (document.getElementById(`tab-${next.id}`))?.focus();
  };
  if (e.key === "ArrowRight") go(i + 1);
  else if (e.key === "ArrowLeft") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(tabs.length - 1);
  else if (e.key === "Delete" || e.key === "Backspace") closeTab(t);
  else return;
  e.preventDefault();
}

/* ---------- Command palette (⌘K) ---------- */

/**
 * @typedef {{ label: string, hint?: string, ctx?: Ctx, icon: string, run: (e?: any) => void, group: string }} Command
 */

/** @returns {Command[]} */
function commands() {
  const out = [];
  const many = state.contexts.length > 1;
  for (const ctx of state.contexts) {
    if (!ctx.running) {
      out.push({ group: "Contexts", icon: "home", label: ctx.name, hint: "Stopped. Start it with pond in its folder", ctx, run: () => { ctx.nav.open.add("ctx"); renderNav(); } });
      continue;
    }
    const at = many ? ` in ${ctx.name}` : "";
    out.push(
      { group: "Actions", icon: "query", label: `New query${at}`, ctx, run: () => open(ctx, "query", [], { newTab: true }) },
      { group: "Actions", icon: "graph", label: `New graph${at}`, ctx, run: () => ensureInstance(open(ctx, "graph", [], { newTab: true })).newGraph() },
      { group: "Actions", icon: "import", label: `Import a file${at}`, ctx, run: () => ensureInstance(open(ctx, "data", [])).importDialog?.() },
      { group: "Go to", icon: "home", label: `Overview of ${ctx.name}`, ctx, run: () => open(ctx, "home") },
      { group: "Go to", icon: "files", label: `Files${at}`, ctx, run: () => open(ctx, "files", ["dbfs"]) },
      { group: "Go to", icon: "workspace", label: `Scripts${at}`, ctx, run: () => open(ctx, "files", ["workspace"]) },
      { group: "Go to", icon: "job", label: `Jobs and runs${at}`, ctx, run: () => open(ctx, "jobs") },
      { group: "Go to", icon: "settings", label: `Settings${at}`, ctx, run: () => open(ctx, "admin") },
    );
    for (const c of ctx.nav.catalogs ?? []) {
      for (const s of ctx.nav.schemas[c.name] ?? []) {
        for (const t of ctx.nav.children[`${c.name}.${s.name}`]?.tables ?? []) {
          out.push({ group: "Tables", icon: "table", label: t.full_name, ctx, run: (e) => open(ctx, "data", [t.full_name], { newTab: e?.metaKey || e?.ctrlKey }) });
        }
      }
    }
    for (const sq of ctx.nav.queries ?? []) out.push({ group: "Saved queries", icon: "query", label: sq.display_name, ctx, run: (e) => openSavedQuery(ctx, sq, e) });
    for (const g of ctx.nav.graphs ?? []) out.push({ group: "Graphs", icon: "graph", label: g.name, ctx, run: () => open(ctx, "graph", [g.name]) });
    for (const j of ctx.nav.jobs ?? []) out.push({ group: "Jobs", icon: "job", label: j.settings?.name ?? `Job ${j.job_id}`, ctx, run: () => open(ctx, "jobs", ["job", String(j.job_id)]) });
  }
  out.push(
    { group: "Page", icon: "query", label: "Reopen closed tab", run: reopenClosedTab },
    { group: "Page", icon: "theme", label: "Switch theme: system, light, dark", run: cycleTheme },
    { group: "Page", icon: "activity", label: "Show or hide activity", run: toggleActivity },
  );
  return out;
}

// Ranks by where the query's words appear: whole-label prefixes first, then word starts.
function score(label, q) {
  const l = label.toLowerCase();
  let total = 0;
  for (const word of q.split(/\s+/).filter(Boolean)) {
    const i = l.indexOf(word);
    if (i < 0) return -1;
    total += i === 0 ? 0 : /[\s._/-]/.test(l[i - 1]) ? 1 : 3;
  }
  return total;
}

let paletteSel = 0;
/** @type {Command[]} */
let paletteItems = [];

function openPalette() {
  const dlg = /** @type {HTMLDialogElement} */ ($("#palette"));
  const input = /** @type {HTMLInputElement} */ ($("#palette-input"));
  if (dlg.open) return input.select();
  input.value = "";
  renderPalette();
  dlg.showModal();
  input.focus();
  // Tables, queries and graphs load in the background and join the list as they arrive.
  Promise.all(state.contexts.filter((c) => c.running && !c.offline).map(loadEverything)).then(() => dlg.open && renderPalette());
}

function renderPalette() {
  const q = /** @type {HTMLInputElement} */ ($("#palette-input")).value.trim().toLowerCase();
  const all = commands();
  paletteItems = q
    ? all.map((c) => ({ c, s: score(`${c.label} ${c.ctx?.name ?? ""}`, q) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).slice(0, 60).map((x) => x.c)
    : all.filter((c) => c.group === "Actions" || c.group === "Go to").filter((c) => !c.ctx || c.ctx === (state.active?.ctx ?? self()));
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  const list = $("#palette-list");
  let group = "";
  const many = state.contexts.length > 1;
  list.replaceChildren(...paletteItems.flatMap((c, i) => {
    const head = c.group !== group ? [h("li", { class: "palette-group", role: "presentation" }, (group = c.group))] : [];
    return [...head, h("li", {
      class: "palette-item", role: "option", id: `pal-${i}`, "aria-selected": String(i === paletteSel),
      onmousemove: () => i !== paletteSel && selectPalette(i), onclick: (e) => runPalette(i, e),
    }, icon(c.icon), h("span", { class: "palette-label" }, c.label),
    many && c.ctx && h("span", { class: "ctx-mark", style: `--ctx: var(--series-${c.ctx.slot + 1})` }, c.ctx.name),
    c.hint && h("span", { class: "palette-hint" }, c.hint))];
  }));
  if (!paletteItems.length) list.replaceChildren(h("li", { class: "palette-empty" }, `Nothing matches “${q}”.`));
  $("#palette-input").setAttribute("aria-activedescendant", paletteItems.length ? `pal-${paletteSel}` : "");
}

function selectPalette(i) {
  paletteSel = i;
  for (const li of document.querySelectorAll(".palette-item")) li.setAttribute("aria-selected", String(li.id === `pal-${i}`));
  document.getElementById(`pal-${i}`)?.scrollIntoView({ block: "nearest" });
  $("#palette-input").setAttribute("aria-activedescendant", `pal-${i}`);
}

function runPalette(i, e) {
  const item = paletteItems[i];
  if (!item) return;
  /** @type {HTMLDialogElement} */ ($("#palette")).close();
  item.run(e);
}

/* ---------- Theme, drawer, activity ---------- */

const THEMES = ["system", "light", "dark"];
function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("#theme-btn").setAttribute("aria-label", `Theme: ${theme}`);
  $("#theme-btn").title = `Theme: ${theme}. Click to change.`;
  $("#theme-btn").dataset.theme = theme;
  document.dispatchEvent(new CustomEvent("pond:theme"));
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(store("pond.theme") ?? "system") + 1) % THEMES.length];
  store("pond.theme", next);
  applyTheme(next);
}

function toggleActivity(force) {
  const panel = $("#activity");
  const show = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !show;
  document.body.classList.toggle("with-activity", show);
  $("#activity-btn").setAttribute("aria-expanded", String(show));
  if (show) state.unseen = 0;
  store("pond.activity", show);
  renderActivity();
}

const narrow = matchMedia("(max-width: 760px)");
function syncDrawer() {
  const closed = narrow.matches && !document.body.classList.contains("nav-open");
  const nav = $("#nav");
  nav.inert = closed;
  $("#main").inert = narrow.matches && !closed;
  if (closed && nav.contains(document.activeElement)) $("#nav-btn").focus();
  if (!narrow.matches && document.activeElement === $("#nav-btn")) $("#filter").focus();
  $("#nav").setAttribute("aria-hidden", String(closed));
}
narrow.addEventListener("change", () => { closeDrawer(); syncDrawer(); });
function closeDrawer() {
  document.body.classList.remove("nav-open");
  $("#nav-btn").setAttribute("aria-expanded", "false");
  syncDrawer();
}

/* ---------- Wiring ---------- */

$("#nav-btn").addEventListener("click", () => {
  const isOpen = document.body.classList.toggle("nav-open");
  $("#nav-btn").setAttribute("aria-expanded", String(isOpen));
  syncDrawer();
  if (isOpen) $("#filter").focus();
});
$("#palette-btn").addEventListener("click", openPalette);
$("#theme-btn").addEventListener("click", cycleTheme);
$("#activity-btn").addEventListener("click", () => toggleActivity());
$("#activity-close").addEventListener("click", () => toggleActivity(false));
$("#trust").addEventListener("change", (e) => agentTrust.set(!(/** @type {HTMLInputElement} */ (e.target)).checked));
document.addEventListener("pond:trust", renderTrust);
$("#refresh-nav").addEventListener("click", async () => {
  await loadContexts();
  for (const ctx of state.contexts) if (ctx.running) await Promise.all([loadStatus(ctx), refreshNav(ctx)]);
});

let filterTimer;
$("#filter").addEventListener("input", (e) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    state.filter = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
    renderNav();
    if (state.filter) {
      await Promise.all(state.contexts.filter((c) => c.running).map(loadEverything));
      renderNav();
    }
  }, 120);
});

$("#palette-input").addEventListener("input", () => {
  paletteSel = 0;
  renderPalette();
});
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") selectPalette(Math.min(paletteItems.length - 1, paletteSel + 1));
  else if (e.key === "ArrowUp") selectPalette(Math.max(0, paletteSel - 1));
  else if (e.key === "Enter") runPalette(paletteSel, e);
  else return;
  e.preventDefault();
});
$("#palette").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) /** @type {HTMLDialogElement} */ (e.currentTarget).close();
});

// Links inside a tab (#/<view>/…) are relative to that tab's context.
$("#panels").addEventListener("click", (e) => {
  const a = /** @type {HTMLElement} */ (e.target).closest?.("a[href^='#/']");
  if (!a || !state.active) return;
  const segs = a.getAttribute("href").replace(/^#\//, "").split("/").filter((s, i) => s || i === 0);
  if (!VIEWS.includes(segs[0])) return;
  e.preventDefault();
  const parts = segs.slice(1).filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const tab = state.active;
  const newTab = e.metaKey || e.ctrlKey;
  open(tab.ctx, segs[0], parts, newTab ? { newTab: true } : { from: tab });
});

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
  } else if (mod && e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    open(state.active?.ctx ?? self(), "query", [], { newTab: true });
  } else if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
    closeDrawer();
    $("#nav-btn").focus();
  }
});

window.addEventListener("popstate", followHash);
window.addEventListener("hashchange", followHash);

/* ---------- Start ---------- */

syncDrawer();
applyTheme(store("pond.theme") ?? "system");
if (store("pond.activity")) toggleActivity(true);
renderActivity();
renderTrust();

while (!state.contexts.length) {
  await loadContexts();
  if (!state.contexts.length) {
    $("#connection-status").textContent = "Pond connection lost. Retrying; browser drafts are kept.";
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
const own = self();
if (!store(STATE_KEY)?.navOpen?.[own.id]) {
  own.nav.open.add("ctx");
  own.nav.open.add("t:");
}
for (const ctx of state.contexts) if (ctx.running) watch(ctx);

renderNav(); // the config knows the home folder, which shortens paths

const webmcp = registerWebMcp(agentUi());
$("#webmcp-status").textContent = webmcp.ok
  ? "Agents in this browser can use this page through WebMCP."
  : "WebMCP isn't available in this browser, so only MCP clients can reach the lake.";

const activeId = restore();
const route = parseHash();
if (route) open(route.ctx, route.view, route.parts, { history: false });
else if (activeId !== false) activateTab(state.tabs.find((t) => t.id === activeId) ?? state.tabs[0], { history: false });
else open(own, "home", [], { history: false });

for (const ctx of state.contexts) if (ctx.running && ctx.nav.open.has("ctx")) refreshNav(ctx);

// Contexts start and stop in other terminals; keep the navigator current.
setInterval(async () => {
  const before = new Set(state.contexts.filter((c) => c.running).map((c) => c.id));
  await loadContexts();
  for (const ctx of state.contexts) {
    if (ctx.running && !before.has(ctx.id)) {
      watch(ctx);
      if (ctx.nav.open.has("ctx")) refreshNav(ctx);
    }
  }
}, CONTEXTS_MS);

export { LakeError };
