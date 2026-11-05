// @ts-check
import { quoteIdent, literal } from "./graph.js";

// Inspect original relationship rows. Analysis may combine rows on one drawn line;
// this query preserves each row and all of its properties.
/** @param {{ node?: any, pair?: any[], search?: string }} [filter] */
export function relationshipsSql(def, columns, filter = {}, limit = 1001) {
  const { node, pair, search = "" } = filter;
  const source = `e.${quoteIdent(columns[0].name)}`;
  const target = `e.${quoteIdent(columns[1].name)}`;
  const where = [];
  if (node != null) where.push(`(${source} = ${literal(node)} OR ${target} = ${literal(node)})`);
  if (pair) {
    const [a, b] = pair.map(literal);
    where.push(`((${source} = ${a} AND ${target} = ${b})${def.directed === false ? ` OR (${source} = ${b} AND ${target} = ${a})` : ""})`);
  }
  if (search.trim()) where.push(`(${columns.map((c) => `contains(lower(CAST(e.${quoteIdent(c.name)} AS VARCHAR)), lower(${literal(search.trim())}))`).join(" OR ")})`);
  return `SELECT * FROM (\n${def.edges_sql}\n) AS e${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${limit == null ? "" : ` LIMIT ${limit}`}`;
}

export const propertyText = (value) => value == null ? "null" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);

export function relationshipLabel(columns, row) {
  const at = columns.findIndex((c, i) => i > 1 && ["relationship", "type", "kind", "label"].includes(c.name.toLowerCase()));
  return at >= 0 && row[at] != null ? propertyText(row[at]) : "Relationship";
}

export function distanceToConnection(point, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const fraction = length ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length)) : 0;
  return Math.hypot(point.x - from.x - fraction * dx, point.y - from.y - fraction * dy);
}
