// WebMCP: exposes Pond's actions as tools on navigator.modelContext, so a browser agent can
// drive the page. Tools act through the UI, so the human sees what the agent does, and
// destructive tools ask the human first.
// Spec: https://webmachinelearning.github.io/webmcp/

import { FULL_LOAD_EDGES, listGraphs, saveGraph } from "./graph.js";
import { METRICS, GROUPINGS } from "./views/graph.js";

const DEFAULT_MAX_ROWS = 100;
const READ_MAX_BYTES = 64 * 1024;

const text = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

const capRows = (rows, max) => ({
  rows: rows.slice(0, max),
  row_count: rows.length,
  ...(rows.length > max && { note: `Only the first ${max} of ${rows.length} rows are included; raise max_rows or aggregate in SQL.` }),
});

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = (description, extra) => ({ type: "string", description, ...extra });
const fullName = (parts) => str(`${parts}-part name, dot separated`, { pattern: parts === 3 ? "^[^.]+\\.[^.]+\\.[^.]+$" : undefined });
const READ = { readOnlyHint: true };

// Destructive tools show the page's own confirmation dialog. When the browser offers
// requestUserInteraction, the dialog runs inside it so the agent waits for the human.
async function askUser(client, fn) {
  const ok = client?.requestUserInteraction ? await client.requestUserInteraction(fn) : await fn();
  if (!ok) throw new Error("The user declined.");
}

function summarizeRun(run, output, lake) {
  return {
    run_id: run.run_id,
    job_id: run.job_id ?? null,
    name: run.run_name,
    state: run.state,
    done: lake.isRunDone(run),
    started: run.start_time,
    ended: run.end_time || null,
    ...(output && { logs: output.logs, error: output.error, error_trace: output.error_trace, logs_truncated: output.logs_truncated }),
  };
}

async function runResult(lake, runId, wait) {
  let run = wait ? await lake.waitForRun(runId) : await lake.getRun(runId);
  const output = lake.isRunDone(run) ? await lake.getRunOutput(run.tasks?.[0]?.run_id ?? runId).catch(() => null) : null;
  return summarizeRun(run, output, lake);
}

export function buildTools(ui) {
  const { lake, views } = ui;
  const wait = { type: "boolean", default: true, description: "Wait for the run to finish (up to 5 minutes) and return its output." };
  const params = { type: "array", items: { type: "string" }, description: "Arguments passed to the script (sys.argv[1:])." };

  return [
    /* ---------- Orientation ---------- */
    {
      name: "get_view",
      description: "Which context (directory) this lake belongs to and what the user is looking at: section, selection, SQL in the editor, last query. Call this first.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => ui.snapshot(),
    },

    /* ---------- Data ---------- */
    {
      name: "list_catalogs",
      description: "List Unity Catalog catalogs.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => (await lake.listCatalogs()).map((c) => ({ name: c.name, comment: c.comment })),
    },
    {
      name: "list_schemas",
      description: "List schemas in a catalog.",
      inputSchema: obj({ catalog: str("Catalog name") }, ["catalog"]),
      annotations: READ,
      execute: async ({ catalog }) => (await lake.listSchemas(catalog)).map((s) => ({ full_name: s.full_name, comment: s.comment })),
    },
    {
      name: "list_tables",
      description: "List tables and volumes in a schema.",
      inputSchema: obj({ catalog: str("Catalog name"), schema: str("Schema name") }, ["catalog", "schema"]),
      annotations: READ,
      execute: async ({ catalog, schema }) => {
        const [tables, volumes] = await Promise.all([lake.listTables(catalog, schema), lake.listVolumes(catalog, schema)]);
        return {
          tables: tables.map((t) => ({ full_name: t.full_name, table_type: t.table_type, format: t.data_source_format, comment: t.comment })),
          volumes: volumes.map((v) => ({ full_name: v.full_name, path: lake.volumePath(v.full_name) })),
        };
      },
    },
    {
      name: "describe_table",
      description: "Columns, types and storage of a table, without changing what the user sees.",
      inputSchema: obj({ full_name: fullName(3) }, ["full_name"]),
      annotations: READ,
      execute: async ({ full_name }) => {
        const t = await lake.getTable(full_name);
        return {
          full_name: t.full_name, table_type: t.table_type, format: t.data_source_format, storage_location: t.storage_location, comment: t.comment,
          columns: (t.columns ?? []).map((c) => ({ name: c.name, type: c.type_text, nullable: c.nullable, comment: c.comment })),
        };
      },
    },
    {
      name: "open_table",
      description: "Show a table to the user (columns and a data preview) and return its columns and first rows.",
      inputSchema: obj({ full_name: fullName(3), max_rows: { type: "integer", minimum: 0, maximum: 100, default: 10 } }, ["full_name"]),
      execute: async ({ full_name, max_rows = 10 }) => {
        const { table, preview, previewError } = await views.data.openTable(full_name);
        return {
          full_name: table.full_name,
          columns: (table.columns ?? []).map((c) => ({ name: c.name, type: c.type_text })),
          ...(preview ? capRows(preview.rows, max_rows) : { preview_error: previewError }),
        };
      },
    },
    {
      name: "create_catalog",
      description: "Create a catalog (MiniLake adds a default schema) and show it to the user.",
      inputSchema: obj({ name: str("Catalog name"), comment: str("Optional description") }, ["name"]),
      execute: async ({ name, comment }) => {
        await lake.createCatalog(name, comment);
        await ui.refreshTree();
        ui.navigate("data", name);
        return `Created catalog ${name} with schema ${name}.default.`;
      },
    },
    {
      name: "create_schema",
      description: "Create a schema in a catalog and show it to the user.",
      inputSchema: obj({ catalog: str("Catalog name"), name: str("Schema name"), comment: str("Optional description") }, ["catalog", "name"]),
      execute: async ({ catalog, name, comment }) => {
        await lake.createSchema(catalog, name, comment);
        await ui.refreshTree();
        ui.navigate("data", `${catalog}.${name}`);
        return `Created schema ${catalog}.${name}.`;
      },
    },
    {
      name: "create_volume",
      description: "Create a volume (a folder for files at /Volumes/catalog/schema/volume).",
      inputSchema: obj({ catalog: str("Catalog name"), schema: str("Schema name"), name: str("Volume name"), comment: str("Optional description") }, ["catalog", "schema", "name"]),
      execute: async ({ catalog, schema, name, comment }) => {
        await lake.createVolume(catalog, schema, name, comment);
        await ui.refreshTree();
        ui.navigate("data", "volume", `${catalog}.${schema}.${name}`);
        return { full_name: `${catalog}.${schema}.${name}`, path: lake.volumePath(`${catalog}.${schema}.${name}`) };
      },
    },
    {
      name: "drop_object",
      description: "Drop a catalog, schema, table or volume and everything in it. The user is asked to confirm in the page.",
      inputSchema: obj({ kind: { type: "string", enum: ["catalog", "schema", "table", "volume"] }, full_name: str("Name of the object, e.g. sales.raw.orders") }, ["kind", "full_name"]),
      annotations: { destructiveHint: true },
      execute: async ({ kind, full_name }, client) => {
        await askUser(client, () => views.data.dropObject(kind, full_name, { byAgent: true }));
        return `Dropped ${kind} ${full_name}.`;
      },
    },
    {
      name: "import_data",
      description: "Load CSV, TSV, JSON Lines, JSON or Parquet content into a table. The file is kept in the schema's 'imports' volume. Give text content for text formats; for files already in the lake use create_table_from_file.",
      inputSchema: obj({
        catalog: str("Catalog name"),
        schema: str("Schema name"),
        table: str("Table name"),
        file_name: str("File name with extension, which decides the format, e.g. orders.csv"),
        content: str("The file's text content"),
        mode: { type: "string", enum: ["create", "replace", "append"], default: "create" },
      }, ["catalog", "schema", "table", "file_name", "content"]),
      execute: async ({ catalog, schema, table, file_name, content, mode = "create" }) => {
        const res = await lake.importFile({ data: new Blob([content]), fileName: file_name, catalog, schema, table, mode });
        await ui.refreshTree();
        ui.navigate("data", res.table);
        return res;
      },
    },
    {
      name: "create_table_from_file",
      description: "Create a table from a CSV, TSV, JSON or Parquet file already in the lake (e.g. in a volume).",
      inputSchema: obj({
        path: str("File path, e.g. /Volumes/sales/raw/landing/orders.csv"),
        catalog: str("Catalog name"), schema: str("Schema name"), table: str("Table name"),
        mode: { type: "string", enum: ["create", "replace", "append"], default: "create" },
      }, ["path", "catalog", "schema", "table"]),
      execute: async (input) => {
        const res = await lake.tableFromFile(input);
        await ui.refreshTree();
        ui.navigate("data", res.table);
        return res;
      },
    },

    /* ---------- Query ---------- */
    {
      name: "run_sql",
      description: "Run SQL in the user's Query tab, where they see the statement and results, and return the result. MiniLake runs the DuckDB dialect, not Spark SQL. Statements can modify data.",
      inputSchema: obj({
        sql: str("A single SQL statement"),
        max_rows: { type: "integer", minimum: 0, maximum: 1000, default: DEFAULT_MAX_ROWS, description: "Rows to return to you. The user's grid shows up to 1000." },
      }, ["sql"]),
      annotations: { destructiveHint: true },
      execute: async ({ sql, max_rows = DEFAULT_MAX_ROWS }) => {
        views.query.setSql(sql);
        ui.navigate("query");
        const out = await views.query.runEditor({ byAgent: true });
        if (out?.error) throw new Error(out.error);
        return { columns: out.result.columns, elapsed_ms: out.result.elapsedMs, ...capRows(out.result.rows, max_rows) };
      },
    },
    {
      name: "draft_sql",
      description: "Put SQL in the user's editor without running it, for them to review and run. Prefer this over run_sql for statements that change data.",
      inputSchema: obj({ sql: str("SQL") }, ["sql"]),
      execute: async ({ sql }) => {
        views.query.open(sql);
        return "SQL placed in the editor. The user can run it with ⌘↵ / Ctrl+Enter.";
      },
    },
    {
      name: "save_query",
      description: "Save SQL as a named query the user can reopen from the Query tab.",
      inputSchema: obj({ name: str("Query name"), sql: str("SQL") }, ["name", "sql"]),
      execute: async ({ name, sql }) => {
        ui.navigate("query");
        const saved = await views.query.save({ name, sql, byAgent: true });
        return { id: saved.id, name };
      },
    },
    {
      name: "list_saved_queries",
      description: "Saved queries in this context.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => (await lake.listSavedQueries()).map((q) => ({ id: q.id, name: q.display_name, sql: q.query_text })),
    },
    {
      name: "query_history",
      description: "Recently executed SQL statements with status, duration and errors.",
      inputSchema: obj({ max: { type: "integer", minimum: 1, maximum: 100, default: 20 } }),
      annotations: READ,
      execute: async ({ max = 20 }) => (await lake.queryHistory(max)).map((e) => ({
        sql: e.query_text, status: e.status, duration_ms: e.duration, rows: e.rows_produced, error: e.error_message, started: e.query_start_time_ms,
      })),
    },

    /* ---------- Jobs ---------- */
    {
      name: "list_jobs",
      description: "Saved jobs with their script and parameters.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => (await lake.listJobs()).map((j) => ({ job_id: j.job_id, name: j.settings?.name, ...lake.jobScript(j) })),
    },
    {
      name: "list_runs",
      description: "Recent job runs, newest first.",
      inputSchema: obj({ job_id: { type: "integer", description: "Only runs of this job" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }),
      annotations: READ,
      execute: async ({ job_id, limit = 20 }) => (await lake.listRuns({ jobId: job_id, limit })).map((r) => summarizeRun(r, null, lake)),
    },
    {
      name: "get_run",
      description: "A run's state and, once finished, its output logs. Shows the run to the user.",
      inputSchema: obj({ run_id: { type: "integer" }, wait }, ["run_id"]),
      execute: async ({ run_id, wait: w = false }) => {
        ui.navigate("jobs", "run", run_id);
        return runResult(lake, run_id, w);
      },
    },
    {
      name: "run_script",
      description: "Run a Python/PySpark script once in a Spark container on this context's network and show the run to the user. Use SparkSession.builder.getOrCreate(); MiniLake's tables are reachable by path or through its Unity Catalog connector. Saved under /Shared/pond.",
      inputSchema: obj({ name: str("Run name"), source: str("Python source"), parameters: params, wait }, ["name", "source"]),
      execute: async ({ name, source, parameters, wait: w = true }) => {
        const { run_id } = await lake.runScript(name, source, parameters);
        ui.navigate("jobs", "run", run_id);
        return runResult(lake, run_id, w);
      },
    },
    {
      name: "create_job",
      description: "Save a Python/PySpark script as a job the user can run again.",
      inputSchema: obj({ name: str("Job name"), source: str("Python source"), parameters: params }, ["name", "source"]),
      execute: async ({ name, source, parameters }) => {
        const res = await lake.createScriptJob(name, source, parameters);
        ui.navigate("jobs", "job", res.job_id);
        return res;
      },
    },
    {
      name: "run_job",
      description: "Run a saved job now and show the run to the user.",
      inputSchema: obj({ job_id: { type: "integer" }, wait }, ["job_id"]),
      execute: async ({ job_id, wait: w = true }) => {
        const { run_id } = await lake.runNow(job_id);
        ui.navigate("jobs", "run", run_id);
        return runResult(lake, run_id, w);
      },
    },

    /* ---------- Files ---------- */
    {
      name: "list_files",
      description: "List a directory in the lake's file system. Volumes are under /Volumes/catalog/schema/volume.",
      inputSchema: obj({ path: str("Directory path", { default: "/" }) }),
      annotations: READ,
      execute: async ({ path = "/" }) => (await lake.listDir(path)).map((e) => ({ path: e.path, is_directory: e.is_directory, size: e.file_size, modified: e.last_modified })),
    },
    {
      name: "read_file",
      description: "Read a text file from the lake's file system.",
      inputSchema: obj({ path: str("File path"), max_bytes: { type: "integer", minimum: 1, maximum: 1048576, default: READ_MAX_BYTES } }, ["path"]),
      annotations: READ,
      execute: async ({ path, max_bytes = READ_MAX_BYTES }) => {
        const blob = await lake.readFile(path);
        return { path, size: blob.size, truncated: blob.size > max_bytes, content: await blob.slice(0, max_bytes).text() };
      },
    },
    {
      name: "write_file",
      description: "Write a text file to the lake's file system (overwrites), e.g. into a volume, and show its folder to the user.",
      inputSchema: obj({ path: str("File path, e.g. /Volumes/sales/raw/landing/notes.txt"), content: str("Text content") }, ["path", "content"]),
      execute: async ({ path, content }) => {
        await lake.uploadFile(path, new Blob([content]));
        ui.navigate("files", "dbfs", ...path.split("/").filter(Boolean));
        return `Wrote ${content.length} characters to ${path}.`;
      },
    },
    {
      name: "delete_path",
      description: "Delete a file or a directory (recursively) from the lake's file system. The user is asked to confirm.",
      inputSchema: obj({ path: str("File or directory path") }, ["path"]),
      annotations: { destructiveHint: true },
      execute: async ({ path }, client) => {
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        const entry = (await lake.listDir(parent)).find((e) => e.path === path);
        if (!entry) throw new Error(`${path} does not exist.`);
        await askUser(client, () => ui.views.files.remove(entry, { byAgent: true }));
        return `Deleted ${path}.`;
      },
    },
    {
      name: "list_workspace",
      description: "List workspace objects (scripts, notebooks, folders).",
      inputSchema: obj({ path: str("Workspace path", { default: "/" }) }),
      annotations: READ,
      execute: async ({ path = "/" }) => (await lake.listWorkspace(path)).map((o) => ({ path: o.path, type: o.object_type, language: o.language })),
    },
    {
      name: "read_workspace_file",
      description: "Read a workspace script or notebook's source.",
      inputSchema: obj({ path: str("Workspace path") }, ["path"]),
      annotations: READ,
      execute: async ({ path }) => ({ path, source: await lake.exportWorkspace(path) }),
    },
    {
      name: "write_workspace_file",
      description: "Create or overwrite a Python script in the workspace and show it to the user.",
      inputSchema: obj({ path: str("Workspace path, e.g. /Shared/pond/etl.py"), source: str("Python source") }, ["path", "source"]),
      execute: async ({ path, source }) => {
        await lake.importWorkspace(path, source);
        ui.navigate("files", "workspace", ...path.split("/").filter(Boolean));
        return `Saved ${path}.`;
      },
    },

    /* ---------- Graph ---------- */
    {
      name: "list_graphs",
      description: "List saved graphs: each is defined by an edge query (first two columns source and target, optional weight column) and an optional node query (first column id, optional label column).",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => listGraphs(lake),
    },
    {
      name: "open_graph",
      description: `Open a graph in the user's Graph tab, by saved name or by SQL. Up to ${FULL_LOAD_EDGES.toLocaleString()} edges load in full; bigger graphs open on their best-connected nodes and their neighbours (mode "overview"). Returns its size and node attribute columns.`,
      inputSchema: obj({
        name: str("A saved graph's name"),
        edges_sql: str("SQL whose first two columns are source and target node ids; a column named weight weights edges"),
        nodes_sql: str("Optional SQL whose first column is the node id; a column named label names nodes, others become attributes"),
        directed: { type: "boolean", default: true, description: "Whether edges have a direction" },
      }),
      execute: async ({ name, edges_sql, nodes_sql, directed }) => {
        if (!name && !edges_sql) throw new Error("Give either name or edges_sql.");
        ui.navigate("graph");
        return name ? views.graph.open(name, { byAgent: true }) : views.graph.openAdhoc({ edges_sql, nodes_sql, directed }, { byAgent: true });
      },
    },
    {
      name: "save_graph",
      description: "Save a graph definition under a name so it can be reopened from the Graph tab. Replaces a saved graph with the same name.",
      inputSchema: obj({
        name: str("Graph name: letters, digits, spaces, dots, dashes, underscores"),
        edges_sql: str("SQL whose first two columns are source and target node ids"),
        nodes_sql: str("Optional SQL whose first column is the node id"),
        directed: { type: "boolean", default: true },
      }, ["name", "edges_sql"]),
      execute: async (def) => {
        const saved = await saveGraph(lake, def);
        await views.graph.refreshSaved();
        return saved;
      },
    },
    {
      name: "graph_metrics",
      description: "Compute a metric over the open graph's nodes and show it in the page (node size for centralities, colour for groupings). Centralities return the top nodes; groupings return group sizes, plus modularity for communities. Metrics cover the loaded nodes.",
      inputSchema: obj({
        metric: { type: "string", enum: [...Object.keys(METRICS), ...Object.keys(GROUPINGS)], description: "degree, in_degree and out_degree count edges; pagerank, betweenness, closeness, eigenvector, hub and authority rank importance; clustering is the local clustering coefficient; community (Louvain), component and strong_component group nodes" },
        top: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      }, ["metric"]),
      annotations: READ,
      execute: async ({ metric, top = 10 }) => {
        ui.navigate("graph");
        const result = await views.graph.ranking(metric, top);
        await views.graph.style(METRICS[metric] ? { size: metric } : { color: metric });
        return result;
      },
    },
    {
      name: "graph_stats",
      description: "Summary of the open graph: nodes, edges, density, average degree, connected components and any communities, clustering or diameter computed so far.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => views.graph.stats(),
    },
    {
      name: "shortest_path",
      description: "Find and highlight a shortest path between two nodes of the open graph. Uses edge weights as distances when the graph has a weight column. In overview mode, nodes not loaded are searched in SQL across the whole graph (ignoring weights). Returns null when there is no path.",
      inputSchema: obj({
        from: str("Start node id or label"),
        to: str("End node id or label"),
        use_weights: { type: "boolean", default: true },
      }, ["from", "to"]),
      annotations: READ,
      execute: async ({ from, to, use_weights = true }) => {
        ui.navigate("graph");
        return views.graph.findPath(from, to, { useWeights: use_weights });
      },
    },
    {
      name: "graph_neighbors",
      description: "Select a node in the open graph and return its neighbours (outgoing and incoming when directed). In overview mode, set expand to load its neighbours from the lake first.",
      inputSchema: obj({ node: str("Node id or label"), expand: { type: "boolean", default: false } }, ["node"]),
      annotations: READ,
      execute: async ({ node, expand = false }) => {
        ui.navigate("graph");
        if (expand) await views.graph.expand(node);
        views.graph.select(node);
        return views.graph.neighbors(node);
      },
    },

    /* ---------- Admin ---------- */
    {
      name: "list_warehouses",
      description: "SQL warehouses. They all share the same catalogs.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => (await lake.listWarehouses()).map((w) => ({ id: w.id, name: w.name, state: w.state })),
    },
    {
      name: "list_secrets",
      description: "Secret scopes and their keys. Values are never returned.",
      inputSchema: obj(),
      annotations: READ,
      execute: async () => Promise.all((await lake.listScopes()).map(async (s) => ({ scope: s.name, keys: (await lake.listSecrets(s.name)).map((k) => k.key) }))),
    },
    {
      name: "put_secret",
      description: "Store a secret for jobs to use ({{secrets/scope/key}} or dbutils.secrets.get). Creates the scope if needed.",
      inputSchema: obj({ scope: str("Scope"), key: str("Key"), value: str("Secret value") }, ["scope", "key", "value"]),
      execute: async ({ scope, key, value }) => {
        await ui.views.admin.saveSecret(scope, key, value);
        return `Stored ${scope}/${key}.`;
      },
    },
    {
      name: "reset_lake",
      description: "Delete everything in this context's lake: catalogs, tables, files, jobs, queries and secrets. The user must confirm by typing the context name.",
      inputSchema: obj(),
      annotations: { destructiveHint: true },
      execute: async (_, client) => {
        ui.navigate("admin");
        await askUser(client, () => ui.views.admin.resetLake({ byAgent: true }));
        return "The lake was reset.";
      },
    },
  ];
}

// Wraps a tool so every call is logged in the UI and results use the MCP content shape.
function wrap(tool, ui) {
  return {
    ...tool,
    execute: async (input = {}, client) => {
      try {
        const result = await tool.execute(input, client);
        ui.logAgent(tool.name, input);
        return text(result);
      } catch (err) {
        ui.logAgent(tool.name, input, err.message);
        return fail(err.message);
      }
    },
  };
}

export function registerWebMcp(ui) {
  const tools = buildTools(ui).map((t) => wrap(t, ui));
  // Handy for debugging, and for agents that script the page directly.
  window.pond = { tools: Object.fromEntries(tools.map((t) => [t.name, t])) };

  const mc = navigator.modelContext;
  if (!mc) {
    return { ok: false, message: "This browser does not expose navigator.modelContext. Tools are still available on window.pond.tools." };
  }
  try {
    if (typeof mc.registerTool === "function") {
      for (const tool of tools) mc.registerTool(tool);
    } else if (typeof mc.provideContext === "function") {
      mc.provideContext({ tools });
    } else {
      return { ok: false, message: "navigator.modelContext exists but supports neither registerTool nor provideContext." };
    }
  } catch (err) {
    return { ok: false, message: `WebMCP registration failed: ${err.message}` };
  }
  return { ok: true, message: `${tools.length} tools registered` };
}
