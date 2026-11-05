import { test } from "node:test";
import assert from "node:assert/strict";

// highlight() builds spans with dom.js's h(); a minimal document is enough for it.
globalThis.document ??= {
  createElement: (tag) => ({
    tag, children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { this.children.push(...c); },
    addEventListener() {},
    get textContent() { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); },
  }),
  createTextNode: (t) => t,
};
const { highlight } = await import("../static/editor.js");

const kinds = (parts) => parts.filter((p) => typeof p !== "string").map((p) => `${p.className}:${p.textContent}`);

test("SQL keywords, strings, numbers, comments and calls get their own spans", () => {
  const parts = highlight("select count(*), 'it''s' -- note\nFROM t LIMIT 10", "sql");
  assert.deepEqual(kinds(parts), ["tok-keyword:select", "tok-function:count", "tok-string:'it''s'", "tok-comment:-- note", "tok-keyword:FROM", "tok-keyword:LIMIT", "tok-number:10"]);
  // Nothing is lost: the spans and the plain text between them add up to the source.
  assert.equal(parts.map((p) => (typeof p === "string" ? p : p.textContent)).join(""), "select count(*), 'it''s' -- note\nFROM t LIMIT 10");
});

test("Python keywords, decorators and strings", () => {
  const parts = highlight("@udf\ndef f(x):\n    return \"a#b\"  # done", "python");
  assert.deepEqual(kinds(parts), ["tok-decorator:@udf", "tok-keyword:def", "tok-function:f", "tok-keyword:return", "tok-string:\"a#b\"", "tok-comment:# done"]);
});

test("an unfinished string or comment highlights to the end instead of breaking", () => {
  assert.deepEqual(kinds(highlight("SELECT 'open", "sql")), ["tok-keyword:SELECT", "tok-string:'open"]);
  assert.deepEqual(kinds(highlight("/* open", "sql")), ["tok-comment:/* open"]);
});
