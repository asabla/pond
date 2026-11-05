// @ts-check
import { statements } from "./sql.js";

// Short history labels keep the SQL available for inspection rather than squeezing
// an entire statement onto one line. Literal/comment contents are never identifiers.
export function queryTitle(sql) {
  const tokens = (sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|[a-zA-Z_]\w*|[().;]/g) ?? [])
    .filter((token) => !token.startsWith("'") && !token.startsWith("--") && !token.startsWith("/*"));
  const end = tokens.indexOf(";");
  if (end >= 0) tokens.splice(end);
  const lower = tokens.map((token) => token.toLowerCase());
  const verb = lower[0];
  const nameAfter = (keyword) => {
    let at = lower.indexOf(keyword) + 1;
    if (!at) return "";
    if (lower[at] === "if") at += lower[at + 1] === "not" ? 3 : 2;
    if (!tokens[at] || ["select", "(", ";"].includes(lower[at])) return "";
    let name = tokens[at];
    while (tokens[at + 1] === "." && tokens[at + 2]) { name = tokens[at + 2]; at += 2; }
    return name.replace(/^(["`])|(["`])$/g, "").replaceAll('""', '"').replaceAll("``", "`");
  };
  const table = nameAfter("from");
  let title;
  if (verb === "select" || verb === "with") {
    const count = lower.some((token, i) => token === "count" && tokens[i + 1] === "(");
    title = table ? `${count ? "Count" : "Read"} ${table}` : "Select values";
  } else if (["create", "drop", "alter"].includes(verb)) {
    const kind = ["table", "view", "schema", "catalog"].find((word) => lower.includes(word));
    title = `${verb[0].toUpperCase()}${verb.slice(1)}${kind ? ` ${kind} ${nameAfter(kind)}` : " objects"}`;
  } else if (verb === "insert") title = `Insert into ${nameAfter("into") || "table"}`;
  else if (verb === "update") title = `Update ${nameAfter("update") || "table"}`;
  else if (verb === "delete") title = `Delete from ${table || "table"}`;
  else if (verb === "merge") title = `Merge into ${nameAfter("into") || "table"}`;
  else title = "SQL statement";
  const total = statements(sql).length;
  return total > 1 ? `${title} · ${total} statements` : title;
}
