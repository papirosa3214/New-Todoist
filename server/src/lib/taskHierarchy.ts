// Вложенность задач — ровно один уровень (владелец 02.10.2026: «у дочерних
// задач не должно быть своих дочерних — семейка обрывается; чтобы это не
// просто где-то в приложении закрыто, а сломаться не могло никак»).
//
// Задача либо верхнего уровня (может иметь дочерние), либо дочерняя (своих
// дочерних не имеет). Держится в два слоя:
//   • эта проверка — понятный отказ в API и в путях, которые сами вешают
//     задачи на родителя (импорт Linear, результаты диагностики);
//   • триггеры БД (миграция 084_task_hierarchy_one_level) — последняя
//     линия: любой код, пишущий в tasks, получит отказ от самой базы.
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
  if (parent.parent_id) {
    return `«${parent.title}» сама дочерняя: вложенность в TaskFlow одна — дочернюю задачу можно повесить только на задачу верхнего уровня`;
  }
  if (taskId && db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1").get(taskId)) {
    return "у этой задачи есть свои дочерние — дочерней она стать не может, иначе вложенность станет двухуровневой";
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
  return db
    .prepare(
      `SELECT c.id, c.title, c.parent_id FROM tasks c
         JOIN tasks p ON p.id = c.parent_id
        WHERE p.parent_id IS NOT NULL`,
    )
    .all() as Array<{ id: string; title: string; parent_id: string }>;
}
