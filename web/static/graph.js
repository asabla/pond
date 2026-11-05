// @ts-check
// Graph analytics helpers shared by the Graph view and WebMCP. Plain functions over rows and
// maps, so they are testable without a browser; graphology and sigma are used by the view.
//
// A graph is defined by SQL: an edge query whose first two columns are the source and target
// node ids (a column named `weight` weights edges; other columns become edge attributes), and
// optionally a node query whose first column is the node id (a `label` column names nodes;
// other columns become node attributes). Definitions are saved as JSON in the lake's files.

export const GRAPHS_DIR = "/pond/graphs";
// Up to this many edges the whole graph is loaded and every metric is exact.
export const FULL_LOAD_EDGES = 30000;
// Bigger graphs open on their best-connected nodes and those nodes' neighbours, up to
// OVERVIEW_EDGES edges; double-click expands a node.
export const OVERVIEW_SEEDS = 20;
export const OVERVIEW_EDGES = 500;
export const NEIGHBOR_LIMIT = 100;
// Category slots before the rest fold into "Other" (see the palette in style.css).
export const SLOTS = 8;

/* ---------- Definitions ---------- */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/;

export function validateDefinition(def) {
  if (!def || typeof def !== "object") return "A graph definition is an object.";
  if (def.name != null && !NAME.test(def.name)) return "Graph names use letters, digits, spaces, dots, dashes and underscores.";
  if (!def.edges_sql?.trim()) return "edges_sql is required: a query whose first two columns are source and target.";
  return null;
}

export const normalize = (def) => ({
  name: def.name?.trim() || null,
  edges_sql: stripSemicolons(def.edges_sql),
  nodes_sql: def.nodes_sql?.trim() ? stripSemicolons(def.nodes_sql) : null,
  directed: def.directed !== false,
});

const stripSemicolons = (sql) => sql.trim().replace(/;+\s*$/, "");

// SQL for a graph over an existing table.
export function definitionFromTables({ name, edgeTable, source, target, weight, directed = true, nodeTable, nodeId, label }) {
  const cols = [`${quoteIdent(source)} AS source`, `${quoteIdent(target)} AS target`];
  if (weight) cols.push(`${quoteIdent(weight)} AS weight`);
  const def = { name, directed, edges_sql: `SELECT ${cols.join(", ")}\nFROM ${quoteTable(edgeTable)}` };
  if (nodeTable && nodeId) {
    const used = [nodeId, label].filter(Boolean).map(quoteIdent);
    def.nodes_sql = `SELECT ${quoteIdent(nodeId)} AS id${label ? `, ${quoteIdent(label)} AS label` : ""}, * EXCLUDE (${used.join(", ")})\nFROM ${quoteTable(nodeTable)}`;
  }
  return def;
}

/* ---------- SQL ---------- */

export const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
export const quoteTable = (fullName) => fullName.split(".").map(quoteIdent).join(".");

// A literal for a node id, keeping numbers numeric so comparisons use the column's type.
export function literal(value) {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const list = (values) => values.map(literal).join(", ");
// The newlines keep a trailing `-- comment` in the user's SQL from swallowing the ")".
const wrap = (sql) => `(\n${sql}\n)`;
const edges = (def) => `${wrap(def.edges_sql)} AS e`;

export const countEdgesSql = (def) => `SELECT count(*) AS edges FROM ${edges(def)}`;
export const columnsSql = (def) => `SELECT * FROM ${edges(def)} LIMIT 0`;
export const loadEdgesSql = (def, limit) => `SELECT * FROM ${edges(def)} LIMIT ${limit}`;
export const nodesSql = (def, ids) =>
  `SELECT * FROM ${wrap(def.nodes_sql)} AS n${ids ? ` WHERE n.${quoteIdent(ids.column)} IN (${list(ids.values)})` : ""}`;

export function topNodesSql(def, { source, target }, n = OVERVIEW_SEEDS) {
  return `SELECT id, count(*) AS degree FROM (
  SELECT e.${quoteIdent(source)} AS id FROM ${edges(def)}
  UNION ALL
  SELECT e.${quoteIdent(target)} AS id FROM ${edges(def)}
) AS d GROUP BY id ORDER BY degree DESC, id LIMIT ${n}`;
}

export function edgesAmongSql(def, { source, target }, ids) {
  const among = list(ids);
  return `SELECT * FROM ${edges(def)} WHERE e.${quoteIdent(source)} IN (${among}) AND e.${quoteIdent(target)} IN (${among})`;
}

export function edgesTouchingSql(def, { source, target }, ids, limit = OVERVIEW_EDGES) {
  const among = list(ids);
  return `SELECT * FROM ${edges(def)} WHERE e.${quoteIdent(source)} IN (${among}) OR e.${quoteIdent(target)} IN (${among}) LIMIT ${limit}`;
}

export function neighborsSql(def, { source, target }, id, limit = NEIGHBOR_LIMIT) {
  const v = literal(id);
  return `SELECT * FROM ${edges(def)} WHERE e.${quoteIdent(source)} = ${v} OR e.${quoteIdent(target)} = ${v} LIMIT ${limit}`;
}

// The edge from a to b (either way round when undirected), to draw one step of a path.
export function edgeBetweenSql(def, { source, target }, a, b, directed) {
  const s = `e.${quoteIdent(source)}`;
  const t = `e.${quoteIdent(target)}`;
  const [la, lb] = [literal(a), literal(b)];
  return `SELECT * FROM ${edges(def)} WHERE (${s} = ${la} AND ${t} = ${lb})${directed ? "" : ` OR (${s} = ${lb} AND ${t} = ${la})`} LIMIT 1`;
}

// One breadth-first step: edges leaving (forward) or entering (backward) the frontier.
export function frontierSql(def, { source, target }, ids, { directed, backward = false }) {
  const s = `e.${quoteIdent(source)}`;
  const t = `e.${quoteIdent(target)}`;
  const among = list(ids);
  if (!directed) return `SELECT ${s} AS a, ${t} AS b FROM ${edges(def)} WHERE ${s} IN (${among}) OR ${t} IN (${among})`;
  return backward
    ? `SELECT ${t} AS a, ${s} AS b FROM ${edges(def)} WHERE ${t} IN (${among})`
    : `SELECT ${s} AS a, ${t} AS b FROM ${edges(def)} WHERE ${s} IN (${among})`;
}

/* ---------- Rows ---------- */

// Node keys are strings (graphology's keys); the raw value is kept for SQL literals.
export const keyOf = (v) => String(v);

export function edgeRecords({ columns, rows }) {
  if (columns.length < 2) throw new Error("The edge query needs at least two columns: source and target.");
  const weightAt = columns.findIndex((c, i) => i > 1 && c.name.toLowerCase() === "weight");
  const extra = columns.map((c, i) => [c.name, i]).filter(([, i]) => i > 1 && i !== weightAt);
  const out = [];
  for (const row of rows) {
    if (row[0] == null || row[1] == null) continue;
    // NULL or empty means no weight (1); Number() would turn both into 0.
    const raw = weightAt >= 0 ? row[weightAt] : null;
    const weight = raw == null || raw === "" ? 1 : Number(raw);
    out.push({
      source: row[0],
      target: row[1],
      weight: Number.isFinite(weight) ? weight : 1,
      attributes: Object.fromEntries(extra.map(([name, i]) => [name, row[i]])),
    });
  }
  return out;
}

export function nodeRecords({ columns, rows }) {
  const labelAt = columns.findIndex((c, i) => i > 0 && c.name.toLowerCase() === "label");
  const seen = new Set([columns[0]?.name, columns[labelAt]?.name]);
  const extra = columns.map((c, i) => [c.name, i]).filter(([name, i]) => i > 0 && i !== labelAt && !seen.has(name) && (seen.add(name), true));
  return rows.filter((r) => r[0] != null).map((row) => ({
    id: row[0],
    label: labelAt >= 0 && row[labelAt] != null ? String(row[labelAt]) : String(row[0]),
    attributes: Object.fromEntries(extra.map(([name, i]) => [name, row[i]])),
  }));
}

/* ---------- Metrics graphology-library lacks ---------- */

// Local clustering coefficient, ignoring direction: the share of a node's neighbour pairs
// that are themselves connected.
export function clusteringCoefficients(nodes, neighborsOf) {
  const sets = new Map(nodes.map((n) => [n, new Set(neighborsOf(n).filter((m) => m !== n))]));
  const out = {};
  for (const [n, nbrs] of sets) {
    const k = nbrs.size;
    if (k < 2) {
      out[n] = 0;
      continue;
    }
    const arr = [...nbrs];
    let links = 0;
    for (let i = 0; i < arr.length; i++) {
      const si = sets.get(arr[i]);
      for (let j = i + 1; j < arr.length; j++) if (si?.has(arr[j])) links++;
    }
    out[n] = (2 * links) / (k * (k - 1));
  }
  return out;
}

/* ---------- Encoding ---------- */

// Categories by size, largest first: the first SLOTS get palette slots in fixed order, the
// rest share "Other" (slot -1). Ties break on the category so colours are stable.
export function categorize(values, slots = SLOTS) {
  const counts = new Map();
  for (const v of Object.values(values)) {
    const key = v == null ? "∅" : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }));
  const slotOf = new Map(ranked.slice(0, slots).map(([k], i) => [k, i]));
  const legend = ranked.slice(0, slots).map(([category, count], slot) => ({ category, count, slot }));
  const otherCount = ranked.slice(slots).reduce((n, [, c]) => n + c, 0);
  const byNode = {};
  for (const [node, v] of Object.entries(values)) byNode[node] = slotOf.get(v == null ? "∅" : String(v)) ?? -1;
  return { byNode, legend, other: otherCount ? { count: otherCount, categories: ranked.length - slots } : null };
}

export const isNumeric = (values) => {
  const vs = Object.values(values).filter((v) => v != null && v !== "");
  return vs.length > 0 && vs.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))));
};

// Maps numbers onto [0, 1] for size or a sequential ramp; a flat metric maps to 0.5.
export function scale(values) {
  const nums = Object.values(values).map(Number).filter(Number.isFinite);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const x = Number(v);
    out[k] = !Number.isFinite(x) ? 0 : max > min ? (x - min) / (max - min) : 0.5;
  }
  return { byNode: out, min, max };
}

/* ---------- Shortest path through SQL, for graphs too big to load ---------- */

// Bidirectional breadth-first search, one SQL query per level, always growing the smaller
// side. Returns the node ids on a shortest path (ignoring weights), or null when there is
// provably none. Throws when it gives up first, so "no path" is never a guess.
export const PATH_MAX_HOPS = 20;
export async function sqlShortestPath({ runSql, def, columns, from, to, directed, maxDepth = PATH_MAX_HOPS, maxFrontier = 20000 }) {
  if (keyOf(from) === keyOf(to)) return [from];
  /** @type {[Side, Side]} */
  const sides = [
    { parent: new Map([[keyOf(from), null]]), raw: new Map([[keyOf(from), from]]), frontier: [from], backward: false },
    { parent: new Map([[keyOf(to), null]]), raw: new Map([[keyOf(to), to]]), frontier: [to], backward: true },
  ];
  for (let depth = 0; depth < maxDepth; depth++) {
    const side = sides[0].frontier.length <= sides[1].frontier.length ? sides[0] : sides[1];
    const other = side === sides[0] ? sides[1] : sides[0];
    if (!side.frontier.length) return null;
    if (side.frontier.length > maxFrontier) {
      throw new Error(`The search reached ${side.frontier.length.toLocaleString()} nodes at depth ${depth}; no path within reach. Narrow the graph with SQL.`);
    }
    const { rows } = await runSql(frontierSql(def, columns, side.frontier, { directed, backward: side.backward }));
    const inFrontier = new Set(side.frontier.map(keyOf));
    const next = [];
    for (let [a, b] of rows) {
      if (!directed && !inFrontier.has(keyOf(a))) [a, b] = [b, a];
      const kb = keyOf(b);
      if (side.parent.has(kb)) continue;
      side.parent.set(kb, keyOf(a));
      side.raw.set(kb, b);
      next.push(b);
      if (other.parent.has(kb)) return join(sides, kb);
    }
    side.frontier = next;
  }
  throw new Error(`No path within ${maxDepth} hops.`);
}

/**
 * @typedef {{ parent: Map<string, any>, raw: Map<string, any>, frontier: any[], backward: boolean }} Side
 * @param {[Side, Side]} sides
 * @param {string} meet
 */
function join([fwd, bwd], meet) {
  const path = [];
  for (let k = meet; k != null; k = fwd.parent.get(k)) path.unshift(fwd.raw.get(k));
  for (let k = bwd.parent.get(meet); k != null; k = bwd.parent.get(k)) path.push(bwd.raw.get(k));
  return path;
}

/* ---------- Saved graphs (JSON files in the lake) ---------- */

const graphPath = (name) => `${GRAPHS_DIR}/${name.replace(/[^\w.-]+/g, "_")}.json`;

export async function listGraphs(lake) {
  let entries;
  try {
    entries = await lake.listDir(GRAPHS_DIR);
  } catch {
    return []; // the folder appears with the first saved graph
  }
  const graphs = [];
  for (const e of entries.filter((x) => !x.is_directory && x.path.endsWith(".json"))) {
    try {
      graphs.push(normalize(JSON.parse(await (await lake.readFile(e.path)).text())));
    } catch {
      // skip files that aren't graph definitions
    }
  }
  return graphs.filter((g) => g.name).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveGraph(lake, def) {
  const problem = validateDefinition(def) || (!def.name && "A saved graph needs a name.");
  if (problem) throw new Error(problem);
  const g = normalize(def);
  await lake.uploadFile(graphPath(g.name), new Blob([JSON.stringify(g, null, 2)], { type: "application/json" }));
  return g;
}

export const deleteGraph = (lake, name) => lake.deleteFile(graphPath(name));
