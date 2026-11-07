// Живой черновик хода роли в базе (владелец 31.10.2026).
//
// Зачем: раньше растущий ответ и размышления жили только в памяти процесса
// (chatLiveTurn) и попадали в chat_messages одним куском в самом конце хода.
// Владелец останавливал роль — часть текста пропадала; падал/перезапускался
// сервер — пропадал весь ход. Теперь каждый живой ход зеркалится в
// chat_live_drafts: текст и ВСЕ размышления обновляются по ходу (не реже
// раза в LIVE_DRAFT_MS), а после остановки или рестарта из черновика можно
// восстановить частичный ответ.
//
// Черновик не заменяет chat_messages: итоговый ответ по-прежнему ложится
// туда обычным путём. Черновик — страховка на время хода и архив
// размышлений (в истории они обрезаются ради размера базы, здесь лежат
// целиком).
//
// Таблица без FK: черновик может появиться раньше, чем тестовая/временная
// база успеет завести чат, и он не должен ломать ход из-за ссылочной
// целостности. Чат и роль в нём — просто идентификаторы.

import db from "../db.js";
import type { LiveItem } from "./chatLiveTurn.js";

/** Как часто обновлять строку черновика при живом ходе (мс). Секунда —
 *  компромисс: при остановке теряется не больше последней секунды, а
 *  длинный ход с сотнями шагов не переписывает мегабайты JSON на каждом
 *  кадре. */
export const LIVE_DRAFT_MS = 1_000;

export type LiveDraftStatus = "running" | "finished" | "saved" | "recovered";

export interface LiveDraftSnapshot {
  turnId: string;
  chatId: string;
  roleId: string;
  roleName?: string;
  triggerMessageId?: string | null;
  replyMessageId?: string | null;
  /** Весь текст хода (все текстовые куски), без обёрток контракта. */
  text: string;
  /** Последний текстовый кусок — он же частичный ответ при остановке. */
  answerText: string;
  /** Полный снимок items: шаги и размышления без обрезки. */
  items: LiveItem[];
}

/** openedAt — начало хода: по нему видно, что черновик не от прошлого
 *  запуска. */
export function beginLiveDraft(input: {
  turnId: string;
  chatId: string;
  roleId: string;
  roleName?: string;
  triggerMessageId?: string | null;
  replyMessageId?: string | null;
  startedAt: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO chat_live_drafts
         (turn_id, chat_id, role_id, role_name, trigger_message_id,
          reply_message_id, text, answer_text, items_json, status,
          started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', 'running', ?, datetime('now'))
       ON CONFLICT(turn_id) DO NOTHING`,
    ).run(
      input.turnId,
      input.chatId,
      input.roleId,
      input.roleName ?? null,
      input.triggerMessageId ?? null,
      input.replyMessageId ?? null,
      input.startedAt,
    );
  } catch (error) {
    warnOnce("начать", error);
  }
}

export function saveLiveDraft(snapshot: LiveDraftSnapshot): void {
  try {
    db.prepare(
      `UPDATE chat_live_drafts
          SET text = ?, answer_text = ?, items_json = ?, updated_at = datetime('now')
        WHERE turn_id = ? AND status = 'running'`,
    ).run(
      snapshot.text,
      snapshot.answerText,
      JSON.stringify(snapshot.items),
      snapshot.turnId,
    );
  } catch (error) {
    warnOnce("обновить", error);
  }
}

/** Ход дошёл до конца (успех, остановка или сбой) — черновик больше не
 *  «живой». Итоговое сообщение отмечается отдельно, когда реально легло
 *  в chat_messages. */
export function finishLiveDraft(snapshot: LiveDraftSnapshot): void {
  try {
    db.prepare(
      `UPDATE chat_live_drafts
          SET text = ?, answer_text = ?, items_json = ?,
              status = CASE WHEN status = 'running' THEN 'finished' ELSE status END,
              updated_at = datetime('now')
        WHERE turn_id = ?`,
    ).run(
      snapshot.text,
      snapshot.answerText,
      JSON.stringify(snapshot.items),
      snapshot.turnId,
    );
  } catch (error) {
    warnOnce("закрыть", error);
  }
}

/** Итоговый ответ лёг в чат под этим id — черновик считается сохранённым. */
export function markLiveDraftSaved(turnId: string, messageId: string): void {
  try {
    db.prepare(
      `UPDATE chat_live_drafts
          SET status = 'saved', reply_message_id = ?, updated_at = datetime('now')
        WHERE turn_id = ? AND status IN ('running', 'finished')`,
    ).run(messageId, turnId);
  } catch (error) {
    warnOnce("отметить сохранённым", error);
  }
}

/**
 * Восстановление после падения/перезапуска сервера: всё, что осталось в
 * статусе running, — это ходы, которых уже нет в памяти. Кладём их в чат
 * частичным ответом (если итоговое сообщение не успело записаться) и
 * помечаем recovered.
 *
 * Возвращает число восстановленных ходов.
 */
export function recoverLiveDrafts(): number {
  let rows: Array<{
    turn_id: string;
    chat_id: string;
    role_id: string;
    trigger_message_id: string | null;
    reply_message_id: string | null;
    text: string;
    answer_text: string;
    items_json: string;
    started_at: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT turn_id, chat_id, role_id, trigger_message_id, reply_message_id,
                text, answer_text, items_json, started_at
           FROM chat_live_drafts
          WHERE status IN ('running', 'finished')
          ORDER BY started_at`,
      )
      .all() as typeof rows;
  } catch (error) {
    warnOnce("прочитать при восстановлении", error);
    return 0;
  }

  let recovered = 0;
  for (const row of rows) {
    try {
      const hasContent =
        row.text.trim().length > 0 ||
        row.answer_text.trim().length > 0 ||
        row.items_json !== "[]";
      if (!hasContent) {
        // Ход оборвался до первого токена — сохранять нечего, но строку
        // нельзя оставлять running: следующий старт снова её подхватит.
        db.prepare(
          `UPDATE chat_live_drafts SET status = 'recovered', updated_at = datetime('now')
            WHERE turn_id = ?`,
        ).run(row.turn_id);
        continue;
      }
      const parts = [row.text.trim(), row.answer_text.trim()].filter(Boolean);
      const text = parts.length
        ? `${parts[parts.length - 1]}\n\n_Ход прерван перезапуском сервера._`
        : "_Ход прерван перезапуском сервера._";
      let messageId = row.reply_message_id;
      const existing = messageId
        ? db.prepare("SELECT id FROM chat_messages WHERE id = ?").get(messageId)
        : undefined;
      if (!existing) {
        const chatExists = db
          .prepare("SELECT 1 FROM chats WHERE id = ?")
          .get(row.chat_id);
        const roleExists = db
          .prepare("SELECT 1 FROM users WHERE id = ?")
          .get(row.role_id);
        if (chatExists && roleExists) {
          messageId = messageId || `draft-${row.turn_id}`;
          // items_json — массив LiveItem; в chat_messages.steps клиент ждёт
          // SavedSteps {duration_ms, items}. Голый массив ронял разбор ленты.
          let stepsJson: string | null = null;
          if (row.items_json !== "[]") {
            try {
              const items = JSON.parse(row.items_json);
              stepsJson = JSON.stringify({
                duration_ms: 0,
                items: Array.isArray(items) ? items : [],
              });
            } catch {
              stepsJson = null;
            }
          }
          db.prepare(
            `INSERT INTO chat_messages
               (id, from_user_id, text, channel, chat_id, steps,
                reply_to_message_id, stop_reason, partial)
             VALUES (?, ?, ?, 'chat', ?, ?, ?, 'server_restart', 1)`,
          ).run(
            messageId,
            row.role_id,
            text,
            row.chat_id,
            stepsJson,
            row.trigger_message_id,
          );
        }
      }
      db.prepare(
        `UPDATE chat_live_drafts
            SET status = 'recovered', reply_message_id = ?, updated_at = datetime('now')
          WHERE turn_id = ?`,
      ).run(messageId, row.turn_id);
      recovered += 1;
    } catch (error) {
      warnOnce("восстановить", error);
    }
  }
  return recovered;
}

let warned = false;
function warnOnce(action: string, error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[chatLiveDraft] не удалось ${action} черновик хода:`,
    error instanceof Error ? error.message : error,
  );
}
