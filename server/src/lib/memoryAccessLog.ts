import crypto from "node:crypto";
import db from "../db.js";

/**
 * Журнал обращений к памяти (владелец 08.11.2026: «хочу видеть, кто туда
 * обращается и сколько раз»).
 *
 * Пишем только вопрос и число находок: тело записи в журнале не нужно, а
 * лишняя копия памяти — лишняя утечка. Падение журнала не должно ломать
 * ответ роли — поэтому всё в try/catch.
 */
export function logMemoryAccess(input: {
  roleKey: string | null;
  query: string;
  hits: number;
  kind?: "recall" | "detail" | "owner";
  chatId?: string | null;
}): void {
  try {
    db.prepare(
      `INSERT INTO memory_access_log (id, role_key, chat_id, query, hits, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      (input.roleKey ?? "").slice(0, 64) || null,
      input.chatId ?? null,
      (input.query ?? "").slice(0, 500),
      Math.max(0, input.hits),
      input.kind ?? "recall",
    );
  } catch {
    // Журнал — наблюдение, а не условие работы памяти.
  }
}

export interface MemoryAgentStat {
  role_key: string | null;
  name: string;
  calls: number;
  calls_week: number;
  last_at: string | null;
  records: number;
  uses: number;
}

/** Кто обращался к памяти и сколько раз. */
export function memoryAgentStats(): MemoryAgentStat[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(a.role_key, '') AS role_key,
              COUNT(*) AS calls,
              SUM(CASE WHEN a.at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS calls_week,
              MAX(a.at) AS last_at
         FROM memory_access_log a
        GROUP BY COALESCE(a.role_key, '')`,
    )
    .all() as Array<{ role_key: string; calls: number; calls_week: number; last_at: string | null }>;

  const byName = db.prepare(`SELECT name FROM users WHERE role_key = ? LIMIT 1`);
  const records = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(use_count), 0) AS uses
       FROM memories
      WHERE scope = 'role' AND role_key = ?`,
  );

  const stats = rows.map((row) => {
    const named = row.role_key ? (byName.get(row.role_key) as { name: string } | undefined) : undefined;
    const own = row.role_key
      ? (records.get(row.role_key) as { n: number; uses: number })
      : { n: 0, uses: 0 };
    return {
      role_key: row.role_key || null,
      name: named?.name ?? (row.role_key || "Владелец"),
      calls: row.calls,
      calls_week: row.calls_week,
      last_at: row.last_at,
      records: own.n,
      uses: own.uses,
    };
  });

  // Роли, которые ещё не обращались, тоже нужны: иначе «не видно» читается
  // как «нет памяти», а не «никто не спрашивал».
  const silent = db
    .prepare(
      `SELECT u.role_key AS role_key, u.name AS name,
              (SELECT COUNT(*) FROM memories m WHERE m.scope = 'role' AND m.role_key = u.role_key) AS records
         FROM users u
        WHERE u.role_key IS NOT NULL AND u.role_key <> ''
          AND COALESCE(u.archived, 0) = 0
          AND u.role_key NOT IN (SELECT COALESCE(role_key, '') FROM memory_access_log)`,
    )
    .all() as Array<{ role_key: string; name: string; records: number }>;
  for (const row of silent) {
    stats.push({
      role_key: row.role_key,
      name: row.name,
      calls: 0,
      calls_week: 0,
      last_at: null,
      records: row.records,
      uses: 0,
    });
  }

  return stats.sort((a, b) => (b.calls_week - a.calls_week) || (b.records - a.records));
}

export interface MemoryBrowseItem {
  id: string;
  bank: string;
  role_key: string | null;
  text: string;
  importance: number | null;
  score: number | null;
  at: string | null;
}

/** Банки, в которых реально что-то лежит. */
export function memoryBanksInUse(): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT bank FROM memory_mnemo_ids ORDER BY bank`)
    .all() as Array<{ bank: string }>;
  return rows.map((row) => row.bank);
}

export function roleKeyOfBank(bank: string): string | null {
  return bank.startsWith("tf-role-") ? bank.slice("tf-role-".length) : null;
}
