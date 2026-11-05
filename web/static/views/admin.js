// @ts-check
// Settings: the context, connecting agents, warehouses, secrets, and resetting the lake.
import { h, table, action, button, formDialog, confirmDialog, toast, loading, errorBox, empty, snippet, fmtTime, shellQuote } from "../dom.js";
import { connectAgent } from "../mcp-connect.js";

export function createAdminView(ui) {
  const { lake } = ui;
  const el = h("section", { class: "view", "aria-label": "Settings" });
  let token = 0;
  const openScopes = new Set();

  const page = (...children) => el.replaceChildren(h("div", { class: "page" }, ...children));
  const section = (title, actions, ...body) =>
    h("div", { class: "section" }, h("div", { class: "section-head" }, h("h2", {}, title), h("div", { class: "actions" }, actions)), ...body);

  async function show() {
    const t = ++token;
    page(loading());
    try {
      const [cfg, warehouses, scopes] = await Promise.all([lake.config(), lake.listWarehouses().catch(() => []), lake.listScopes().catch(() => [])]);
      const secrets = Object.fromEntries(await Promise.all(scopes.map(async (s) => [s.name, await lake.listSecrets(s.name).catch(() => [])])));
      if (t !== token) return;
      render({ cfg, warehouses, scopes, secrets });
    } catch (err) {
      if (t === token) page(errorBox(err.message));
    }
  }

  function render({ cfg, warehouses, scopes, secrets }) {
    const ctx = cfg.context;
    page(
      h("div", { class: "title-row" }, h("h1", {}, "Settings")),

      section("Context", null, ctx
        ? h("dl", { class: "kv" },
          h("dt", {}, "Name"), h("dd", {}, ctx.name),
          h("dt", {}, "Directory"), h("dd", {}, ctx.dir),
          h("dt", {}, "Data"), h("dd", {}, `${ctx.dir}/.pond/data`),
          h("dt", {}, "Container"), h("dd", {}, ctx.container),
          h("dt", {}, "MiniLake"), h("dd", {}, cfg.minilake_url),
          cfg.version && [h("dt", {}, "Pond"), h("dd", {}, cfg.version)])
        : h("p", { class: "help" }, `Attached to a MiniLake pond does not manage: ${cfg.minilake_url}`)),
      ctx && h("div", { class: "help" }, "Container logs:", snippet(`pond logs ${shellQuote(ctx.dir)} -f`)),

      section("Runtime and recovery", null,
        h("dl", { class: "kv" },
          h("dt", {}, "Runtime"), h("dd", {}, cfg.runtime?.provider ?? "External MiniLake"),
          h("dt", {}, "Engine"), h("dd", {}, cfg.runtime?.kind ?? "external"),
          cfg.runtime?.version && [h("dt", {}, "Engine version"), h("dd", {}, cfg.runtime.version)],
          cfg.runtime?.image && [h("dt", {}, "MiniLake image"), h("dd", {}, cfg.runtime.image)],
          cfg.runtime?.connection && [h("dt", {}, "Connection"), h("dd", {}, cfg.runtime.connection)],
          h("dt", {}, "Job execution"), h("dd", {}, cfg.capabilities?.jobs ?? "Unknown; check the service configuration")),
        h("p", { class: "help", role: "status", id: `health-${ui.uid}` }, "Use Check connection to test Pond and MiniLake without running a job."),
        action("Check connection", async () => {
          const health = await lake.health();
          el.querySelector(`#health-${ui.uid}`).textContent = health.error ?? "Pond and MiniLake respond. Job execution has not been tested by this check.";
        }, "", false),
        ctx ? [snippet(`pond doctor ${shellQuote(ctx.dir)}`),
          h("p", { class: "help" }, "The terminal owns this context. Stop it before taking a data snapshot. A snapshot contains lake data, saved queries, graphs, scripts, jobs, runs and secrets. Keep the snapshot private."),
          snippet(`pond down ${shellQuote(ctx.dir)}`),
          snippet(`pond export ${shellQuote(ctx.dir)} -o lake.pond.tar.gz`),
          h("p", { class: "help" }, "Restore into a stopped context. Import replaces its data and asks for confirmation."),
          snippet(`pond import lake.pond.tar.gz ${shellQuote(ctx.dir)}`)]
          : h("p", { class: "help" }, "This external service owns its start, stop, job runtime and backups. Use the service owner's backup procedure."),
        h("p", { class: "help" }, "Drafts, closed-tab recovery and open tabs stay in this browser at this address. Saved objects and query/run history live in the lake. Page activity clears on reload. Export query and graph definitions or scripts to keep them in project files.")),

      ui.mcpUrl && section("Connect an agent", null,
        connectAgent(ui)),

      section("SQL warehouses", button("New warehouse", newWarehouse),
        table(warehouses, [
          ["Name", (w) => [w.name, w.id === cfg.warehouse_id && h("span", { class: "badge accent inline" }, "used by pond")]],
          ["Id", (w) => h("span", { class: "mono" }, w.id)],
          ["State", (w) => w.state ?? ""],
          ["Size", (w) => w.cluster_size ?? ""],
          ["", (w) => action("Delete", async () => {
            if (!(await confirmDialog({ title: `Delete warehouse ${w.name}?`, body: w.id === cfg.warehouse_id ? "Pond uses this warehouse for SQL; it will create a new one." : "The warehouse is removed. Data is not affected." }))) return;
            await lake.deleteWarehouse(w.id);
            await lake.config({ refresh: true });
            show();
          }, "ghost danger-text")],
        ], { empty: "No warehouses." }),
        h("p", { class: "help muted" }, "All warehouses share the same catalogs; MiniLake runs every statement on DuckDB.")),

      section("Secrets", [button("Add secret", () => putSecret()), button("New scope", newScope)],
        h("p", { class: "help" }, "Jobs read secrets with dbutils.secrets.get or {{secrets/scope/key}} in task environment variables. Values cannot be read back here."),
        scopes.length
          ? h("div", { class: "scopes" }, scopes.map((s) => scopeBlock(s, secrets[s.name] ?? [])))
          : empty("No secret scopes.")),

      h("div", { class: "section danger-zone" },
        h("h2", {}, "Reset lake"),
        h("p", { class: "help" }, `Deletes every catalog, table, volume, file, job, query and secret in ${ctx ? `the ${ctx.name} context` : "this MiniLake"}. Other contexts are not affected.`),
        action("Reset lake…", () => resetLake(), "danger")),
    );
  }

  function scopeBlock(scope, keys) {
    const open = openScopes.has(scope.name) || keys.length <= 5;
    return h("details", { class: "scope", open, ontoggle: (e) => (e.target.open ? openScopes.add(scope.name) : openScopes.delete(scope.name)) },
      h("summary", {}, h("b", {}, scope.name), h("span", { class: "muted" }, ` · ${keys.length} key${keys.length === 1 ? "" : "s"}`),
        h("span", { class: "spacer" }),
        action("Add", () => putSecret(scope.name), "ghost"),
        action("Delete scope", async () => {
          if (!(await confirmDialog({ title: `Delete scope ${scope.name}?`, body: "The scope and all its secrets are deleted.", typeToConfirm: scope.name }))) return;
          await lake.deleteScope(scope.name);
          show();
        }, "ghost danger-text")),
      keys.length
        ? h("ul", { class: "keys" }, keys.map((k) => h("li", {},
          h("code", {}, k.key), h("span", { class: "muted" }, ` · updated ${fmtTime(k.last_updated_timestamp)}`),
          h("span", { class: "spacer" }),
          action("Delete", async () => {
            if (!(await confirmDialog({ title: `Delete secret ${scope.name}/${k.key}?`, body: "Jobs using it will fail to resolve it." }))) return;
            await lake.deleteSecret(scope.name, k.key);
            show();
          }, "ghost danger-text"))))
        : h("p", { class: "help muted" }, "No keys."));
  }

  async function newWarehouse() {
    const v = await formDialog({ title: "New SQL warehouse", fields: [{ name: "name", label: "Name", required: true }], submit: "Create", onSubmit: async (values) => lake.createWarehouse(values.name) });
    if (!v) return;
    show();
  }

  async function newScope() {
    const v = await formDialog({ title: "New secret scope", fields: [{ name: "scope", label: "Scope", required: true, pattern: "[\\w.\\-]+" }], submit: "Create", onSubmit: async (values) => lake.createScope(values.scope) });
    if (!v) return;
    show();
  }

  async function putSecret(scope) {
    const v = await formDialog({
      title: scope ? `Add secret to ${scope}` : "Add secret",
      fields: [
        !scope && { name: "scope", label: "Scope", required: true, hint: "Created if it does not exist." },
        { name: "key", label: "Key", required: true, pattern: "[\\w.\\-]+" },
        { name: "value", label: "Value", type: "password", required: true },
      ].filter(Boolean),
      submit: "Save secret",
      onSubmit: async (values) => saveSecret(scope ?? values.scope, values.key, values.value),
    });
    if (!v) return;
    try {
      openScopes.add(scope ?? v.scope);
      toast("Secret saved");
      show();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  async function saveSecret(scope, key, value) {
    if (!(await lake.listScopes()).some((s) => s.name === scope)) await lake.createScope(scope);
    await lake.putSecret(scope, key, value);
  }

  async function resetLake({ byAgent = false } = {}) {
    const ctx = ui.context;
    const ok = await confirmDialog({
      title: byAgent ? "Agent wants to reset the lake" : "Reset the lake?",
      body: `Everything in ${ctx ? `the ${ctx.name} context` : "this MiniLake"} is deleted: catalogs, tables, volumes, files, jobs, queries and secrets. This cannot be undone.`,
      confirm: "Reset lake",
      typeToConfirm: ctx?.name ?? "reset",
    });
    if (!ok) return false;
    await lake.resetLake();
    toast("Lake reset");
    await ui.refreshTree();
    if (!el.hidden) show();
    return true;
  }

  return { el, show, resetLake, saveSecret };
}
