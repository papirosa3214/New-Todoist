import crypto from "node:crypto";
import db from "../db.js";
import { readWorkPlan, saveWorkPlan } from "./subtaskWorkPlan.js";
import { raiseIncident } from "./incidents.js";
export function checkWorkPlanStore(): {ok:boolean; reason?:string} {
  const complete = new Error("probe_complete");
  try {
    db.transaction(() => {
      const owner = db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as any;
      if (!owner) throw new Error("Нет владельца для пробного хода");
      const id = "work-plan-probe-" + crypto.randomUUID();
      db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,?,?)").run(id,"Проба чек-листа",owner.id);
      db.prepare("INSERT INTO subtasks(id,task_id,title,done,position) VALUES(?,?,?,0,0)").run(id,id,"Проба");
      saveWorkPlan(id,owner.id,0,[{id:"probe",title:"Пробный этап",state:"pending"}]);
      saveWorkPlan(id,owner.id,1,[{id:"probe",title:"Пробный этап",state:"done"}]);
      const plan=readWorkPlan(id);
      if (plan?.revision !== 2 || plan.items[0]?.state !== "done") throw new Error("Запись/чтение этапа расходятся");
      throw complete; // rollback всей пробы, включая служебные task/subtask
    })();
  } catch (error) {
    return error === complete ? {ok:true} : {ok:false,reason:String((error as Error).message)};
  }
  return {ok:false,reason:"Проба не завершена"};
}
export function raiseWorkPlanAlert(reason:string) {
  raiseIncident({key:"work-plan-watch",title:"Рабочие чек-листы не сохраняются",description:
    "## Работа\nСторож не смог записать и прочитать этап: "+reason+"\nПроверить миграцию 129_subtask_work_plans, таблицу subtask_work_plans и права записи; выполнить пробу checkWorkPlanStore.\n## Результат\nИсправлено хранение рабочего плана исполнителей.\n## Критерии приёмки\nПробный этап сохраняется и обновляется, после проверки служебные строки отсутствуют.\n## Границы\nНе менять исполнение и сдачу подзадач."});
}
export function startWorkPlanWatcher() {
  const check=()=>{const result=checkWorkPlanStore();if(!result.ok)raiseWorkPlanAlert(result.reason ?? "Неизвестный сбой");};
  check();const timer=setInterval(check,15*60*1000);timer.unref();return ()=>clearInterval(timer);
}
