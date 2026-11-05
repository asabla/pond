// @ts-check
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

let storageWarning = false;
export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    if (value !== undefined && !storageWarning) {
      storageWarning = true;
      toast("Browser storage is unavailable or full. Keep this page open and export unsaved work before closing it.", "err");
    }
    return undefined;
  }
}

export function toast(text, kind) {
  // The workbench logs these in its activity rail.
  globalThis.document?.dispatchEvent(new CustomEvent("pond:toast", { detail: { text: String(text), kind } }));
  const stack = globalThis.document?.querySelector("#toasts");
  if (!stack) return;
  stack.append(h("div", { class: `toast ${kind ?? ""}` }, text));
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => stack.firstElementChild?.remove(), 3500);
}

export const loading = (text) => h("div", { class: "empty" }, h("span", { class: "loading" }), text ? ` ${text}` : null);
export const empty = (...children) => h("div", { class: "empty" }, ...children);
export const errorBox = (message) => h("div", { class: "error", role: "alert" }, message);

// Reuse unchanged subtrees, including their focused controls and event handlers.
// When a changed subtree must be replaced, restore the same logical control.
export function reconcile(root, ...children) {
  const next = h("div", {}, children);
  const active = document.activeElement;
  const focused = root.contains(active) ? active : null;
  const focusKey = focused?.getAttribute("data-focus-key");
  const sync = (parent, nodes) => {
    const old = [...parent.childNodes];
    nodes.forEach((node, i) => {
      const prev = old[i];
      if (prev?.isEqualNode(node)) return;
      if (prev?.nodeType === 1 && node.nodeType === 1 && !["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(node.tagName) && prev.tagName === node.tagName && prev.getAttribute("data-key") === node.getAttribute("data-key")) {
        for (const attr of [...prev.attributes]) if (!node.hasAttribute(attr.name)) prev.removeAttribute(attr.name);
        for (const attr of [...node.attributes]) if (prev.getAttribute(attr.name) !== attr.value) prev.setAttribute(attr.name, attr.value);
        sync(prev, [...node.childNodes]);
      } else if (prev) prev.replaceWith(node);
      else parent.append(node);
    });
    old.slice(nodes.length).forEach((node) => node.remove());
  };
  const scroll = root.scrollTop;
  sync(root, [...next.childNodes]);
  root.scrollTop = scroll;
  if (focusKey && !focused.isConnected) root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

/**
 * A short, unambiguous time: the clock for today, the day and month otherwise, and the
 * year only when it isn't this one. Month names avoid the 05/11 day-or-month question.
 * @param {number | string | null | undefined} ms
 */
export function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const clock = { hour: "2-digit", minute: "2-digit" };
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], /** @type {any} */ (clock));
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString([], /** @type {any} */ ({ day: "numeric", month: "short", ...(sameYear ? clock : { year: "numeric" }) }));
}
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

export function grid({ columns, rows }, { max = 1000, label = "Data table" } = {}) {
  const numeric = columns.map((c) => NUMERIC.test(c.type || ""));
  return h("div", { class: "grid-wrap", tabindex: "0", role: "region", "aria-label": label },
    h("table", { class: "grid", "aria-label": label },
      h("thead", {}, h("tr", {},
        h("th", { class: "rownum" }, "#"),
        columns.map((c, j) => h("th", { scope: "col", class: numeric[j] ? "num" : null, title: `${c.name} ${c.type ?? ""}` }, c.name, h("small", {}, (c.type || "").toLowerCase()))),
        // Takes the spare width, so columns stay as wide as their content.
        h("th", { class: "fill", "aria-hidden": "true" }))),
      h("tbody", {}, rows.slice(0, max).map((row, i) => h("tr", {},
        h("td", { class: "rownum" }, String(i + 1)),
        row.map((v, j) => v === null
          ? h("td", { class: "null" }, "null")
          : h("td", { class: numeric[j] ? "num" : null, title: String(v).length > 40 ? String(v) : null }, String(v))),
        h("td", { class: "fill", "aria-hidden": "true" }))))));
}

// Simple key/value table for lists of objects: cols = [[label, row => node|string], ...].
/**
 * @param {any[]} rows
 * @param {any[]} cols [header, cell(row)] pairs
 * @param {{ onRow?: (row: any) => void, empty?: string }} [opts]
 */
export function table(rows, cols, { onRow, empty: emptyText = "Nothing here yet." } = {}) {
  if (!rows.length) return empty(emptyText);
  // Clickable rows can be reached with Tab and opened with Enter or Space, and the
  // opened row is marked selected.
  const open = (tr, r) => {
    for (const row of tr.parentElement.querySelectorAll("tr.selected")) row.classList.remove("selected");
    tr.classList.add("selected");
    onRow(r);
  };
  const rowProps = (r) => (onRow ? {
    class: "clickable",
    tabindex: "0",
    onclick: (e) => !e.target.closest("button,a,input") && open(e.currentTarget, r),
    onkeydown: (e) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        open(e.currentTarget, r);
      }
    },
  } : {});
  return h("div", { class: "grid-wrap", tabindex: "0", role: "region", "aria-label": "List. Scroll horizontally to see all columns." }, h("table", { class: "grid list" },
    h("thead", {}, h("tr", {}, cols.map(([label]) => h("th", { scope: "col" }, label || "Actions")))),
    h("tbody", {}, rows.map((r) => h("tr", rowProps(r), cols.map(([, render]) => h("td", {}, render(r))))))));
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

export const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

export function snippet(text, label = "Copy command") {
  const btn = h("button", {
    "aria-label": `${label}: ${text}`,
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
/**
 * Fills a role="tablist" with tab buttons, or updates the ones already there, so a
 * focused tab keeps focus. The selected tab is the one in the Tab order; the arrow
 * keys, Home and End move between tabs, as the ARIA tabs pattern expects.
 * @param {HTMLElement} list the tablist element
 * @param {Array<[string, string]>} items [key, label] pairs
 * @param {string} selected
 * @param {(key: string) => void} onSelect
 * @param {string} panelId id of the role="tabpanel" the tabs control
 */
export function syncTabs(list, items, selected, onSelect, panelId) {
  const keyNav = (e) => {
    const all = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('[role="tab"]')]);
    const i = all.indexOf(e.currentTarget);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const target = all[(next + all.length) % all.length];
    target.focus();
    target.click();
  };
  if (list.querySelectorAll('[role="tab"]').length !== items.length) {
    list.replaceChildren(...items.map(([key, label]) => h("button", {
      role: "tab", id: `${panelId}-tab-${key}`, "aria-controls": panelId, onclick: () => onSelect(key), onkeydown: keyNav,
    }, label)));
  }
  for (const [key] of items) {
    const tab = /** @type {HTMLElement} */ (list.querySelector(`#${panelId}-tab-${key}`));
    tab.setAttribute("aria-selected", String(key === selected));
    tab.tabIndex = key === selected ? 0 : -1;
  }
  document.getElementById(panelId)?.setAttribute("aria-labelledby", `${panelId}-tab-${selected}`);
}

// Wraps an event handler so a failure shows as a toast instead of vanishing.
export const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    toast(err.message, "err");
  }
};

export function action(label, fn, kind = "", requiresLake = true) {
  const btn = h("button", {
    class: `btn ${kind}`, "data-lake-action": requiresLake,
    onclick: async () => {
      const restoreFocus = document.activeElement === btn;
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = requiresLake && Boolean(btn.closest('[data-offline="true"]'));
        if (btn.disabled) btn.dataset.offlineDisabled = "true";
        if (restoreFocus && !btn.disabled && btn.isConnected && document.activeElement === document.body) btn.focus({ preventScroll: true });
      }
    },
  }, label);
  return btn;
}

/* ---------- Dialogs (native <dialog>) ---------- */

let dialogSeq = 0;
function openDialog(build) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dlg = h("dialog", { class: "dialog", "aria-labelledby": `dialog-title-${++dialogSeq}` });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(value);
    };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!dlg.dataset.busy) close(null); });
    dlg.append(build(close));
    dlg.querySelector("h2")?.setAttribute("id", dlg.getAttribute("aria-labelledby"));
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("[autofocus], input, textarea, select")?.focus();
  });
}

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {"text" | "textarea" | "select" | "file" | "checkbox" | "password" | string} [type]
 * @property {any} [value]
 * @property {string} [placeholder]
 * @property {boolean} [required]
 * @property {any[]} [options] strings, or { value, label } objects, for a select
 * @property {string} [hint]
 * @property {string} [pattern] checked by the browser, compiled with the v flag
 * @property {string} [accept] file types, for a file field
 * @property {number} [rows] for a textarea
 */

/**
 * A modal form. Resolves to the field values, or null when cancelled.
 * @param {{ title: string, intro?: any, fields: Field[], submit?: string, danger?: boolean,
 *   validate?: (values: Record<string, any>) => string | null | undefined | false,
 *   onSubmit?: (values: Record<string, any>) => Promise<any> }} opts
 * @returns {Promise<Record<string, any> | null>}
 */
export function formDialog({ title, intro, fields, submit = "Save", danger = false, validate, onSubmit }) {
  return openDialog((close) => {
    const err = h("div", { class: "form-error", hidden: true, role: "alert", tabindex: "-1" });
    const form = h("form", { method: "dialog" },
      h("h2", {}, title),
      intro && h("p", { class: "help" }, intro),
      fields.map((f) => field(f)),
      err,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", class: `btn ${danger ? "danger" : "primary"}` }, submit)));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const dlg = form.closest("dialog");
      if (dlg.dataset.busy) return;
      const values = {};
      for (const f of fields) {
        const input = form.elements[f.name];
        // Passwords and secrets keep their spaces: they may be part of the value.
        values[f.name] = f.type === "file" ? input.files[0] : f.type === "checkbox" ? input.checked : (f.type === "password" || f.type === "textarea") ? input.value : input.value.trim();
      }
      const problem = validate?.(values);
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        err.focus();
        return;
      }
      const controls = [...form.querySelectorAll("input,textarea,select,button")].filter((el) => !el.disabled);
      try {
        dlg.dataset.busy = "true";
        form.setAttribute("aria-busy", "true");
        controls.forEach((el) => { el.disabled = true; });
        await onSubmit?.(values);
        close(values);
      } catch (error) {
        err.textContent = error.message || String(error);
        err.hidden = false;
        err.focus();
      } finally {
        delete dlg.dataset.busy;
        form.removeAttribute("aria-busy");
        controls.forEach((el) => { el.disabled = false; });
      }
    });
    return form;
  });
}

function field(f) {
  const common = { name: f.name, id: `f-${dialogSeq}-${f.name}`, required: f.required, placeholder: f.placeholder, autocomplete: "off", spellcheck: "false", "aria-describedby": f.hint ? `hint-${dialogSeq}-${f.name}` : null };
  let input;
  if (f.type === "textarea") input = h("textarea", { ...common, rows: f.rows ?? 8, class: "mono" }, f.value ?? "");
  else if (f.type === "select") input = h("select", common, f.options.map((o) => h("option", { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
  else if (f.type === "checkbox") {
    return h("label", { class: "check" }, h("input", { ...common, type: "checkbox", checked: f.value }), " ", f.label);
  } else input = h("input", { ...common, type: f.type ?? "text", value: f.value, accept: f.accept, pattern: f.pattern });
  return h("label", { class: "field", for: common.id }, h("span", {}, f.label), input, f.hint && h("small", { id: `hint-${dialogSeq}-${f.name}` }, f.hint));
}

/**
 * Destructive actions confirm by typing the name, so a stray click cannot drop data.
 * @param {{ title: string, body?: any, confirm?: string, typeToConfirm?: string }} opts
 * @returns {Promise<boolean>}
 */
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
