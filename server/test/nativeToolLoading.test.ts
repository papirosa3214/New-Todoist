import {beforeAll,it,expect,vi} from "vitest";
import {Type} from "typebox";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
import {TOOL_LOADER_NAME} from "../src/runtime/nativeToolLoader.js";
import {createAgentSession,SessionManager,SettingsManager} from "@earendil-works/pi-coding-agent";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});

/** Живая сессия в тесте: активный набор виден загрузчику. */
function fakeSession(){
  let active:string[]=[];
  return {
    getActiveToolNames:()=>[...active],
    setActiveToolsByName:(names:string[])=>{active=[...new Set(names)];},
    names:()=>[...active],
  };
}

it("в модель уходят группы по объектам и отдельные операции, а не весь каталог",()=>{
  const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"loading"});
  for(const name of ["taskflow_tasks","taskflow_step","taskflow_memory","taskflow_batch","taskflow_work_plan"])expect(catalog.activeNames).toContain(name);
  // Члены групп и выведенные операции не активны отдельными схемами.
  for(const name of ["taskflow","taskflow_task","taskflow_recall","taskflow_heartbeat"])expect(catalog.activeNames).not.toContain(name);
  // загрузчик подключения по требованию активен (07.11.2026)
  expect(catalog.activeNames).toContain(TOOL_LOADER_NAME);
  expect(catalog.activeNames.length).toBeLessThan(catalog.registeredNames.length);
  // Прежние имена остаются в реестре сессии и подключаются автоматически.
  expect(catalog.registeredNames).toContain("taskflow_recall");
  expect(catalog.registeredNames).toContain(TOOL_LOADER_NAME);
  expect(catalog.customTools.map(tool=>tool.name)).toContain("taskflow");
});

it("загрузчик подключает операцию по имени и отдаёт индекс остальных",async()=>{
  const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"loading"});
  const session=fakeSession();
  catalog.attachSession(session);
  const target=catalog.registeredNames.find(name=>name!==TOOL_LOADER_NAME && !catalog.activeNames.includes(name))!;
  expect(target).toBeTruthy();
  const loader=catalog.customTools.find(tool=>tool.name===TOOL_LOADER_NAME)!;
  const out=await loader.execute("call-1",{names:[target]});
  const payload=JSON.parse(out.content[0].text);
  expect(payload.activated).toContain(target);
  expect(session.names()).toContain(target);
  // Индекс — чтобы модель знала, что ещё можно подключить; подключённое из
  // индекса уходит (оно уже в списке инструментов).
  expect(payload.available.length).toBeGreaterThan(0);
  expect(payload.available.map((row:any)=>row.name)).not.toContain(target);
});

it("загрузчик подбирает операцию по смыслу запроса",async()=>{
  const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"loading"});
  const session=fakeSession();
  catalog.attachSession(session);
  const loader=catalog.customTools.find(tool=>tool.name===TOOL_LOADER_NAME)!;
  const out=await loader.execute("call-2",{query:"taskflow_doc_write"});
  const payload=JSON.parse(out.content[0].text);
  expect(payload.matches).toContain("taskflow_doc_write");
  expect(session.names()).toContain("taskflow_doc_write");
});

it("загрузчик подключает любую операцию набора — урезания по ролям нет (владелец 07.11.2026)",async()=>{
  const catalog=buildRoleToolCatalog({role:"critic_verifier",mode:"work",runId:"loading",taskId:"task"});
  const session=fakeSession();
  catalog.attachSession(session);
  const loader=catalog.customTools.find(tool=>tool.name===TOOL_LOADER_NAME)!;
  const out=await loader.execute("call-4",{names:["taskflow_subtask_done"]});
  const payload=JSON.parse(out.content[0].text);
  expect(payload.activated).toContain("taskflow_subtask_done");
});

it("загрузчик умеет подключать операцию без вызова модели",async()=>{
 const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"loading"});
 const session=fakeSession();
 catalog.attachSession(session);
 const target=catalog.registeredNames.find(name=>name!==TOOL_LOADER_NAME&&!catalog.activeNames.includes(name))!;
 catalog.loader.activate([target]);
 expect(session.names()).toContain(target);
});
it("allowlist оставляет инструменты в реестре — иначе подключить их нечем",async()=>{
  const probe=(name:string)=>({name,label:name,description:"probe",parameters:Type.Object({id:Type.Optional(Type.String())}),
    execute:async()=>({content:[{type:"text",text:"ok"}],details:{}})});
  const {session}=await createAgentSession({
    cwd:".", customTools:[probe("op_a"),probe("op_b")], tools:["op_a","op_b"],
    sessionManager:SessionManager.inMemory(), settingsManager:SettingsManager.inMemory({compaction:{enabled:false}}),
  });
  expect(session.getAllTools().map(tool=>tool.name)).toEqual(expect.arrayContaining(["op_a","op_b"]));
  session.setActiveToolsByName(["op_a"]);
  expect(session.getActiveToolNames()).toEqual(["op_a"]);
  // Сузили набор — и расширили обратно: реестр это позволяет.
  session.setActiveToolsByName(["op_a","op_b"]);
  expect(session.getActiveToolNames()).toEqual(["op_a","op_b"]);
  session.dispose();
});

it("сужение активного набора не меняет системный промпт",async()=>{
  const probe=(name:string)=>({name,label:name,description:"probe",parameters:Type.Object({id:Type.Optional(Type.String())}),
    execute:async()=>({content:[{type:"text",text:"ok"}],details:{}})});
  const {session}=await createAgentSession({
    cwd:".", customTools:[probe("op_a"),probe("op_b")], tools:["op_a","op_b"],
    sessionManager:SessionManager.inMemory(), settingsManager:SettingsManager.inMemory({compaction:{enabled:false}}),
  });
  const before=session.systemPrompt;
  session.setActiveToolsByName(["op_a"]);
  expect(session.systemPrompt).toBe(before);
  session.dispose();
});

it("подключённая операция проходит прежние проверки прав и идемпотентности",async()=>{
  const execute=vi.fn(async(_id:string,args:any)=>({content:[{type:"text",text:JSON.stringify({answer:args.query})}]}));
  const parameters=Type.Object({query:Type.String()},{additionalProperties:false});
  const catalog=buildRoleToolCatalog({role:"infra_engineer",mode:"work",runId:"loading"},[{name:"mcp__infra__probe",description:"probe",parameters,execute}]);
  const session=fakeSession();
  catalog.attachSession(session);
  const loader=catalog.customTools.find(tool=>tool.name===TOOL_LOADER_NAME)!;
  await loader.execute("call-5",{names:["mcp__infra__probe"]});
  expect(session.names()).toContain("mcp__infra__probe");
  const tool=catalog.customTools.find(t=>t.name==="mcp__infra__probe")!;
  const out=await tool.execute("call-6",{query:"health"});
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(out.content[0].text)).toEqual({answer:"health"});
});


it("чатовый конвейер может сдать текущий пункт нативным инструментом из ядра",()=>{
  const catalog=buildRoleToolCatalog({role:"builder",mode:"chat",runId:"conveyor-core",chatId:"chat",messageId:"owner-message"});
  expect(catalog.activeNames).toContain("taskflow_work_item_submit");
  const submit=catalog.customTools.find(tool=>tool.name==="taskflow_work_item_submit")!;
  expect(submit.parameters.properties.item_id.type).toBe("string");
  expect(submit.parameters.required).toContain("item_id");
});


it("нативный план чата не требует минимум этапов и объясняет явную сдачу",()=>{
 const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"description",chatId:"chat",messageId:"message"});
 const plan=catalog.customTools.find(tool=>tool.name==="taskflow_work_plan")!;
 expect(plan.description).not.toContain("3–7");
 expect(plan.description).toContain("taskflow_work_item_submit");
});
