import {beforeAll,it,expect} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {recordToolAudit} from "../src/runtime/toolAuditStore.js";
import {createUniversalTaskflow} from "../src/runtime/universalTaskflow.js";
import {toolRequestStore} from "../src/runtime/toolRequestStore.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";

beforeAll(()=>{migrate();runMigrations();});

const lastRow=(runId:string)=>db
 .prepare("SELECT id, dup_of, tool, operation, outcome, error_code FROM role_tool_audit WHERE run_id=? ORDER BY rowid DESC LIMIT 1")
 .get(runId) as {id:string;dup_of:string|null;tool:string;operation:string;outcome:string;error_code:string|null};

// D2 карточки e73e7314: событие действия по A1 содержит dup_of — «на что
// похож повтор». Колонка была заведена, но не заполнялась ни нативным
// каталогом, ни шлюзом: событие действия приходило неполным.
it("второй такой же отказ получает dup_of на первый вызов",()=>{
 const base={role:"builder",mode:"work",runId:"dup-direct",taskId:"task-d",subtaskId:"slot-d",action:"invoke",tool:"t",operation:"taskflow_task",errorCode:"INVALID_ARGUMENTS",errorMessage:"не сошлась схема",durationMs:5} as const;
 recordToolAudit({...base,outcome:"error"});
 const first=lastRow("dup-direct");
 expect(first.dup_of).toBeNull();
 recordToolAudit({...base,outcome:"error"});
 const second=lastRow("dup-direct");
 expect(second.dup_of).toBe(first.id);
});

it("другая операция и другой исход — не повтор",()=>{
 recordToolAudit({role:"builder",mode:"work",runId:"dup-mixed",taskId:"task-m",subtaskId:"slot-m",action:"invoke",tool:"t",operation:"taskflow_task",outcome:"ok"});
 const ok=lastRow("dup-mixed");
 expect(ok.dup_of).toBeNull();
 recordToolAudit({role:"builder",mode:"work",runId:"dup-mixed",taskId:"task-m",subtaskId:"slot-m",action:"invoke",tool:"t",operation:"taskflow_plan_read",outcome:"error",errorCode:"INVALID_ARGUMENTS"});
 expect(lastRow("dup-mixed").dup_of).toBeNull();
});

it("повтор в другом шаге не склеивается: сравнивается элемент действия",()=>{
 recordToolAudit({role:"builder",mode:"work",runId:"dup-item",taskId:"task-i",subtaskId:"slot-1",action:"invoke",tool:"t",operation:"taskflow_task",outcome:"error",errorCode:"INVALID_ARGUMENTS"});
 const first=lastRow("dup-item");
 recordToolAudit({role:"builder",mode:"work",runId:"dup-item",taskId:"task-i",subtaskId:"slot-2",action:"invoke",tool:"t",operation:"taskflow_task",outcome:"error",errorCode:"INVALID_ARGUMENTS"});
 expect(lastRow("dup-item").dup_of).not.toBe(first.id);
});

it("явно переданный dup_of не перезаписывается",()=>{
 recordToolAudit({role:"builder",mode:"work",runId:"dup-explicit",taskId:"task-e",subtaskId:"slot-e",action:"invoke",tool:"t",operation:"taskflow_task",outcome:"error",errorCode:"INVALID_ARGUMENTS",dupOf:"chosen-by-caller"});
 expect(lastRow("dup-explicit").dup_of).toBe("chosen-by-caller");
});

it("нативный каталог заполняет dup_of у повторного отказа SDK",()=>{
 const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"dup-native",taskId:"task-n",subtaskId:"slot-n"});
 const target=catalog.registeredNames.find((name:string)=>"taskflow_task"===name)!;
 const refuse=(callId:string)=>catalog.onToolExecutionEnd({type:"tool_execution_end",toolCallId:callId,toolName:target,isError:true,result:{content:[{type:"text",text:"- /id: Expected string, received undefined"}]}});
 refuse("dup-native-1");
 const first=lastRow("dup-native");
 expect(first.error_code).toBe("INVALID_ARGUMENTS");
 refuse("dup-native-2");
 expect(lastRow("dup-native").dup_of).toBe(first.id);
});

it("шлюз заполняет dup_of у повторного отказа операции",async()=>{
 // Операция требует поле q: два одинаковых вызова без него дают настоящий
 // отказ аргументов от самого шлюза — тот путь, который раньше не заполнял dup_of.
 const tool={name:"probe_dup",description:"dup probe",parameters:{type:"object",properties:{q:{type:"string"}},required:["q"],additionalProperties:false},execute:async()=>({content:[{type:"text",text:"ok"}]})};
 const universal=createUniversalTaskflow([tool] as any,{role:"builder",mode:"work",runId:"dup-gateway",taskId:"task-g",subtaskId:"slot-g",actor:"role_builder",executionMode:"card",authorize:()=>true},toolRequestStore);
 await universal.execute("gw-1",{action:"invoke",operation:"probe_dup",version:1,arguments:{}} as any);
 const first=lastRow("dup-gateway");
 expect(first.error_code).toBe("INVALID_ARGUMENTS");
 await universal.execute("gw-2",{action:"invoke",operation:"probe_dup",version:1,arguments:{}} as any);
 expect(lastRow("dup-gateway").dup_of).toBe(first.id);
});
