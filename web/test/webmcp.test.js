// Unit tests for the WebMCP tool definitions. Run with: node --test web/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTools, registerWebMcp, isDestructiveSql } from "../static/webmcp.js";
import * as lake from "../static/lake.js";

// A stand-in for the page: tools only reach the UI through this object.
function fakeUi({ confirm = true } = {}) {
  const log = [];
  const nav = [];
  const ui = {
    lake,
    log,
    nav,
    navigate: (view) => nav.push(view),
    refreshTree: async () => {},
    snapshot: () => ({ view: "data" }),
    logAgent: (name, _input, error) => log.push({ name, error }),
    views: {
      data: { dropObject: async () => confirm, open: async () => {} },
      query: {},
      files: { remove: async () => confirm },
      admin: { resetLake: async () => confirm },
    },
  };
  return ui;
}

const tools = buildTools(fakeUi());

test("every tool has a unique snake_case name, a description and an object schema", () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  for (const t of tools) {
    assert.match(t.name, /^[a-z]+(_[a-z]+)*$/, t.name);
    assert.ok(t.description?.length > 10, `${t.name} needs a description`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} schema`);
    for (const key of t.inputSchema.required ?? []) {
      assert.ok(key in (t.inputSchema.properties ?? {}), `${t.name} requires undeclared ${key}`);
    }
    assert.equal(typeof t.execute, "function");
  }
});

test("tools that can destroy data are marked destructive, and none of them read-only", () => {
  const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
  // run_sql can modify data; the other three also ask the user first.
  assert.deepEqual(destructive, ["delete_path", "drop_object", "reset_lake", "run_sql"]);
  for (const t of tools) assert.ok(!(t.annotations?.destructiveHint && t.annotations?.readOnlyHint), t.name);
});

test("destructive tools fail with 'The user declined.' when the user cancels", async () => {
  const declined = buildTools(fakeUi({ confirm: false }));
  const byName = Object.fromEntries(declined.map((t) => [t.name, t]));
  await assert.rejects(byName.drop_object.execute({ kind: "table", full_name: "a.b.c" }), { message: "The user declined." });
  await assert.rejects(byName.reset_lake.execute({}), { message: "The user declined." });
});

test("destructive tools wait for requestUserInteraction when the agent offers it", async () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  let asked = 0;
  const client = { requestUserInteraction: async (fn) => (asked++, fn()) };
  assert.equal(await byName.reset_lake.execute({}, client), "The lake was reset.");
  assert.equal(asked, 1);
});

test("isDestructiveSql spots statements that delete or replace data, wherever they hide", () => {
  for (const sql of [
    "DROP TABLE a", "  delete from a", "-- tidy up\nTRUNCATE a", "/* x */ CREATE OR REPLACE TABLE a AS SELECT 1",
    "insert  overwrite a select 1", "INSERT OR REPLACE INTO a VALUES (1)", "SELECT 1; DROP TABLE t",
    "WITH x AS (SELECT 1) DELETE FROM t", "CREATE /* c */ OR REPLACE TABLE a AS SELECT 1", "EXPLAIN ANALYZE DELETE FROM t",
    "ALTER TABLE a DROP COLUMN b", "/* a /* nested */ comment */ DROP TABLE a",
  ]) {
    assert.ok(isDestructiveSql(sql), sql);
  }
  // Analysis and schema changes that keep data run without asking.
  for (const sql of [
    "SELECT 1", "CREATE TABLE a (b INT)", "INSERT INTO a VALUES (1)", "UPDATE a SET b = 1", "ALTER TABLE a ADD COLUMN c INT",
    "-- drop table a\nSELECT 1", "SELECT 'drop table a; delete' AS note", 'SELECT "delete" FROM a', "SELECT deleted, dropped FROM a;",
  ]) {
    assert.ok(!isDestructiveSql(sql), sql);
  }
});

test("overwriting tools ask first, and stop when the user declines", async () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const decline = { requestUserInteraction: async () => false };
  const realFetch = globalThis.fetch;
  let wrote = false;
  globalThis.fetch = async (_path, init = {}) => {
    if ((init.method ?? "GET") === "PUT") wrote = true;
    return new Response(JSON.stringify({ path: "/a.txt", file_size: 3 }), { status: 200 }); // the file exists
  };
  try {
    await assert.rejects(byName.write_file.execute({ path: "/a.txt", content: "new" }, decline), { message: "The user declined." });
    assert.equal(wrote, false);
    await assert.rejects(byName.import_data.execute({ catalog: "c", schema: "s", table: "t", file_name: "../x.csv", content: "a" }), /plain file name/);
    await assert.rejects(byName.drop_object.execute({ kind: "database", full_name: "a" }), /kind must be/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("graph tools validate their input before touching the page", async () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await assert.rejects(byName.open_graph.execute({}), { message: "Give either name or edges_sql." });
  assert.deepEqual(byName.graph_metrics.inputSchema.properties.metric.enum.slice(0, 2), ["degree", "in_degree"]);
  assert.ok(byName.graph_metrics.inputSchema.properties.metric.enum.includes("community"));
});

test("registration wraps tools in MCP content and logs every call", async () => {
  const registered = [];
  globalThis.window = {};
  Object.defineProperty(globalThis.navigator, "modelContext", {
    value: { registerTool: (t) => registered.push(t) },
    configurable: true,
  });
  const ui = fakeUi({ confirm: false });
  const res = registerWebMcp(ui);
  assert.equal(res.ok, true);
  assert.equal(registered.length, tools.length);
  assert.ok(window.pond.tools.get_view);

  const out = await window.pond.tools.reset_lake.execute({});
  assert.equal(out.isError, true);
  assert.deepEqual(out.content, [{ type: "text", text: "The user declined." }]);
  assert.deepEqual(ui.log, [{ name: "reset_lake", error: "The user declined." }]);
});

test("without navigator.modelContext, tools stay on window.pond.tools", () => {
  Object.defineProperty(globalThis.navigator, "modelContext", { value: undefined, configurable: true });
  globalThis.window = {};
  const res = registerWebMcp(fakeUi());
  assert.equal(res.ok, false);
  assert.equal(Object.keys(window.pond.tools).length, tools.length);
});

test("the README's WebMCP table lists exactly these tools", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("### WebMCP")[1].split("\n## ")[0];
  const table = section.split("\n").filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith("| Area"));
  const documented = table.flatMap((l) => [...l.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])).sort();
  assert.deepEqual(documented, tools.map((t) => t.name).sort());
});
