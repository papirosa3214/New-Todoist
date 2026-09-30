// Сообщение чата с ролями в том виде, в каком его видит клиент.
//
// Один формат на все пути доставки: история (GET /api/chats/:id/messages),
// ответ на отправку и событие `chat:new`. Раньше ответ роли уходил по сокету
// сырой строкой БД (шаги — JSON-строкой, is_session_marker — 0/1), и
// клиенту приходилось перечитывать всю ленту, чтобы показать готовый ответ.
// С одним форматом iPhone вставляет пузырь прямо из события — без
// перезапроса и без скачка ленты.
import db from "../db.js";
import {
  stepDetailFallback,
  unwrapRoleEnvelope,
  type SavedSteps,
} from "../runtime/chatLiveTurn.js";

// Ленивая подготовка: db.prepare с колонкой chat_message_id не должен
// падать на импорте, если миграция 053 ещё не прошла (index.ts импортирует
// маршруты раньше, чем прогоняет миграции).
let attachmentsOf: import("better-sqlite3").Statement | null = null;

/** Шаги из БД; инструментам трекера без подписи — подпись по имени. */
function savedSteps(raw: string): SavedSteps {
  const steps = JSON.parse(raw) as SavedSteps;
  for (const it of steps.items ?? []) {
    if (it.kind === "step") it.detail = stepDetailFallback(it.tool, it.detail);
  }
  return steps;
}

/** Строку chat_messages (с join-полями автора) привести к формату клиента. */
export function formatChatMessage(message: any) {
  if (!message) return message;
  attachmentsOf ??= db.prepare(
    `SELECT id, file_name, mime, size FROM attachments
      WHERE chat_message_id = ? ORDER BY created_at`,
  );
  return {
    ...message,
    attachments: attachmentsOf.all(message.id),
    // Быстрые ответы (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/) —
    // хранятся JSON-строкой (у SQLite нет своего типа массива).
    quick_replies: message.quick_replies ? JSON.parse(message.quick_replies) : null,
    // SQLite отдаёт 0/1 числом — iOS Decodable для Bool ждёт true/false.
    is_session_marker: Boolean(message.is_session_marker),
    // Шаги хода роли (владелец 27.09.2026) — JSON-строка в chat_messages.steps.
    steps: message.steps ? savedSteps(message.steps) : null,
    // Конверт ok/output в ответе роли (01.10.2026) — показываем только output.
    text: typeof message.text === "string" ? unwrapRoleEnvelope(message.text) : message.text,
  };
}

/** Одно сообщение чата по id — в формате клиента, null если его нет. */
export function loadChatMessage(id: string) {
  const row = db
    .prepare(
      `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
              f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
              t.title as task_title
         FROM chat_messages m
         LEFT JOIN users f ON f.id = m.from_user_id
         LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.id = ?`,
    )
    .get(id);
  return row ? formatChatMessage(row) : null;
}
