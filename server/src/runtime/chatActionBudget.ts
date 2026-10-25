import db from "../db.js";
import {getSetting} from "../lib/serverSettings.js";
import {readChatWorkPlan,chatPlanViewOf,chatDeliveryRow} from "../lib/subtaskWorkPlan.js";
import {currentChatGeneration} from "./chatQueue.js";
const CONTROL = new Set(["taskflow_work_plan", "taskflow_work_item_submit", "taskflow_chat_reply", "taskflow_tools"]);
type BudgetEntry={used:number;calls:string[]};
/** Reserve before execution. Counts belong to the server item, not the model turn. */
export function reserveChatItemAction(input:{chatId:string;roleId:string;callId:string;messageId?:string}):void {
  db.transaction(()=>{
    const plan=readChatWorkPlan(input.chatId,input.roleId);
    if(!plan)return;
    const view=chatPlanViewOf(plan);
    if(view.status!=="active" || !view.current_item_id)
      throw Object.assign(new Error("План завершён или остановлен: новые действия не выполняются"),{code:"CHAT_PLAN_CLOSED"});
    if(input.messageId){
      const delivery=chatDeliveryRow(input.chatId,input.roleId,input.messageId);
      if(!delivery || !["picked","done"].includes(delivery.status) || delivery.session_generation<currentChatGeneration(input.chatId,input.roleId))
        throw Object.assign(new Error("Действие устаревшего хода отклонено"),{code:"CHAT_RUN_STALE"});
    }
    const row=db.prepare("SELECT action_budget_json FROM chat_work_plans WHERE chat_id=? AND role_id=?").get(plan.chat_id,input.roleId) as {action_budget_json:string};
    const counts=Object.assign(Object.create(null),JSON.parse(row.action_budget_json)) as Record<string,BudgetEntry>;
    const entry=counts[view.current_item_id] ?? {used:0,calls:[]};
    if(entry.calls.includes(input.callId))
      throw Object.assign(new Error("Повтор действия отклонён: сначала проверь его прежний результат"),{code:"CHAT_ACTION_REPLAY"});
    const limit=getSetting("chat_item_max_actions");
    if(entry.used>=limit)
      throw Object.assign(new Error(`Бюджет действий пункта исчерпан: ${entry.used} из ${limit}`),{code:"CHAT_ACTION_BUDGET"});
    counts[view.current_item_id]={used:entry.used+1,calls:[...entry.calls,input.callId]};
    db.prepare("UPDATE chat_work_plans SET action_budget_json=? WHERE chat_id=? AND role_id=?").run(JSON.stringify(counts),plan.chat_id,input.roleId);
  })();
}
export function guardChatActions<T extends {name:string;execute:(...args:any[])=>any}>(
  tools:T[],reserve:(callId:string)=>void,onExhausted:()=>void,
):T[]{
  let exhausted=false;
  return tools.map(tool=>CONTROL.has(tool.name)?tool:{
    ...tool,execute:async(...args:any[])=>{
      try{reserve(String(args[0]??""));}
      catch(error){
        if((error as {code?:string}).code==="CHAT_ACTION_BUDGET" && !exhausted){exhausted=true;onExhausted();}
        throw error;
      }
      return tool.execute(...args);
    },
  });
}
