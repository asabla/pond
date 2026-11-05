import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { statements, isMultiStatement, changesCatalog } from "../static/sql.js";

test("statements split on semicolons outside quotes and comments", () => {
  assert.deepEqual(statements("select 1; select 'a;b' -- c;d\n; /* e; */"), [["select", "1"], ["select", "'…'"]]);
  assert.deepEqual(statements(`select "x;y", 'it''s; fine'`), [["select", '"…"', "'…'"]]);
  assert.equal(isMultiStatement("SELECT 1;  "), false);
  assert.equal(isMultiStatement("SELECT 1) AS e; DROP TABLE x; SELECT * FROM (SELECT 1"), true);
});

test("changesCatalog sees DDL past leading comments", () => {
  assert.ok(changesCatalog("-- note\nCREATE TABLE a (b INT)"));
  assert.ok(changesCatalog("SELECT 1; DROP TABLE a"));
  assert.ok(!changesCatalog("SELECT 'create'"));
});

// Browsers compile pattern attributes with the v flag and silently skip ones that don't
// compile, so a broken pattern means no validation at all.
test("every form pattern compiles the way browsers compile it", () => {
  const dir = new URL("../static/views/", import.meta.url);
  let checked = 0;
  for (const file of readdirSync(dir)) {
    const src = readFileSync(new URL(file, dir), "utf8");
    for (const m of src.matchAll(/pattern: "((?:[^"\\]|\\.)*)"/g)) {
      const pattern = JSON.parse(`"${m[1]}"`);
      assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, "v"), `${file}: ${pattern}`);
      checked++;
    }
  }
  assert.ok(checked >= 5);
});
