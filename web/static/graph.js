// @ts-check
import { isMultiStatement } from "./sql.js";
import "./graph-core.js";
// The classic-script engine also runs inside Go. Supply the shared SQL scanner.
globalThis.pondSqlValidator = isMultiStatement;
export const {
  FULL_LOAD_NODES, countNodesSql, nodesInEdgesSql, parseJSON, fileBase, PATH_MAX_HOPS, sqlShortestPath, METRICS, GROUPINGS, ensureNode,
  addEdges, addNodes, metric, grouping, stats, ranking, neighbors,
  shortestPath, createGraph, GRAPHS_DIR, FULL_LOAD_EDGES, OVERVIEW_SEEDS, OVERVIEW_EDGES, NEIGHBOR_LIMIT,
  SLOTS, validateDefinition, normalize, definitionFromTables, quoteIdent, quoteTable, literal,
  countEdgesSql, columnsSql, loadEdgesSql, nodesSql, topNodesSql, edgesAmongSql, edgesTouchingSql,
  neighborsSql, edgeBetweenSql, frontierSql, keyOf, edgeRecords, nodeRecords, clusteringCoefficients,
  categorize, isNumeric, scale,
} = globalThis.pondGraphCore;

/* ---------- Saved graphs (JSON files in the lake) ---------- */

// A file name for a new graph. Names that differ only in punctuation ("a b", "a_b")
// would share a file, so saveGraph checks the folder and adds a number when needed.

async function graphFiles(lake) {
  let entries;
  try {
    entries = await lake.listDir(GRAPHS_DIR);
  } catch (err) {
    // The folder appears with the first saved graph. Any other failure must surface, or
    // saveGraph would think no graphs exist and could overwrite one.
    if (err?.status === 404) return [];
    throw err;
  }
  const read = async (e) => {
    try {
      return { path: e.path, def: normalize(JSON.parse(await (await lake.readFile(e.path)).text())) };
    } catch {
      return null; // skip files that aren't graph definitions
    }
  };
  const files = await Promise.all(entries.filter((x) => !x.is_directory && x.path.endsWith(".json")).map(read));
  return files.filter((f) => f?.def.name);
}

export async function listGraphs(lake) {
  return (await graphFiles(lake)).map((f) => f.def).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveGraph(lake, def) {
  const problem = validateDefinition(def) || (!def.name && "A saved graph needs a name.");
  if (problem) throw new Error(problem);
  const g = normalize(def);
  const files = await graphFiles(lake);
  // Overwrite the graph's own file; otherwise pick a file name no other graph uses.
  let path = files.find((f) => f.def.name === g.name)?.path;
  for (let i = 1; !path; i++) {
    const candidate = `${GRAPHS_DIR}/${fileBase(g.name)}${i > 1 ? `-${i}` : ""}.json`;
    if (!files.some((f) => f.path === candidate)) path = candidate;
  }
  await lake.uploadFile(path, new Blob([JSON.stringify(g, null, 2)], { type: "application/json" }));
  return g;
}

export async function deleteGraph(lake, name) {
  const file = (await graphFiles(lake)).find((f) => f.def.name === name);
  if (!file) throw new Error(`No saved graph named “${name}”.`);
  await lake.deleteFile(file.path);
}
