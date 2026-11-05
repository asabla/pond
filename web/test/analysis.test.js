import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("shared analysis covers all metrics, groups and graph edge cases", () => {
  const sandbox = vm.createContext({ DOMParser: function () {}, Document: function () {} });
  for (const file of ["../static/vendor/graphology.umd.min.js", "../static/vendor/graphology-library.min.js", "../static/graph-core.js", "analysis-fixture.js"]) {
    vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), sandbox);
  }
  const results = JSON.parse(vm.runInContext("JSON.stringify(runGraphFixtures())", sandbox));
  assert.equal(results[0].stats.nodes, 4);
  assert.equal(results[0].stats.edges, 4);
  assert.equal(results[0].stats.components, 2);
  assert.equal(results[0].path, null);
  assert.equal(results[1].path.hops, 2);
  assert.equal(results[2].neighbors.node, "9007199254740993");
  assert.equal(results[3].stats.nodes, 0);
  assert.equal(results[4].path.error, "Error");
  assert.equal(results[5].metrics.eigenvector.error, "Error");
});
