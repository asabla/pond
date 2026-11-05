// @ts-check
import { h, snippet, store, shellQuote } from "./dom.js";

// Transport/configuration forms verified against the official client examples:
// https://developers.openai.com/learn/docs-mcp
export const HARNESSES = [["codex", "Codex"], ["claude", "Claude Code"], ["cursor", "Cursor"], ["vscode", "VS Code / Copilot"], ["url", "Other MCP client"]];

export function mcpSetup(harness, name, url) {
  const server = `pond-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  if (harness === "codex") return { help: "Run this command with the Codex CLI. The CLI and IDE extension share MCP configuration.", text: `codex mcp add ${shellQuote(server)} --url ${shellQuote(url)}` };
  if (harness === "claude") return { help: "Run this command from the project where you use Claude Code.", text: `claude mcp add --transport http ${shellQuote(server)} ${shellQuote(url)}` };
  if (harness === "cursor") return { help: "Merge this server into ~/.cursor/mcp.json, then restart Cursor.", text: JSON.stringify({ mcpServers: { [server]: { url } } }, null, 2) };
  if (harness === "vscode") return { help: "Merge this server into .vscode/mcp.json in your project. Enable it in Copilot Agent mode.", text: JSON.stringify({ servers: { [server]: { type: "http", url } } }, null, 2) };
  return { help: "Use this URL with an MCP client that supports Streamable HTTP.", text: url };
}

export function connectAgent(ui) {
  const saved = store("pond.mcpHarness");
  const initial = HARNESSES.some(([key]) => key === saved) ? saved : "codex";
  const output = h("div", { class: "mcp-setup" });
  const select = h("select", { class: "input", "aria-label": "Agent harness" }, HARNESSES.map(([value, label]) => h("option", { value, selected: value === initial }, label)));
  const render = () => {
    const setup = mcpSetup(select.value, ui.ctx?.id ?? ui.ctx?.name ?? "lake", ui.mcpUrl);
    output.replaceChildren(h("p", { class: "help" }, setup.help), snippet(setup.text, "Copy MCP setup"));
  };
  select.addEventListener("change", () => { store("pond.mcpHarness", select.value); render(); select.focus(); });
  render();
  return h("div", { class: "mcp-connect" }, h("label", { class: "mcp-harness" }, "Connect with", select), output,
    h("a", { class: "help", href: "https://developers.openai.com/learn/docs-mcp", target: "_blank", rel: "noopener noreferrer" }, "Client setup reference"));
}
