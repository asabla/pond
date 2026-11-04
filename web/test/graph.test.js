// Unit tests for the graph helpers. Run with: node --test web/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import * as g from "../static/graph.js";

test("definitions need edge SQL and a safe name, and lose trailing semicolons", () => {
  assert.match(g.validateDefinition({}), /edges_sql/);
  assert.match(g.validateDefinition({ name: "../x", edges_sql: "SELECT 1, 2" }), /names/);
  assert.equal(g.validateDefinition({ name: "Social graph 1", edges_sql: "SELECT 1, 2" }), null);
  assert.deepEqual(g.normalize({ name: " n ", edges_sql: "SELECT a, b FROM t;; ", nodes_sql: "  " }), {
    name: "n", edges_sql: "SELECT a, b FROM t", nodes_sql: null, directed: true,
  });
  assert.equal(g.normalize({ edges_sql: "x", directed: false }).directed, false);
});

test("definitionFromTables quotes names and maps columns", () => {
  const def = g.definitionFromTables({
    name: "follows", edgeTable: "social.core.follows", source: "src", target: "dst", weight: "w",
    nodeTable: "social.core.people", nodeId: "id", label: "name",
  });
  assert.equal(def.edges_sql, 'SELECT "src" AS source, "dst" AS target, "w" AS weight\nFROM "social"."core"."follows"');
  assert.equal(def.nodes_sql, 'SELECT "id" AS id, "name" AS label, * EXCLUDE ("id", "name")\nFROM "social"."core"."people"');
  assert.equal(g.definitionFromTables({ edgeTable: "a.b.c", source: "s", target: "t" }).nodes_sql, undefined);
});

test("literals keep numbers numeric and escape strings", () => {
  assert.equal(g.literal(42), "42");
  assert.equal(g.literal("O'Brien"), "'O''Brien'");
  assert.equal(g.literal(true), "TRUE");
  assert.equal(g.quoteIdent('we"ird'), '"we""ird"');
});

test("SQL builders wrap the edge query and address columns by name", () => {
  const def = { edges_sql: "SELECT * FROM t" };
  const cols = { source: "src", target: "dst" };
  assert.equal(g.countEdgesSql(def), "SELECT count(*) AS edges FROM (SELECT * FROM t) AS e");
  assert.match(g.topNodesSql(def, cols, 5), /e\."src" AS id .*\s+UNION ALL\s+.* e\."dst" AS id .* LIMIT 5$/s);
  assert.match(g.edgesAmongSql(def, cols, [1, "b"]), /e\."src" IN \(1, 'b'\) AND e\."dst" IN \(1, 'b'\)$/);
  assert.match(g.neighborsSql(def, cols, "x", 7), /= 'x' OR e\."dst" = 'x' LIMIT 7$/);
  assert.match(g.edgesTouchingSql(def, cols, [1, 2], 9), /e\."src" IN \(1, 2\) OR e\."dst" IN \(1, 2\) LIMIT 9$/);
  assert.match(g.frontierSql(def, cols, [1], { directed: true, backward: true }), /SELECT e\."dst" AS a, e\."src" AS b .* WHERE e\."dst" IN \(1\)$/);
  assert.match(g.nodesSql({ nodes_sql: "SELECT * FROM n" }, { column: "id", values: [1, 2] }), /WHERE n\."id" IN \(1, 2\)$/);
});

test("edgeRecords reads source, target, weight and extra attributes", () => {
  const recs = g.edgeRecords({
    columns: [{ name: "s" }, { name: "t" }, { name: "Weight" }, { name: "kind" }],
    rows: [[1, 2, "2.5", "a"], [2, null, 1, "b"], [3, 1, "oops", "c"]],
  });
  assert.deepEqual(recs, [
    { source: 1, target: 2, weight: 2.5, attributes: { kind: "a" } },
    { source: 3, target: 1, weight: 1, attributes: { kind: "c" } },
  ]);
  assert.throws(() => g.edgeRecords({ columns: [{ name: "only" }], rows: [] }), /two columns/);
});

test("nodeRecords takes the id, a label column and de-duplicated attributes", () => {
  const recs = g.nodeRecords({
    columns: [{ name: "id" }, { name: "label" }, { name: "id" }, { name: "name" }, { name: "team" }],
    rows: [[1, "Ann", 1, "Ann", 3], [2, null, 2, null, 4]],
  });
  assert.deepEqual(recs, [
    { id: 1, label: "Ann", attributes: { name: "Ann", team: 3 } },
    { id: 2, label: "2", attributes: { name: null, team: 4 } },
  ]);
});

test("clustering coefficient counts connected neighbour pairs", () => {
  // A triangle a-b-c with a tail c-d.
  const adj = { a: ["b", "c"], b: ["a", "c"], c: ["a", "b", "d"], d: ["c"] };
  const cc = g.clusteringCoefficients(Object.keys(adj), (n) => adj[n]);
  assert.deepEqual(cc, { a: 1, b: 1, c: 1 / 3, d: 0 });
});

test("categorize gives the largest categories fixed slots and folds the rest", () => {
  const values = { a: "x", b: "x", c: "x", d: "y", e: "y", f: "z", g: null };
  const { byNode, legend, other } = g.categorize(values, 2);
  assert.deepEqual(legend, [{ category: "x", count: 3, slot: 0 }, { category: "y", count: 2, slot: 1 }]);
  assert.deepEqual(other, { count: 2, categories: 2 });
  assert.equal(byNode.a, 0);
  assert.equal(byNode.d, 1);
  assert.equal(byNode.f, -1);
  assert.equal(byNode.g, -1);
});

test("scale maps numbers to 0..1 and treats a flat metric as the middle", () => {
  assert.deepEqual(g.scale({ a: 2, b: 4, c: 3 }).byNode, { a: 0, b: 1, c: 0.5 });
  assert.deepEqual(g.scale({ a: 5, b: 5 }).byNode, { a: 0.5, b: 0.5 });
  assert.ok(g.isNumeric({ a: 1, b: "2.5" }));
  assert.ok(!g.isNumeric({ a: 1, b: "x" }));
});

// A fake runSql that answers frontierSql queries from an in-memory edge list.
function fakeSql(edgeList) {
  let queries = 0;
  const runSql = async (sql) => {
    queries++;
    const ids = new Set(sql.match(/IN \(([^)]*)\)/)[1].split(", ").map(Number));
    const backward = /SELECT e\."t" AS a/.test(sql);
    const undirected = / OR /.test(sql);
    const rows = [];
    for (const [s, t] of edgeList) {
      if (undirected ? ids.has(s) || ids.has(t) : backward ? ids.has(t) : ids.has(s)) rows.push(backward ? [t, s] : [s, t]);
    }
    return { rows };
  };
  return { runSql, queries: () => queries };
}

const cols = { source: "s", target: "t" };
const def = { edges_sql: "SELECT * FROM edges" };

test("sqlShortestPath finds a shortest directed path from both ends", async () => {
  // 1→2→3→4→5, plus a longer detour 1→6→7→8→9→5.
  const sql = fakeSql([[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 7], [7, 8], [8, 9], [9, 5]]);
  const path = await g.sqlShortestPath({ runSql: sql.runSql, def, columns: cols, from: 1, to: 5, directed: true });
  assert.deepEqual(path, [1, 2, 3, 4, 5]);
  assert.ok(sql.queries() <= 4, `used ${sql.queries()} queries`);
});

test("sqlShortestPath respects direction, or ignores it when undirected", async () => {
  const sql = fakeSql([[2, 1], [3, 2]]);
  assert.equal(await g.sqlShortestPath({ runSql: sql.runSql, def, columns: cols, from: 1, to: 3, directed: true }), null);
  assert.deepEqual(await g.sqlShortestPath({ runSql: sql.runSql, def, columns: cols, from: 1, to: 3, directed: false }), [1, 2, 3]);
  assert.deepEqual(await g.sqlShortestPath({ runSql: sql.runSql, def, columns: cols, from: 4, to: 4, directed: true }), [4]);
});

test("sqlShortestPath says when it stopped at the hop limit rather than claiming no path", async () => {
  const chain = Array.from({ length: 10 }, (_, i) => [i, i + 1]);
  await assert.rejects(
    g.sqlShortestPath({ runSql: fakeSql(chain).runSql, def, columns: cols, from: 0, to: 10, directed: true, maxDepth: 4 }),
    /No path within 4 hops/,
  );
  assert.equal((await g.sqlShortestPath({ runSql: fakeSql(chain).runSql, def, columns: cols, from: 0, to: 10, directed: true })).length, 11);
});

test("sqlShortestPath gives up on runaway frontiers", async () => {
  // 0 fans out to 50 nodes and 999 fans in from 50 others, with no path between the fans.
  const star = Array.from({ length: 50 }, (_, i) => [0, i + 1]).concat(Array.from({ length: 50 }, (_, i) => [200 + i, 999]));
  const sql = fakeSql(star);
  await assert.rejects(
    g.sqlShortestPath({ runSql: sql.runSql, def, columns: cols, from: 0, to: 999, directed: true, maxFrontier: 10 }),
    /reached 50 nodes/,
  );
});

test("saved graphs round-trip through the lake's files", async () => {
  const files = new Map();
  const lake = {
    listDir: async (dir) => {
      if (![...files.keys()].some((p) => p.startsWith(dir))) throw new Error("not found");
      return [...files.keys()].map((path) => ({ path, is_directory: false }));
    },
    readFile: async (path) => new Blob([files.get(path)]),
    uploadFile: async (path, blob) => files.set(path, await blob.text()),
    deleteFile: async (path) => files.delete(path),
  };
  assert.deepEqual(await g.listGraphs(lake), []);
  await g.saveGraph(lake, { name: "b graph", edges_sql: "SELECT 1, 2;", directed: false });
  await g.saveGraph(lake, { name: "a", edges_sql: "SELECT 3, 4" });
  files.set("/pond/graphs/junk.json", "{not json");
  const graphs = await g.listGraphs(lake);
  assert.deepEqual(graphs.map((x) => x.name), ["a", "b graph"]);
  assert.deepEqual(graphs[1], { name: "b graph", edges_sql: "SELECT 1, 2", nodes_sql: null, directed: false });
  assert.ok(files.has("/pond/graphs/b_graph.json"));
  await assert.rejects(g.saveGraph(lake, { edges_sql: "SELECT 1, 2" }), /needs a name/);
  await g.deleteGraph(lake, "a");
  assert.deepEqual((await g.listGraphs(lake)).map((x) => x.name), ["b graph"]);
});
