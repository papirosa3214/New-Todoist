// Сдача работы в чате (владелец 14.10.2026, по образцу «Тикет 1 сдан…»).
//
// Роль, запущенная из чата, после сдачи этапа отвечает владельцу в его
// разговор (chatWorkRequests). Сам отчёт лежит документом в папке задачи,
// а в чат раньше доходила только короткая отписка. Теперь к первому ответу
// роли по этому этапу после сдачи прикладывается блок `handoff`: главное из
// отчёта («Результат» и «Что сделано») и ссылка на полный документ — клиент
// рисует его отдельной карточкой сдачи.
import db from "../db.js";
import { roleResultDocument } from "./roleResultReport.js";
import { tiptapToMarkdown } from "./tiptapToMarkdown.js";

export const HANDOFF_SECTIONS = ["Результат", "Что сделано"];

/** Только названные разделы `## …` отчёта, в исходном порядке. */
export function reportSections(markdown: string, names: string[]): string {
  const parts = markdown.split(/^(?=##[ \t]+)/m);
  return parts
    .filter(part => {
      const title = part.match(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/m)?.[1]?.trim();
      return title !== undefined && names.includes(title) && part.startsWith("##");
    })
    .map(part => part.trim())
    .join("\n\n");
}

export function chatHandoff(message: any): { note_id: string; title: string; step_title: string | null; summary: string } | null {
  if (!message?.subtask_id || !message.from_user_id) return null;
  const author = db.prepare("SELECT role_key FROM users WHERE id=?").get(message.from_user_id) as { role_key: string | null } | undefined;
  if (!author?.role_key) return null;
  const doc = roleResultDocument(message.subtask_id);
  if (!doc) return null;
  // Отчёт должен быть сдан раньше сообщения, и сдача — только у первого
  // ответа роли по этапу после отчёта: вопросы по ходу работы не трогаем.
  const reported = db.prepare("SELECT created_at FROM task_events WHERE kind=\x27role_result_report\x27 AND field=? AND to_value=? ORDER BY rowid DESC LIMIT 1").get(message.subtask_id, doc.id) as { created_at: string } | undefined;
  if (!reported || !message.created_at || message.created_at < reported.created_at) return null;
  const first = db.prepare("SELECT id FROM chat_messages WHERE chat_id=? AND subtask_id=? AND from_user_id=? AND created_at>=? ORDER BY created_at, rowid LIMIT 1")
    .get(message.chat_id, message.subtask_id, message.from_user_id, reported.created_at) as { id: string } | undefined;
  if (first?.id !== message.id) return null;
  const note = db.prepare("SELECT content FROM user_notes WHERE id=?").get(doc.id) as { content: string | null } | undefined;
  const summary = reportSections(tiptapToMarkdown(note?.content ?? null), HANDOFF_SECTIONS);
  if (!summary) return null;
  const step = db.prepare("SELECT title FROM subtasks WHERE id=?").get(message.subtask_id) as { title: string } | undefined;
  return { note_id: doc.id, title: doc.title, step_title: step?.title ?? null, summary };
}
