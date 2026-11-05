import { test } from "node:test";
import assert from "node:assert/strict";
import { queryTitle } from "../static/overview-model.js";
import { mcpSetup } from "../static/mcp-connect.js";

test("history titles describe the operation and table without exposing raw SQL", () => {
  assert.equal(queryTitle("WITH counts AS (SELECT id FROM demo.raw.people) SELECT * FROM counts"), "Read people");
  assert.equal(queryTitle("SELECT count(*) FROM `demo`.`raw`.`people`"), "Count people");
  assert.equal(queryTitle("CREATE OR REPLACE TABLE demo.raw.people AS SELECT 1"), "Create table people");
  assert.equal(queryTitle("SELECT 'from fake_table' AS note -- FROM another_fake\n"), "Select values");
  assert.equal(queryTitle('SELECT * FROM "demo"."raw"."Team members"'), "Read Team members");
  assert.equal(queryTitle("SELECT 1; DELETE FROM demo.raw.people"), "Select values · 2 statements");
});

test("harness setup preserves the selected workspace URL in each client format", () => {
  const url = "http://localhost:8701/mcp";
  assert.match(mcpSetup("codex", "shop", url).text, /^codex mcp add 'pond-shop' --url 'http:\/\/localhost:8701\/mcp'$/);
  assert.match(mcpSetup("claude", "shop", url).text, /^claude mcp add --transport http 'pond-shop'/);
  assert.deepEqual(JSON.parse(mcpSetup("cursor", "shop", url).text), { mcpServers: { "pond-shop": { url } } });
  assert.deepEqual(JSON.parse(mcpSetup("vscode", "shop", url).text), { servers: { "pond-shop": { type: "http", url } } });
  assert.equal(mcpSetup("url", "shop", url).text, url);
  assert.ok(mcpSetup("codex", "odd name", "http://host/it's").text.includes("it'\"'\"'s"));
});
