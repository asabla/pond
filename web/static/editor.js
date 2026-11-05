// @ts-check
// A small code editor: a textarea with a highlighted copy of its text behind it, and line
// numbers. It needs no library, so it works offline and without a build step.
import { h } from "./dom.js";

let editorSeq = 0;

const SQL_KEYWORDS = new Set(`select from where group by order having limit offset join left right inner outer full cross on using
as and or not in is null like ilike between case when then else end distinct union all intersect except with recursive
insert into values update set delete create replace table view schema catalog drop alter add column if exists
primary key references default copy to format describe show explain analyze qualify over partition window rows range
asc desc nulls first last true false cast try_cast interval filter within pivot unpivot struct map list array
truncate merge matched attach detach use pragma install load returning lateral natural semi anti asof`.split(/\s+/));

const PY_KEYWORDS = new Set(`False None True and as assert async await break class continue def del elif else except
finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case`.split(/\s+/));

const SQL_TOKENS = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/g;
const PY_TOKENS = /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[rbfu]*"(?:[^"\\\n]|\\.)*"?|[rbfu]*'(?:[^'\\\n]|\\.)*'?)|(@\w+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/g;

/**
 * Splits code into highlighted spans.
 * @param {string} code
 * @param {"sql" | "python"} language
 * @returns {(string | HTMLElement)[]}
 */
export function highlight(code, language) {
  const out = [];
  const re = language === "python" ? PY_TOKENS : SQL_TOKENS;
  const keywords = language === "python" ? PY_KEYWORDS : SQL_KEYWORDS;
  let at = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > at) out.push(code.slice(at, m.index));
    const [text, comment, string, third, number, call, word] = m;
    let kind = null;
    if (comment) kind = "comment";
    else if (string) kind = "string";
    else if (third) kind = language === "python" ? "decorator" : "ident";
    else if (number) kind = "number";
    else if (call) kind = keywords.has(language === "sql" ? call.toLowerCase() : call) ? "keyword" : "function";
    else if (word && keywords.has(language === "sql" ? word.toLowerCase() : word)) kind = "keyword";
    out.push(kind ? h("span", { class: `tok-${kind}` }, text) : text);
    at = m.index + text.length;
  }
  if (at < code.length) out.push(code.slice(at));
  return out;
}

/**
 * @param {{ language: "sql" | "python", value?: string, placeholder?: string, label: string, className?: string }} opts
 */
export function createCodeEditor({ language, value = "", placeholder, label, className = "" }) {
  const helpId = `editor-help-${++editorSeq}`;
  const input = /** @type {HTMLTextAreaElement} */ (h("textarea", {
    class: "code-input", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": label, "aria-describedby": helpId, placeholder, wrap: "off",
  }));
  const code = h("code", {});
  const layer = h("pre", { class: "code-layer", "aria-hidden": "true" }, code);
  const gutter = h("div", { class: "code-gutter", "aria-hidden": "true" });
  const el = h("div", { class: `code-editor ${className}` }, gutter, h("div", { class: "code-area" }, layer, input),
    h("span", { class: "sr-only", id: helpId }, "Tab inserts indentation. Press Escape, then Tab to move to the next control. Shift+Tab moves to the previous control."));

  let lines = 0;
  function refresh() {
    // A trailing newline needs a character after it, or the layer is a line short.
    code.replaceChildren(...highlight(input.value, language), "\n");
    const n = input.value.split("\n").length;
    if (n !== lines) {
      lines = n;
      gutter.replaceChildren(...Array.from({ length: n }, (_, i) => h("span", {}, String(i + 1))));
    }
    sync();
  }
  function sync() {
    layer.scrollTop = input.scrollTop;
    layer.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  }

  input.addEventListener("input", refresh);
  input.addEventListener("scroll", sync);
  let leaveEditor = false;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { leaveEditor = true; return; }
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (leaveEditor) { leaveEditor = false; return; }
      e.preventDefault();
      input.setRangeText(language === "python" ? "    " : "  ", input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    leaveEditor = false;
  });
  input.value = value;
  refresh();

  return {
    el,
    input,
    refresh,
    get value() {
      return input.value;
    },
    set value(v) {
      input.value = v;
      refresh();
    },
    focus: () => input.focus(),
  };
}
