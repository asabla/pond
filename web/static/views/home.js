// @ts-check
// Overview: a context at a glance. Its tables with row counts, what was run lately, what
// is saved, and how to connect an agent.
import { h, button, snippet, empty, errorBox, loading, fmtTime, fmtDuration, guard, shellQuote } from "../dom.js";
import { listGraphs } from "../graph.js";
import { runStatus } from "./jobs.js";
import { connectAgent } from "../mcp-connect.js";
import { queryTitle } from "../overview-model.js";
import { highlight } from "../editor.js";

const MAX_COUNTED = 40;

export function createHomeView(ui) {
  const { lake } = ui;
  const el = h("section", { class: "view home-view", "aria-label": "Overview" });
  let token = 0;
  const counts = new Map();
  const COUNT_TTL = 30000;

  el.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      el.classList.add("dropping");
    }
  });
  el.addEventListener("dragleave", (e) => !el.contains(e.relatedTarget) && el.classList.remove("dropping"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dropping");
    const file = e.dataTransfer.files[0];
    if (file) ui.importFile?.(file);
  });

  const page = (...children) => el.replaceChildren(h("div", { class: "page home" }, ...children));

  function head(status) {
    const ctx = ui.ctx;
    return h("header", { class: "home-head", style: `--ctx: var(--series-${(ctx?.slot ?? 0) + 1})` },
      h("div", { class: "home-title" },
        h("h1", {}, "Overview"),
        status),
      ctx?.running !== false && !ctx?.offline && h("div", { class: "actions" },
        button("Import file", guard(() => ui.importFile?.())),
        button("New query", () => ui.open("query", [], { newTab: true }), "primary")));
  }

  async function show() {
    const t = ++token;
    const ctx = ui.ctx;
    if (ctx && !ctx.running) {
      return page(head(h("p", { class: "home-status stopped" }, "Stopped")),
        h("div", { class: "home-note" }, h("p", {}, "This context isn't running. Start it in a terminal to open its lake here:"), snippet(`pond ${shellQuote(ctx.dir)}`)));
    }
    if (ui.state.offline) {
      return page(head(h("p", { class: "home-status offline" }, "Not responding")),
        h("div", { class: "home-note" },
          h("p", {}, "MiniLake for this context stopped answering. Its logs usually say why:"),
          ui.context?.container ? snippet(`pond logs ${shellQuote(ui.ctx?.dir)}`) : null,
          h("p", { class: "muted" }, h("span", { class: "loading" }), ` Retrying · ${ui.state.offline.error}`)));
    }
    page(head(null), loading());
    try {
      const [tables, history, queries, graphs, runs] = await Promise.all([
        allTables(),
        lake.queryHistory(8).catch(() => []),
        lake.listSavedQueries().catch(() => []),
        listGraphs(lake).catch(() => []),
        lake.listRuns({ limit: 5 }).catch(() => []),
      ]);
      if (t !== token) return;
      render({ tables, history, queries, graphs, runs });
      countRows(tables, t);
    } catch (err) {
      if (t === token) page(head(null), errorBox(err.message));
    }
  }

  async function allTables() {
    const out = [];
    for (const c of await lake.listCatalogs()) {
      for (const s of await lake.listSchemas(c.name)) {
        out.push(...(await lake.listTables(c.name, s.name)));
      }
    }
    return out;
  }

  // Show the workspace immediately, then fetch uncached counts in bounded batches.
  async function countRows(tables, t) {
    const pending = tables.map((tb, index) => ({ tb, index })).filter(({ tb }) => {
      const entry = counts.get(tb.full_name);
      return !entry || Date.now() - entry.at > COUNT_TTL || entry.updated !== tb.updated_at || entry.version !== lake.dataVersion;
    });
    for (let start = 0; start < pending.length && t === token; start += MAX_COUNTED) {
      const batch = pending.slice(start, start + MAX_COUNTED);
      const version = lake.dataVersion;
      const sql = batch.map(({ tb, index }) => `SELECT ${index} AS i, count(*) AS n FROM ${lake.quoteName(tb.full_name)}`).join("\nUNION ALL\n");
      try {
        const result = await lake.runSql(`/* pond:system */ ${sql}`);
        for (const [index, count] of result.rows) {
          const tb = tables[Number(index)];
          if (!tb) continue;
          const at = Date.now();
          counts.set(tb.full_name, { count, at, updated: tb.updated_at, version });
          if (t !== token) continue;
          const cell = el.querySelector(`[data-rows="${index}"]`);
          if (cell) { cell.textContent = `${Number(count).toLocaleString()} rows`; cell.title = `Counted ${fmtTime(at)}`; }
        }
      } catch (error) {
        if (t !== token) return;
        for (const { index } of batch) {
          const cell = el.querySelector(`[data-rows="${index}"]`);
          if (cell) { cell.textContent = "Unavailable"; cell.title = error.message; }
        }
      }
    }
  }

  function render({ tables, history, queries, graphs, runs }) {
    const tableList = tables.length
      ? h("ul", { class: "home-list tables" }, tables.map((tb, i) => h("li", {},
        h("a", { href: `#/data/${tb.full_name}` },
          h("b", {}, tb.name), h("span", { class: "ns" }, `${tb.catalog_name}.${tb.schema_name}`)),
        h("span", { class: "meta", "data-rows": String(i), title: counts.has(tb.full_name) ? `Counted ${fmtTime(counts.get(tb.full_name).at)}` : "Counting in the background" }, counts.has(tb.full_name) ? `${Number(counts.get(tb.full_name).count).toLocaleString()} rows` : "Counting…"),
        h("span", { class: "meta" }, `${tb.columns?.length ?? 0} columns`))))
      : h("div", { class: "home-empty" },
        h("p", {}, "This lake has no tables yet. Drop a CSV, JSON or Parquet file here, or create one with SQL."),
        h("p", { class: "muted" }, "To fill a context the same way every time, put .sql or .py files in ", h("code", {}, "pond-seed/"), ". They run when the lake is new."));

    const recent = history.length
      ? h("div", { class: "recent-queries" }, history.map((e) => h("details", { class: "recent-query" },
        h("summary", {}, h("span", { class: "recent-query-title" }, queryTitle(e.query_text)),
          h("span", { class: "recent-query-meta" }, [e.status === "FINISHED" ? "Succeeded" : e.status || "Unknown", e.rows_produced != null && `${e.rows_produced} ${Number(e.rows_produced) === 1 ? "row" : "rows"}`, fmtDuration(e.duration), fmtTime(e.query_start_time_ms)].filter(Boolean).join(" · "))),
        h("pre", { class: "recent-query-sql", tabindex: "0", "aria-label": "Query SQL" }, highlight(e.query_text, "sql")),
        button("Open in editor", () => ui.views.query.open(e.query_text), "ghost"))))
      : empty("Nothing run yet.");

    page(
      head(null),
      h("div", { class: "home-grid" },
        h("div", { class: "home-main" },
          h("section", { class: "home-section" }, h("h2", {}, "Tables ", h("span", { class: "count" }, String(tables.length))), tableList),
          h("section", { class: "home-section" }, h("h2", {}, "Recent queries"), recent)),
        h("aside", { class: "home-side" },
          h("section", { class: "home-section" }, h("h2", {}, "Saved"),
            queries.length || graphs.length
              ? h("ul", { class: "home-list saved" },
                queries.map((q) => h("li", {}, h("button", { class: "linkish", onclick: () => ui.openSavedQuery?.(q) }, h("span", { class: "ico ico-query", "aria-hidden": "true" }), q.display_name))),
                graphs.map((g) => h("li", {}, h("a", { href: `#/graph/${encodeURIComponent(g.name)}` }, h("span", { class: "ico ico-graph", "aria-hidden": "true" }), g.name))))
              : h("p", { class: "muted" }, "Saved queries and graphs show up here.")),
          runs.length > 0 && h("section", { class: "home-section" }, h("h2", {}, "Recent runs"),
            h("ul", { class: "home-list runs" }, runs.map((r) => {
              const st = runStatus(r);
              return h("li", {}, h("a", { href: `#/jobs/run/${r.run_id}` }, r.run_name ?? `Run #${r.run_id}`),
                h("span", { class: `status-badge ${st.tone}` }, st.label));
            }))),
          ui.mcpUrl && h("section", { class: "home-section" }, h("h2", {}, "Connect an agent"),
            connectAgent(ui)))),
    );
  }

  return {
    el,
    show,
    activate: () => show(),
    treeChanged: () => { counts.clear(); if (!el.hidden) show(); },
    snapshot: () => ({ overview: ui.ctx?.name }),
  };
}
