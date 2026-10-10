import db from "../db.js";
export type WorkPlanItem = { id: string; title: string; state: "pending" | "in_progress" | "done" };
export const WORK_PLAN_INSTRUCTION = "РАБОЧИЙ ЧЕК-ЛИСТ: перед выполнением своего слота составь короткий план конкретных действий через taskflow_work_plan. Обычно 3–7 этапов, для простой работы достаточно одного. В начале прочитай сохранённый план (инструмент без items); при продолжении используй его, не обнуляй выполненное. Перед этапом отметь его in_progress, по факту выполнения — done, при необходимости дополни список. При записи передавай весь актуальный список с устойчивыми id и base_revision из последнего ответа. Галочки не сдача и не ревью подзадачи: обычную сдачу через taskflow_subtask_done сохраняем; автоматического закрытия или запрета сдачи по чек-листу нет.";
export function validateWorkPlan(raw: unknown): WorkPlanItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw new Error("План содержит от 1 до 20 этапов");
  const ids = new Set<string>(); let current = 0;
  return raw.map(item => {
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) throw new Error("У этапов должны быть уникальные устойчивые id");
    ids.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.trim().length > 200) throw new Error("Название этапа: 1–200 символов");
    if (!["pending", "in_progress", "done"].includes(item.state)) throw new Error("Состояние этапа: pending, in_progress или done");
    if (item.state === "in_progress" && ++current > 1) throw new Error("Текущим может быть только один этап");
    return {id:item.id, title:item.title.trim(), state:item.state};
  });
}
export function readWorkPlan(subtaskId: string) {
  const row = db.prepare("SELECT * FROM subtask_work_plans WHERE subtask_id=?").get(subtaskId) as any;
  return row ? {subtask_id:subtaskId, revision:row.revision, items:JSON.parse(row.items_json), updated_at:row.updated_at, author_id:row.author_id} : null;
}
export function saveWorkPlan(subtaskId: string, authorId: string, revision: number, items: WorkPlanItem[]) {
  return db.transaction(() => {
    const existing = readWorkPlan(subtaskId);
    if ((existing?.revision ?? 0) !== revision) throw new Error("revision_conflict");
    db.prepare(`INSERT INTO subtask_work_plans(subtask_id,revision,items_json,author_id,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(subtask_id) DO UPDATE SET revision=excluded.revision,items_json=excluded.items_json,author_id=excluded.author_id,updated_at=excluded.updated_at`)
      .run(subtaskId, revision+1, JSON.stringify(items), authorId, new Date().toISOString());
    return readWorkPlan(subtaskId);
  })();
}
