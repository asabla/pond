// @ts-check
// MiniLake client. Pond's server proxies /api and /_minilake to MiniLake, so every call is
// same-origin. Shared by the UI and the WebMCP tools so both see the lake the same way.

const UC = "/api/2.1/unity-catalog";
const JOBS = "/api/2.2/jobs";
const POLL_MS = 250;
// Where Pond keeps scripts it runs as jobs, so they are easy to find in the workspace.
export const SCRIPTS_DIR = "/Shared/pond";
// Volume that file imports land in when the caller does not pick one.
export const IMPORT_VOLUME = "imports";

let configPromise;

export class LakeError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] MiniLake's error_code
   * @param {number} [status] the HTTP status
   */
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new LakeError(data.message || data.detail || `${method} ${path} failed (${res.status})`, data.error_code, res.status);
  return data;
}

const q = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
const enc = encodeURIComponent;
// Files API paths keep their slashes; each segment is encoded on its own.
const fsPath = (path) => path.split("/").filter(Boolean).map(enc).join("/");

export function config({ refresh = false } = {}) {
  if (!configPromise || refresh) {
    configPromise = call("GET", "/pond/config").catch((err) => {
      configPromise = undefined;
      throw err;
    });
  }
  return configPromise;
}

/* ---------- Unity Catalog ---------- */

// Follows next_page_token, for APIs that page. MiniLake 1.9 returns everything at once.
async function allPages(path, key) {
  const out = [];
  let token;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page = await call("GET", token ? `${path}${sep}${q({ page_token: token })}` : path);
    out.push(...(page[key] ?? []));
    token = page.next_page_token;
  } while (token);
  return out;
}

export const listCatalogs = () => allPages(`${UC}/catalogs`, "catalogs");
export const createCatalog = (name, comment) => call("POST", `${UC}/catalogs`, { name, comment: comment || undefined });
export const deleteCatalog = (name) => call("DELETE", `${UC}/catalogs/${enc(name)}?force=true`);

export const listSchemas = async (catalog) => (await call("GET", `${UC}/schemas?${q({ catalog_name: catalog })}`)).schemas ?? [];
export const createSchema = (catalog, name, comment) =>
  call("POST", `${UC}/schemas`, { catalog_name: catalog, name, comment: comment || undefined });
export const deleteSchema = (fullName) => call("DELETE", `${UC}/schemas/${enc(fullName)}?force=true`);

export const listTables = async (catalog, schema) =>
  (await call("GET", `${UC}/tables?${q({ catalog_name: catalog, schema_name: schema })}`)).tables ?? [];
export const getTable = (fullName) => call("GET", `${UC}/tables/${enc(fullName)}`);
export const deleteTable = (fullName) => call("DELETE", `${UC}/tables/${enc(fullName)}`);

export const listVolumes = async (catalog, schema) =>
  (await call("GET", `${UC}/volumes?${q({ catalog_name: catalog, schema_name: schema })}`)).volumes ?? [];
export const createVolume = (catalog, schema, name, comment) =>
  call("POST", `${UC}/volumes`, { catalog_name: catalog, schema_name: schema, name, volume_type: "MANAGED", comment: comment || undefined });
export const deleteVolume = (fullName) => call("DELETE", `${UC}/volumes/${enc(fullName)}`);
export const volumePath = (fullName) => `/Volumes/${fullName.split(".").join("/")}`;

// Backticks are Databricks-style; MiniLake rewrites them for DuckDB.
export const quoteName = (fullName) =>
  fullName.split(".").map((part) => "`" + part.replaceAll("`", "``") + "`").join(".");

/* ---------- SQL ---------- */

// MiniLake's DuckDB has no CREATE CATALOG, and a schema made with SQL CREATE SCHEMA works but
// is missing from Unity Catalog's listing. Both statements go through Unity Catalog instead.
const IDENT = "(\\w+|`[^`]+`|\"[^\"]+\")";
const CREATE_CATALOG = new RegExp(`^create\\s+catalog\\s+(if\\s+not\\s+exists\\s+)?${IDENT}\\s*;?$`, "i");
const CREATE_SCHEMA = new RegExp(`^create\\s+schema\\s+(if\\s+not\\s+exists\\s+)?${IDENT}\\.${IDENT}\\s*;?$`, "i");
const unquote = (name) => name.replace(/^[`"]|[`"]$/g, "");

async function catalogDdl(statement) {
  const bare = statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
  let m = bare.match(CREATE_CATALOG);
  if (m) {
    const name = unquote(m[2]);
    if (!(m[1] && (await listCatalogs()).some((c) => c.name === name))) await createCatalog(name);
    return true;
  }
  m = bare.match(CREATE_SCHEMA);
  if (m) {
    const [catalog, name] = [unquote(m[2]), unquote(m[3])];
    if (!(m[1] && (await listSchemas(catalog)).some((s) => s.name === name))) await createSchema(catalog, name);
    return true;
  }
  return false;
}

export async function runSql(statement) {
  const started = performance.now();
  if (await catalogDdl(statement)) return { statementId: null, columns: [], rows: [], truncated: false, elapsedMs: Math.round(performance.now() - started) };
  const { warehouse_id, error } = await config();
  if (!warehouse_id) throw new LakeError(error || "No SQL warehouse available", "NO_WAREHOUSE");

  let res = await call("POST", "/api/2.0/sql/statements", { warehouse_id, statement, wait_timeout: "30s" });
  while (["PENDING", "RUNNING"].includes(res.status?.state)) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    res = await call("GET", `/api/2.0/sql/statements/${res.statement_id}`);
  }
  if (res.status?.state !== "SUCCEEDED") {
    throw new LakeError(res.status?.error?.message || `Statement ${res.status?.state}`, res.status?.error?.error_code);
  }

  const columns = (res.manifest?.schema?.columns ?? []).map((c) => ({ name: c.name, type: c.type_text }));
  return {
    statementId: res.statement_id,
    columns,
    rows: res.result?.data_array ?? [],
    truncated: Boolean(res.manifest?.truncated || res.result?.truncated),
    elapsedMs: Math.round(performance.now() - started),
  };
}

export const previewTable = (fullName, limit = 100) =>
  runSql(`SELECT * FROM ${quoteName(fullName)} LIMIT ${Math.max(1, Math.min(10000, limit | 0))}`);

export const queryHistory = async (max = 50) =>
  (await call("GET", `/api/2.0/sql/history/queries?${q({ max_results: max })}`)).res ?? [];

export const listSavedQueries = async () => (await call("GET", "/api/2.0/sql/queries")).results ?? [];
// Saving under an existing name updates that query; MiniLake rejects duplicate names.
export async function saveQuery(name, sql) {
  const existing = (await listSavedQueries()).find((sq) => sq.display_name === name);
  if (existing) return updateQuery(existing.id, name, sql);
  const { warehouse_id } = await config();
  return call("POST", "/api/2.0/sql/queries", { query: { display_name: name, query_text: sql, warehouse_id } });
}
export const updateQuery = (id, name, sql) =>
  call("PATCH", `/api/2.0/sql/queries/${enc(id)}`, { update_mask: "display_name,query_text", query: { display_name: name, query_text: sql } });
export const deleteQuery = (id) => call("DELETE", `/api/2.0/sql/queries/${enc(id)}`);

export const listWarehouses = async () => (await call("GET", "/api/2.0/sql/warehouses")).warehouses ?? [];
export const createWarehouse = (name) => call("POST", "/api/2.0/sql/warehouses", { name });
export const deleteWarehouse = (id) => call("DELETE", `/api/2.0/sql/warehouses/${enc(id)}`);

/* ---------- Files (DBFS root, including /Volumes) ---------- */

export const listDir = async (path) => (await call("GET", `/api/2.0/fs/directories/${fsPath(path)}`)).contents ?? [];
export const makeDir = (path) => call("PUT", `/api/2.0/fs/directories/${fsPath(path)}`);
export const deleteDir = (path) => call("DELETE", `/api/2.0/fs/directories/${fsPath(path)}`);
/** @param {string} path */
export async function fileExists(path) {
  try {
    await call("GET", `/api/2.0/dbfs/get-status?${q({ path })}`);
    return true;
  } catch (err) {
    if (err.code === "RESOURCE_DOES_NOT_EXIST") return false;
    throw err;
  }
}

/** @param {string} path */
export async function workspaceExists(path) {
  try {
    await call("GET", `/api/2.0/workspace/get-status?${q({ path })}`);
    return true;
  } catch (err) {
    if (err.code === "RESOURCE_DOES_NOT_EXIST") return false;
    throw err;
  }
}

export const deleteFile = (path) => call("DELETE", `/api/2.0/fs/files/${fsPath(path)}`);

// MiniLake only deletes empty directories, so empty them first.
export async function deleteTree(path) {
  for (const entry of await listDir(path)) {
    if (entry.is_directory) await deleteTree(entry.path);
    else await deleteFile(entry.path);
  }
  await deleteDir(path);
}

export async function uploadFile(path, data, { overwrite = true } = {}) {
  const res = await fetch(`/api/2.0/fs/files/${fsPath(path)}?overwrite=${overwrite}`, { method: "PUT", body: data });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new LakeError(body.message || `Upload failed (${res.status})`, body.error_code);
  }
}

export async function readFile(path) {
  const res = await fetch(`/api/2.0/fs/files/${fsPath(path)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new LakeError(body.message || `Read failed (${res.status})`, body.error_code);
  }
  return res.blob();
}

/**
 * Reads the first maxBytes of a file as text, without downloading the rest: MiniLake
 * ignores Range headers on the Files API, but the DBFS read API takes a length.
 * @param {string} path
 * @param {number} maxBytes
 */
export async function readHead(path, maxBytes) {
  const [status, chunk] = await Promise.all([
    call("GET", `/api/2.0/dbfs/get-status?${q({ path })}`),
    call("GET", `/api/2.0/dbfs/read?${q({ path, offset: 0, length: maxBytes })}`),
  ]);
  const bytes = Uint8Array.from(atob(chunk.data ?? ""), (c) => c.charCodeAt(0));
  return { size: status.file_size, truncated: status.file_size > bytes.length, text: new TextDecoder().decode(bytes) };
}

// SQL runs inside MiniLake, where files live under <data_root>/dbfs.
export async function sqlPath(path) {
  const { data_root } = await config();
  return `${data_root ?? "data"}/dbfs${path}`;
}

/* ---------- Data import ---------- */

export const FORMATS = {
  csv: "read_csv_auto",
  tsv: "read_csv_auto",
  json: "read_json_auto",
  jsonl: "read_json_auto",
  ndjson: "read_json_auto",
  parquet: "read_parquet",
};

export function formatOf(fileName) {
  const ext = fileName.split(".").pop().toLowerCase();
  return FORMATS[ext] ? ext : null;
}

export const tableNameFor = (fileName) =>
  fileName.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "imported";

// Creates (or replaces, or appends to) a table from a file already in the lake.
export async function tableFromFile({ path, catalog, schema, table, mode = "create" }) {
  const format = formatOf(path);
  if (!format) throw new LakeError(`Unsupported file type: ${path}. Use CSV, TSV, JSON, JSONL or Parquet.`);
  const source = `${FORMATS[format]}('${(await sqlPath(path)).replaceAll("'", "''")}')`;
  const target = quoteName(`${catalog}.${schema}.${table}`);
  const statement = mode === "append"
    ? `INSERT INTO ${target} SELECT * FROM ${source}`
    : `CREATE ${mode === "replace" ? "OR REPLACE " : ""}TABLE ${target} AS SELECT * FROM ${source}`;
  await runSql(statement);
  const count = await runSql(`SELECT count(*) FROM ${target}`);
  return { table: `${catalog}.${schema}.${table}`, path, rows: count.rows[0]?.[0] };
}

// Loads a local file into a table: stage it in a volume, then create the table from it.
export async function importFile({ file, data, fileName, catalog, schema, table, volume = IMPORT_VOLUME, mode = "create" }) {
  fileName ??= file?.name;
  if (!formatOf(fileName)) throw new LakeError(`Unsupported file type: ${fileName}. Use CSV, TSV, JSON, JSONL or Parquet.`);
  if (!(await listVolumes(catalog, schema)).some((v) => v.name === volume)) {
    await createVolume(catalog, schema, volume, "Files imported with Pond");
  }
  const path = `${volumePath(`${catalog}.${schema}.${volume}`)}/${fileName}`;
  await uploadFile(path, file ?? data);
  return tableFromFile({ path, catalog, schema, table, mode });
}

// SQL that reads a data file in place, for previews and the Query tab.
export async function selectFromFile(path, limit = 100) {
  const format = formatOf(path);
  if (!format) return null;
  return `SELECT *\nFROM ${FORMATS[format]}('${(await sqlPath(path)).replaceAll("'", "''")}')\nLIMIT ${limit}`;
}

/* ---------- Workspace ---------- */

export const listWorkspace = async (path) => (await call("GET", `/api/2.0/workspace/list?${q({ path })}`)).objects ?? [];
export const mkdirsWorkspace = (path) => call("POST", "/api/2.0/workspace/mkdirs", { path });
export const deleteWorkspace = (path, recursive = false) => call("POST", "/api/2.0/workspace/delete", { path, recursive });

export async function exportWorkspace(path) {
  const { content } = await call("GET", `/api/2.0/workspace/export?${q({ path, format: "SOURCE" })}`);
  const bytes = Uint8Array.from(atob(content ?? ""), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function importWorkspace(path, source, language = "PYTHON") {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  await mkdirsWorkspace(path.slice(0, path.lastIndexOf("/")) || "/");
  return call("POST", "/api/2.0/workspace/import", { path, format: "SOURCE", language, content: btoa(binary), overwrite: true });
}

/* ---------- Jobs ---------- */

export const listJobs = () => allPages(`${JOBS}/list?${q({ limit: 100, expand_tasks: true })}`, "jobs");
export const getJob = (id) => call("GET", `${JOBS}/get?${q({ job_id: id })}`);
export const deleteJob = (id) => call("POST", `${JOBS}/delete`, { job_id: Number(id) });
export const runNow = (id) => call("POST", `${JOBS}/run-now`, { job_id: Number(id) });
/** @param {{ jobId?: number, limit?: number }} [opts] */
export const listRuns = async ({ jobId, limit = 50 } = {}) =>
  (await call("GET", `${JOBS}/runs/list?${q({ job_id: jobId, limit })}`)).runs ?? [];
export const getRun = (id) => call("GET", `${JOBS}/runs/get?${q({ run_id: id })}`);
export const cancelRun = (id) => call("POST", `${JOBS}/runs/cancel`, { run_id: Number(id) });
export const getRunOutput = (id) => call("GET", `${JOBS}/runs/get-output?${q({ run_id: id })}`);

const pythonTask = (file, parameters) => ({
  task_key: "main",
  spark_python_task: { python_file: file, parameters: parameters?.length ? parameters : undefined },
});

export const scriptPath = (name, dir = SCRIPTS_DIR) => `${dir}/${name.replace(/[^\w.-]+/g, "_").replace(/\.py$/, "")}.py`;
// One-off runs keep their scripts apart, so a run can't overwrite a job's script.
export const RUNS_DIR = `${SCRIPTS_DIR}/runs`;

// A script path no other script uses: names that differ only in punctuation share a
// base, and an existing script may belong to another job.
async function freeScriptPath(name) {
  const base = scriptPath(name).slice(0, -3);
  for (let i = 1; ; i++) {
    const path = `${base}${i > 1 ? `-${i}` : ""}.py`;
    if (!(await workspaceExists(path))) return path;
  }
}

// Saves a script to the workspace and creates a job that runs it.
export async function createScriptJob(name, source, parameters) {
  const file = await freeScriptPath(name);
  await importWorkspace(file, source);
  const { job_id } = await call("POST", `${JOBS}/create`, { name, tasks: [pythonTask(file, parameters)] });
  return { job_id, file };
}

// Rewrites a job's script in place and resets its settings.
export async function updateJob(jobId, { name, file, source, parameters }) {
  if (source != null) await importWorkspace(file, source);
  await call("POST", `${JOBS}/reset`, { job_id: Number(jobId), new_settings: { name, tasks: [pythonTask(file, parameters)] } });
}

export const submitFile = async (name, file, parameters) =>
  call("POST", `${JOBS}/runs/submit`, { run_name: name, tasks: [pythonTask(file, parameters)] });

export const jobScript = (job) => job?.settings?.tasks?.[0]?.spark_python_task ?? job?.tasks?.[0]?.spark_python_task ?? null;

// One-off run: saves the script to the workspace and submits it without creating a job.
export async function runScript(name, source, parameters) {
  const file = scriptPath(name, RUNS_DIR);
  await importWorkspace(file, source);
  const { run_id } = await call("POST", `${JOBS}/runs/submit`, { run_name: name, tasks: [pythonTask(file, parameters)] });
  return { run_id, file };
}

export const isRunDone = (run) => ["TERMINATED", "SKIPPED", "INTERNAL_ERROR"].includes(run?.state?.life_cycle_state);

/**
 * @param {number} id
 * @param {{ timeoutMs?: number, onUpdate?: (run: any) => void }} [opts]
 */
export async function waitForRun(id, { timeoutMs = 300000, onUpdate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let run = await getRun(id);
  while (!isRunDone(run) && Date.now() < deadline) {
    onUpdate?.(run);
    await new Promise((r) => setTimeout(r, 1500));
    run = await getRun(id);
  }
  return run;
}

/* ---------- Secrets ---------- */

export const listScopes = async () => (await call("GET", "/api/2.0/secrets/scopes/list")).scopes ?? [];
export const createScope = (scope) => call("POST", "/api/2.0/secrets/scopes/create", { scope });
export const deleteScope = (scope) => call("POST", "/api/2.0/secrets/scopes/delete", { scope });
export const listSecrets = async (scope) => (await call("GET", `/api/2.0/secrets/list?${q({ scope })}`)).secrets ?? [];
export const putSecret = (scope, key, value) => call("POST", "/api/2.0/secrets/put", { scope, key, string_value: value });
export const deleteSecret = (scope, key) => call("POST", "/api/2.0/secrets/delete", { scope, key });

/* ---------- MiniLake control plane ---------- */

export const services = async () => (await call("GET", "/_minilake/services")).services ?? {};
export async function resetLake() {
  await call("POST", "/_minilake/reset");
  // Reset drops the warehouse too; the next config call makes a new one.
  await config({ refresh: true });
}
