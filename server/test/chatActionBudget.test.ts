import {beforeAll,afterEach,it,expect,vi} from "vitest";
import crypto from "node:crypto";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {getSetting,setSetting,resetSetting,reloadServerSettings} from "../src/lib/serverSettings.js";
import {saveChatWorkPlan,submitChatWorkItem,stopChatWorkPlan} from "../src/lib/subtaskWorkPlan.js";
import {guardChatActions,reserveChatItemAction} from "../src/runtime/chatActionBudget.js";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});
afterEach(()=>{resetSetting("chat_item_max_actions",null);});
function plan(){
 const chatId=crypto.randomUUID(), messageId=crypto.randomUUID(), deliveryId=crypto.randomUUID();
 db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,?,?)").run(chatId,"direct","u1");
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text) VALUES(?,?,?,?)").run(messageId,chatId,"u1","Работай");
 db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status) VALUES(?,?,?,?,?,?,?,?)")
 .run(deliveryId,chatId,"role_builder",deliveryId,messageId,1,"{}","picked");
 saveChatWorkPlan(chatId,"role_builder",0,[{id:"one",title:"Первый",state:"pending"},{id:"two",title:"Второй",state:"pending"}]);
 return {chatId,roleId:"role_builder",messageId};
}
const reserve=(context:ReturnType<typeof plan>,callId:string)=>reserveChatItemAction({...context,callId});
it("по умолчанию десять действий; одиннадцатое отвергается до эффекта",async()=>{
 const context=plan(),execute=vi.fn(async()=>"ok"),exhausted=vi.fn();
 const [tool]=guardChatActions([{name:"bash",execute}],id=>reserve(context,id),exhausted);
 expect(getSetting("chat_item_max_actions")).toBe(10);
 for(let i=0;i<10;i++)await tool.execute("call-"+i);
 await expect(tool.execute("call-10")).rejects.toThrow(/исчерпан/);
 expect(execute).toHaveBeenCalledTimes(10);expect(exhausted).toHaveBeenCalledOnce();
});
it("успешная сдача открывает независимые десять действий следующего пункта",()=>{
 const context=plan();
 for(let i=0;i<10;i++)reserve(context,"first-"+i);
 submitChatWorkItem({...context,itemId:"one",result:"Готово",outcome:"done"});
 for(let i=0;i<10;i++)reserve(context,"second-"+i);
 expect(()=>reserve(context,"second-10")).toThrow(/исчерпан/);
});
it("новый ход и перезагрузка настроек не обнуляют расход текущего пункта",()=>{
 const context=plan();
 for(let i=0;i<7;i++)reserve(context,"before-"+i);
 reloadServerSettings();
 for(let i=0;i<3;i++)reserve(context,"after-"+i);
 expect(()=>reserve(context,"extra")).toThrow(/исчерпан/);
});
it("повышение и снижение лимита действуют на следующий вызов, сброс возвращает десять",()=>{
 const context=plan();for(let i=0;i<10;i++)reserve(context,"used-"+i);
 setSetting("chat_item_max_actions",12,null);reserve(context,"more-1");reserve(context,"more-2");
 expect(()=>reserve(context,"more-3")).toThrow(/исчерпан/);
 resetSetting("chat_item_max_actions",null);expect(getSetting("chat_item_max_actions")).toBe(10);
 expect(()=>reserve(context,"after-reset")).toThrow(/исчерпан/);
});
it("повтор прежнего действия не повторяет побочный эффект вслепую",()=>{
 const context=plan();reserve(context,"same");
 expect(()=>reserve(context,"same")).toThrow(/повтор/i);
});
it("управление планом, сдача и сообщение владельцу не тратят бюджет",async()=>{
 const reservation=vi.fn(),execute=vi.fn(async()=>"ok");
 const tools=guardChatActions(["taskflow_work_item_submit","taskflow_work_plan","taskflow_chat_reply","taskflow_tools"].map(name=>({name,execute})),reservation,vi.fn());
 for(const tool of tools)await tool.execute("control");
 expect(reservation).not.toHaveBeenCalled();expect(execute).toHaveBeenCalledTimes(4);
});
it("новое поручение после стопа получает новый бюджет",()=>{
 const context=plan();for(let i=0;i<10;i++)reserve(context,"old-"+i);
 stopChatWorkPlan(context.chatId,context.roleId);
 saveChatWorkPlan(context.chatId,context.roleId,0,[{id:"one",title:"Новое поручение",state:"pending"}]);
 expect(()=>reserve(context,"new-action")).not.toThrow();
});

it("правка будущего плана и отклонённая сдача не сбрасывают текущий бюджет",()=>{
 const context=plan();for(let i=0;i<10;i++)reserve(context,"used-"+i);
 expect(()=>submitChatWorkItem({...context,itemId:"two",result:"Пропустить",outcome:"done"})).toThrow();
 saveChatWorkPlan(context.chatId,context.roleId,1,[{id:"one",title:"Первый",state:"pending"},{id:"two",title:"Уточнённый второй",state:"pending"}]);
 expect(()=>reserve(context,"after-edit")).toThrow(/исчерпан/);
});
it("корень и ветка разговора расходуют один бюджет текущего пункта",()=>{
 const context=plan(),branch=crypto.randomUUID();
 db.prepare("INSERT INTO chats(id,kind,created_by,branch_of_chat_id) VALUES(?,?,?,?)").run(branch,"direct","u1",context.chatId);
 for(let i=0;i<6;i++)reserve(context,"root-"+i);
 for(let i=0;i<4;i++)reserveChatItemAction({chatId:branch,roleId:context.roleId,callId:"branch-"+i});
 expect(()=>reserveChatItemAction({chatId:branch,roleId:context.roleId,callId:"branch-extra"})).toThrow(/исчерпан/);
});
