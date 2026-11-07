import {beforeAll,afterAll,it,expect} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
let app:any;
let owner:string;
beforeAll(async()=>{
 app=await buildApp();seedRoleAccounts(db);
 owner=(db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as any).id;
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES('material-chat','Материалы','direct',?)").run(owner);
 for(const id of [owner,'role_builder'])db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES('material-chat',?)").run(id);
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES('material-request','material-chat',?,'Покажи отчёт','chat')").run(owner);
 db.prepare("INSERT INTO user_notes(id,title,content) VALUES(?,?,?)").run("aae18cc4-1dcc-4ea9-80a9-ee4b0e5ea9ad","Готовый отчёт",JSON.stringify({type:"doc",content:[]}));
});
afterAll(async()=>{await app.close()});
const catalog=()=>buildRoleToolCatalog({role:'builder',mode:'work',runId:'material-run',chatId:'material-chat',messageId:'material-request'});
const invoke=async(id:string)=>JSON.parse((await catalog().customTools[0].execute('share',{action:'invoke',operation:'taskflow_chat_share_material',version:1,request_id:'share-'+id,arguments:{note_id:id}}) as any).content[0].text);
it('роль отправляет существующий документ как внутреннюю ссылку, без системного вложения',async()=>{
 expect(catalog().operations.some(t=>t.name==='taskflow_chat_share_material')).toBe(true);
 const result=await invoke('aae18cc4-1dcc-4ea9-80a9-ee4b0e5ea9ad');expect(result.ok).toBe(true);
 const row=db.prepare("SELECT id,text,reply_to_message_id FROM chat_messages WHERE chat_id='material-chat' AND from_user_id='role_builder' ORDER BY rowid DESC LIMIT 1").get() as any;
 expect(row.text).toContain('note://aae18cc4-1dcc-4ea9-80a9-ee4b0e5ea9ad');
 expect(row.text).toContain('Готовый отчёт');expect(row.text).toContain('Открыть в TaskFlow');
 expect(row.reply_to_message_id).toBe('material-request');
 expect(db.prepare('SELECT count(*) n FROM attachments WHERE chat_message_id=?').get(row.id)).toEqual({n:0});
});
it('не выдумывает ссылку на отсутствующий документ',async()=>{
 const before=(db.prepare("SELECT count(*) n FROM chat_messages").get() as any).n;
 const result=await invoke('missing-note');expect(result.ok).toBe(false);
 expect((db.prepare("SELECT count(*) n FROM chat_messages").get() as any).n).toBe(before);
});
it('без контекста чата инструмент объясняет ограничение',async()=>{
 const c=buildRoleToolCatalog({role:'builder',mode:'work',runId:'material-no-context',taskId:'task'});
 const r=JSON.parse((await c.customTools[0].execute('describe',{action:'describe',operation:'taskflow_chat_share_material'}) as any).content[0].text);
 expect(r.data.restriction.code).toBe('CONTEXT_REQUIRED');
});

it('запись документа возвращает готовый material со ссылкой вместо голого ID',async()=>{
 const c=catalog();
 const response=JSON.parse((await c.customTools[0].execute('write',{action:'invoke',operation:'taskflow_doc_write',version:1,request_id:'write-material-link',arguments:{id:'aae18cc4-1dcc-4ea9-80a9-ee4b0e5ea9ad',markdown:'Дополнение отчёта'}}) as any).content[0].text);
 expect(response.ok).toBe(true);
 const data=JSON.parse(response.data.content[0].text);
 expect(data.material).toMatchObject({kind:'document',ref:'note://aae18cc4-1dcc-4ea9-80a9-ee4b0e5ea9ad'});
});
