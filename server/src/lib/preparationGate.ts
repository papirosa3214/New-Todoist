// Утверждение плана владельцем (владелец 07.10.2026: «нет блоков для меня, моё слово главное»).
// Фоновая подготовка (модель предлагает подзадачи и роли) — помощник, а не шлагбаум: идёт она,
// упала, ждёт уточнения или карточку правили после неё — утверждение всё равно проходит.
// Чтобы запоздавший ответ модели потом не переписал утверждённое, при утверждении задания
// подготовки, которые ещё идут, гасятся (статус superseded — финальная запись у них тогда
// не выполняется, см. current() в runtime/autoPreparation.ts), а флаг «нужно уточнить»
// снимается: владелец своим утверждением ответил на вопрос.
import db from "../db.js";

export function settlePreparationOnApproval(taskId: string): void {
  db.prepare(
    "UPDATE task_preparation_jobs SET status='superseded', worker_id=NULL, lease_until=NULL, updated_at=datetime('now') WHERE task_id=? AND status IN ('queued','running')",
  ).run(taskId);
  db.prepare("UPDATE tasks SET needs_clarification=0, clarification_question=NULL WHERE id=? AND needs_clarification=1").run(taskId);
}
