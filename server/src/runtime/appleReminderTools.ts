import crypto from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {Type} from "typebox";

type Payload={title:string;notes:string;mode:"normal"|"urgent";at?:string;key:string};
const exec=promisify(execFile);
async function send(payload:Payload):Promise<any>{
 const script=fileURLToPath(new URL("../../scripts/apple_reminders/"+(payload.mode==="urgent"?"urgent":"normal")+".py",import.meta.url));
 const args=[script,"--title",payload.title,"--notes",payload.notes,"--key",payload.key];
 if(payload.at)args.push("--at",payload.at);
 const result=await exec("python3",args,{timeout:110_000,maxBuffer:256*1024});
 return JSON.parse(result.stdout);
}
export function appleReminderTools(role:string,T:any,deliver:(p:Payload)=>Promise<any>=send):any[]{
 const common={
  title:Type.String({minLength:1,maxLength:200,description:"Название напоминания владельцу"}),
  notes:Type.Optional(Type.String({maxLength:3000,description:"Причина, контекст, ссылка или ID задачи"})),
  at:Type.Optional(Type.String({description:"ISO 8601 с часовым поясом; без значения — через минуту"})),
  key:Type.Optional(Type.String({maxLength:120,description:"Устойчивый ключ события; повтор не создаст дубль"})),
 };
 return (["normal","urgent"] as const).map(mode=>T(
  mode==="urgent"?"taskflow_notify_owner_urgent":"taskflow_notify_owner",
  mode==="urgent"?
   "Создать срочное Apple-напоминание со звуковым сигналом на iPhone владельца. Только когда нужен его ответ, разрешение или решение; reason обязателен. Обычные блоки, сдача, завершение и Заминки уведомляются сервером без срочности. taskflow_ask_user_question уже сам вызывает срочный сигнал: второе напоминание для него не создавай. Требуется доступный Mac; при ошибке напоминание не подтверждено.":
   "Создать обычное Apple-напоминание владельцу (название, время, заметка). События блокировки, сдачи, выполнения и Заминки уже отправляются автоматически — не дублируй их. Требуется доступный Mac; возвращается фактический идентификатор созданного напоминания.",
  Type.Object(mode==="urgent"?{...common,reason:Type.String({minLength:1,maxLength:500,description:"Почему требуется именно решение владельца"})}:common),
  async(p:any)=>{
   if(typeof p.title!=="string"||!p.title.trim()||p.title.length>200)throw new Error("Укажи непустое название до 200 символов");
   if(p.at&&(!/(Z|[+-]\d{2}:\d{2})$/.test(p.at)||!Number.isFinite(Date.parse(p.at))))throw new Error("Дата должна содержать часовой пояс (ISO 8601)");
   if(mode==="urgent"&&(!p.reason||!String(p.reason).trim()))throw new Error("Укажи причину обращения за решением владельца");
   const notes=("Роль: "+role+"\n"+(p.reason?"Нужен владелец: "+p.reason+"\n":"")+(p.notes??"")).slice(0,3900);
   return deliver({title:p.title.trim(),notes,mode,...(p.at?{at:p.at}:{}),key:"role:"+role+":"+(p.key||crypto.randomUUID())});
  }
 ));
}
