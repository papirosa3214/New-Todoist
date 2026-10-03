import db from "../db.js";

/** Префикс ошибки триггера БД — по нему маршруты узнают отказ иерархии. */
export const HIERARCHY_ERROR_PREFIX = "task_hierarchy:";

/**
 * Можно ли сделать задачу `taskId` дочерней для `parentId`. `taskId` —
 * null для ещё не созданной задачи. Возвращает текст отказа или null.
 */
export function hierarchyRefusal(taskId: string | null, parentId: string): string | null {
  if (taskId && taskId === parentId) return "задача не может быть родительской сама себе";
  const parent = db.prepare("SELECT title, parent_id FROM tasks WHERE id = ?").get(parentId) as
    | { title: string; parent_id: string | null }
    | undefined;
  if (!parent) return "нет такой родительской задачи";
  const seen = new Set<string>();
  let ancestor: string | null = parentId;
  while (ancestor) {
    if (ancestor === taskId || seen.has(ancestor)) return "вложенность задач не может содержать цикл";
    seen.add(ancestor);
    const row = db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(ancestor) as {parent_id: string | null} | undefined;
    ancestor = row?.parent_id ?? null;
  }
  return null;
}

/** Ошибка SQLite от триггера иерархии → человеческий текст; иначе null. */
export function hierarchyErrorText(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const at = message.indexOf(HIERARCHY_ERROR_PREFIX);
  return at >= 0 ? message.slice(at + HIERARCHY_ERROR_PREFIX.length).trim() : null;
}

/** Задачи, нарушающие правило (созданные до него), — для журнала при старте. */
export function hierarchyViolations(): Array<{ id: string; title: string; parent_id: string }> {
  const rows = db.prepare("SELECT id,title,parent_id FROM tasks WHERE parent_id IS NOT NULL").all() as Array<{id:string;title:string;parent_id:string}>;
  return rows.filter(row => hierarchyRefusal(row.id, row.parent_id) !== null);
}
