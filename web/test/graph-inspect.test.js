import test from "node:test";
import assert from "node:assert/strict";
import { relationshipsSql, relationshipLabel, propertyText, distanceToConnection } from "../static/graph-inspect.js";

const columns = [{ name: "from" }, { name: "to" }, { name: "relationship" }, { name: 'evidence"note' }];

test("relationship inspection retains rows and properties, including reverse undirected rows", () => {
  const def = { edges_sql: "SELECT * FROM evidence -- original rows", directed: false };
  const sql = relationshipsSql(def, columns, { pair: ["O'Brien", "work:3"] });
  assert.match(sql, /original rows\n\) AS e/);
  assert.match(sql, /e\."from" = 'O''Brien' AND e\."to" = 'work:3'/);
  assert.match(sql, /OR \(e\."from" = 'work:3' AND e\."to" = 'O''Brien'\)/);
  assert.match(sql, /LIMIT 1001$/);
  assert.doesNotMatch(sql, /GROUP BY|DISTINCT/);
  assert.doesNotMatch(relationshipsSql({ ...def, directed: true }, columns, { pair: [1, 2] }), / OR /);
});

test("relationship search covers properties in SQL before limiting rows and quotes literal text", () => {
  const sql = relationshipsSql({ edges_sql: "SELECT * FROM t" }, columns, { node: 42, search: "100% O'Brien" });
  assert.match(sql, /e\."from" = 42 OR e\."to" = 42/);
  assert.match(sql, /e\."evidence""note" AS VARCHAR/);
  assert.match(sql, /lower\('100% O''Brien'\)/);
  assert.ok(sql.indexOf("contains") < sql.indexOf("LIMIT"));
  assert.doesNotMatch(relationshipsSql({ edges_sql: "SELECT * FROM t" }, columns, {}, null), /LIMIT/);
});

test("relationship labels and nested properties retain readable data", () => {
  assert.equal(relationshipLabel(columns, [1, 2, "ACTED_IN", "credit"]), "ACTED_IN");
  assert.equal(relationshipLabel(columns, [1, 2, null, null]), "Relationship");
  assert.equal(propertyText({ source: "credits", verified: true }), '{\n  "source": "credits",\n  "verified": true\n}');
  assert.equal(propertyText(false), "false");
  assert.equal(propertyText(null), "null");
});

test("connection selection uses a bounded line segment, including zero-length connections", () => {
  assert.equal(distanceToConnection({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distanceToConnection({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distanceToConnection({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
});
