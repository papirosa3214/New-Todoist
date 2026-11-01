// Закрытие карточки закрывает всё, что под ней.
//
// Решение владельца 12.10.2026: «если я нажимаю, что они выполнены, значит
// дочерние, и все подзадачи должны закрываться с выполненным статусом».
// Раньше закрывалась только сама карточка: её шаги оставались неотмеченными,
// дочерние карточки — активными, и закрытая карточка торчала в проекте
// зачёркнутой, а дочерние продолжали числиться в работе.
//
// Вложенность задач одна (taskHierarchy.ts), поэтому достаточно одного
// уровня дочерних. Вызывать после того, как сама карточка уже переведена в
// completed.

import db from "../db.js";
import { logEvent, releaseSubtaskWork } from "../agentState.js";
import { setTaskTopicClosed } from "./projectTopics.js";
import { bumpContextVersion } from "../runtime/taskContextVersion.js";
import { releaseMissionSkills } from "./missionSkills.js";

export function closeTaskTree(taskId: string, actorId: string | null): { children: string[]; steps: number } {
  const children = (
    db
      .prepare("SELECT id FROM tasks WHERE parent_id = ? AND status = 'active' AND archived_at IS NULL")
      .all(taskId) as Array<{ id: string }>
  ).map((r) => r.id);

  let steps = 0;
  db.transaction(() => {
    const closeChild = db.prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now'),
              agent_state = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'active'`,
    );
    const markSteps = db.prepare("UPDATE subtasks SET done = 1 WHERE task_id = ? AND done = 0");
    for (const id of children) {
      if (!closeChild.run(id).changes) continue;
      logEvent({ taskId: id, actorId, kind: "state_changed", field: "status", fromValue: "active", toValue: "completed" });
    }
    for (const id of [taskId, ...children]) {
      // Сначала снять отметки «в работе» с шагов, потом отметить их сделанными:
      // иначе шаг остался бы и сделанным, и занятым исполнителем.
      releaseSubtaskWork(id);
      steps += markSteps.run(id).changes;
    }
  })();

  for (const id of children) {
    try {
      setTaskTopicClosed(id, true);
      bumpContextVersion(id);
    } catch (e) {
      console.warn(`[close-cascade] ${id}:`, e);
    }
  }
  // Навыки миссии (владелец 01.11.2026): карточка закрыта — контракт
  // выполнен, навыки миссии больше не нужны. Уходят в архив ВНЕ папки skills/,
  // чтобы Pi их не подхватил и они не влияли на будущие задачи той же роли.
  // Файл восстановим — архив рядом.
  try {
    const released = releaseMissionSkills(taskId);
    if (released.length) {
      logEvent({ taskId, actorId, kind: "mission_skills_released", field: String(released.length), toValue: released.join(", ") });
    }
  } catch (error) {
    logEvent({ taskId, actorId, kind: "mission_skills_release_failed", field: "mission_skills", toValue: error instanceof Error ? error.message : String(error) });
  }
  return { children, steps };
}
