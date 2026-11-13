// server/src/lib/closedTasksFeed.ts
//
// Лёгкая выдача для телефона (владелец 13.11.2026): «мне сама задача со
// всем содержимым не нужна, но хотя бы карточка с итогом и названием…
// архив 1 мес… статистика — фото с сервера… чисто по дням, в какой день
// сколько задач».
//
// - Мини-карточки закрытых (выполненных и архивных) задач за последние
//   30 дней: название, проект, дата закрытия, пометка, итог одной строкой.
//   Полная карточка на телефон приходит только при восстановлении.
// - Снимок «сколько задач выполнено в какой день». Сервер сам считает и
//   помнит, в какой версии менялся каждый день: с курсором телефону уходят
//   только изменившиеся дни (в том числе уменьшившиеся — переоткрыли задачу).
//
// На сервере ничего не удаляется: окно в 30 дней — только для выдачи.

import db from "../db.js";

/** Сколько дней мини-карточки живут в архиве телефона. */
export const ARCHIVE_WINDOW_DAYS = 30;
/** Длина итога одной строкой. */
const OUTCOME_MAX = 200;
/** День считается по Москве: даты в базе — UTC. */
const DAY_SHIFT = "+3 hours";

export type ClosedTaskItem = {
  id: string;
  title: string;
  project_name: string | null;
  kind: "completed" | "archived";
  closed_at: string;
  outcome: string | null;
};

const CLOSED_WHERE = "(t.archived_at IS NOT NULL OR t.status = 'completed')";
const CLOSED_AT = "COALESCE(t.archived_at, t.completed_at, t.updated_at)";

function oneLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const flat = line.replace(/\s+/g, " ");
  return flat.length > OUTCOME_MAX ? flat.slice(0, OUTCOME_MAX - 1) + "…" : flat;
}

/** Итог: результат последнего закрытого шага → заголовок последнего отчёта → первая строка описания. */
function outcomeOf(taskId: string, description: string | null): string | null {
  const step = db
    .prepare(
      `SELECT result FROM subtasks
        WHERE task_id = ? AND done = 1 AND result IS NOT NULL AND trim(result) <> ''
        ORDER BY position DESC LIMIT 1`,
    )
    .get(taskId) as { result?: string } | undefined;
  if (step?.result) return oneLine(step.result);
  const report = db
    .prepare("SELECT title FROM task_reports WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as { title?: string } | undefined;
  if (report?.title) return oneLine(report.title);
  return oneLine(description);
}

/**
 * Мини-карточки закрытых задач за окно в 30 дней. `ids` — только эти
 * карточки (дельта по журналу изменений); без него — все в окне.
 */
export function closedTaskItems(ids?: string[]): ClosedTaskItem[] {
  if (ids && ids.length === 0) return [];
  const idFilter = ids ? `AND t.id IN (${ids.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.archived_at, ${CLOSED_AT} AS closed_at,
              COALESCE(p.name, t.project_name_snapshot) AS project_name
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE ${CLOSED_WHERE}
          AND ${CLOSED_AT} >= datetime('now', '-${ARCHIVE_WINDOW_DAYS} days')
          ${idFilter}
        ORDER BY ${CLOSED_AT} DESC`,
    )
    .all(...(ids ?? [])) as Array<{
    id: string;
    title: string;
    description: string | null;
    archived_at: string | null;
    closed_at: string;
    project_name: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    project_name: r.project_name ?? null,
    kind: r.archived_at ? "archived" : "completed",
    closed_at: r.closed_at,
    outcome: outcomeOf(r.id, r.description),
  }));
}

// MARK: Статистика по дням

function ensureDailyStats(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS completed_daily_stats (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    version INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS completed_daily_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`);
}

/**
 * Пересчитывает «сколько задач выполнено в какой день» (дёшево: одна
 * группировка), записывает изменившиеся дни новой версией и отдаёт снимок:
 * без курсора — все дни с задачами, с курсором — только дни, изменившиеся
 * после него. Курсор — номер версии.
 */
export function completedDailyStats(since: string | null): {
  server_time: string;
  full: boolean;
  days: Array<{ day: string; count: number }>;
} {
  ensureDailyStats();
  return db.transaction(() => {
    const fresh = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT date(completed_at, '${DAY_SHIFT}') AS day, COUNT(*) AS count
           FROM tasks
          WHERE status = 'completed' AND completed_at IS NOT NULL
          GROUP BY day`,
      )
      .all() as Array<{ day: string; count: number }>) {
      fresh.set(row.day, row.count);
    }
    const stored = new Map<string, number>();
    for (const row of db.prepare("SELECT day, count FROM completed_daily_stats").all() as Array<{
      day: string;
      count: number;
    }>) {
      stored.set(row.day, row.count);
    }
    const current =
      (db.prepare("SELECT value FROM completed_daily_meta WHERE key = 'version'").get() as
        | { value?: number }
        | undefined)?.value ?? 0;

    const changed: Array<[string, number]> = [];
    for (const [day, count] of fresh) if (stored.get(day) !== count) changed.push([day, count]);
    for (const [day, count] of stored) if (!fresh.has(day) && count !== 0) changed.push([day, 0]);

    let version = current;
    if (changed.length) {
      version = current + 1;
      const upsert = db.prepare(
        `INSERT INTO completed_daily_stats (day, count, version) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET count = excluded.count, version = excluded.version`,
      );
      for (const [day, count] of changed) upsert.run(day, count, version);
      db.prepare(
        `INSERT INTO completed_daily_meta (key, value) VALUES ('version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(version);
    }

    const cursor = since !== null && /^\d+$/.test(since) ? Number(since) : null;
    // Курсор из будущего (база пересоздана) — полный снимок.
    const full = cursor === null || cursor > version;
    const days = (full
      ? db.prepare("SELECT day, count FROM completed_daily_stats WHERE count > 0 ORDER BY day").all()
      : db
          .prepare("SELECT day, count FROM completed_daily_stats WHERE version > ? ORDER BY day")
          .all(cursor)) as Array<{ day: string; count: number }>;
    return { server_time: String(version), full, days };
  })();
}
