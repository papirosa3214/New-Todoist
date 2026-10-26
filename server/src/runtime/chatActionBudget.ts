import crypto from "node:crypto";
import {openBudgetCase,updateBudgetCase} from "./chatBudgetCases.js";
import db from "../db.js";
import {getSetting} from "../lib/serverSettings.js";
import {readChatWorkPlan,chatPlanViewOf,chatDeliveryRow} from "../lib/subtaskWorkPlan.js";
import {currentChatGeneration} from "./chatQueue.js";
const CONTROL = new Set(["taskflow_work_plan", "taskflow_work_item_submit", "taskflow_chat_reply", "taskflow_tools"]);
type BudgetEntry={used:number;calls:string[];caseId?:string};
export type BudgetReservation={restart?:boolean};
/** Reserve before execution. Counts belong to the server item, not the model turn. */
export function reserveChatItemAction(input:{chatId:string;roleId:string;callId:string;messageId?:string}):BudgetReservation|void {
  const decision=db.transaction(()=>{
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
    const base=Math.min(100,getSetting("chat_item_max_actions")),total=base+50;
    if(entry.used>=total)
      throw Object.assign(new Error(`Бюджет действий пункта исчерпан: ${entry.used} из ${total}; материалы сохранены в приватной карточке разбора`),{code:"CHAT_ACTION_BUDGET"});
    const restart=entry.used>=base && !entry.caseId;
    if(restart){
      entry.caseId=crypto.randomUUID();
      openBudgetCase({id:entry.caseId,chatId:plan.chat_id,roleId:input.roleId,itemId:view.current_item_id,
        title:view.items.find(i=>i.id===view.current_item_id)!.title,used:entry.used,base,total});
      counts[view.current_item_id]=entry;
      db.prepare("UPDATE chat_work_plans SET action_budget_json=? WHERE chat_id=? AND role_id=?").run(JSON.stringify(counts),plan.chat_id,input.roleId);
      // A process restart must never restore the exhausted SDK session.
      db.prepare("UPDATE chat_sessions SET pi_session_id='' WHERE chat_id=? AND role_id=?").run(plan.chat_id,input.roleId);
      return {restart:true};
    }
    counts[view.current_item_id]={...entry,used:entry.used+1,calls:[...entry.calls,input.callId]};
    db.prepare("UPDATE chat_work_plans SET action_budget_json=? WHERE chat_id=? AND role_id=?").run(JSON.stringify(counts),plan.chat_id,input.roleId);
    if(entry.caseId)updateBudgetCase(entry.caseId,entry.used+1);
    return {restart:false};
  })();
  // Throw only after the checkpoint transaction commits.
  if(decision?.restart)throw Object.assign(new Error("Основные 100 действий исчерпаны: продолжение в новой сессии на 50 действий"),{code:"CHAT_ACTION_CONTINUE"});
  return decision;
}
export function guardChatActions<T extends {name:string;execute:(...args:any[])=>any}>(
  tools:T[],reserve:(callId:string)=>BudgetReservation|void,onExhausted:()=>void,onContinued?:()=>void,
):T[]{
  let halted:unknown;
  return tools.map(tool=>({...tool,execute:async(...args:any[])=>{
    if(halted)throw halted;
    if(!CONTROL.has(tool.name)){
      try{reserve(String(args[0]??""));}
      catch(error){
        const code=(error as {code?:string}).code;
        if(code==="CHAT_ACTION_BUDGET" || code==="CHAT_ACTION_CONTINUE"){
          halted=error;
          if(code==="CHAT_ACTION_CONTINUE")onContinued?.();else onExhausted();
        }
        throw error;
      }
    }
    return tool.execute(...args);
  }}));
}

/** The model may end its answer exactly at a boundary without another tool call. */
export function assertChatBudgetAtTurnEnd(input:{chatId:string;roleId:string;messageId?:string}):void {
 const plan=readChatWorkPlan(input.chatId,input.roleId);if(!plan)return;
 const view=chatPlanViewOf(plan);if(view.status!=="active" || !view.current_item_id)return;
 const row=db.prepare("SELECT action_budget_json FROM chat_work_plans WHERE chat_id=? AND role_id=?").get(plan.chat_id,input.roleId) as {action_budget_json:string};
 const entry=JSON.parse(row.action_budget_json)[view.current_item_id] as BudgetEntry|undefined;
 const base=Math.min(100,getSetting("chat_item_max_actions"));
 if(entry && entry.used>=base && (!entry.caseId || entry.used>=base+50))
  reserveChatItemAction({...input,callId:'turn-boundary:'+crypto.randomUUID()});
}
