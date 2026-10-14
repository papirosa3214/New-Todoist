import db from "../db.js";

/**
 * Срез знаний роли (шаг 4 схемы базы знаний, заметка cfa5cdcd).
 *
 * Срез — витрина базы знаний применительно к этой роли. Задача в нём
 * ровно одна: чтобы роль не просыпалась в вакуум. Она должна увидеть, что
 * уже работала над этими вопросами, и — главное — **где это посмотреть**.
 *
 * Что входит и что не входит:
 *
 * - Только заметки с ПОСТОЯННОЙ категорией (`kb_category`). Неразобранное
 *   и помеченное мусором не попадает: иначе в срезе окажется ровно то,
 *   что Помощник владельца назвал мусором, и роль станет читать шум.
 * - Текущая задача исключается. Срез — это прошлое; настоящее роль берёт
 *   из фактического контекста хода.
 * - Никаких счётчиков выполненного: роль не оглядывается назад.
 * - Свои формулировки роли, а не абстрактные описания функций.
 * - Пустой срез не вставляется: молчание честнее строки впустую.
 */

const MAX_ITEMS = 7;

export interface SliceItem {
  id: string;
  title: string;
  category: string;
  updatedAt: string;
}

export interface RoleSlice {
  items: SliceItem[];
  lastWorkedAt: string | null;
}

/** Заметки роли с постоянной категорией, свежие сверху. */
export function collectRoleSlice(
  actorId: string,
  excludeNoteIds: string[] = [],
  limit = MAX_ITEMS,
): RoleSlice {
  const excluded = excludeNoteIds.filter(Boolean);
  const placeholders = excluded.map(() => "?").join(",");
  const sql = `
    SELECT id, title, kb_category, updated_at
      FROM user_notes
     WHERE updated_by = ?
       AND kb_category IS NOT NULL
       AND kb_category <> 'мусор'
       ${excluded.length ? `AND id NOT IN (${placeholders})` : ""}
     ORDER BY updated_at DESC
     LIMIT ?`;
  const params: unknown[] = [actorId, ...excluded, limit];
  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    title: string | null;
    kb_category: string | null;
    updated_at: string | null;
  }>;

  const items: SliceItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const title = (r.title ?? "").trim();
    if (!title) continue;
    // Один смысловой материал — одна строка, сколько бы раз его ни
    // переписывали: список должен читаться, а не считаться.
    const key = title.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: r.id,
      title,
      category: (r.kb_category ?? "").trim(),
      updatedAt: r.updated_at ?? "",
    });
  }

  let lastWorkedAt: string | null = null;
  if (items.length === 0) {
    const any = db
      .prepare("SELECT MAX(updated_at) AS at FROM user_notes WHERE updated_by = ?")
      .get(actorId) as { at: string | null };
    lastWorkedAt = any?.at ?? null;
  }
  return { items, lastWorkedAt };
}

/** Текст блока для промта; пустая строка — блок не вставляем. */
export function buildRoleSliceText(slice: RoleSlice, roleTitle: string, now = new Date()): string {
  if (slice.items.length === 0) {
    if (!slice.lastWorkedAt) return "";
    return [
      `ТВОЁ СОСТОЯНИЕ (срез на ${fmt(now)})`,
      ``,
      `Ты — ${roleTitle}. Сейчас у тебя задач по базе знаний нет.`,
      `Последний раз ты писала в базу ${fmtTime(slice.lastWorkedAt)}.`,
      `Прежде чем браться: сверь свою память с базой знаний (taskflow_kb_search).`,
      `Закончил работу — запиши новое (taskflow_doc_write).`,
    ].join("\n");
  }
  const lines = slice.items.map((n) => `  — ${n.title} → ${n.category} · заметка #${n.id.slice(0, 8)}`);
  return [
    `ТВОЁ СОСТОЯНИЕ (срез на ${fmt(now)})`,
    ``,
    `Ты — ${roleTitle}. Вот что ты уже делала и где это лежит:`,
    ...lines,
    ``,
    `Если задача смежная с этим — сначала загляни в эти заметки, не изобретай`,
    `заново. Если это направление уже упиралось в грабли — это там записано.`,
    `Сверить память: taskflow_kb_search. Дописать своё: taskflow_doc_write.`,
  ].join("\n");
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTime(sqlTs: string): string {
  return String(sqlTs).slice(5, 16).replace("T", " ");
}