// Query: SQL editor, results, saved queries and the lake's query history.
import { h, grid, toCsv, download, store, toast, formDialog, confirmDialog, empty, errorBox, loading, fmtTime, fmtDuration } from "../dom.js";

const GRID_MAX_ROWS = 1000;
const DRAFT_KEY = "pond.draft";

export function createQueryView(ui) {
  const { lake } = ui;
  const state = { running: false, last: null, panel: store("pond.queryPanel") ?? "saved", savedId: null };

  const editor = h("textarea", { class: "editor", spellcheck: "false", autocomplete: "off", "aria-label": "SQL editor", placeholder: "SELECT * FROM catalog.schema.table LIMIT 100" });
  const runBtn = h("button", { class: "btn primary", onclick: () => runEditor() }, "Run ", h("kbd", {}, "⌘↵"));
  const saveBtn = h("button", { class: "btn", onclick: () => save() }, "Save");
  const savedLabel = h("span", { class: "muted saved-label" });
  const results = h("div", { class: "results" });
  const panelBody = h("div", { class: "panel-body" });
  const panelTabs = h("div", { class: "panel-tabs", role: "tablist" });

  const el = h("section", { class: "view query-view", "aria-label": "Query" },
    h("div", { class: "query-main" },
      h("div", { class: "editor-wrap" },
        h("div", { class: "editor-bar" }, runBtn, saveBtn, savedLabel,
          h("span", { class: "spacer" }),
          h("span", { class: "muted dialect", title: "MiniLake executes SQL with DuckDB, not Spark SQL" }, "DuckDB dialect")),
        editor),
      results),
    h("aside", { class: "query-panel" }, panelTabs, panelBody));

  editor.value = store(DRAFT_KEY) ?? "";
  editor.addEventListener("input", () => store(DRAFT_KEY, editor.value));
  editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runEditor();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
    }
  });

  function setSql(sql, { savedId = null, name = null } = {}) {
    editor.value = sql;
    store(DRAFT_KEY, sql);
    state.savedId = savedId;
    savedLabel.textContent = name ? `· ${name}` : "";
  }

  async function runEditor({ byAgent = false } = {}) {
    const sql = editor.value.trim();
    if (byAgent && state.running) throw new Error("Another query is still running in the editor.");
    if (!sql || state.running) return state.last;
    state.running = true;
    runBtn.disabled = true;
    results.replaceChildren(h("div", { class: "results-bar" }, h("span", { class: "loading" }), "Running…"));
    try {
      state.last = { sql, result: await lake.runSql(sql), byAgent };
      if (/^\s*(create|drop|alter)\b/i.test(sql)) ui.refreshTree();
    } catch (err) {
      state.last = { sql, error: err.message, byAgent };
    } finally {
      state.running = false;
      runBtn.disabled = false;
    }
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
        r.truncated && h("span", { class: "muted" }, "truncated by MiniLake"),
        agent,
        h("span", { class: "spacer" }),
        r.columns.length > 0 && h("button", { class: "btn ghost", onclick: () => download("pond-result.csv", toCsv(r), "text/csv") }, "Export CSV")),
      r.columns.length ? grid(r, { max: GRID_MAX_ROWS }) : empty("Statement succeeded."),
    );
  }

  async function save({ name, sql = editor.value.trim(), byAgent = false } = {}) {
    if (!sql) return toast("Nothing to save yet.", "err");
    if (!name) {
      const v = await formDialog({
        title: state.savedId ? "Update saved query" : "Save query",
        fields: [{ name: "name", label: "Name", required: true, value: savedLabel.textContent.replace(/^· /, "") }],
        submit: "Save",
      });
      if (!v) return;
      name = v.name;
    }
    const saved = state.savedId && !byAgent
      ? await lake.updateQuery(state.savedId, name, sql)
      : await lake.saveQuery(name, sql);
    setSql(sql, { savedId: saved.id, name });
    toast(`Saved “${name}”`);
    if (state.panel === "saved") renderPanel();
    return saved;
  }

  /* ---------- Side panel ---------- */

  function renderPanelTabs() {
    panelTabs.replaceChildren(...[["saved", "Saved"], ["history", "History"]].map(([key, label]) =>
      h("button", { role: "tab", "aria-selected": String(state.panel === key), onclick: () => { state.panel = key; store("pond.queryPanel", key); renderPanelTabs(); renderPanel(); } }, label)));
  }

  async function renderPanel() {
    panelBody.replaceChildren(loading());
    try {
      if (state.panel === "saved") {
        const queries = await lake.listSavedQueries();
        panelBody.replaceChildren(...(queries.length ? queries.map((sq) => h("div", { class: "panel-item" },
          h("button", { class: "panel-open", title: sq.query_text, onclick: () => setSql(sq.query_text, { savedId: sq.id, name: sq.display_name }) },
            h("b", {}, sq.display_name), h("code", {}, sq.query_text.replace(/\s+/g, " "))),
          h("button", { class: "icon-btn small", title: "Delete", "aria-label": `Delete ${sq.display_name}`, onclick: async () => {
            if (!(await confirmDialog({ title: `Delete “${sq.display_name}”?`, body: "The saved query is removed from this context." }))) return;
            await lake.deleteQuery(sq.id);
            if (state.savedId === sq.id) setSql(editor.value);
            renderPanel();
          } }, "×"))) : [empty("No saved queries. Write one and press Save (⌘S).")]));
      } else {
        const history = await lake.queryHistory(50);
        panelBody.replaceChildren(...(history.length ? history.map((e) => h("div", { class: "panel-item" },
          h("button", { class: "panel-open", title: e.query_text, onclick: () => setSql(e.query_text) },
            h("span", { class: `dot ${e.status === "FINISHED" ? "ok" : "err"}` }),
            h("code", {}, e.query_text.replace(/\s+/g, " ")),
            h("small", {}, [fmtTime(e.query_start_time_ms), fmtDuration(e.duration), e.rows_produced != null && `${e.rows_produced} rows`].filter(Boolean).join(" · "),
              e.error_message && h("span", { class: "err-text" }, ` · ${e.error_message.split("\n")[0]}`))))) : [empty("No queries run yet.")]));
      }
    } catch (err) {
      panelBody.replaceChildren(errorBox(err.message));
    }
  }

  renderPanelTabs();
  renderResults();

  return {
    el,
    show() {
      renderPanel();
      editor.focus();
    },
    open(sql) {
      setSql(sql);
      ui.navigate("query");
    },
    setSql,
    runEditor,
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
