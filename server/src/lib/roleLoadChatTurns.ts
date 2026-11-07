// Ходы ролей в чате без карточки — для экрана «Загрузка ролей».
//
// Источник времени: chat_message_queue (picked_at → finished_at) — это
// время хода роли, а не только модели. Название работы берём из отчёта
// роли по этому ходу: сообщение роли в том же чате внутри интервала
// хода несёт role_envelope_json, где блок report описывает, что сделано.
//
// Правило подписи (одна мысль — одно место):
//   1. заголовок раздела result отчёта (или work, если result без заголовка);
//   2. затем текст раздела result;
//   3. затем обычный заголовок ответа;
//   4. затем первая строка текста ответа;
//   5. вежливые подтверждения («Принято», «Да», «Ок») названием работы не
//      считаются — снимаем их префиксом.
//
// Модуль чистый: SQL и разбор конверта вынесены отдельно, чтобы поведение
// можно было проверить на реальных данных без подъёма HTTP-сервера.

import type Database from "better-sqlite3";

export type ChatTurn = {
  id: string;
  chat_id: string;
  chat_title: string | null;
  role_id: string;
  role_key: string | null;
  started_at: string;
  ended_at: string;
  /** Название работы — из отчёта роли по этому ходу. */
  title: string;
};

const POLITE_PREFIX =
  /^(принято|принял|приняла|ок|окей|да|хорошо|спасибо|понял|поняла|да,|ага)[,.!:\s]*/iu;

function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/gu, " ").trim();
  t = t.replace(/^@[\p{L}\p{N}_-]+[,!]?\s*/u, "");
  t = t.replace(/[*`_]/gu, "");
  t = t.replace(POLITE_PREFIX, "").trim();
  if (!t) return "Чат";
  return t.length > 120 ? t.slice(0, 119).trimEnd() + "…" : t;
}

/** Разбор конверта ответа роли: возвращает название работы или null. */
export function titleFromEnvelope(envelopeJson: string | null): string | null {
  if (!envelopeJson) return null;
  let env: any;
  try {
    env = JSON.parse(envelopeJson);
  } catch {
    return null;
  }
  const blocks: any[] = Array.isArray(env?.output) ? env.output : [];
  for (const block of blocks) {
    if (block?.type !== "report") continue;
    const sections = block?.sections ?? {};
    for (const sec of ["result", "work"]) {
      for (const sb of sections[sec] ?? []) {
        if (sb?.type === "heading" && typeof sb.text === "string" && sb.text.trim()) {
          return cleanTitle(sb.text);
        }
      }
    }
    for (const sec of ["result", "work"]) {
      for (const sb of sections[sec] ?? []) {
        if (sb?.type === "text" && typeof sb.text === "string" && sb.text.trim()) {
          return cleanTitle(sb.text.split("\n")[0]);
        }
      }
    }
  }
  for (const block of blocks) {
    if (block?.type === "heading" && typeof block.text === "string" && block.text.trim()) {
      return cleanTitle(block.text);
    }
  }
  return null;
}

/** Название из обычного текста ответа — последний рубег. */
export function titleFromText(text: string | null): string | null {
  if (!text) return null;
  const md = text.match(/^#{1,3}\s+(.+)$/mu);
  if (md) return cleanTitle(md[1]);
  const first = text.trim().split("\n")[0];
  return first ? cleanTitle(first) : null;
}

/**
 * Список чатовых ходов за окно. fromIso/toIso — ISO-строки UTC.
 */
export function readChatTurns(
  db: Database.Database,
  fromIso: string,
  toIso: string,
): ChatTurn[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.chat_id, q.role_id, q.picked_at, q.finished_at,
              c.title AS chat_title, u.role_key
         FROM chat_message_queue q
         LEFT JOIN chats c ON c.id = q.chat_id
         LEFT JOIN users u ON u.id = q.role_id
        WHERE q.status = 'done'
          AND q.finished_at IS NOT NULL
          AND datetime(q.picked_at) < datetime(?)
          AND datetime(q.finished_at) > datetime(?)`,
    )
    .all(toIso, fromIso) as Array<{
    id: string;
    chat_id: string;
    role_id: string;
    picked_at: string;
    finished_at: string;
    chat_title: string | null;
    role_key: string | null;
  }>;

  const messageOf = db.prepare(
    `SELECT text, role_envelope_json
       FROM chat_messages
      WHERE chat_id = ? AND from_user_id = ?
        AND datetime(created_at) >= datetime(?)
        AND datetime(created_at) <= datetime(?)
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1`,
  );

  const out: ChatTurn[] = [];
  for (const row of rows) {
    const msg = messageOf.get(row.chat_id, row.role_id, row.picked_at, row.finished_at) as
      | { text: string | null; role_envelope_json: string | null }
      | undefined;
    const title =
      titleFromEnvelope(msg?.role_envelope_json ?? null) ??
      titleFromText(msg?.text ?? null) ??
      "Чат";
    out.push({
      id: row.id,
      chat_id: row.chat_id,
      chat_title: row.chat_title,
      role_id: row.role_id,
      role_key: row.role_key,
      started_at: row.picked_at,
      ended_at: row.finished_at,
      title,
    });
  }
  return out;
}
