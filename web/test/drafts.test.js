import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft } from "../static/drafts.js";
import { shellQuote } from "../static/dom.js";

const values = new Map();
globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };

test("upgrading a query draft keeps text stored by the previous version", () => {
  values.set("legacy-query", JSON.stringify("SELECT 'keep this draft'"));
  const draft = createDraft("legacy-query", "", { savedId: null });
  assert.equal(draft.value, "SELECT 'keep this draft'");
  assert.equal(draft.dirty, true);
  draft.change("SELECT 'changed draft'");
  assert.equal(createDraft("legacy-query", "").value, "SELECT 'changed draft'");
});

test("reload keeps saved identity, unsaved text and its conflict baseline", () => {
  const draft = createDraft("query-1", "", { savedId: null });
  draft.saved("SELECT 1", { savedId: "saved-7", name: "Count" });
  draft.change("SELECT 2");
  const restored = createDraft("query-1", "");
  assert.equal(restored.value, "SELECT 2");
  assert.equal(restored.identity.savedId, "saved-7");
  assert.equal(restored.dirty, true);
  assert.equal(restored.conflicts("SELECT 1"), false);
  assert.equal(restored.conflicts("SELECT 3"), true);
});

test("job source and parameters survive a new view without changing the saved base", () => {
  const initial = { source: "print(1)", parameters: "a" };
  const draft = createDraft("project-a/job-1", initial);
  draft.change({ source: "print(2)", parameters: "b" });
  assert.deepEqual(createDraft("project-a/job-1", initial).value, { source: "print(2)", parameters: "b" });
  assert.deepEqual(createDraft("project-b/job-1", initial).value, initial);
  draft.saved(draft.value);
  assert.equal(createDraft("project-a/job-1", initial).dirty, false);
});

test("project paths are quoted as one shell argument", () => {
  assert.equal(shellQuote("/a project/it's $data`"), "'/a project/it'\"'\"'s $data`'");
});
