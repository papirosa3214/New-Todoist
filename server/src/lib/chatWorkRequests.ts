// Просьба владельца из разговора к исполнителю шага — сверх обычной сдачи.
//
// Владелец 12.10.2026: отбивка в чат — не ритуал. По умолчанию исполнитель
// работает как всегда: комментарии, артефакты, сдача. Но если в разговоре
// владелец попросил «пусть сообщит, когда сделает, и пришлёт отчёт», шаг
// получает ровно эту дополнительную просьбу: по завершении ответить в тот
// чат на то сообщение. Просьбы хранятся в шагах запуска (chat_work_launches)
// и попадают исполнителю через общий контекст карточки (topicContext).
//
// Отдельный модуль без зависимостей от рантайма: его читает projectTopics.

import db from "../db.js";

type Step = { slot: string; role_key: string; report?: string; message_id?: string };

export function chatWorkRequests(taskId: string): string[] {
  const rows = db
    .prepare("SELECT steps_json FROM chat_work_launches WHERE task_id = ? AND status = 'started' ORDER BY created_at")
    .all(taskId) as Array<{ steps_json: string }>;
  const lines: string[] = [];
  for (const row of rows) {
    let steps: Step[] = [];
    try { steps = JSON.parse(row.steps_json) as Step[]; } catch { continue; }
    for (const s of steps) {
      if (!s.report || !s.message_id) continue;
      lines.push(
        `- @${s.role_key}, слот ${s.slot}: когда закончишь свой шаг, СВЕРХ обычной сдачи ответь владельцу в его разговор — ` +
        `taskflow_chat_reply(message_id="${s.message_id}", text=…): коротко что сделано и ${s.report}. ` +
        "Одно сообщение, после сдачи результата; обычные итог и артефакты это не заменяет.",
      );
    }
  }
  return lines.length ? ["Просьбы владельца из разговора (только для названных шагов):", ...lines] : [];
}
