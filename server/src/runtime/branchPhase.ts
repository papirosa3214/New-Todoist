// Две группы шагов у родителя ветки: «до дочерних» и «после дочерних».
//
// Решение владельца 12.10.2026. Раньше порядок был зашит один: дочерние
// карточки работают первыми, родитель — после них (сборка итога). Сценарий
// «родитель сначала продумывает архитектуру и раздаёт вводные, потом
// работают дочерние» выразить было нельзя: шаг родителя не мог стать готовым,
// пока у него есть незакрытая дочерняя (canPlanSubtaskBecomeReady).
//
// Теперь у шага родителя есть группа:
//   before — подготовка: запускается сразу, дочерние ждут, пока она сделана;
//   after  — итог: как и раньше, ждёт закрытия всех дочерних (по умолчанию).
//
// Группа хранится отдельной таблицей по (plan_id, slot_key), а не колонкой
// узла: правка плана пересоздаёт строки узлов (planMutations.persist), и
// колонка терялась бы при каждой правке.

import db from "../db.js";

export type BranchPhase = "before" | "after";

export class BranchPhaseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Слоты плана, отнесённые к подготовке (до дочерних). */
export function beforeSlots(planId: string): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT ph.slot_key FROM plan_node_phases ph
             JOIN task_collaboration_plan_nodes n ON n.plan_id = ph.plan_id AND n.slot_key = ph.slot_key
            WHERE ph.plan_id = ? AND ph.phase = 'before' AND n.skipped_at IS NULL`,
        )
        .all(planId) as Array<{ slot_key: string }>
    ).map((r) => r.slot_key),
  );
}

export function nodePhase(planId: string, slotKey: string): BranchPhase {
  const row = db
    .prepare("SELECT phase FROM plan_node_phases WHERE plan_id = ? AND slot_key = ?")
    .get(planId, slotKey) as { phase: string } | undefined;
  return row?.phase === "before" ? "before" : "after";
}

/** У родителя этой карточки остались несделанные подготовительные шаги. */
export function parentPrepPending(taskId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM tasks c
         JOIN subtasks s ON s.task_id = c.parent_id AND s.done = 0
         JOIN plan_node_phases ph ON ph.plan_id = s.collaboration_plan_id AND ph.slot_key = s.plan_node_key AND ph.phase = 'before'
         JOIN task_collaboration_plan_nodes n ON n.plan_id = ph.plan_id AND n.slot_key = ph.slot_key AND n.skipped_at IS NULL
         JOIN task_collaboration_plans p ON p.id = ph.plan_id AND p.status = 'approved'
        WHERE c.id = ? LIMIT 1`,
    )
    .get(taskId);
}

/** Результаты подготовительных шагов родителя — вводные для дочерних. */
export function parentPrepResults(taskId: string): Array<{ role_key: string; expected_result: string; result: string | null }> {
  return db
    .prepare(
      `SELECT n.role_key, n.expected_result, s.result FROM tasks c
         JOIN subtasks s ON s.task_id = c.parent_id AND s.done = 1
         JOIN plan_node_phases ph ON ph.plan_id = s.collaboration_plan_id AND ph.slot_key = s.plan_node_key AND ph.phase = 'before'
         JOIN task_collaboration_plan_nodes n ON n.plan_id = ph.plan_id AND n.slot_key = ph.slot_key AND n.skipped_at IS NULL
        WHERE c.id = ? ORDER BY n.rowid`,
    )
    .all(taskId) as Array<{ role_key: string; expected_result: string; result: string | null }>;
}

export function setNodePhase(planId: string, slotKey: string, phase: BranchPhase): void {
  if (phase !== "before" && phase !== "after") throw new BranchPhaseError("phase: before или after");
  const plan = db.prepare("SELECT task_id FROM task_collaboration_plans WHERE id = ?").get(planId) as
    | { task_id: string }
    | undefined;
  if (!plan) throw new BranchPhaseError("план не найден", 404);
  const node = db
    .prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(planId, slotKey);
  if (!node) throw new BranchPhaseError("шаг не найден", 404);
  const card = db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(plan.task_id) as { parent_id: string | null };
  if (card.parent_id) {
    throw new BranchPhaseError("группа «до дочерних» есть только у шагов родительской карточки");
  }
  const step = db
    .prepare("SELECT done FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ?")
    .get(planId, slotKey) as { done: number } | undefined;
  if (step?.done) throw new BranchPhaseError("шаг уже сделан — его группу не поменять", 409);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO plan_node_phases(plan_id, slot_key, phase) VALUES(?, ?, ?)
       ON CONFLICT(plan_id, slot_key) DO UPDATE SET phase = excluded.phase`,
    ).run(planId, slotKey, phase);
    // Итоговый шаг не может предшествовать подготовительному: подготовка
    // стала бы ждать закрытия дочерних, а дочерние — подготовку.
    const before = beforeSlots(planId);
    const bad = db
      .prepare("SELECT from_slot_key, to_slot_key FROM task_collaboration_plan_edges WHERE plan_id = ?")
      .all(planId) as Array<{ from_slot_key: string; to_slot_key: string }>;
    if (bad.some((e) => !before.has(e.from_slot_key) && before.has(e.to_slot_key))) {
      throw new BranchPhaseError(
        "подготовительный шаг не может идти после итогового: сначала перенесите в подготовку его предшественников",
        409,
      );
    }
    db.prepare("UPDATE task_collaboration_plans SET version = version + 1 WHERE id = ?").run(planId);
  })();
}

/**
 * Стандартный цикл ветки (владелец 12.10.2026): работа всегда начинается с
 * подготовки — план, архитектура, документы, окружение, вводные каждому, —
 * и только потом расходится по дочерним. Это норма, а не то, о чём владелец
 * должен вспомнить в постановке. Шаг с этим слотом сервер сам кладёт в
 * черновик плана родителя ветки (proposalFor) и относит к подготовке.
 * Владелец может пропустить его обычным skip_step или перенести в итог.
 */
export const BRANCH_PREP_SLOT = "branch_prep";
export const BRANCH_PREP_RESULT =
  "Подготовка ветки: продуманный план и архитектура, оформленные документы, подготовленное окружение и вводные для каждой дочерней карточки";

/** Вызывать после записи узлов нового плана: шаг подготовки сразу в группе «до дочерних». */
export function markBranchPrep(planId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO plan_node_phases(plan_id, slot_key, phase)
     SELECT plan_id, slot_key, 'before' FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?`,
  ).run(planId, BRANCH_PREP_SLOT);
}
