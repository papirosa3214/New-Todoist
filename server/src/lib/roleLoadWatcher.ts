import crypto from "node:crypto";
import db from "../db.js";
import {readRoleLoad} from "../routes/coordination.js";
import {raiseIncident} from "./incidents.js";

export function checkRoleLoad(): {ok:boolean;reason?:string} {
  const rolledBack=new Error("successful role-load probe rollback");
  try {
    db.transaction(()=>{
      const user=db.prepare("SELECT id FROM users LIMIT 1").get() as {id:string}|undefined;
      if(!user)throw new Error("No user available for probe");
      const taskId="role-load-probe-"+crypto.randomUUID(), stepId=crypto.randomUUID();
      db.prepare("INSERT INTO tasks(id,title,status,agent_state) VALUES(?,?,'completed','in_progress')").run(taskId,"Role load probe");
      db.prepare("INSERT INTO subtasks(id,task_id,title,done,agent_state,agent_id) VALUES(?,?,?,0,'in_progress',?)").run(stepId,taskId,"probe",user.id);
      db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,?,datetime('now','-7 days'))").run(crypto.randomUUID(),taskId,stepId,user.id);
      const absent=()=>{
        const data=readRoleLoad("24h");
        if(data.attempts.some(a=>a.task_id===taskId)||data.active_now.some(a=>a.task_id===taskId)||data.open_slots.some(a=>a.id===taskId))
          throw new Error("Completed task or submitted step contributes to load");
      };
      absent();
      db.prepare("UPDATE tasks SET status='active',agent_state=NULL WHERE id=?").run(taskId);
      db.prepare("UPDATE subtasks SET done=1 WHERE id=?").run(stepId);
      absent();
      db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(taskId);
      db.prepare("UPDATE attempts SET started_at=datetime('now','-2 minutes'),ended_at=datetime('now','-1 minute') WHERE task_id=?").run(taskId);
      const history=readRoleLoad("24h");
      const finished=history.attempts.find(a=>a.task_id===taskId);
      if(!finished || finished.active || history.active_now.some(a=>a.task_id===taskId))
        throw new Error("Confirmed finished work lost or treated as current");
      throw rolledBack;
    })();
  }catch(e){return e===rolledBack?{ok:true}:{ok:false,reason:String((e as Error).message)};}
  return {ok:false,reason:"Probe did not finish"};
}
export function startRoleLoadWatcher(){
  const check=()=>{
    const result=checkRoleLoad();if(result.ok)return;
    raiseIncident({key:"role-load-alert",title:"Гант учитывает завершённую работу как текущую нагрузку",description:
      "## Работа\nПроба readRoleLoad не прошла: "+result.reason+"\n## Результат\nГант отражает фактическое состояние работы.\n## Критерии приёмки\ncheckRoleLoad успешен; completed и done исключены.\n## Границы\nНе удалять карточки и журнал запусков."});
  };
  check();const timer=setInterval(check,15*60*1000);timer.unref();return()=>clearInterval(timer);
}
