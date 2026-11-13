// Сторож хранения рабочего чек-листа исполнителя (таблица subtask_work_plans,
// миграция 129_subtask_work_plans).
//
// 25.10.2026 проба этого сторожа упала с «no such column: OLD.id» — и это был
// не сам чек-лист: запись в subtask_work_plans тянет за собой журнал изменений
// задач (`task_changes`), а его триггеры из сборки d96358f9 ссылались на OLD
// в INSERT-триггере, где строки OLD не существует. Та же поломка ловила
// историю сдачи и пробу нагрузки ролей (заметки 9fd9eea7, cfa9d928).
//
// Отсюда правило сторожа: проба не просто сообщает о поломке, а сначала
// переустанавливает триггеры журнала из нынешнего кода и повторяет пробу.
// Старое определение триггера переживает правку кода (`CREATE TRIGGER IF NOT
// EXISTS` его не заменяет), поэтому без починки карточка починки висела бы
// вечно, а тревога повторялась после каждой выкладки.
import crypto from "node:crypto";
import db from "../db.js";
import { readWorkPlan, saveWorkPlan } from "./subtaskWorkPlan.js";
import { raiseIncident } from "./incidents.js";
import { reinstallTaskChangesLedger } from "./taskChanges.js";
import { logEvent } from "../agentState.js";

/** Проба: завести служебную карточку с подзадачей, дважды записать чек-лист
 *  (создание и обновление), прочитать и убедиться, что запись и чтение
 *  совпали. Транзакция откатывается целиком, служебных строк не остаётся. */
export function checkWorkPlanStore(): { ok: boolean; reason?: string } {
  const complete = new Error("probe_complete");
  try {
    db.transaction(() => {
      const owner = db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as any;
      if (!owner) throw new Error("Нет владельца для пробного хода");
      const id = "work-plan-probe-" + crypto.randomUUID();
      db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,?,?)").run(id, "Проба чек-листа", owner.id);
      db.prepare("INSERT INTO subtasks(id,task_id,title,done,position) VALUES(?,?,?,0,0)").run(id, id, "Проба");
      saveWorkPlan(id, owner.id, 0, [{ id: "probe", title: "Пробный этап", state: "pending" }]);
      saveWorkPlan(id, owner.id, 1, [{ id: "probe", title: "Пробный этап", state: "done" }]);
      const plan = readWorkPlan(id);
      if (plan?.revision !== 2 || plan.items[0]?.state !== "done") throw new Error("Запись/чтение этапа расходятся");
      throw complete; // rollback всей пробы, включая служебные task/subtask
    })();
  } catch (error) {
    return error === complete ? { ok: true } : { ok: false, reason: String((error as Error).message) };
  }
  return { ok: false, reason: "Проба не завершена" };
}

/** Переустановить то, что способно сломать пробу: триггеры журнала изменений
 *  задач. Свой триггер чек-листа (`work_plan_submission_tail`) ставит миграция
 *  и он идемпотентен — здесь его не трогаем, чтобы не менять сдачу подзадач. */
export function repairWorkPlanTriggers(): void {
  reinstallTaskChangesLedger();
}

export function raiseWorkPlanAlert(reason: string) {
  raiseIncident({ key: "work-plan-watch", title: "Рабочие чек-листы не сохраняются", description:
    "## Работа\nСторож не смог записать и прочитать этап: " + reason + "\nПроверить миграцию 129_subtask_work_plans, таблицу subtask_work_plans и права записи; выполнить пробу checkWorkPlanStore.\n## Результат\nИсправлено хранение рабочего плана исполнителей.\n## Критерии приёмки\nПробный этап сохраняется и обновляется, после проверки служебные строки отсутствуют.\n## Границы\nНе менять исполнение и сдачу подзадач." });
}

/** Когда поломка ушла, а карточка починки ещё открыта — отметить это в ленте,
 *  чтобы карточку можно было закрыть (иначе она висит вечно, как в 25.10→30.10). */
function noteRecovery(taskId: string) {
  try {
    const seen = db
      .prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='work_plan_recovered' LIMIT 1")
      .get(taskId);
    if (seen) return;
    logEvent({
      taskId,
      actorId: null,
      kind: "work_plan_recovered",
      field: "work_plan",
      toValue: "Проба сохранения чек-листа снова проходит — поломка ушла, карточку можно закрыть",
    });
  } catch {
    // лента — по возможности
  }
}

export function startWorkPlanWatcher() {
  const check = () => {
    let result = checkWorkPlanStore();
    if (!result.ok) {
      try {
        repairWorkPlanTriggers();
      } catch (e) {
        console.error(`[work-plan] триггеры не пересоздались: ${String((e as Error).message)}`);
      }
      result = checkWorkPlanStore();
    }
    if (result.ok) {
      const card = db
        .prepare("SELECT id FROM tasks WHERE incident_key='work-plan-watch' AND status='active' AND archived_at IS NULL LIMIT 1")
        .get() as { id: string } | undefined;
      if (card) noteRecovery(card.id);
      return;
    }
    console.error(`[work-plan] проба не прошла — ${result.reason}`);
    raiseWorkPlanAlert(result.reason ?? "Неизвестный сбой");
  };
  check();
  const timer = setInterval(check, 15 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
