/**
 * Общий разбор строки запроса в FTS5 MATCH.
 * Токены в кавычках — FTS5 не читает их как операторы (AND/OR/NEAR…).
 */

export function toFtsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
