import db from "../db.js";

function parentOf(taskId: string): string | null {
  const row = db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(taskId) as
    | { parent_id: string | null }
    | undefined;
  return row?.parent_id ?? null;
}

/** Корень дерева задач. Обрывает на цикле (не должно случаться, но не
 *  вешает сервер, если случится). */
export function rootTaskId(taskId: string): string {
  let current = taskId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return current;
    seen.add(current);
    const parent = parentOf(current);
    if (!parent) return current;
    current = parent;
  }
}

/** Версия контекста ветки — растёт на КОРНЕ дерева при каждом переходе
 *  любой задачи ветки в review/completed (см. вызовы в routes/tasks.ts,
 *  routes/subtasks.ts, routes/agent-state.ts). Монотонная, но не строго
 *  последовательная — пропуски не страшны: она нужна только чтобы runtime
 *  между admission и claim заметил, что дерево изменилось, и перечитал
 *  dependency_context заново (см. dependencyContext.ts). */
export function bumpContextVersion(taskId: string): number {
  const root = rootTaskId(taskId);
  db.prepare("UPDATE tasks SET context_version = context_version + 1 WHERE id = ?").run(root);
  return (db.prepare("SELECT context_version AS v FROM tasks WHERE id = ?").get(root) as { v: number }).v;
}

export function contextVersionOf(taskId: string): number {
  const root = rootTaskId(taskId);
  return (db.prepare("SELECT context_version AS v FROM tasks WHERE id = ?").get(root) as { v: number } | undefined)?.v ?? 1;
}
