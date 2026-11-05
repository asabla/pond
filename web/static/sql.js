// @ts-check
// A small SQL scanner: enough to tell statements apart and read their keywords without
// being fooled by strings, quoted names or comments. It doesn't parse SQL.

/**
 * Splits SQL into statements, each as its lowercased keywords and names. Text in quotes
 * and comments is dropped, so `'a; drop'` or `-- drop` are not words.
 * @param {string} sql
 * @returns {string[][]} one word list per non-empty statement
 */
export function statements(sql) {
  /** @type {string[][]} */
  const out = [];
  /** @type {string[]} */
  let words = [];
  let word = "";
  const endWord = () => {
    if (word) words.push(word.toLowerCase());
    word = "";
  };
  const endStatement = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      endWord();
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else if (c === "/" && sql[i + 1] === "*") {
      endWord();
      // Block comments nest in DuckDB.
      let depth = 1;
      for (i += 2; i < sql.length && depth > 0; i++) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, i++);
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, i++);
      }
      i--;
    } else if (c === "'" || c === '"' || c === "`") {
      endWord();
      // A doubled quote is an escaped quote inside the string.
      for (i++; i < sql.length; i++) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i++;
          else break;
        }
      }
      words.push(c === "'" ? "'…'" : '"…"'); // keeps the statement's shape without the text
    } else if (c === ";") {
      endStatement();
    } else if (/\w/.test(c)) {
      word += c;
    } else {
      endWord();
    }
  }
  endStatement();
  return out;
}

/**
 * Whether the SQL is more than one statement, ignoring trailing semicolons.
 * @param {string} sql
 */
export const isMultiStatement = (sql) => statements(sql).length > 1;

/**
 * @param {string[]} words
 * @param {string[]} seq
 */
const hasSequence = (words, seq) => words.some((_, i) => seq.every((s, j) => words[i + j] === s));

/**
 * Whether any statement deletes data: dropping objects or columns, deleting or truncating
 * rows, or replacing a table or its rows. Queries, inserts, updates and schema changes
 * that keep data don't count. Every statement is checked, wherever the keyword appears,
 * so a second statement or a CTE can't hide one.
 * @param {string} sql
 */
export const isDestructiveSql = (sql) => statements(sql).some((w) =>
  w.includes("drop") || w.includes("delete") || w.includes("truncate") ||
  hasSequence(w, ["or", "replace"]) || hasSequence(w, ["insert", "overwrite"]) ||
  hasSequence(w, ["replace", "into"]));

/**
 * Whether the SQL creates, drops or alters objects, so the catalog tree needs a refresh.
 * @param {string} sql
 */
export const changesCatalog = (sql) => statements(sql).some((w) => ["create", "drop", "alter", "attach", "detach"].includes(w[0]));
