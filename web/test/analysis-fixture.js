// Shared acceptance fixtures for the browser engine and embedded Go runtime.
globalThis.runGraphFixtures = function () {
  const core = globalThis.pondGraphCore, Graph = globalThis.graphology, lib = globalThis.graphologyLibrary;
  const cases = [
    { directed: true, rows: [["a", "b", 2], ["b", "c", 1], ["c", "a", 1], ["a", "b", 3], ["c", "c", 0]], nodes: ["a", "b", "c", "isolated"] },
    { directed: false, rows: [["a", "b", 1], ["b", "c", 1], ["c", "a", 1], ["c", "d", 2], ["c", "c", 1]], nodes: ["a", "b", "c", "d"] },
    { directed: true, rows: [["9007199254740993", "9007199254740995", null], ["9007199254740995", "9007199254740993", "invalid"]], nodes: ["9007199254740993", "9007199254740995"] },
    { directed: true, rows: [], nodes: [] },
    { directed: true, rows: [["a", "b", -1], ["b", "a", 1]], nodes: ["a", "b"] },
    { directed: true, rows: [["a", "b", 1], ["b", "c", 1]], nodes: ["a", "b", "c"] },
  ];
  const attempt = (fn) => { try { return fn(); } catch (err) { return { error: err.name }; } };
  return cases.map((fixture) => {
    const g = core.createGraph(Graph, fixture.directed);
    core.addEdges(g, core.edgeRecords({ columns: [{ name: "source" }, { name: "target" }, { name: "weight" }], rows: fixture.rows }), true);
    core.addNodes(g, fixture.nodes.map((id) => ({ id, label: id, attributes: { team: id === "a" ? "one" : "two" } })), false);
    const result = { stats: core.stats(g, lib, true), metrics: {}, groups: {} };
    for (const metric of Object.keys(core.METRICS)) result.metrics[metric] = attempt(() => core.ranking(g, lib, metric, true, 100));
    for (const grouping of [...Object.keys(core.GROUPINGS), "attr:team"]) result.groups[grouping] = attempt(() => ({ ...core.grouping(g, lib, grouping, true), ranking: core.ranking(g, lib, grouping, true, 100) }));
    if (fixture.nodes.length) {
      const a = fixture.nodes[0], b = fixture.nodes.at(-1);
      result.neighbors = core.neighbors(g, a);
      result.path = attempt(() => core.shortestPath(g, lib, a, b, true));
      result.unweighted_path = core.shortestPath(g, lib, a, b, false);
      result.same_node = core.shortestPath(g, lib, a, a, false);
    }
    return result;
  });
};
