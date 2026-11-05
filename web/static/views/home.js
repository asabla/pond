// @ts-check
// Overview: a context at a glance. Its tables with row counts, what was run lately, what
// is saved, and how to connect an agent.
import { h, button, snippet, empty, errorBox, loading, fmtTime, fmtDuration, guard } from "../dom.js";
import { listGraphs } from "../graph.js";
import { runStatus } from "./jobs.js";

const MAX_COUNTED = 40;

export function createHomeView(ui) {
  const { lake } = ui;
  const el = h("section", { class: "view home-view", "aria-label": "Overview" });
  let token = 0;

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
        h("h1", {}, ctx?.name ?? "Lake"),
        h("p", { class: "home-dir" }, ctx?.dir ?? ""),
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
        h("div", { class: "home-note" }, h("p", {}, "This context isn't running. Start it in a terminal to open its lake here:"), snippet(`pond ${ctx.dir}`)));
    }
    if (ui.state.offline) {
      return page(head(h("p", { class: "home-status offline" }, "Not responding")),
        h("div", { class: "home-note" },
          h("p", {}, "MiniLake for this context stopped answering. Its logs usually say why:"),
          ui.context?.container ? snippet(`docker logs ${ui.context.container}`) : null,
          h("p", { class: "muted" }, h("span", { class: "loading" }), ` Retrying · ${ui.state.offline.error}`)));
    }
    page(head(h("p", { class: "home-status ok" }, "Running")), loading());
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

  // Row counts come in after the page shows, in one statement for up to MAX_COUNTED tables.
  async function countRows(tables, t) {
    const counted = tables.slice(0, MAX_COUNTED);
    if (!counted.length) return;
    const sql = counted.map((tb, i) => `SELECT ${i} AS i, count(*) AS n FROM ${lake.quoteName(tb.full_name)}`).join("\nUNION ALL\n");
    const res = await lake.runSql(sql).catch(() => null);
    if (t !== token || !res) return;
    for (const [i, n] of res.rows) {
      const cell = el.querySelector(`[data-rows="${i}"]`);
      if (cell) cell.textContent = `${Number(n).toLocaleString()} rows`;
    }
  }

  function render({ tables, history, queries, graphs, runs }) {
    const ctx = ui.ctx;
    const tableList = tables.length
      ? h("ul", { class: "home-list tables" }, tables.map((tb, i) => h("li", {},
        h("a", { href: `#/data/${tb.full_name}` },
          h("span", { class: "ns" }, `${tb.catalog_name}.${tb.schema_name}.`), h("b", {}, tb.name)),
        h("span", { class: "meta", "data-rows": String(i) }, i < MAX_COUNTED ? "" : "—"),
        h("span", { class: "meta" }, `${tb.columns?.length ?? 0} columns`))))
      : h("div", { class: "home-empty" },
        h("p", {}, "This lake has no tables yet. Drop a CSV, JSON or Parquet file here, or create one with SQL."),
        h("p", { class: "muted" }, "To fill a context the same way every time, put .sql or .py files in ", h("code", {}, "pond-seed/"), ". They run when the lake is new."));

    const recent = history.length
      ? h("ul", { class: "home-list history" }, history.map((e) => h("li", {},
        h("button", { class: "linkish mono", title: e.query_text, onclick: () => ui.views.query.open(e.query_text) },
          h("span", { class: `dot ${e.status === "FINISHED" ? "ok" : "err"}` }), e.query_text.replace(/\s+/g, " ")),
        h("span", { class: "meta" }, [e.rows_produced != null && `${e.rows_produced} rows`, fmtDuration(e.duration), fmtTime(e.query_start_time_ms)].filter(Boolean).join(" · ")))))
      : empty("Nothing run yet.");

    page(
      head(h("p", { class: "home-status ok" }, "Running")),
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
            h("p", { class: "help" }, "Register this context's MCP server with Claude Code, or any MCP client:"),
            snippet(`claude mcp add --transport http pond-${ctx?.name ?? "lake"} ${ui.mcpUrl}`),
            h("p", { class: "help muted" }, "Agents in this browser can also use the page itself through WebMCP. You'll see what they do under Activity.")))),
    );
  }

  return {
    el,
    show,
    activate: () => show(),
    snapshot: () => ({ overview: ui.ctx?.name }),
  };
}
