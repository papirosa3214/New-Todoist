import {describe,it,expect,vi} from "vitest";
import {Type} from "typebox";
import {createUniversalTaskflow,memoryRequestStore} from "../src/runtime/universalTaskflow.js";
import {ToolError} from "../src/runtime/inProcessRun.js";
const context={actor:"role_builder",role:"builder",mode:"work" as const,runId:"test-run"};
const tool=(execute=vi.fn(async()=>({content:[{type:"text",text:"done"}]})))=>({name:"taskflow_comment",description:"Комментарий в задачу",parameters:Type.Object({id:Type.String(),text:Type.String()}),execute});
const decode=(r:any)=>JSON.parse(r.content[0].text);
describe("universal TaskFlow",()=>{
 it("discovers by text and describes the exact schema without execution",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  expect(decode(await api.execute("1",{action:"discover",query:"Комментарий"})).data.operations[0].operation).toBe("taskflow_comment");
  expect(decode(await api.execute("2",{action:"describe",operation:t.name})).data.inputSchema.required).toEqual(["id","text"]);
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("validates nested arguments before side effects",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  expect(decode(await api.execute("3",{action:"invoke",operation:t.name,version:1,arguments:{id:5},request_id:"invalid"})).error.code).toBe("INVALID_ARGUMENTS");
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("blocks writes in planning and checks current authorization on every call",async()=>{
  const t=tool();let allowed=true;
  const api=createUniversalTaskflow([t],{...context,authorize:()=>allowed});
  allowed=false;
  expect(decode(await api.execute("4",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"deny"})).error.code).toBe("FORBIDDEN");
  const plan=createUniversalTaskflow([t],{...context,mode:"plan"});
  expect(decode(await plan.execute("5",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"plan"})).error.code).toBe("MODE_RESTRICTED");
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("rejects duplicate registrations instead of choosing a handler",()=>{
  const t=tool();expect(()=>createUniversalTaskflow([t,t],context)).toThrow(/duplicate/i);
 });
 it("показывает закрытое ролью действие в каталоге с причиной (17.10.2026)",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],{...context,authorize:()=>false});
  const found=decode(await api.execute("7",{action:"discover",query:"Комментарий"}));
  const op=found.data.operations.find((o:any)=>o.operation===t.name);
  expect(op).toBeTruthy();
  expect(op.available).toBe(false);
  expect(op.restriction.code).toBe("FORBIDDEN");
  expect(found.data.closed).toBe(1);
  const described=decode(await api.execute("8",{action:"describe",operation:t.name}));
  expect(described.data.available).toBe(false);
  expect(decode(await api.execute("9",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"closed"})).error.code).toBe("FORBIDDEN");
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("preserves media content returned by underlying adapters",async()=>{
  const t=tool(vi.fn(async()=>({content:[{type:"image",data:"AA==",mimeType:"image/png"}]})) as any);
  const api=createUniversalTaskflow([t],context);
  const r=await api.execute("6",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"media"});
  expect(r.content.some((c:any)=>c.type==="image")).toBe(true);
 });
 it("request_id внутри arguments: запись закрывается, успех не превращается в сбой",async()=>{
  const t=tool();const store=memoryRequestStore();const api=createUniversalTaskflow([t],context,store);
  const r=decode(await api.execute("7",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x",request_id:"in-args"}}));
  expect(r.ok).toBe(true);expect(r.request_id).toBe("in-args");
  expect(store.get(context.actor,"in-args")?.state).toBe("succeeded");
 });
 it("отказ по правилу — REJECTED с подсказкой; сбой хоста — по-прежнему OPERATION_FAILED",async()=>{
  const store=memoryRequestStore();
  const rule=createUniversalTaskflow([tool(vi.fn(async()=>{throw new ToolError("POST /x → 400: сначала возьми шаг",400);}) as any)],context,store);
  const rej=decode(await rule.execute("8",{action:"invoke",operation:"taskflow_comment",version:1,arguments:{id:"t",text:"x"},request_id:"rule"}));
  expect(rej.error.code).toBe("REJECTED");expect(rej.error.hint).toContain("новым request_id");
  expect(store.get(context.actor,"rule")?.state).toBe("rejected");
  const host=createUniversalTaskflow([tool(vi.fn(async()=>{throw new Error("Хост не выполнил");}) as any)],context);
  expect(decode(await host.execute("9",{action:"invoke",operation:"taskflow_comment",version:1,arguments:{id:"t",text:"x"},request_id:"host"})).error.code).toBe("OPERATION_FAILED");
 });
});

describe("режим «Обсуждение» в чате и инструменты Mac (20.10.2026)", () => {
  it("обсуждение в чате не ограничено — как работа по задаче", async () => {
    const { operationRestriction } = await import("../src/runtime/universalTaskflow.js");
    const ctx = { role: "builder", mode: "discussion" } as any;
    expect(operationRestriction("taskflow_host_bash", ctx)).toBeUndefined();
    expect(operationRestriction("taskflow_host_write", ctx)).toBeUndefined();
    expect(operationRestriction("taskflow_subtask_done", ctx)).toBeUndefined();
    expect(operationRestriction("taskflow_create_task", ctx)).toBeUndefined();
  });
});

describe("разбор отказов 20.10.2026: мелочи прощаются, остальное объясняется", () => {
  const ctx = { actor: "a", role: "builder", mode: "work", runId: "r" };
  const seen: any[] = [];
  const op = (name: string, parameters: any) => ({ name, description: name, parameters, execute: async (_: string, a: any) => { seen.push(a); return { content: [{ type: "text", text: "ok" }] }; } });
  const parse = (r: any) => JSON.parse(r.content[0].text);
  const plan = op("taskflow_work_plan", Type.Object({ base_revision: Type.Optional(Type.Number()), items: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String(), state: Type.Union([Type.Literal("pending"), Type.Literal("done")]) }))) }));
  const task = op("taskflow_task", Type.Object({ id: Type.String() }));
  const host = op("taskflow_host_read", Type.Object({ machine: Type.Optional(Type.String()), arguments: Type.Object({ path: Type.String() }) }));

  it("форма вызова приводится к схеме до проверки (карточка c8083c2a, И1)", async () => {
    const api = createUniversalTaskflow([plan as any], ctx);
    // base_revision строкой "0" — та же ревизия, другая запись.
    const r = parse(await api.execute("1", { action: "invoke", operation: "taskflow_work_plan", version: 1, request_id: "p1", arguments: { base_revision: "0" } }));
    expect(r.ok).toBe(true);
    expect(seen.at(-1).base_revision).toBe(0);
    // А неверное значение внутри элемента массива по-прежнему названо точно.
    const count=seen.length;
    const bad = parse(await api.execute("2", { action: "invoke", operation: "taskflow_work_plan", version: 1, request_id: "p2", arguments: { items: [{ id: 1, title: "t", state: "pending" }] } }));
    expect(bad.ok).toBe(false);expect(bad.error.code).toBe("INVALID_ARGUMENTS");
    expect(seen.length).toBe(count);
  });

  it("любая версия операции — та же операция; task_id становится id", async () => {
    const api = createUniversalTaskflow([task as any], ctx);
    const short=parse(await api.execute("1",{operation:"taskflow_task",arguments:{id:"T1"}}));
    expect(short.ok).toBe(true);
    const version=parse(await api.execute("3",{action:"invoke",operation:"taskflow_task",version:2,arguments:{id:"T1"}}));
    expect(version.ok).toBe(true);
    const alias=parse(await api.execute("2",{action:"invoke",operation:"taskflow_task",version:1,arguments:{task_id:"T1"}}));
    expect(alias.ok).toBe(true);
    expect(seen.at(-1).id).toBe("T1");
  });

  it("ошибка называет точное место", async () => {
    const api = createUniversalTaskflow([plan as any], ctx);
    const r = parse(await api.execute("1", { action: "invoke", operation: "taskflow_work_plan", version: 1, request_id: "p2", arguments: { items: [{ id: "1", title: "t", state: "started" }] } }));
    expect(r.error.code).toBe("INVALID_ARGUMENTS");
    expect(r.error.message).toContain("arguments.items[0].state");
  });

  it("плоский вызов host-операции кладёт параметры в arguments сам", async () => {
    const api = createUniversalTaskflow([host as any], ctx);
    const r = parse(await api.execute("1", { action: "invoke", operation: "taskflow_host_read", version: 1, request_id: "h1", arguments: { path: "a.swift" } }));
    expect(r.ok).toBe(true);
    expect(seen.at(-1).arguments).toEqual({ path: "a.swift" });
  });

  it("ключ повтора подставляется сам; занятый — сказано, что делать", async () => {
    const api = createUniversalTaskflow([plan as any], ctx);
    const сам = parse(await api.execute("call-1", { operation: "taskflow_work_plan", arguments: {} }));
    expect(сам.ok).toBe(true);
    expect(сам.request_id).toMatch(/:call-1$/);
    const пустой = parse(await api.execute("1", { operation: "taskflow_work_plan", request_id: "", arguments: {} }));
    expect(пустой.error.message).toMatch(/придумай новый/);
    await api.execute("1", { action: "invoke", operation: "taskflow_work_plan", version: 1, request_id: "k", arguments: {} });
    const занят = parse(await api.execute("1", { action: "invoke", operation: "taskflow_work_plan", version: 1, request_id: "k", arguments: { base_revision: 1 } }));
    expect(занят.error.message).toMatch(/новый request_id/);
  });
});

describe("discover: конфликт с вызовом операции",()=>{
 it.each([
  {operation:"taskflow_comment"},
  {operation:"taskflow_comment",version:1,arguments:{id:"t",text:"hello"},request_id:"conflict"},
  {arguments:{}},
 ])("объясняет конфликт %j без каталога и выполнения",async(fields)=>{
  const t=tool();const store=memoryRequestStore();const api=createUniversalTaskflow([t],context,store);
  const r=decode(await api.execute("conflict",{action:"discover",...fields}));
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe("ACTION_CONFLICT");
  expect(r.error.message).toContain('action: "discover"');
  expect(r.error.hint).toContain('"action":"describe"');
  expect(r.error.hint).toContain('"action":"invoke"');
  expect(r.error.hint).toContain("query");
  expect(r.data).toBeUndefined();
  expect(t.execute).not.toHaveBeenCalled();
  expect(store.get(context.actor,"conflict")).toBeUndefined();
 });
 it("поиск и просмотр каталога без параметров операции остаются доступны",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  for(const fields of [{},{query:"Комментарий",limit:1,offset:0}]){
   const r=decode(await api.execute("search",{action:"discover",...fields}));
   expect(r.ok).toBe(true);expect(r.data.operations[0].operation).toBe(t.name);
  }
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("после подсказки describe и invoke выполняют выбранную операцию",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  expect(decode(await api.execute("bad",{action:"discover",operation:t.name,arguments:{id:"t",text:"hello"}})).ok).toBe(false);
  expect(decode(await api.execute("schema",{action:"describe",operation:t.name})).data.inputSchema.required).toEqual(["id","text"]);
  expect(t.execute).not.toHaveBeenCalled();
  const r=decode(await api.execute("run",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"hello"},request_id:"fixed"}));
  expect(r.ok).toBe(true);expect(t.execute).toHaveBeenCalledTimes(1);
 });
});

describe("говорящие ошибки размещения параметров invoke",()=>{
 it.each(["query","limit","id"])("называет перенос %s внутрь arguments и даёт исправленный вызов",async(field)=>{
  const execute=vi.fn(async()=>({content:[]}));
  const t={name:"taskflow_task_summary",description:"summary",parameters:Type.Object({[field]:Type.String()}),execute};
  const api=createUniversalTaskflow([t],context);
  const r=decode(await api.execute("bad",{action:"invoke",operation:t.name,version:1,arguments:{},[field]:"example"}));
  expect(r.ok).toBe(false);
  expect(r.error.message).toContain(field+" → arguments."+field);
  expect(r.error.hint).toContain('"arguments":{"'+field+'":"example"}');
  expect(r.error.hint).not.toContain("discover");
  expect(execute).not.toHaveBeenCalled();
  const corrected=JSON.parse(r.error.hint.match(/Правильный вызов: (.*)\. Повтори/)[1]);
  expect(decode(await api.execute("corrected",corrected)).ok).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
 });
 it("для отсутствующего поля явно называет arguments.query",async()=>{
  const api=createUniversalTaskflow([{name:"taskflow_task_summary",description:"summary",parameters:Type.Object({query:Type.String()}),execute:vi.fn()}],context);
  const r=decode(await api.execute("bad",{action:"invoke",operation:"taskflow_task_summary",version:1,arguments:{}}));
  expect(r.error.hint).toContain("arguments.query");
  expect(r.error.hint).not.toContain("discover");
 });
});

describe("форма вызова: синонимы искомых имён и типы (И1, 21.10.2026)",()=>{
 it.each([
  {id:"t",content:"hello"},
  {task_id:"t",text:"hello"},
 ])("принимает ту же пару аргументов в другом имени %j",async(arguments_)=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  const r=decode(await api.execute("alias",{action:"invoke",operation:t.name,version:1,request_id:"alias",arguments:arguments_}));
  expect(r.ok).toBe(true);
  expect(t.execute).toHaveBeenCalledTimes(1);
 });
 it.each([
  {id:42,text:"hello"},
  {id:"t",body:"hello"},
 ])("чужое имя или чужой тип не выдумывает %j",async(arguments_)=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  const r=decode(await api.execute("strict",{action:"invoke",operation:t.name,version:1,request_id:"strict",arguments:arguments_}));
  expect(r.ok).toBe(false);expect(r.error.code).toBe("INVALID_ARGUMENTS");
  expect(t.execute).not.toHaveBeenCalled();
 });
});

describe("диагностика структуры и типов",()=>{
 const run=async(parameters:any,args:any)=>{
  const execute=vi.fn(async()=>({content:[]}));
  const api=createUniversalTaskflow([{name:"taskflow_task_summary",description:"test",parameters,execute}],context);
  const response=decode(await api.execute("bad",{action:"invoke",operation:"taskflow_task_summary",version:1,arguments:args,request_id:"diag"}));
  return {response,execute,api};
 };
 it("снимает лишний arguments в подсказке и даёт исполнимый пример",async()=>{
  const {response:r,execute,api}=await run(Type.Object({query:Type.String()}),{arguments:{query:"сводка"}});
  expect(r.error.hint).toContain("arguments.arguments.query → arguments.query");
  expect(r.error.hint).toContain("Убери лишний уровень");
  expect(execute).not.toHaveBeenCalled();
  const example=JSON.parse(r.error.hint.match(/Правильный вызов: (.*)\. Повтори/)[1]);
  expect(decode(await api.execute("fixed",example)).ok).toBe(true);
 });
 it("item-обёртка массива разворачивается и вызов идёт, а не отказывает",async()=>{
  const schema=Type.Object({base_revision:Type.Number(),items:Type.Array(Type.Object({id:Type.String(),state:Type.Union([Type.Literal("pending"),Type.Literal("done")])}))});
  const {response:r,execute}=await run(schema,{base_revision:0,items:{item:[{id:"1",state:"pending"}]}});
  expect(r.ok).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0][1]).toEqual({base_revision:0,items:[{id:"1",state:"pending"}]});
 });
 it("показывает вложенный путь, фактический тип/значение и допустимые значения",async()=>{
  const schema=Type.Object({base_revision:Type.Number(),items:Type.Array(Type.Object({id:Type.String(),state:Type.Union([Type.Literal("pending"),Type.Literal("done")])}))});
  // base_revision строкой приведён к числу, а ошибка внутри элемента массива
  // по-прежнему называет точное место и допустимые значения.
  const {response:r}=await run(schema,{base_revision:"0",items:[{id:1,state:"started"}]});
  expect(r.error.message).not.toContain("arguments.base_revision");
  expect(r.error.message).toContain("arguments.items[0].id");
  expect(r.error.message).toContain("число 1");
  expect(r.error.message).toContain('"pending"');
  expect(r.error.message).toContain('"done"');
  expect(r.error.message).not.toContain("пришли ключи");
 });
 it("не убирает обязательный вложенный arguments у host",async()=>{
  const {response:r}=await run(Type.Object({arguments:Type.Object({path:Type.String()})}),{arguments:{path:42}});
  expect(r.error.message).toContain("arguments.arguments.path");
  expect(r.error.hint).not.toContain("Убери лишний уровень");
 });
 it("не раскрывает секретное значение при ошибке типа",async()=>{
  const {response:r}=await run(Type.Object({token:Type.Number()}),{token:"private-secret-token"});
  expect(JSON.stringify(r)).not.toContain("private-secret-token");
  expect(r.error.message).toContain("arguments.token");
 });
});

describe("describe: шпаргалка вызова",()=>{
 it("возвращает форму вызова и пути обязательных значений для чтения",async()=>{
  const execute=vi.fn();
  const api=createUniversalTaskflow([{name:"taskflow_task_summary",description:"summary",parameters:Type.Object({query:Type.String({description:"Вопрос владельца"})}),execute}],context);
  const r=decode(await api.execute("schema",{action:"describe",operation:"taskflow_task_summary"}));
  expect(r.data.invokeTemplate).toEqual({operation:"taskflow_task_summary",arguments:{query:expect.any(String)}});
  expect(r.data.invokeTemplate.request_id).toBeUndefined();
  expect(r.data.templateFields).toContainEqual(expect.objectContaining({path:"arguments.query",type:"строка",required:true,description:"Вопрос владельца"}));
  expect(r.data.templateInstructions).toContain("замени");
  expect(api.description).toContain('"arguments":{"query":');
  expect(execute).not.toHaveBeenCalled();
 });
 it("для изменения не требует request_id и показывает законную вложенность host",async()=>{
  const api=createUniversalTaskflow([{name:"taskflow_host_write",description:"host",parameters:Type.Object({arguments:Type.Object({path:Type.String(),content:Type.String()})}),execute:vi.fn()}],context);
  const r=decode(await api.execute("schema",{action:"describe",operation:"taskflow_host_write"}));
  expect(r.data.invokeTemplate.request_id).toBeUndefined();
  expect(r.data.invokeTemplate.arguments.arguments).toMatchObject({path:expect.any(String),content:expect.any(String)});
  expect(r.data.templateFields.map((f:any)=>f.path)).toContain("arguments.arguments.path");
 });
 it("массив показывается массивом; перечисления и числа сохраняют тип",async()=>{
  const api=createUniversalTaskflow([{name:"taskflow_work_plan",description:"plan",parameters:Type.Object({base_revision:Type.Number(),items:Type.Array(Type.Object({id:Type.String(),state:Type.Union([Type.Literal("pending"),Type.Literal("done")])}))}),execute:vi.fn()}],context);
  const r=decode(await api.execute("schema",{action:"describe",operation:"taskflow_work_plan"}));
  expect(typeof r.data.invokeTemplate.arguments.base_revision).toBe("number");
  expect(Array.isArray(r.data.invokeTemplate.arguments.items)).toBe(true);
  expect(r.data.invokeTemplate.arguments.items[0].state).toBe("pending");
  expect(r.data.templateInstructions).toContain("числа");
 });
 it("служебный requests.status тоже показывает готовую форму",async()=>{
  const api=createUniversalTaskflow([],context);
  const r=decode(await api.execute("schema",{action:"describe",operation:"requests.status"}));
  expect(r.data.invokeTemplate.arguments.request_id).toEqual(expect.any(String));
  expect(r.data.invokeTemplate.version).toBeUndefined();
  expect(decode(await api.execute("st",{operation:"requests.status",arguments:{request_id:"нет"}})).error.code).toBe("UNKNOWN_REQUEST");
 });
});
describe("три неверных вызова подряд — остановка с готовым вызовом (20.10.2026)",()=>{
 it("на третьей ошибке даёт coach с формой; успех обнуляет счёт",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  const bad=()=>api.execute("x",{operation:t.name,arguments:{id:5}}).then(decode);
  expect((await bad()).error.coach).toBeUndefined();
  expect((await bad()).error.coach).toBeUndefined();
  const third=await bad();
  expect(third.error.code).toBe("INVALID_ARGUMENTS");
  expect(third.error.coach.message).toMatch(/СТОП/);
  expect(third.error.coach.call).toEqual({operation:t.name,arguments:{id:expect.any(String),text:expect.any(String)}});
  expect(decode(await api.execute("ok",{operation:t.name,arguments:{id:"t",text:"x"}})).ok).toBe(true);
  expect((await bad()).error.coach).toBeUndefined();
 });
});
