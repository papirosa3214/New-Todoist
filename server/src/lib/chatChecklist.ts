// Отметки пунктов checklist-виджета в чате (карточка 21842242-9add-4628-8535-1ae3458fef40,
// владелец: «Отметки в виджете checklist должны доезжать до роли»).
//
// До 19.10.2026 состояние пунктов жило только в клиенте: роль в ленте
// taskflow_chat_read не видела ни отметки, ни реакции об отметке, отдельной
// операции чтения не было. Теперь:
//
//   1) клиент шлёт POST /api/chats/:id/messages/:messageId/checklist
//      (widget_key, item_key, done) — как у реакции на сообщение;
//   2) сервер проверяет, что такой пункт действительно есть в тексте
//      сообщения, и кладёт строку в chat_checklist_items;
//   3) роль читает состояние операцией taskflow_checklist_state.
//
// Ключи виджета и пункта — как в самом виджете: `id`/`key` блока и
// `key`/`id` пункта, а если их нет — порядковый номер (строкой). Так клиенту
// не нужно ничего изобретать: у него уже есть разобранный блок.
//
// Разбор блока — тот же, что у нормализатора виджетов (canonicalizeWidget),
// поэтому отметка ищется и в каноническом блоке, и в старом формате
// Помощника владельца (`checklists`/`checked`), и в композитном блоке.
import db from "../db.js";
import { canonicalizeWidget, widgetTypeOf } from "./widgetNormalize.js";

const WIDGET_BLOCK = /```widget[^\n]*\n([\s\S]*?)(?:```|$)/g;

export interface ChecklistItem {
  /** Ключ пункта: `key`/`id` из блока, иначе его номер строкой. */
  key: string;
  /** Подпись пункта — по ней роль сопоставляет пункт со своей задачей. */
  label: string;
  done: boolean;
}

export interface ChecklistWidget {
  /** Ключ виджета: `id`/`key` из блока, иначе номер блока в сообщении. */
  widget_key: string;
  title: string | null;
  items: ChecklistItem[];
}

export interface ChecklistMessageState {
  message_id: string;
  task_id: string | null;
  created_at: string | null;
  widgets: ChecklistWidget[];
}

const short = (value: unknown, max = 80): string =>
  String(value ?? "").trim().slice(0, max);

function checklistWidget(json: unknown, position: number): ChecklistWidget | null {
  if (widgetTypeOf(json) !== "checklist") return null;
  const obj = json as Record<string, unknown>;
  const widgetKey = short(obj.id ?? obj.key ?? obj.widget_id) || String(position);
  const title = typeof obj.title === "string" ? short(obj.title, 200) : null;
  const rawItems = Array.isArray(obj.items) ? (obj.items as unknown[]) : [];
  const items: ChecklistItem[] = [];
  rawItems.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const item = raw as Record<string, unknown>;
    const key = short(item.key ?? item.id) || String(index);
    const label = short(item.text ?? item.label ?? item.title, 300) || key;
    items.push({ key, label, done: item.done === true });
  });
  return { widget_key: widgetKey, title, items };
}

/** Все checklist-виджеты текста сообщения — в порядке блоков. */
export function checklistWidgetsOf(text: string): ChecklistWidget[] {
  const out: ChecklistWidget[] = [];
  if (typeof text !== "string" || !text.includes("```widget")) return out;
  let position = 0;
  WIDGET_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIDGET_BLOCK.exec(text)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      position += 1;
      continue; // битый блок — не наш предмет
    }
    const canonical = canonicalizeWidget(parsed) ?? parsed;
    const blocks = Array.isArray((canonical as { _composite?: unknown })._composite)
      ? ((canonical as { _composite: unknown[] })._composite)
      : [canonical];
    for (const block of blocks) {
      const widget = checklistWidget(block, position);
      if (widget) out.push(widget);
      position += 1;
    }
  }
  return out;
}

export class ChecklistItemError extends Error {}

/** Найти пункт по ключу виджета и ключу пункта (ключ — или номер строкой). */
function resolveItem(
  widgets: ChecklistWidget[],
  widgetKey: string,
  itemKey: string,
): { widget: ChecklistWidget; item: ChecklistItem } {
  const widget =
    widgets.find((w) => w.widget_key === widgetKey) ??
    widgets[Number(widgetKey)];
  if (!widget) {
    throw new ChecklistItemError(
      `В сообщении нет checklist-виджета «${widgetKey}»`,
    );
  }
  const item =
    widget.items.find((i) => i.key === itemKey) ?? widget.items[Number(itemKey)];
  if (!item) {
    throw new ChecklistItemError(
      `В виджете «${widget.title ?? widget.widget_key}» нет пункта «${itemKey}»`,
    );
  }
  return { widget, item };
}

// Ленивая подготовка: db.prepare с новой таблицей не должен падать на импорте,
// если миграция ещё не прошла (index.ts импортирует маршруты раньше, чем прогоняет
// миграции) — ровно как в chatMessages.ts.
let stateOf: import("better-sqlite3").Statement | null = null;
let rowsByChat: import("better-sqlite3").Statement | null = null;
let upsertState: import("better-sqlite3").Statement | null = null;

function prepare(): void {
  stateOf ??= db.prepare(
    `SELECT widget_key, item_key, done FROM chat_checklist_items
      WHERE message_id = ? ORDER BY widget_key, item_key`,
  );
  rowsByChat ??= db.prepare(
    `SELECT c.message_id, c.widget_key, c.item_key, c.done, c.updated_at,
            m.task_id, m.created_at
       FROM chat_checklist_items c JOIN chat_messages m ON m.id = c.message_id
      WHERE m.chat_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC`,
  );
  upsertState ??= db.prepare(
    `INSERT INTO chat_checklist_items(message_id, widget_key, item_key, done, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(message_id, widget_key, item_key)
     DO UPDATE SET done = excluded.done, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
}

/** Отметки одного сообщения — что именно хранится (без подписей). */
export function checklistStateOfMessage(messageId: string) {
  prepare();
  return (stateOf as import("better-sqlite3").Statement)
    .all(messageId)
    .map((row: any) => ({
      widget_key: row.widget_key,
      item_key: row.item_key,
      done: Boolean(row.done),
    }));
}

/** Записать отметку пункта. Бросает ChecklistItemError, если пункта нет. */
export function setChecklistItem(input: {
  messageId: string;
  text: string;
  widgetKey: string;
  itemKey: string;
  done: boolean;
  userId?: string | null;
}): ChecklistWidget {
  const widgets = checklistWidgetsOf(input.text);
  const { widget, item } = resolveItem(widgets, input.widgetKey, input.itemKey);
  prepare();
  (upsertState as import("better-sqlite3").Statement).run(
    input.messageId,
    widget.widget_key,
    item.key,
    input.done ? 1 : 0,
    input.userId ?? null,
  );
  return widget;
}

const MAX_MESSAGES = 50;
const MAX_ITEMS = 50;

/** Состояние отметок чата для роли: сообщения, у которых есть отметки, с
 *  подписями пунктов — роль сопоставляет их со своими задачами. */
export function checklistStateOfChat(chatId: string): ChecklistMessageState[] {
  prepare();
  const rows = (rowsByChat as import("better-sqlite3").Statement).all(chatId) as any[];
  if (!rows.length) return [];
  const textOf = db.prepare("SELECT text FROM chat_messages WHERE id=?");
  const byMessage = new Map<string, any[]>();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(row);
    byMessage.set(row.message_id, list);
  }
  const out: ChecklistMessageState[] = [];
  for (const [messageId, list] of byMessage) {
    if (out.length >= MAX_MESSAGES) break;
    const textRow = textOf.get(messageId) as { text?: string } | undefined;
    const widgets = checklistWidgetsOf(textRow?.text ?? "");
    const states = new Map(
      list.map((r) => [`${r.widget_key} ${r.item_key}`, Boolean(r.done)]),
    );
    const payload: ChecklistWidget[] = [];
    for (const widget of widgets) {
      if (payload.length >= MAX_ITEMS) break;
      payload.push({
        widget_key: widget.widget_key,
        title: widget.title,
        items: widget.items.slice(0, MAX_ITEMS).map((item) => ({
          key: item.key,
          label: item.label,
          done: states.get(`${widget.widget_key} ${item.key}`) ?? item.done,
        })),
      });
    }
    // Виджет из сообщения удалён или переписан — отметки всё равно показываем,
    // иначе роль решит, что пунктов нет.
    for (const row of list) {
      if (payload.some((w) => w.widget_key === row.widget_key)) continue;
      if (payload.length >= MAX_ITEMS) break;
      payload.push({
        widget_key: row.widget_key,
        title: null,
        items: [
          { key: row.item_key, label: row.item_key, done: Boolean(row.done) },
        ],
      });
    }
    out.push({
      message_id: messageId,
      task_id: list[0].task_id ?? null,
      created_at: list[0].created_at ?? null,
      widgets: payload,
    });
  }
  return out;
}