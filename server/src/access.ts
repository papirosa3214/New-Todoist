// Shared object-ownership lookups. A row is returned only if it belongs to
// the given user, so callers can do `if (!row) return 404` without repeating
// the ownership predicate everywhere.
import db from "./db.js";

/** Task is "owned" by its creator or its assignee (matches the /api/tasks list rule). */
export function getTaskForUser(
  taskId: string,
  userId: string,
): any | undefined {
  return db
    .prepare(
      "SELECT * FROM tasks WHERE id = ? AND (creator_id = ? OR assignee_id = ?)",
    )
    .get(taskId, userId, userId);
}

/** Only the creator may delete a task (assignees complete/update, they don't delete). */
export function getTaskForOwnerDelete(
  taskId: string,
  userId: string,
): any | undefined {
  return db
    .prepare("SELECT * FROM tasks WHERE id = ? AND creator_id = ?")
    .get(taskId, userId);
}

export function getProjectForUser(
  projectId: string,
  userId: string,
): any | undefined {
  return db
    .prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?")
    .get(projectId, userId);
}

export function getLabelForUser(
  labelId: string,
  userId: string,
): any | undefined {
  return db
    .prepare("SELECT * FROM labels WHERE id = ? AND owner_id = ?")
    .get(labelId, userId);
}

/** True if every id in `labelIds` is owned by `userId` (no missing/foreign ids). */
export function allLabelsOwnedByUser(
  labelIds: string[],
  userId: string,
): boolean {
  const unique = [...new Set(labelIds)];
  if (unique.length === 0) return true;
  const placeholders = unique.map(() => "?").join(",");
  const owned = db
    .prepare(
      `SELECT id FROM labels WHERE owner_id = ? AND id IN (${placeholders})`,
    )
    .all(userId, ...unique) as Array<{ id: string }>;
  return owned.length === unique.length;
}
