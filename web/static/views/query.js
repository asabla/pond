// @ts-check
// Query: SQL editor, results, saved queries and the lake's query history.
import { h, grid, toCsv, download, store, toast, formDialog, confirmDialog, empty, errorBox, loading, fmtTime, fmtDuration, guard, syncTabs } from "../dom.js";
import { createDraft } from "../drafts.js";
import { changesCatalog } from "../sql.js";
import { createCodeEditor } from "../editor.js";

const GRID_MAX_ROWS = 1000;

// The SQL a saved query shows in a list: its first line that isn't a comment.
const firstLine = (sql) => sql.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("--")) ?? sql.trim();

export function createQueryView(ui) {
  const { lake } = ui;
  // Each query tab keeps its own draft.
  const draftKey = `pond.draft.${ui.uid ?? "main"}`;
  const panelId = `query-panel-${ui.uid ?? "main"}`;
  const oldDraft = store(draftKey);
  const draft = createDraft(draftKey, typeof oldDraft === "string" ? oldDraft : "", { savedId: null, name: null });
  const state = { running: false, last: null, panel: store("pond.queryPanel") ?? "history", panelOpen: store("pond.queryPanelOpen") ?? false, savedId: draft.identity.savedId ?? null, includeBackground: store("pond.queryIncludeBackground") ?? false };

  const code = createCodeEditor({ language: "sql", label: "SQL editor", placeholder: "SELECT * FROM catalog.schema.table LIMIT 100", className: "query-editor" });
  const editor = code.input;
  const runBtn = h("button", { class: "btn primary", "data-lake-action": true, onclick: () => runEditor() }, "Run ", h("kbd", {}, "⌘↵"));
  const saveBtn = h("button", { class: "btn", "data-lake-action": true, onclick: guard(() => save()) }, "Save");
  const savedLabel = h("span", { class: "saved-label" });
  const panelBtn = h("button", { class: "btn ghost", "aria-expanded": String(state.panelOpen), "aria-controls": panelId, onclick: () => togglePanel() }, "History");
  const status = h("p", { class: "sr-only", role: "status" });
  const results = h("div", { class: "results" });
  const panelBody = h("div", { class: "panel-body", id: panelId, role: "tabpanel" });
  const panelTabs = h("div", { class: "panel-tabs", role: "tablist" });
  const panel = h("aside", { class: "query-panel", hidden: !state.panelOpen }, panelTabs, panelBody);

  const el = h("section", { class: "view query-view", "aria-label": "Query" },
    h("div", { class: "query-main" },
      h("div", { class: "editor-wrap" },
        h("div", { class: "editor-bar" }, runBtn, saveBtn, h("button", { class: "btn ghost", "data-lake-action": true, onclick: guard(() => save({ asNew: true })) }, "Save as…"),
          h("button", { class: "btn ghost", onclick: () => download(`${draft.identity.name ?? "query"}.pond.json`, JSON.stringify({ queries: [{ name: draft.identity.name ?? "Query", sql: editor.value }] }, null, 2), "application/json") }, "Export definition"), savedLabel,
          h("span", { class: "spacer" }),
          h("span", { class: "dialect", title: "MiniLake executes SQL with DuckDB, not Spark SQL" }, "DuckDB SQL"),
          panelBtn),
        code.el, status),
      results),
    panel);

  function togglePanel(force) {
    state.panelOpen = typeof force === "boolean" ? force : !state.panelOpen;
    store("pond.queryPanelOpen", state.panelOpen);
    panel.hidden = !state.panelOpen;
    panelBtn.setAttribute("aria-expanded", String(state.panelOpen));
    if (state.panelOpen) renderPanel();
  }

  code.value = draft.value;
  const updateLabel = () => { savedLabel.textContent = `${draft.identity.name ?? "Draft"}${draft.dirty ? " · Unsaved changes" : ""}`; };
  updateLabel();
  editor.addEventListener("input", () => { draft.change(editor.value); updateLabel(); });
  editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runEditor();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      guard(save)();
    }
  });

  function setSql(sql, { savedId = null, name = null } = {}) {
    code.value = sql;
    if (savedId) draft.saved(sql, { savedId, name });
    else { draft.saved("", { savedId: null, name }); draft.change(sql); }
    state.savedId = savedId;
    updateLabel();
    ui.setTitle?.(name);
  }

  async function runEditor({ byAgent = false } = {}) {
    if (ui.state.offline) {
      if (byAgent) throw new Error("MiniLake is offline. The editor draft is kept.");
      toast("MiniLake is offline. The editor draft is kept.", "err");
      return state.last;
    }
    const sql = editor.value.trim();
    if (byAgent && state.running) throw new Error("Another query is still running in the editor.");
    if (!sql || state.running) return state.last;
    state.running = true;
    status.textContent = "Query running.";
    runBtn.disabled = true;
    results.replaceChildren(h("div", { class: "results-bar" }, h("span", { class: "loading" }), "Running…"));
    try {
      state.last = { sql, result: await lake.runSql(sql), byAgent };
      if (changesCatalog(sql)) ui.refreshTree();
      if (!byAgent) ui.log?.(`Ran a query: ${state.last.result.rows.length.toLocaleString()} rows in ${state.last.result.elapsedMs} ms`, { detail: firstLine(sql) });
    } catch (err) {
      state.last = { sql, error: err.message, byAgent };
      if (!byAgent) ui.log?.("A query failed", { detail: err.message.split("\n")[0], error: true });
    } finally {
      state.running = false;
      runBtn.disabled = Boolean(ui.state.offline);
      if (runBtn.disabled) runBtn.dataset.offlineDisabled = "true";
    }
    status.textContent = state.last.error ? `Query failed: ${state.last.error}` : `Query completed. ${state.last.result.rows.length} rows fetched.`;
    renderResults();
    if (state.panel === "history") renderPanel();
    return state.last;
  }

  function renderResults() {
    const last = state.last;
    if (!last) return results.replaceChildren(empty("Run a query to see results here."));
    const agent = last.byAgent && h("span", { class: "by-agent" }, "run by agent");
    if (last.error) return results.replaceChildren(h("div", { class: "results-bar" }, h("b", {}, "Failed"), agent), errorBox(last.error));
    const r = last.result;
    results.replaceChildren(
      h("div", { class: "results-bar" },
        h("b", {}, `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? "" : "s"}`),
        h("span", {}, `${r.elapsedMs} ms`),
        r.rows.length > GRID_MAX_ROWS && h("span", { class: "muted" }, `showing first ${GRID_MAX_ROWS.toLocaleString()}`),
        r.truncated && h("span", { class: "muted" }, "Result limited; export includes fetched rows only."),
        agent,
        h("span", { class: "spacer" }),
        r.columns.length > 1 && h("button", { class: "btn ghost", title: "Draw the first two columns as source → target edges", onclick: () => ui.views.graph.openAdhoc({ edges_sql: last.sql }).catch((err) => toast(err.message, "err")) }, "Show as graph"),
        r.columns.length > 0 && h("button", { class: "btn ghost", onclick: () => download("pond-result.csv", toCsv(r), "text/csv") }, r.truncated ? "Export fetched rows" : "Export CSV")),
      r.columns.length ? grid(r, { max: GRID_MAX_ROWS }) : empty("Statement succeeded."),
    );
  }

  /** @param {{ name?: string, sql?: string, byAgent?: boolean, asNew?: boolean }} [opts] */
  async function save({ name, sql = editor.value, byAgent = false, asNew = false } = {}) {
    if (ui.state.offline) throw new Error("MiniLake is offline. The editor draft is kept.");
    if (!sql.trim()) throw new Error("Nothing to save yet.");
    let saved;
    const write = async (values) => {
      const queries = await lake.listSavedQueries();
      const id = !asNew && !byAgent ? state.savedId : null;
      const current = queries.find((q) => q.id === id);
      if (id && (!current || current.display_name !== draft.identity.name || draft.conflicts(current.query_text))) {
        throw new Error("The saved query changed or was deleted. Your draft is kept. Cancel and use Save as with a new name, or open the saved query to compare.");
      }
      const duplicate = queries.find((q) => q.display_name === values.name && q.id !== id);
      if (duplicate && !byAgent) throw new Error("That name already exists. Choose another name to keep both queries.");
      saved = id ? await lake.updateQuery(id, values.name, sql) : await lake.saveQuery(values.name, sql);
      setSql(sql, { savedId: saved.id, name: values.name });
    };
    if (name) await write({ name });
    else if (!await formDialog({
      title: asNew ? "Save query as" : state.savedId ? "Update saved query" : "Save query",
      intro: `Context: ${ui.ctx?.name ?? "this lake"}. Saved queries live in the lake. Drafts stay in this browser at this address.`,
      fields: [{ name: "name", label: "Name", required: true, value: asNew ? "" : draft.identity.name }],
      submit: "Save", onSubmit: write,
    })) return;
    toast(`Saved “${draft.identity.name}”`);
    if (state.panel === "saved" && state.panelOpen) renderPanel();
    ui.refreshTree();
    return saved;
  }

  /* ---------- Side panel ---------- */

  function renderPanelTabs() {
    syncTabs(panelTabs, [["saved", "Saved"], ["history", "History"]], state.panel, (key) => {
      state.panel = key;
      store("pond.queryPanel", key);
      renderPanelTabs();
      renderPanel();
    }, panelId);
  }

  let panelToken = 0;

  async function renderPanel() {
    // Switching between Saved and History quickly must not let the slower list win.
    const t = ++panelToken;
    panelBody.replaceChildren(loading());
    try {
      if (state.panel === "saved") {
        const queries = await lake.listSavedQueries();
        if (t !== panelToken) return;
        panelBody.replaceChildren(...(queries.length ? queries.map((sq) => h("div", { class: "panel-item" },
          h("button", { class: "panel-open", title: sq.query_text, onclick: () => ui.openSavedQuery?.(sq) },
            h("b", {}, sq.display_name), h("code", {}, firstLine(sq.query_text))),
          h("button", { class: "icon-btn small", title: "Delete", "aria-label": `Delete ${sq.display_name}`, onclick: guard(async () => {
            if (!(await confirmDialog({ title: `Delete “${sq.display_name}”?`, body: "The saved query is removed from this context." }))) return;
            await lake.deleteQuery(sq.id);
            if (state.savedId === sq.id) setSql(editor.value);
            renderPanel();
            ui.refreshTree();
          }) }, "×"))) : [empty("No saved queries. Write one and press Save (⌘S).")]));
      } else {
        const history = await lake.queryHistory(50, { includeBackground: state.includeBackground });
        if (t !== panelToken) return;
        panelBody.replaceChildren(h("label", { class: "check history-filter" }, h("input", { type: "checkbox", checked: state.includeBackground, onchange: (event) => {
          state.includeBackground = event.target.checked;
          store("pond.queryIncludeBackground", state.includeBackground);
          renderPanel();
        } }), " Include background queries"), ...(history.length ? history.map((e) => h("div", { class: "panel-item" },
          h("button", { class: "panel-open", title: e.query_text, onclick: () => ui.views.query.open(e.query_text) },
            h("span", { class: `dot ${e.status === "FINISHED" ? "ok" : "err"}` }),
            h("code", {}, e.query_text.replace(/\s+/g, " ")),
            h("small", {}, [fmtTime(e.query_start_time_ms), fmtDuration(e.duration), e.rows_produced != null && `${e.rows_produced} rows`].filter(Boolean).join(" · "),
              e.error_message && h("span", { class: "err-text" }, ` · ${e.error_message.split("\n")[0]}`))))) : [empty("No queries run yet.")]));
      }
    } catch (err) {
      if (t === panelToken) panelBody.replaceChildren(errorBox(err.message));
    }
  }

  renderPanelTabs();
  renderResults();

  return {
    el,
    show() {
      if (state.panelOpen) renderPanel();
      code.focus();
    },
    activate() {
      code.focus();
    },
    savedId: () => state.savedId,
    dirty: () => draft.dirty,
    open(sql) {
      setSql(sql);
      ui.navigate("query");
    },
    setSql,
    runEditor,
    running: () => state.running,
    save,
    snapshot: () => ({
      editor_sql: editor.value,
      last_query: state.last && {
        sql: state.last.sql,
        error: state.last.error,
        row_count: state.last.result?.rows.length,
        columns: state.last.result?.columns,
        by_agent: state.last.byAgent,
      },
    }),
  };
}
