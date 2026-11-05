// Unit tests for the MiniLake client. Run with: node --test web/test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as lake from "../static/lake.js";

// A fetch stand-in: routes map "METHOD /path" prefixes to responses; every call is recorded.
let calls;
let routes;
beforeEach(() => {
  calls = [];
  routes = {};
  globalThis.fetch = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    const [status, data] = key ? routes[key](body, path) : [404, { message: `no route ${method} ${path}` }];
    return new Response(typeof data === "string" ? data : JSON.stringify(data), { status });
  };
});

test("query history separates background statements without deleting them", async () => {
  routes["GET /api/2.0/sql/history/queries"] = () => [200, { res: [
    { query_text: "/* pond:system */ SELECT 1" }, { query_text: "SELECT 2" }, { query_text: "SELECT 3" },
  ] }];
  assert.deepEqual((await lake.queryHistory(1)).map((row) => row.query_text), ["SELECT 2"]);
  assert.equal((await lake.queryHistory(3, { includeBackground: true })).length, 3);
});

test("foreground SQL invalidates cached counts while background counts do not", async () => {
  const client = lake.createLake();
  routes["GET /pond/config"] = () => [200, { warehouse_id: "w" }];
  routes["POST /api/2.0/sql/statements"] = () => [200, { status: { state: "SUCCEEDED" } }];
  const initial = client.dataVersion;
  await client.runSql("/* pond:system */ SELECT count(*) FROM a.b.c");
  assert.equal(client.dataVersion, initial);
  await client.runSql("INSERT INTO a.b.c VALUES (1)");
  assert.ok(client.dataVersion > initial);
});

test("first import creates its namespace and retries without overwriting a staged file", async () => {
  const catalogs = [], schemas = [], volumes = [];
  const client = lake.createLake();
  routes["GET /pond/config"] = () => [200, { warehouse_id: "w", data_root: "/data" }];
  routes["GET /api/2.1/unity-catalog/catalogs"] = () => [200, { catalogs }];
  routes["POST /api/2.1/unity-catalog/catalogs"] = (body) => { catalogs.push(body); return [200, body]; };
  routes["GET /api/2.1/unity-catalog/schemas"] = () => [200, { schemas }];
  routes["POST /api/2.1/unity-catalog/schemas"] = (body) => { schemas.push(body); return [200, body]; };
  routes["GET /api/2.1/unity-catalog/volumes"] = () => [200, { volumes }];
  routes["POST /api/2.1/unity-catalog/volumes"] = (body) => { volumes.push(body); return [200, body]; };
  let fail = true;
  routes["PUT /api/2.0/fs/files/"] = () => fail ? [503, { message: "Upload interrupted" }] : [200, {}];
  routes["POST /api/2.0/sql/statements"] = () => [200, { status: { state: "SUCCEEDED" }, result: { data_array: [[2]] } }];
  const opts = { data: new Blob(["id\n1\n2\n"]), fileName: "people.csv", catalog: "main", schema: "raw", table: "people" };
  await assert.rejects(client.importFile(opts), /Upload interrupted/);
  fail = false;
  const result = await client.importFile(opts);
  assert.equal(result.table, "main.raw.people");
  assert.equal(result.rows, 2);
  assert.equal(catalogs.length, 1);
  assert.equal(schemas.length, 1);
  assert.equal(volumes.length, 1);
  const uploads = calls.filter((c) => c.method === "PUT");
  assert.notEqual(uploads[0].path, uploads[1].path);
  assert.match(uploads[1].path, /people\.csv\?overwrite=false$/);
  assert.ok(calls.find((c) => c.body?.statement?.startsWith("CREATE TABLE `main`.`raw`.`people`")));
  assert.ok(calls.find((c) => c.body?.statement?.includes("read_csv_auto('/data/volumes/main/raw/imports/")));
});

test("external file queries discover the service root and distinguish volumes from DBFS", async () => {
  const client = lake.createLake();
  routes["GET /pond/config"] = () => [200, { warehouse_id: "external" }];
  routes["POST /api/2.0/sql/statements"] = () => [200, { status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [{ name: "seq" }, { name: "name" }, { name: "file" }] } }, result: { data_array: [[1, "unity_catalog", "/service/lake/unity_catalog.duckdb"]] } }];
  assert.equal(await client.sqlPath("/Volumes/demo/raw/files/a.csv"), "/service/lake/volumes/demo/raw/files/a.csv");
  assert.equal(await client.sqlPath("/pond/a.csv"), "/service/lake/dbfs/pond/a.csv");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("readHead asks DBFS for only the bytes it needs", async () => {
  routes["GET /api/2.0/dbfs/get-status"] = () => [200, { file_size: 10 }];
  routes["GET /api/2.0/dbfs/read"] = () => [200, { bytes_read: 4, data: btoa("abcd") }];
  assert.deepEqual(await lake.readHead("/Volumes/a b/x.txt", 4), { size: 10, truncated: true, text: "abcd" });
  const read = calls.find((c) => c.path.startsWith("/api/2.0/dbfs/read"));
  assert.equal(read.path, "/api/2.0/dbfs/read?path=%2FVolumes%2Fa+b%2Fx.txt&offset=0&length=4");
});

test("listJobs follows next_page_token", async () => {
  routes["GET /api/2.2/jobs/list"] = (_, path) =>
    path.includes("page_token=p2") ? [200, { jobs: [{ job_id: 2 }] }] : [200, { jobs: [{ job_id: 1 }], next_page_token: "p2" }];
  assert.deepEqual((await lake.listJobs()).map((j) => j.job_id), [1, 2]);
});

test("quoteName backtick-quotes each part and escapes backticks", () => {
  assert.equal(lake.quoteName("shop.raw.orders"), "`shop`.`raw`.`orders`");
  assert.equal(lake.quoteName("a`b.c"), "`a``b`.`c`");
});

test("formatOf and tableNameFor read file names", () => {
  assert.equal(lake.formatOf("orders.CSV"), "csv");
  assert.equal(lake.formatOf("events.jsonl"), "jsonl");
  assert.equal(lake.formatOf("notes.txt"), null);
  assert.match(lake.tableNameFor("Q1 Sales-2024.csv"), /^[a-z0-9_]+$/);
});

test("volumePath and scriptPath build lake paths", () => {
  assert.equal(lake.volumePath("shop.raw.imports"), "/Volumes/shop/raw/imports");
  assert.equal(lake.scriptPath("my job.py"), "/Shared/pond/my_job.py");
});

test("isRunDone recognises terminal states", () => {
  for (const s of ["TERMINATED", "SKIPPED", "INTERNAL_ERROR"]) assert.ok(lake.isRunDone({ state: { life_cycle_state: s } }));
  assert.ok(!lake.isRunDone({ state: { life_cycle_state: "RUNNING" } }));
  assert.ok(!lake.isRunDone(undefined));
});

test("runSql polls until the statement finishes and maps the result", async () => {
  let polls = 0;
  routes["GET /pond/config"] = () => [200, { warehouse_id: "wh1" }];
  routes["POST /api/2.0/sql/statements"] = () => [200, { statement_id: "s1", status: { state: "RUNNING" } }];
  routes["GET /api/2.0/sql/statements/s1"] = () =>
    ++polls < 2
      ? [200, { statement_id: "s1", status: { state: "RUNNING" } }]
      : [200, {
          statement_id: "s1",
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [{ name: "n", type_text: "BIGINT" }] } },
          result: { data_array: [["3"]] },
        }];
  await lake.config({ refresh: true });
  const res = await lake.runSql("SELECT 3 AS n");
  assert.deepEqual(res.columns, [{ name: "n", type: "BIGINT" }]);
  assert.deepEqual(res.rows, [["3"]]);
  assert.equal(res.truncated, false);
  assert.equal(calls.find((c) => c.method === "POST").body.warehouse_id, "wh1");
});

test("runSql surfaces MiniLake's error message and code", async () => {
  routes["GET /pond/config"] = () => [200, { warehouse_id: "wh1" }];
  routes["POST /api/2.0/sql/statements"] = () => [400, { error_code: "INVALID_REQUEST", message: "Parser Error: nope" }];
  await lake.config({ refresh: true });
  await assert.rejects(lake.runSql("SELEC 1"), (err) => err instanceof lake.LakeError && err.message === "Parser Error: nope" && err.code === "INVALID_REQUEST");
});

test("runSql follows result chunks and preserves large integer ids", async () => {
  routes["GET /pond/config"] = () => [200, { warehouse_id: "w" }];
  routes["POST /api/2.0/sql/statements"] = () => [200, '{"statement_id":"s","status":{"state":"SUCCEEDED"},"manifest":{"total_row_count":2,"schema":{"columns":[{"name":"id","type_text":"BIGINT"}]}},"result":{"data_array":[[9007199254740993]],"next_chunk_index":1}}'];
  routes["GET /api/2.0/sql/statements/s/result/chunks/1"] = () => [200, '{"data_array":[[9007199254740995]]}'];
  await lake.config({ refresh: true });
  const result = await lake.runSql("SELECT id FROM t");
  assert.deepEqual(result.rows, [["9007199254740993"], ["9007199254740995"]]);
  assert.equal(result.truncated, false);
  routes["GET /api/2.0/sql/statements/s/result/chunks/1"] = () => [200, { data_array: [], truncated: true }];
  assert.equal((await lake.runSql("SELECT id FROM t")).truncated, true);
});

test("runSql sends CREATE CATALOG and CREATE SCHEMA to Unity Catalog", async () => {
  const catalogs = [];
  const schemas = [];
  routes["GET /api/2.1/unity-catalog/catalogs"] = () => [200, { catalogs: catalogs.map((name) => ({ name })) }];
  routes["POST /api/2.1/unity-catalog/catalogs"] = (b) => (catalogs.push(b.name), [200, {}]);
  routes["GET /api/2.1/unity-catalog/schemas"] = () => [200, { schemas: schemas.map((full) => ({ name: full.split(".")[1] })) }];
  routes["POST /api/2.1/unity-catalog/schemas"] = (b) => (schemas.push(`${b.catalog_name}.${b.name}`), [200, {}]);
  await lake.runSql("-- set up\nCREATE CATALOG IF NOT EXISTS shop;");
  await lake.runSql("create catalog if not exists shop");
  await lake.runSql("CREATE SCHEMA `shop`.raw");
  const res = await lake.runSql("CREATE SCHEMA IF NOT EXISTS shop.raw");
  assert.deepEqual(catalogs, ["shop"]);
  assert.deepEqual(schemas, ["shop.raw"]);
  assert.deepEqual(res.rows, []);
  assert.ok(!calls.some((c) => c.path === "/api/2.0/sql/statements"), "no SQL was sent");
});

test("runSql without a warehouse reports why", async () => {
  routes["GET /pond/config"] = () => [200, { warehouse_id: null, error: "MiniLake unreachable" }];
  await lake.config({ refresh: true });
  await assert.rejects(lake.runSql("SELECT 1"), { message: "MiniLake unreachable", code: "NO_WAREHOUSE" });
});

test("config is cached until refreshed, and a failure is not cached", async () => {
  let n = 0;
  routes["GET /pond/config"] = () => (++n === 1 ? [502, { message: "down" }] : [200, { warehouse_id: `wh${n}` }]);
  await assert.rejects(lake.config({ refresh: true }));
  assert.equal((await lake.config()).warehouse_id, "wh2");
  assert.equal((await lake.config()).warehouse_id, "wh2");
  assert.equal((await lake.config({ refresh: true })).warehouse_id, "wh3");
});

test("file API paths encode each segment but keep slashes", async () => {
  routes["GET /api/2.0/fs/directories/"] = () => [200, { contents: [] }];
  await lake.listDir("/Volumes/shop/raw/my files#1");
  assert.equal(calls[0].path, "/api/2.0/fs/directories/Volumes/shop/raw/my%20files%231");
});

test("importWorkspace sends UTF-8 source as base64", async () => {
  routes["POST /api/2.0/workspace/mkdirs"] = () => [200, {}];
  routes["POST /api/2.0/workspace/import"] = () => [200, {}];
  await lake.importWorkspace("/Shared/pond/hej.py", "print('hej då')");
  const body = calls.find((c) => c.path.endsWith("/import")).body;
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "print('hej då')");
  assert.equal(calls[0].body.path, "/Shared/pond");
});

test("a client for another context prefixes its requests with that context's path", async () => {
  const { createLake } = await import("../static/lake.js");
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    seen.push(path);
    return new Response(JSON.stringify({ catalogs: [{ name: "c" }] }), { status: 200 });
  };
  try {
    const other = createLake("/ctx/shop-1");
    assert.deepEqual((await other.listCatalogs()).map((c) => c.name), ["c"]);
    await other.config();
    assert.deepEqual(seen, ["/ctx/shop-1/api/2.1/unity-catalog/catalogs", "/ctx/shop-1/pond/config"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
