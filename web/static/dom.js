// Shared DOM helpers. No framework: views rebuild their part of the page from state.

export const $ = (sel, root = document) => root.querySelector(sel);

// h("div", { class: "x", onclick }, child, "text", [more]) — falsy children are skipped.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function toast(text, kind) {
  const stack = $("#toasts");
  stack.append(h("div", { class: `toast ${kind ?? ""}` }, text));
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => stack.firstElementChild?.remove(), 3500);
}

export const loading = (text) => h("div", { class: "empty" }, h("span", { class: "loading" }), text ? ` ${text}` : null);
export const empty = (...children) => h("div", { class: "empty" }, ...children);
export const errorBox = (message) => h("div", { class: "error" }, message);

export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "—");
export function fmtBytes(n) {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${i ? n.toFixed(1) : n} ${units[i]}`;
}
export function fmtDuration(ms) {
  if (ms == null || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const NUMERIC = /^(TINYINT|SMALLINT|INT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|LONG|SHORT|BYTE|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i;

export function grid({ columns, rows }, { max = 1000 } = {}) {
  const numeric = columns.map((c) => NUMERIC.test(c.type || ""));
  return h("div", { class: "grid-wrap" },
    h("table", { class: "grid" },
      h("thead", {}, h("tr", {},
        h("th", { class: "rownum" }, "#"),
        columns.map((c) => h("th", { title: `${c.name} ${c.type ?? ""}` }, c.name, h("small", {}, (c.type || "").toLowerCase()))))),
      h("tbody", {}, rows.slice(0, max).map((row, i) => h("tr", {},
        h("td", { class: "rownum" }, String(i + 1)),
        row.map((v, j) => v === null
          ? h("td", { class: "null" }, "null")
          : h("td", { class: numeric[j] ? "num" : null, title: String(v).length > 40 ? String(v) : null }, String(v))))))));
}

// Simple key/value table for lists of objects: cols = [[label, row => node|string], ...].
export function table(rows, cols, { onRow, empty: emptyText = "Nothing here yet." } = {}) {
  if (!rows.length) return empty(emptyText);
  return h("div", { class: "grid-wrap" }, h("table", { class: "grid list" },
    h("thead", {}, h("tr", {}, cols.map(([label]) => h("th", {}, label)))),
    h("tbody", {}, rows.map((r) => h("tr", { class: onRow ? "clickable" : null, onclick: onRow && ((e) => !e.target.closest("button,a") && onRow(r)) },
      cols.map(([, render]) => h("td", {}, render(r))))))));
}

export function toCsv({ columns, rows }) {
  const cell = (v) => (v === null ? "" : /[",\n\r]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return [columns.map((c) => cell(c.name)).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

export function download(name, data, type = "application/octet-stream") {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function snippet(text) {
  const btn = h("button", {
    onclick: async () => {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    },
  }, "Copy");
  return h("pre", { class: "snippet" }, text, btn);
}

export const button = (label, onclick, kind = "") => h("button", { class: `btn ${kind}`, onclick }, label);

// Wraps an async action: disables the button while running and shows failures as a toast.
// Wraps an event handler so a failure shows as a toast instead of vanishing.
export const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    toast(err.message, "err");
  }
};

export function action(label, fn, kind = "") {
  const btn = h("button", {
    class: `btn ${kind}`,
    onclick: async () => {
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
      }
    },
  }, label);
  return btn;
}

/* ---------- Dialogs (native <dialog>) ---------- */

function openDialog(build) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dialog" });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener("cancel", (e) => (e.preventDefault(), close(null)));
    dlg.append(build(close));
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("[autofocus], input, textarea, select")?.focus();
  });
}

// fields: [{ name, label, type: text|textarea|select|file|checkbox|password, value, placeholder, required, options, hint }]
export function formDialog({ title, intro, fields, submit = "Save", danger = false, validate }) {
  return openDialog((close) => {
    const err = h("div", { class: "form-error", hidden: true });
    const form = h("form", { method: "dialog" },
      h("h2", {}, title),
      intro && h("p", { class: "help" }, intro),
      fields.map((f) => field(f)),
      err,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", class: `btn ${danger ? "danger" : "primary"}` }, submit)));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const input = form.elements[f.name];
        values[f.name] = f.type === "file" ? input.files[0] : f.type === "checkbox" ? input.checked : input.value.trim();
      }
      const problem = validate?.(values);
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        return;
      }
      close(values);
    });
    return form;
  });
}

function field(f) {
  const common = { name: f.name, id: `f-${f.name}`, required: f.required, placeholder: f.placeholder, autocomplete: "off", spellcheck: "false" };
  let input;
  if (f.type === "textarea") input = h("textarea", { ...common, rows: f.rows ?? 8, class: "mono" }, f.value ?? "");
  else if (f.type === "select") input = h("select", common, f.options.map((o) => h("option", { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
  else if (f.type === "checkbox") {
    return h("label", { class: "check" }, h("input", { ...common, type: "checkbox", checked: f.value }), " ", f.label);
  } else input = h("input", { ...common, type: f.type ?? "text", value: f.value, accept: f.accept, pattern: f.pattern });
  return h("label", { class: "field", for: common.id }, h("span", {}, f.label), input, f.hint && h("small", {}, f.hint));
}

// Destructive actions confirm by typing the name, so a stray click cannot drop data.
export function confirmDialog({ title, body, confirm = "Delete", typeToConfirm }) {
  return formDialog({
    title,
    intro: body,
    danger: true,
    submit: confirm,
    fields: typeToConfirm ? [{ name: "confirm", label: `Type ${typeToConfirm} to confirm`, required: true }] : [],
    validate: (v) => (typeToConfirm && v.confirm !== typeToConfirm ? `That doesn't match ${typeToConfirm}.` : null),
  }).then((v) => v !== null);
}
