// Shared graph engine. Loaded as a classic script in browsers and the embedded Go runtime.
(function () {
"use strict";
// Graph analytics helpers shared by the Graph view and WebMCP. Plain functions over rows and
// maps, so they are testable without a browser; graphology and sigma are used by the view.
//
// A graph is defined by SQL: an edge query whose first two columns are the source and target
// node ids (a column named `weight` weights edges; other columns become edge attributes), and
// optionally a node query whose first column is the node id (a `label` column names nodes;
// other columns become node attributes). Definitions are saved as JSON in the lake's files.

const GRAPHS_DIR = "/pond/graphs";
// Up to this many edges the whole graph is loaded and every metric is exact.
const FULL_LOAD_EDGES = 30000;
const FULL_LOAD_NODES = 50000;
// Bigger graphs open on their best-connected nodes and those nodes' neighbours, up to
// OVERVIEW_EDGES edges; double-click expands a node.
const OVERVIEW_SEEDS = 20;
const OVERVIEW_EDGES = 500;
const NEIGHBOR_LIMIT = 100;
// Category slots before the rest fold into "Other" (see the palette in style.css).
const SLOTS = 6;

/* ---------- Definitions ---------- */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/;

function validateDefinition(def) {
  if (!def || typeof def !== "object") return "A graph definition is an object.";
  if (def.name != null && !NAME.test(def.name)) return "Graph names use letters, digits, spaces, dots, dashes and underscores.";
  if (def.name != null && typeof def.name !== "string") return "name must be a string.";
  if (def.nodes_sql != null && typeof def.nodes_sql !== "string") return "nodes_sql must be a string.";
  if (typeof def.edges_sql !== "string" || !def.edges_sql.trim()) return "edges_sql is required: a query whose first two columns are source and target.";
  if (globalThis.pondSqlValidator(def.edges_sql) || (def.nodes_sql && globalThis.pondSqlValidator(def.nodes_sql))) return "edges_sql and nodes_sql must each be a single query.";
  return null;
}

const normalize = (def) => ({
  name: def.name?.trim() || null,
  edges_sql: stripSemicolons(def.edges_sql),
  nodes_sql: def.nodes_sql?.trim() ? stripSemicolons(def.nodes_sql) : null,
  directed: def.directed !== false,
});

const stripSemicolons = (sql) => sql.trim().replace(/;+\s*$/, "");

// SQL for a graph over an existing table.
function definitionFromTables({ name, edgeTable, source, target, weight, directed = true, nodeTable, nodeId, label }) {
  const cols = [`${quoteIdent(source)} AS source`, `${quoteIdent(target)} AS target`];
  if (weight) cols.push(`${quoteIdent(weight)} AS weight`);
  const def = { name, directed, edges_sql: `SELECT ${cols.join(", ")}\nFROM ${quoteTable(edgeTable)}` };
  if (nodeTable && nodeId) {
    const used = [...new Set([nodeId, label].filter(Boolean))].map(quoteIdent);
    def.nodes_sql = `SELECT ${quoteIdent(nodeId)} AS id${label ? `, ${quoteIdent(label)} AS label` : ""}, * EXCLUDE (${used.join(", ")})\nFROM ${quoteTable(nodeTable)}`;
  }
  return def;
}

/* ---------- SQL ---------- */

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
const quoteTable = (fullName) => fullName.split(".").map(quoteIdent).join(".");

// A literal for a node id, keeping numbers numeric so comparisons use the column's type.
function literal(value) {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const list = (values) => values.map(literal).join(", ");
// String tokens are consumed whole so numbers inside labels and SQL stay intact.
function parseJSON(text) {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (token, number) => number && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number)) ? `"${number}"` : token));
}
const fileBase = (name) => name.replace(/[^\w.-]+/g, "_");
// The newlines keep a trailing `-- comment` in the user's SQL from swallowing the ")".
const wrap = (sql) => `(\n${sql}\n)`;
const edges = (def) => `${wrap(def.edges_sql)} AS e`;

const countEdgesSql = (def) => `SELECT count(*) AS edges FROM ${edges(def)}`;
const columnsSql = (def) => `SELECT * FROM ${edges(def)} LIMIT 0`;
const loadEdgesSql = (def, limit) => `SELECT * FROM ${edges(def)} LIMIT ${limit}`;
const nodesSql = (def, ids) =>
  `SELECT * FROM ${wrap(def.nodes_sql)} AS n${ids ? ` WHERE n.${quoteIdent(ids.column)} IN (${list(ids.values)})` : ""}`;

const countNodesSql = (def) => `SELECT count(*) AS nodes FROM ${wrap(def.nodes_sql)} AS n`;
// The node query's rows for nodes that appear in an edge, filtered in SQL.
const nodesInEdgesSql = (def, { source, target }, idColumn) =>
  `SELECT * FROM ${wrap(def.nodes_sql)} AS n WHERE n.${quoteIdent(idColumn)} IN (` +
  `SELECT ${quoteIdent(source)} FROM ${edges(def)} UNION SELECT ${quoteIdent(target)} FROM ${edges(def)})`;

function topNodesSql(def, { source, target }, n = OVERVIEW_SEEDS) {
  return `SELECT id, count(*) AS degree FROM (
  SELECT e.${quoteIdent(source)} AS id FROM ${edges(def)} WHERE e.${quoteIdent(source)} IS NOT NULL AND e.${quoteIdent(target)} IS NOT NULL
  UNION ALL
  SELECT e.${quoteIdent(target)} AS id FROM ${edges(def)} WHERE e.${quoteIdent(source)} IS NOT NULL AND e.${quoteIdent(target)} IS NOT NULL
) AS d GROUP BY id ORDER BY degree DESC, id LIMIT ${n}`;
}

function edgesAmongSql(def, { source, target }, ids, limit) {
  const among = list(ids);
  return `SELECT * FROM ${edges(def)} WHERE e.${quoteIdent(source)} IN (${among}) AND e.${quoteIdent(target)} IN (${among})${limit == null ? "" : ` LIMIT ${limit}`}`;
}

function edgesTouchingSql(def, { source, target }, ids, limit = OVERVIEW_EDGES) {
  const among = list(ids);
  return `SELECT * FROM ${edges(def)} WHERE e.${quoteIdent(source)} IN (${among}) OR e.${quoteIdent(target)} IN (${among}) LIMIT ${limit}`;
}

function neighborsSql(def, { source, target }, id, limit = NEIGHBOR_LIMIT) {
  const v = literal(id);
  return `SELECT * FROM ${edges(def)} WHERE e.${quoteIdent(source)} = ${v} OR e.${quoteIdent(target)} = ${v} LIMIT ${limit}`;
}

// The edge from a to b (either way round when undirected), to draw one step of a path.
function edgeBetweenSql(def, { source, target }, a, b, directed) {
  const s = `e.${quoteIdent(source)}`;
  const t = `e.${quoteIdent(target)}`;
  const [la, lb] = [literal(a), literal(b)];
  return `SELECT * FROM ${edges(def)} WHERE (${s} = ${la} AND ${t} = ${lb})${directed ? "" : ` OR (${s} = ${lb} AND ${t} = ${la})`} LIMIT 1`;
}

// One breadth-first step: edges leaving (forward) or entering (backward) the frontier.
function frontierSql(def, { source, target }, ids, { directed, backward = false }) {
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
const keyOf = (v) => String(v);

function edgeRecords({ columns, rows }) {
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

function nodeRecords({ columns, rows }) {
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
function clusteringCoefficients(nodes, neighborsOf) {
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
function categorize(values, slots = SLOTS) {
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

const isNumeric = (values) => {
  const vs = Object.values(values).filter((v) => v != null && v !== "");
  return vs.length > 0 && vs.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))));
};

// Maps numbers onto [0, 1] for size or a sequential ramp; a flat metric maps to 0.5.
function scale(values) {
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
const PATH_MAX_HOPS = 20;
async function sqlShortestPath({ runSql, def, columns, from, to, directed, maxDepth = PATH_MAX_HOPS, maxFrontier = 20000 }) {
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


const METRICS = {
  degree: { label: "Degree" }, in_degree: { label: "In-degree", directed: true },
  out_degree: { label: "Out-degree", directed: true }, pagerank: { label: "PageRank" },
  betweenness: { label: "Betweenness", heavy: true }, closeness: { label: "Closeness", heavy: true },
  eigenvector: { label: "Eigenvector" }, hub: { label: "Hub score (HITS)", directed: true },
  authority: { label: "Authority score (HITS)", directed: true }, clustering: { label: "Clustering coefficient" },
};
const GROUPINGS = {
  community: { label: "Community (Louvain)" }, component: { label: "Connected component" },
  strong_component: { label: "Strongly connected component", directed: true },
};

function ensureNode(g, raw) {
  const key = keyOf(raw);
  if (!g.hasNode(key)) g.addNode(key, { raw, label: key, attributes: {}, x: Math.random(), y: Math.random(), size: 4 });
  return key;
}
function addEdges(g, records, weighted) {
  for (const r of records) {
    const a = ensureNode(g, r.source), b = ensureNode(g, r.target);
    const e = g.edge(a, b);
    if (e === undefined) g.addEdge(a, b, { weight: r.weight, count: 1, attributes: r.attributes });
    else {
      g.updateEdgeAttribute(e, "count", (c) => (c ?? 1) + 1);
      if (weighted) g.updateEdgeAttribute(e, "weight", (w) => (w ?? 0) + r.weight);
    }
  }
}
function addNodes(g, records, onlyExisting = true) {
  for (const r of records) {
    const key = keyOf(r.id);
    if (!g.hasNode(key)) {
      if (onlyExisting) continue;
      ensureNode(g, r.id);
    }
    g.mergeNodeAttributes(key, { label: r.label, attributes: r.attributes });
  }
}
function seeded(seed) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function metric(g, lib, name, weighted) {
  const c = lib.metrics.centrality, weight = weighted ? "weight" : null;
  switch (name) {
    case "degree": return Object.fromEntries(g.nodes().map((n) => [n, g.degree(n)]));
    case "in_degree": return Object.fromEntries(g.nodes().map((n) => [n, g.inDegree(n)]));
    case "out_degree": return Object.fromEntries(g.nodes().map((n) => [n, g.outDegree(n)]));
    case "pagerank": return c.pagerank(g, { getEdgeWeight: weight });
    case "betweenness": return c.betweenness(g, { getEdgeWeight: weight, normalized: true });
    case "closeness": return c.closeness(g);
    case "eigenvector": return c.eigenvector(g, { getEdgeWeight: weight, maxIterations: 500 });
    case "hub": return c.hits(g, { getEdgeWeight: weight, maxIterations: 500 }).hubs;
    case "authority": return c.hits(g, { getEdgeWeight: weight, maxIterations: 500 }).authorities;
    case "clustering": return clusteringCoefficients(g.nodes(), (n) => g.neighbors(n));
    default: throw new Error(`Unknown metric ${name}.`);
  }
}
function grouping(g, lib, name, weighted) {
  let byNode = {}, meta = {};
  if (name === "community") {
    const res = lib.communitiesLouvain.detailed(g, { getEdgeWeight: weighted ? "weight" : null, rng: seeded(42) });
    const counts = new Map();
    for (const id of Object.values(res.communities)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const rank = new Map([...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id], i) => [id, `Community ${i + 1}`]));
    byNode = Object.fromEntries(Object.entries(res.communities).map(([n, id]) => [n, rank.get(id)]));
    meta = { count: res.count, modularity: res.modularity };
  } else if (name === "component" || name === "strong_component") {
    const comps = name === "component" ? lib.components.connectedComponents(g) : lib.components.stronglyConnectedComponents(g);
    comps.forEach((nodes) => nodes.sort());
    comps.sort((a, b) => b.length - a.length || compareKeys(a[0], b[0]));
    const prefix = name === "component" ? "Component" : "Strong component";
    comps.forEach((nodes, i) => nodes.forEach((n) => (byNode[n] = `${prefix} ${i + 1}`)));
    meta = { count: comps.length, largest: comps[0]?.length ?? 0 };
  } else if (name.startsWith("attr:")) {
    g.forEachNode((n, a) => (byNode[n] = a.attributes?.[name.slice(5)] ?? null));
  } else throw new Error(`Unknown grouping ${name}.`);
  return { byNode, meta };
}
const compareKeys = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function stats(g, lib, weighted) {
  const comp = grouping(g, lib, "component", weighted);
  return {
    nodes: g.order, edges: g.size, directed: g.type === "directed", weighted,
    density: lib.metrics.graph.density(g), average_degree: g.order ? (2 * g.size) / g.order : 0,
    components: comp.meta.count, largest_component: comp.meta.largest,
  };
}
function ranking(g, lib, name, weighted, top = 10, computed = null) {
  if (Object.prototype.hasOwnProperty.call(METRICS, name)) {
    const vals = computed ?? metric(g, lib, name, weighted);
    return Object.entries(vals).sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0])).slice(0, top)
      .map(([n, value]) => ({ node: g.getNodeAttribute(n, "raw"), label: g.getNodeAttribute(n, "label"), value }));
  }
  const grp = computed ?? grouping(g, lib, name, weighted);
  const counts = new Map();
  for (const v of Object.values(grp.byNode)) {
    const key = v == null ? "∅" : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = [...counts].sort((a, b) => b[1] - a[1] || compareKeys(a[0], b[0]));
  return { ...grp.meta, groups: groups.slice(0, top).map(([group, nodes]) => ({ group, nodes })),
    other: groups.length > top ? { count: groups.slice(top).reduce((sum, [, count]) => sum + count, 0), categories: groups.length - top } : null };
}
function neighbors(g, id, limit = 200) {
  const key = keyOf(id);
  if (!g.hasNode(key)) throw new Error(`No node ${id} in the loaded graph.`);
  const pick = (ns) => ns.sort(compareKeys).slice(0, limit).map((n) => ({ node: g.getNodeAttribute(n, "raw"), label: g.getNodeAttribute(n, "label") }));
  const base = { node: g.getNodeAttribute(key, "raw"), label: g.getNodeAttribute(key, "label") };
  return g.type === "directed"
    ? { ...base, out: pick(g.outNeighbors(key)), in: pick(g.inNeighbors(key)), out_degree: g.outDegree(key), in_degree: g.inDegree(key), truncated: g.outNeighbors(key).length > limit || g.inNeighbors(key).length > limit }
    : { ...base, neighbors: pick(g.neighbors(key)), degree: g.degree(key), truncated: g.neighbors(key).length > limit };
}
function shortestPath(g, lib, from, to, weighted) {
  const a = keyOf(from), b = keyOf(to);
  if (!g.hasNode(a) || !g.hasNode(b)) throw new Error(`No node ${!g.hasNode(a) ? from : to} in the graph.`);
  if (weighted && g.someEdge((_, attrs) => attrs.weight < 0)) throw new Error("Weighted paths require non-negative distances. Use unweighted search.");
  const keys = weighted ? lib.shortestPath.dijkstra.bidirectional(g, a, b, "weight") : lib.shortestPath.bidirectional(g, a, b);
  if (!keys) return null;
  let weight = 0;
  for (let i = 0; i + 1 < keys.length; i++) weight += g.getEdgeAttribute(g.edge(keys[i], keys[i + 1]), "weight");
  return { nodes: keys.map((n) => ({ node: g.getNodeAttribute(n, "raw"), label: g.getNodeAttribute(n, "label") })), hops: keys.length - 1, weight: weighted ? weight : null, weighted };
}
function createGraph(Graph, directed) {
  return new Graph({ type: directed ? "directed" : "undirected", allowSelfLoops: true });
}
 globalThis.pondGraphCore = { FULL_LOAD_NODES, countNodesSql, nodesInEdgesSql, parseJSON, fileBase, PATH_MAX_HOPS, sqlShortestPath, METRICS, GROUPINGS, ensureNode, addEdges, addNodes, metric, grouping, stats, ranking, neighbors, shortestPath, createGraph, GRAPHS_DIR, FULL_LOAD_EDGES, OVERVIEW_SEEDS, OVERVIEW_EDGES, NEIGHBOR_LIMIT, SLOTS, validateDefinition, normalize, definitionFromTables, quoteIdent, quoteTable, literal, countEdgesSql, columnsSql, loadEdgesSql, nodesSql, topNodesSql, edgesAmongSql, edgesTouchingSql, neighborsSql, edgeBetweenSql, frontierSql, keyOf, edgeRecords, nodeRecords, clusteringCoefficients, categorize, isNumeric, scale };
})();
