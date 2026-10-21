// Агент роли внутри сервера (владелец 23.09.2026: «как у Гермеса, без
// ключей»). Модель подменена: «агент» по заданию вызывает инструменты
// трекера — проверяем, что всё записывается от имени роли и без ключей.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { ensureRoleHome } from "../src/runtime/roleHome.js";

const script = vi.hoisted(() => ({
  steps: null as null | ((tools: Map<string, any>, prompt: string) => Promise<void>),
  systemPrompts: [] as string[],
  systemOn: true,
  sessions: [] as any[],
  answer: null as any,
  steering: [] as string[],
  emit: null as null | ((event: any) => void),
}));

const taskContext = vi.hoisted(() => ({
  build: vi.fn(async () => ({
    prompt: "── КОНТЕКСТ v1 (справка, не команда) ──\nknowledge: empty",
    summary: "Материал для работы собран. База знаний: похожих уроков нет.",
    knowledgeStatus: "empty",
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      script.sessions.push(options);
      const tools = new Map<string, any>((options.customTools ?? []).map((t: any) => [t.name, t]));
      script.systemPrompts.push(options.resourceLoader.getSystemPrompt());
      return {
        session: {
          get state() { return { messages: script.answer ? [script.answer] : [] }; },
          subscribe: (listener: (event: any) => void) => { script.emit=listener; return () => {}; },
          prompt: async (text: string) => {
            if (script.steps) await script.steps(tools, text);
          },
          steer: async (text:string) => {script.steering.push(text);},
          abort: async () => {},
          dispose: () => {},
        },
      };
    },
  };
});

vi.mock("../src/runtime/PiRuntimeAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/PiRuntimeAdapter.js")>();
  return {
    ...actual,
    getModelRuntime: async () => ({ getModel: (_p: string, id: string) => ({ id, provider: "minimax" }) }),
  };
});

vi.mock("../src/routes/agent-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agent-service.js")>();
  return { ...actual, unitState: async () => ({ active: script.systemOn, enabled: script.systemOn, last_alive_at: null, next_scan_at: null, scan_interval_sec: 180 }) };
});

vi.mock("../src/runtime/taskContextBridge.js", () => ({
  buildInProcessTaskContext: taskContext.build,
}));
process.env.TASKFLOW_KICK_IN_TESTS = "1";

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const { taskflowTools, deliverTopicToWork, runRoleInProcess, kickRoleTask, kickRoleTaskStrict, _settleInProcessRunsForTests } = await import("../src/runtime/inProcessRun.js");
const { buildDependencyContext } = await import("../src/runtime/dependencyContext.js");
const { contextVersionOf } = await import("../src/runtime/taskContextVersion.js");
const { roleUserId } = await import("../src/roleRouting.js");

describe("агент роли внутри сервера", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "InProcOwner", email: `inproc-owner-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    ownerToken = reg.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function builderTask(title: string): { taskId: string; stepId: string } {
    const taskId = `inproc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO tasks (id, title, creator_id, status, assignee_id, dispatched_role, ready_for_pickup)
       VALUES (?, ?, ?, 'active', 'role_builder', 'builder', 1)`,
    ).run(taskId, title, ownerId);
    const stepId = `${taskId}-s1`;
    db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, 'Сделать', 1)").run(stepId, taskId);
    return { taskId, stepId };
  }

  const call = (tools: Map<string, any>, name: string, params: any) =>
    tools.get(name).execute(`call-${name}`, params);

  it("командные инструменты работают по слоту без исполнителя карточки и разрешения на карточку", async () => {
    const {taskId,stepId}=builderTask("Слот без захвата карточки");
    db.prepare("UPDATE tasks SET assignee_id=NULL,ready_for_pickup=0 WHERE id=?").run(taskId);
    const planId=taskId+"-plan";
    db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES(?,?,99,'approved','manual','test',?)").run(planId,taskId,ownerId);
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,?,'work','builder',1,'Код')").run(planId+"-node",planId);
    db.prepare("UPDATE subtasks SET collaboration_plan_id=?,plan_node_key='work',agent_id='role_builder' WHERE id=?").run(planId,stepId);
    const tools=new Map(taskflowTools("builder",null,taskId,stepId).map((t:any)=>[t.name,t]));
    expect(tools.has("taskflow_claim")).toBe(false);
    await call(tools,"taskflow_subtask_work",{id:stepId,state:"in_progress"});
    await call(tools,"taskflow_heartbeat",{id:taskId});
    const mine=await call(tools,"taskflow_my_tasks",{state:"in_progress"});
    expect(JSON.stringify(mine)).toContain(taskId);
    await call(tools,"taskflow_comment",{id:taskId,text:"Работаю в назначенном слоте"});
    await call(tools,"taskflow_state",{id:taskId,state:"blocked",block_type:"needs_input",comment:"Нужен доступ"});
    expect((db.prepare("SELECT agent_state FROM subtasks WHERE id=?").get(stepId) as any).agent_state).toBe("blocked");
    expect((db.prepare("SELECT assignee_id,ready_for_pickup FROM tasks WHERE id=?").get(taskId) as any)).toMatchObject({assignee_id:null,ready_for_pickup:0});
  });

  it("действия терминала поступают в live-поток с допустимым типом run", async () => {
    const {taskId}=builderTask("Живой поток терминала");
    script.steps=async(tools)=>{
      await call(tools,"taskflow_claim",{id:taskId});
      script.emit?.({type:"tool_execution_start",toolName:"bash",args:{command:"pwd"}});
      let actions:any[]=[];
      for(let i=0;i<20 && !actions.length;i++) {
        await new Promise(r=>setTimeout(r,10));
        const response=await app.inject({method:"GET",url:`/api/tasks/${taskId}/activity`,headers:{authorization:`Bearer ${ownerToken}`}});
        actions=response.json().actions;
      }
      expect(actions.some(a=>a.kind==="run"&&a.target==="pwd")).toBe(true);
    };
    try {const run=await runRoleInProcess({taskId,role:"builder",mode:"work"});await run.completion;}
    finally {script.steps=null;}
  });

  it("сообщение темы попадает в активную SDK сессию без второго запуска",async()=>{
    const {taskId}=builderTask("Обсудить текущую работу");
    let entered!:()=>void, release!:()=>void;
    const started=new Promise<void>(r=>entered=r);
    const gate=new Promise<void>(r=>release=r);
    script.steering=[];
    script.steps=async()=>{entered();await gate;};
    const run=await runRoleInProcess({taskId,role:"builder",mode:"reply"});
    await started;
    try {
      const count=script.sessions.length;
      // Сообщение подмешано в текущую работу роли — это «working», а не «queued»
      // (очередь ждёт слота, здесь сообщение уже в ходе).
      expect(await deliverTopicToWork(taskId,"builder","message-1","Уточни формат")).toBe("working");
      expect(script.steering).toHaveLength(1);
      expect(script.steering[0]).toContain("message-1");
      expect(script.sessions).toHaveLength(count);
      const headers={authorization:`Bearer ${ownerToken}`};
      const project=(await app.inject({method:"POST",url:"/api/projects",headers,payload:{name:"Тема активного запуска"}})).json();
      db.prepare("UPDATE tasks SET project_id=? WHERE id=?").run(project.id,taskId);
      const topic=(await app.inject({method:"POST",url:`/api/tasks/${taskId}/topic`,headers,payload:{}})).json().chat;
      await app.inject({method:"POST",url:`/api/chats/${topic.id}/members`,headers,payload:{member_id:"role_builder"}});
      const sent=await app.inject({method:"POST",url:`/api/chats/${topic.id}/messages`,headers,payload:{text:"@builder Уточнение из темы"}});
      expect(sent.statusCode).toBe(200);
      expect(script.steering).toHaveLength(2);
      expect(script.steering[1]).toContain(sent.json().message.id);
      expect(script.sessions).toHaveLength(count);
      expect(await deliverTopicToWork(taskId,"qa","message-2","Проверь")).toBe("idle");
    } finally {release();await run.completion;script.steps=null;}
  });

  it("личный вопрос из другой задачи доставляется работающему коллеге; его ответ возвращается в исходный чат",async()=>{
    const {taskId,stepId}=builderTask("Коллега занят другой задачей");
    db.prepare("UPDATE subtasks SET agent_id='role_builder' WHERE id=?").run(stepId);
    const source=builderTask("Вопрос архитектора"),other=source.taskId;
    db.prepare("UPDATE subtasks SET agent_id='role_architect' WHERE id=?").run(source.stepId);
    const chat=(await app.inject({method:"POST",url:"/api/chats",headers:{authorization:`Bearer ${app.jwt.sign({id:'role_architect'})}`},payload:{kind:"direct",member_ids:["role_builder"]}})).json().chat.id;
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    let starts=0;
    script.steering=[];script.steps=async()=>{if(++starts===2)entered();await gate;};
    const run=await runRoleInProcess({taskId,role:"builder",subtaskId:stepId,prompt:"Обсудить",mode:"reply"});
    const author=await runRoleInProcess({taskId:other,role:"architect",subtaskId:source.stepId,prompt:"Обсудить",mode:"reply"});
    await started;
    try{
      const count=script.sessions.length;
      const sent=await app.inject({method:"POST",url:`/api/chats/${chat}/messages`,headers:{authorization:`Bearer ${app.jwt.sign({id:'role_architect'})}`},payload:{text:"Какой формат сохранять?",task_id:other,subtask_id:source.stepId}});
      expect(sent.statusCode).toBe(200);
      expect(script.steering).toHaveLength(1);
      expect(script.steering[0]).toContain(sent.json().message.id);
      expect(script.sessions).toHaveLength(count);
      expect(db.prepare("SELECT status FROM chat_message_queue WHERE message_id=? AND role_id='role_builder'").get(sent.json().message.id)).toMatchObject({status:"pending"});
      expect(db.prepare("SELECT delivered_at FROM slot_topic_inbox WHERE message_id=? AND subtask_id=?").get(sent.json().message.id,stepId)).toMatchObject({delivered_at:null});
      const tools=new Map(taskflowTools("builder",null,taskId,stepId).map((t:any)=>[t.name,t]));
      const result=await call(tools,"taskflow_chat_reply",{message_id:sent.json().message.id,text:"Сохраняй JSON"});
      const response=JSON.parse(result.content[0].text);
      expect(db.prepare("SELECT from_user_id,reply_to_message_id,subtask_id FROM chat_messages WHERE id=?").get(response.id)).toMatchObject({from_user_id:"role_builder",reply_to_message_id:sent.json().message.id,subtask_id:stepId});
      expect((db.prepare("SELECT * FROM subtasks WHERE id=?").get(stepId) as any).done).toBe(0);
      expect(script.steering).toHaveLength(2);
      expect(script.steering[1]).toContain(response.id);
      expect(db.prepare("SELECT status FROM chat_message_queue WHERE message_id=? AND role_id='role_builder'").get(sent.json().message.id)).toMatchObject({status:"done"});
      const manager=script.sessions.at(-1).sessionManager;
      manager.appendMessage({role:"user",content:script.steering[1],timestamp:Date.now()});
      manager.appendMessage({role:"assistant",content:[{type:"text",text:"Учёл ответ и продолжил работу"}],timestamp:Date.now()});
      script.emit?.({type:"message_end",message:{role:"assistant",content:[]}});
      await Promise.resolve();
      expect(db.prepare("SELECT status FROM chat_message_queue WHERE message_id=? AND role_id='role_architect'").get(response.id)).toMatchObject({status:"done"});
      expect(script.sessions).toHaveLength(count);
    }finally{release();await Promise.all([run.completion,author.completion]);script.steps=null;}
  });

  it("личный мессенджер не выбирает произвольный этап при двух работающих сессиях роли",async()=>{
    const firstTask=builderTask("Первый этап мессенджера"),secondTask=builderTask("Второй этап мессенджера");
    let entered!:()=>void,release!:()=>void,starts=0;
    const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    script.steering=[];script.steps=async()=>{if(++starts===2)entered();await gate;};
    const first=await runRoleInProcess({taskId:firstTask.taskId,role:"builder",subtaskId:firstTask.stepId,prompt:"Обсудить",mode:"reply"});
    const second=await runRoleInProcess({taskId:secondTask.taskId,role:"builder",subtaskId:secondTask.stepId,prompt:"Обсудить",mode:"reply"});
    await started;
    try{
      const before=(db.prepare("SELECT count(*) n FROM chat_messages").get() as any).n;
      const messenger=new Map(taskflowTools("qa",null).map((t:any)=>[t.name,t]));
      await expect(call(messenger,"taskflow_chat_send",{to:"builder",text:"Который этап сейчас?"})).rejects.toThrow("несколько работающих этапов");
      expect((db.prepare("SELECT count(*) n FROM chat_messages").get() as any).n).toBe(before);
      expect(script.steering).toHaveLength(0);
    }finally{release();await Promise.all([first.completion,second.completion]);script.steps=null;}
  });

  it("групповой вопрос двум работающим ролям сохраняет отдельный адрес каждого ответа",async()=>{
    const a=builderTask("Работа билдера в группе"),b=builderTask("Работа архитектора в группе");
    db.prepare("UPDATE subtasks SET agent_id='role_builder' WHERE id=?").run(a.stepId);
    db.prepare("UPDATE subtasks SET agent_id='role_architect' WHERE id=?").run(b.stepId);
    const headers={authorization:`Bearer ${ownerToken}`};
    const chat=(await app.inject({method:"POST",url:"/api/chats",headers,payload:{kind:"group",member_ids:["role_builder","role_architect"]}})).json().chat.id;
    let entered!:()=>void,release!:()=>void,starts=0;
    const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    script.steps=async()=>{if(++starts===2)entered();await gate;};
    const first=await runRoleInProcess({taskId:a.taskId,role:"builder",subtaskId:a.stepId,prompt:"Обсудить",mode:"reply"});
    const second=await runRoleInProcess({taskId:b.taskId,role:"architect",subtaskId:b.stepId,prompt:"Обсудить",mode:"reply"});
    await started;
    try{
      const sent=await app.inject({method:"POST",url:`/api/chats/${chat}/messages`,headers,payload:{text:"@builder @architect Уточните формат"}});
      expect(sent.statusCode).toBe(200);
      for(const [role,t] of [["builder",a],["architect",b]] as const){
        const tools=new Map(taskflowTools(role,null,t.taskId,t.stepId).map((x:any)=>[x.name,x]));
        await call(tools,"taskflow_chat_reply",{message_id:sent.json().message.id,text:"Формат JSON"});
      }
      const rows=db.prepare("SELECT status FROM chat_message_queue WHERE message_id=?").all(sent.json().message.id) as any[];
      expect(rows).toHaveLength(2);expect(rows.every(q=>q.status==='done')).toBe(true);
    }finally{release();await Promise.all([first.completion,second.completion]);script.steps=null;}
  });

  it("работа начавшаяся во время ожидания чата получает вопрос без ложного failed",async()=>{
    const {enqueueChatReply}=await import("../src/runtime/chatSession.js");
    const a=builderTask("Работа стартует после приёма сообщения");
    db.prepare("UPDATE subtasks SET agent_id='role_builder' WHERE id=?").run(a.stepId);
    const headers={authorization:`Bearer ${ownerToken}`};
    const chat=(await app.inject({method:"POST",url:"/api/chats",headers,payload:{kind:"direct",member_ids:["role_builder"]}})).json().chat.id;
    let releaseQueue!:()=>void;
    const queueGate=new Promise<void>(r=>releaseQueue=r);
    const occupied=enqueueChatReply(chat,"role_builder",async()=>{await queueGate;return null;});
    const sent=await app.inject({method:"POST",url:`/api/chats/${chat}/messages`,headers,payload:{text:"Вопрос перед запуском работы"}});
    let entered!:()=>void,releaseWork!:()=>void;
    const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>releaseWork=r);
    script.steering=[];script.steps=async()=>{entered();await gate;};
    const run=await runRoleInProcess({taskId:a.taskId,role:"builder",subtaskId:a.stepId,prompt:"Обсудить",mode:"reply"});
    await started;
    try{
      releaseQueue();await occupied;
      await vi.waitFor(()=>expect(script.steering).toHaveLength(1));
      await vi.waitFor(()=>expect(db.prepare("SELECT status FROM chat_message_queue WHERE message_id=?").get(sent.json().message.id)).toMatchObject({status:"pending"}));
    }finally{releaseQueue();releaseWork();await run.completion;script.steps=null;}
  });

  it("recovery не доставляет работающей роли сообщение после отзыва доступа к чату",async()=>{
    const {recoverAgentDelivery}=await import("../src/routes/chats.js");
    const {enqueueMessageDelivery:recordDurableDelivery}=await import("../src/runtime/chatQueue.js");
    const a=builderTask("Отзыв доступа к переписке");
    const headers={authorization:`Bearer ${ownerToken}`};
    const chat=(await app.inject({method:"POST",url:"/api/chats",headers,payload:{kind:"direct",member_ids:["role_builder"]}})).json().chat.id;
    const message=a.taskId+'-message';
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,'Вопрос до восстановления','chat',?)").run(message,ownerId,chat);
    const queued=recordDurableDelivery({chatId:chat,roleId:'role_builder',deliveryId:message,messageId:message,payload:{text:'Вопрос до восстановления'}});
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    script.steering=[];script.steps=async()=>{entered();await gate;};
    const run=await runRoleInProcess({taskId:a.taskId,role:"builder",prompt:"Обсудить",mode:"reply"});
    await started;
    try{
      expect((await app.inject({method:"DELETE",url:`/api/chats/${chat}/members/role_builder`,headers})).statusCode).toBe(200);
      expect(await recoverAgentDelivery({chatId:chat,roleId:'role_builder',deliveryId:queued.id})).toMatchObject({status:'fenced'});
      expect(script.steering).toHaveLength(0);
    }finally{release();await run.completion;script.steps=null;}
  });

  it("два слота одной роли требуют адресации конкретного слота",async()=>{
    const {taskId,stepId}=builderTask("Две ветки");
    const second=`${taskId}-s2`;
    db.prepare("UPDATE subtasks SET plan_node_key='first_slot' WHERE id=?").run(stepId);
    db.prepare("INSERT INTO subtasks(id,task_id,title,position,plan_node_key) VALUES (?,?,'Вторая',2,'second_slot')").run(second,taskId);
    let entered!:()=>void, release!:()=>void, starts=0;
    const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    script.steering=[];
    script.steps=async()=>{starts++;if(starts===2)entered();await gate;};
    const first=await runRoleInProcess({taskId,role:"builder",subtaskId:stepId,prompt:"Обсудить",mode:"reply"});
    const next=await runRoleInProcess({taskId,role:"builder",subtaskId:second,prompt:"Обсудить",mode:"reply"});
    await started;
    try {
      // slot_topic_inbox.message_id — FK на chat_messages: очередь слота хранит
      // ссылку на настоящее сообщение, поэтому заводим его, а не подставляем
      // произвольный токен.
      const msg = db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel) VALUES (?,?,?,'agents')");
      msg.run("ambiguous", ownerId, "Вопрос");
      msg.run("targeted", ownerId, "Вопрос");
      expect(await deliverTopicToWork(taskId,"builder","ambiguous","Вопрос")).toBe("busy");
      expect(script.steering).toHaveLength(0);
      expect(await deliverTopicToWork(taskId,"builder","targeted","Вопрос","second_slot")).toBe("working");
      expect(script.steering).toHaveLength(1);
    } finally {release();await Promise.all([first.completion,next.completion]);script.steps=null;}
  });

  it("задача получает AGENTS и skills своей роли, а write остаётся в проекте", async () => {
    const { taskId } = builderTask("Ресурсы роли в проекте");
    const home = ensureRoleHome("builder");
    const agentsBefore = fs.readFileSync(home.agents, "utf8");
    const skill = path.join(home.skills, "task-probe", "SKILL.md");
    const project = path.join(home.workspace, "project-probe");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(skill, "---\nname: task-probe\ndescription: Task probe\n---\nProbe.\n");
    fs.writeFileSync(home.agents, "Инструкции именно разработчика");
    script.steps = null;
    try {
      const run = await runRoleInProcess({ taskId, role: "builder", cwd: project });
      await run.completion;
      const options = script.sessions.at(-1);
      expect(options.cwd).toBe(project);
      expect(options.resourceLoader.getSkills().skills.map((s: any) => s.name)).toContain("task-probe");
      expect(options.resourceLoader.getAgentsFiles().agentsFiles[0].content).toBe("Инструкции именно разработчика");
      const write = options.customTools.find((t: any) => t.name === "write");
      await write.execute("probe", { path: "result.txt", content: "project result" });
      expect(fs.readFileSync(path.join(project, "result.txt"), "utf8")).toBe("project result");
    } finally {
      fs.writeFileSync(home.agents, agentsBefore);
      fs.rmSync(path.dirname(skill), { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("выключенная Система допускает только явный запуск владельца и завершение текущего захода", async () => {
    const { taskId, stepId } = builderTask("Ручной запуск при выключенной системе");
    script.systemOn = false;
    try {
      expect(await kickRoleTaskStrict(taskId, "assigned", ownerId)).toMatchObject({outcome:"deferred"});
      script.steps = async (tools) => {
        await call(tools, "taskflow_claim", {id: taskId});
        await call(tools, "taskflow_subtask_work", {id: stepId, state:"in_progress"});
        await call(tools, "taskflow_subtask_done", {id: stepId, result:"Ручной заход выполнен"});
        await call(tools, "taskflow_state", {id: taskId, state:"review", comment:"Результат ручного запуска"});
      };
      expect(await kickRoleTaskStrict(taskId, "assigned", ownerId, {manualStart:true})).toMatchObject({outcome:"started"});
      await _settleInProcessRunsForTests();
      expect((db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId) as any).agent_state).toBe("review");
      expect(await kickRoleTaskStrict(taskId, "after_run", ownerId)).toMatchObject({outcome:"deferred"});
    } finally { script.systemOn = true; }
  });

  it("роль берёт задачу, закрывает шаг и сдаёт — всё от своего имени", async () => {
    const { taskId, stepId } = builderTask("Работа внутри сервера");
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: taskId });
      await call(tools, "taskflow_subtask_work", { id: stepId, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: stepId, result: "Сделано." });
      await call(tools, "taskflow_comment", { id: taskId, text: "Готово, проверьте." });
      await call(tools, "taskflow_state", { id: taskId, state: "review", comment: "Итог: сделано." });
    };
    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("review");
    const step = db.prepare("SELECT done FROM subtasks WHERE id = ?").get(stepId) as { done: number };
    expect(step.done).toBe(1);
    const comment = db
      .prepare("SELECT user_id FROM comments WHERE task_id = ? AND text = 'Готово, проверьте.'")
      .get(taskId) as { user_id: string };
    expect(comment.user_id).toBe("role_builder");
    const claimed = db
      .prepare("SELECT actor_id FROM task_events WHERE task_id = ? AND kind = 'claimed'")
      .get(taskId) as { actor_id: string };
    expect(claimed.actor_id).toBe("role_builder");
  });

  it("системный prompt объясняет роли, что она уже работает локально на .110", async () => {
    const { taskId } = builderTask("Локальная файловая операция");
    script.systemPrompts.length = 0;
    script.steps = async () => {};

    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    expect(script.systemPrompts.at(-1)).toContain("ты уже работаешь на сервере .110");
    expect(script.systemPrompts.at(-1)).toContain("не подключайся к .110 по SSH");
    expect(script.systemPrompts.at(-1)).toContain("/home/maksim/Проекты/Хранилище");
  });

  it("перед работой добавляет TaskContext v1 и пишет владельцу его человеческую сводку", async () => {
    const { taskId } = builderTask("Контекст для in-process запуска");
    const prompts: string[] = [];
    script.steps = async (_tools, prompt) => {
      prompts.push(prompt);
    };

    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("КОНТЕКСТ v1");
    const summary = db
      .prepare("SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as { text: string } | undefined;
    expect(summary?.text).toContain("База знаний:");
  });

  it("A и B завершаются — C реально получает их итог в контекст запуска (этап 5)", async () => {
    // Живой закрытый сценарий из плана docs/2026-09-28-parent-child-execution-context,
    // этап 5: A (policy completed) и B (policy review) закрываются через
    // настоящий runtime-путь (не подмену SQL), C собирает их артефакты через
    // DependencyContextEnricher прямо в runtime-запуске, и это видно в
    // audit-событии dependency_context_used с выросшей версией контекста
    // ветки (все три — дети одного родителя, поэтому версия общая).
    const { taskId: parentId } = builderTask("Родитель ветки");

    const { taskId: aId } = builderTask("A: исследование");
    db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentId, aId);
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: aId });
      await call(tools, "taskflow_subtask_work", { id: `${aId}-s1`, state: "in_progress" });
      // Единственный шаг закрывается -> сервер сам сдаёт задачу в review
      // (routes/tasks.ts, авто-review) и пишет artifact_versions.result из
      // resultFromSubtasks; отдельный taskflow_state здесь не нужен.
      await call(tools, "taskflow_subtask_done", { id: `${aId}-s1`, result: "Источники проверены" });
    };
    await runRoleInProcess({ taskId: aId, role: "builder" });
    await _settleInProcessRunsForTests();
    const versionBefore = contextVersionOf(parentId);
    const acceptA = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${aId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    expect(acceptA.statusCode).toBe(200);

    const { taskId: bId } = builderTask("B: контракт");
    db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentId, bId);
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: bId });
      await call(tools, "taskflow_subtask_work", { id: `${bId}-s1`, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: `${bId}-s1`, result: "Контракт согласован" });
    };
    await runRoleInProcess({ taskId: bId, role: "builder" });
    await _settleInProcessRunsForTests();

    const { taskId: cId } = builderTask("C: интеграция A и B");
    db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentId, cId);
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, policy) VALUES (?, ?, 'completed')").run(cId, aId);
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, policy) VALUES (?, ?, 'review')").run(cId, bId);

    script.steps = async () => {};
    await runRoleInProcess({ taskId: cId, role: "builder" });
    await _settleInProcessRunsForTests();

    const used = db
      .prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'dependency_context_used'")
      .get(cId) as { to_value: string } | undefined;
    expect(used).toBeTruthy();
    const payload = JSON.parse(used!.to_value) as { version: number; dependencies: string[] };
    expect(payload.dependencies.sort()).toEqual([aId, bId].sort());
    expect(payload.version).toBeGreaterThan(versionBefore);

    const ctx = buildDependencyContext(cId);
    expect(ctx.status).toBe("ok");
    const results = ctx.dependencies.map((d) => d.result ?? "");
    expect(results.some((r) => r.includes("Источники проверены"))).toBe(true);
    expect(results.some((r) => r.includes("Контракт согласован"))).toBe(true);
  });

  it("T03: V1 получает в runtime только declared collaboration_context A1, без чужого slot-а и чата", async () => {
    // Подменённый агент заканчивает ход мгновенно, без прогресса. Без этого
    // выключателя сервер закрыл бы узел анализа как «брошенный» (MAK-97,
    // settleStalledPlanNode) и внешняя сдача артефакта ниже получила бы 409
    // «артефакт можно сдать только из узла в работе» — а тест проверяет
    // мост контекста, а не жизненный цикл брошенного узла.
    const prevSettle = process.env.TASKFLOW_SETTLE_STALLED_NODES;
    process.env.TASKFLOW_SETTLE_STALLED_NODES = "off";
    try {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: `Bearer ${ownerToken}` }, payload: { title: "T03 runtime context " + Date.now() } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: `Bearer ${ownerToken}` }, payload: {
        profile: "manual",
        nodes: [
          { slot_key: "analysis", role_key: "analyst", output_artifact: { key: "feature_spec", type: "specification", format: "json", required_fields: ["scope"] } },
          { slot_key: "unrelated", role_key: "qa" },
          { slot_key: "delivery", role_key: "builder" },
        ],
        edges: [{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "feature_spec" }],
      },
    });
    expect(plan.statusCode).toBe(201);
    const planId = plan.json().plan.id as string;
    script.steps = async () => {};
    // approve сам стартует оба корневых узла (analysis, unrelated) —
    // у обоих нет incoming edges, поэтому canBecomeReady() пропускает их
    // сразу; проверяемый вызов buildInProcessTaskContext нас пока не
    // интересует, интересен только последующий для "delivery".
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: `Bearer ${ownerToken}` } });
    await _settleInProcessRunsForTests();

    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: `Bearer ${ownerToken}` } })).json() as Array<{ id: string; plan_node_key: string }>;
    const analysisSubtask = subtasks.find((s) => s.plan_node_key === "analysis")!;
    const analystAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;

    // Передача следующему узлу открывается В МОМЕНТ СДАЧИ артефакта
    // (routes/subtask-artifacts.ts, submit → unlockReadyPlanSubtasks),
    // а не при отдельной приёмке. Поэтому интересующий нас запуск "delivery"
    // и его buildInProcessTaskContext случатся на этом запросе — очищаем
    // счётчик заранее, чтобы не поймать запуск корневого узла анализa.
    taskContext.build.mockClear();
    const submitted = await app.inject({ method: "POST", url: `/api/subtasks/${analysisSubtask.id}/artifact`, headers: { authorization: analystAuth }, payload: { summary: "Согласован scope", report_markdown: "## Результат\nСогласован scope для этапа delivery.\n\n## Что сделано\nЗафиксированы границы работы.\n\n## Проверки\nПроверено на тестовой задаче.\n\n## Ограничения\nНет.\n\n## Материалы\ndocs/spec.json", payload: { scope: "в рамках" }, evidence: [{ path: "docs/spec.json" }] } });
    expect(submitted.statusCode, submitted.body).toBe(201);

    // accept — запись факта приёмки; узел delivery уже стартовал на сдаче.
    const accepted = await app.inject({ method: "POST", url: `/api/subtasks/${analysisSubtask.id}/artifact/accept`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    await _settleInProcessRunsForTests();

    expect(taskContext.build).toHaveBeenCalledTimes(1);
    const bridgeInput = taskContext.build.mock.calls[0][0] as { collaboration_context?: any };
    expect(bridgeInput.collaboration_context).toMatchObject({
      status: "ok",
      plan_id: planId,
      slot_key: "delivery",
      predecessor_artifacts: [
        { slot_key: "analysis", artifact_key: "feature_spec", summary: "Согласован scope", payload: { scope: "в рамках" } },
      ],
    });
    // collaboration_context — только объявленный предшественник A1: чужой
    // слот «unrelated» в него не попадает. task_history — отдельный блок
    // «что уже было по карточке», он перечисляет все прошлые шаги законно.
    const serialized = JSON.stringify(bridgeInput.collaboration_context);
    expect(serialized).not.toContain("unrelated");
    const whole = JSON.stringify(bridgeInput);
    expect(whole.toLowerCase()).not.toContain("token");
    expect(whole.toLowerCase()).not.toContain("password");

    const used = db
      .prepare("SELECT field, to_value FROM task_events WHERE task_id = ? AND kind = 'collaboration_context_used'")
      .get(taskId) as { field: string; to_value: string } | undefined;
    expect(used).toBeTruthy();
    expect(used!.field).toBe("delivery");
    expect(JSON.parse(used!.to_value)).toMatchObject({ plan_id: planId, artifacts: ["analysis:feature_spec"] });
    } finally {
      if (prevSettle === undefined) delete process.env.TASKFLOW_SETTLE_STALLED_NODES;
      else process.env.TASKFLOW_SETTLE_STALLED_NODES = prevSettle;
    }
  });

  it("сбой запуска — карточка заблокирована с причиной", async () => {
    const { taskId } = builderTask("Упадёт посреди работы");
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: taskId });
      throw new Error("провайдер не ответил");
    };
    const run = await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();
    await expect(run.completion).rejects.toThrow("провайдер не ответил");

    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("blocked");
    const c = db
      .prepare("SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as { text: string };
    expect(c.text).toContain("провайдер не ответил");
  });

  it("сервер сам будит роль, а после сдачи — Критика (этап C2)", async () => {
    db.prepare("UPDATE users SET reviewer_first_default = 1 WHERE role = 'owner'").run();
    // На живой базе Критик проходит как проверяющий по профилю роли; у
    // тестовой учётки профиля нет — отметка напрямую.
    db.prepare("UPDATE users SET reviewer = 1 WHERE id = 'role_critic_verifier'").run();
    const { taskId, stepId } = builderTask("Цепочка без будильника");
    script.steps = async (tools, prompt) => {
      if (prompt.includes("Проверь сданную работу")) {
        await call(tools, "taskflow_review", { id: taskId, verdict: "approved", findings: "Работа подтверждена." });
        return;
      }
      await call(tools, "taskflow_claim", { id: taskId });
      await call(tools, "taskflow_subtask_work", { id: stepId, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: stepId, result: "Сделано." });
      await call(tools, "taskflow_state", { id: taskId, state: "review", comment: "Итог: сделано." });
    };
    await kickRoleTask(taskId, "assigned");
    for (let i = 0; i < 20; i++) {
      await _settleInProcessRunsForTests();
      await new Promise((r) => setTimeout(r, 20));
    }
    const verdict = db
      .prepare("SELECT reviewer_id, verdict FROM reviews WHERE task_id = ?")
      .get(taskId) as { reviewer_id: string; verdict: string } | undefined;
    expect(verdict).toMatchObject({ reviewer_id: "role_critic_verifier", verdict: "approved" });
    const sent = db
      .prepare("SELECT actor_id FROM task_events WHERE task_id = ? AND kind = 'reviewer_sent'")
      .get(taskId) as { actor_id: string | null } | undefined;
    expect(sent?.actor_id).toBeNull();
  });

  it("вышел посреди работы, но продвинулся — сервер зовёт снова, и агент доделывает (C3)", async () => {
    const { taskId, stepId } = builderTask("Две части работы");
    const step2 = `${taskId}-s2`;
    db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, 'Доделать', 2)").run(step2, taskId);
    db.prepare("UPDATE users SET reviewer_first_default = 0 WHERE role = 'owner'").run();
    const prompts: string[] = [];
    script.steps = async (tools, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        await call(tools, "taskflow_claim", { id: taskId });
        await call(tools, "taskflow_subtask_work", { id: stepId, state: "in_progress" });
        await call(tools, "taskflow_subtask_done", { id: stepId, result: "Первая часть." });
        return; // вышел, не сдав
      }
      await call(tools, "taskflow_subtask_work", { id: step2, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: step2, result: "Вторая часть." });
      await call(tools, "taskflow_state", { id: taskId, state: "review", comment: "Всё." });
    };
    await runRoleInProcess({ taskId, role: "builder" });
    for (let i = 0; i < 20; i++) {
      await _settleInProcessRunsForTests();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Продолжай работу");
    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("review");
    db.prepare("UPDATE users SET reviewer_first_default = 1 WHERE role = 'owner'").run();
  });

  it("без продвижения повторно не зовёт", async () => {
    const { taskId } = builderTask("Ничего не сделал");
    let runs = 0;
    script.steps = async (tools) => {
      runs += 1;
      if (runs === 1) await call(tools, "taskflow_claim", { id: taskId });
    };
    await runRoleInProcess({ taskId, role: "builder" });
    for (let i = 0; i < 10; i++) {
      await _settleInProcessRunsForTests();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runs).toBe(1);
  });

  it("ошибка SDK не считается успехом: три review-захода, затем стойкий блок", async () => {
    db.prepare("UPDATE users SET reviewer_first_default=1 WHERE role='owner'").run();
    const { taskId } = builderTask("Review context overflow");
    db.prepare("UPDATE tasks SET agent_state='review',assignee_id='role_critic_verifier' WHERE id=?").run(taskId);
    script.steps = async () => {};
    script.answer = { role: "assistant", stopReason: "error", errorMessage: "400 context window exceeds limit (2013)", content: [] };
    try {
      for (let i=0; i<3; i++) {
        const run = await kickRoleTaskStrict(taskId, i % 2 ? "after_run" : "review");
        expect(run.outcome).toBe("started");
        if (run.outcome === "started") await expect(run.completion).rejects.toThrow(/context window exceeds limit/);
      }
      expect(db.prepare("SELECT agent_state,block_type,blocked_reason FROM tasks WHERE id=?").get(taskId)).toMatchObject({
        agent_state: "blocked", block_type: "needs_input", blocked_reason: expect.stringContaining("3"),
      });
      const before = script.sessions.length;
      await kickRoleTaskStrict(taskId, "review");
      await expect(runRoleInProcess({taskId,role:"critic_verifier",mode:"review"})).rejects.toThrow(/3|заблокирован/);
      expect(script.sessions).toHaveLength(before);
    } finally { script.answer=null; }
  });

  it("роль не из списка не запускается", async () => {
    const { taskId } = builderTask("Чужая роль");
    await expect(runRoleInProcess({ taskId, role: "synthesizer" })).rejects.toThrow(/нет или она отключена/);
  });

  it("комментарий владельца и durable job записываются вместе", async () => {
    const { taskId } = builderTask("Ответить владельцу");
    db.prepare("UPDATE tasks SET agent_state = 'review' WHERE id = ?").run(taskId);

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { text: "Уточни результат" },
    });
    expect(response.statusCode).toBe(200);
    const comment = response.json();
    const job = db
      .prepare(
        `SELECT reason, actor_id, status, dedupe_key
           FROM role_run_jobs
          WHERE task_id = ? AND reason = 'commented'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId) as any;
    expect(job).toMatchObject({
      reason: "commented",
      actor_id: ownerId,
      status: "queued",
      dedupe_key: `comment:${comment.id}`,
    });
  });

  it("переход в review и durable reviewer job записываются вместе", async () => {
    const { taskId, stepId } = builderTask("Отправить на проверку");
    const roleToken = app.jwt.sign({ id: "role_builder" });
    const headers = { authorization: `Bearer ${roleToken}` };
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers,
      payload: { model: "test-model", runner: "test" },
    });
    expect(claim.statusCode).toBe(200);
    db.prepare("UPDATE subtasks SET done = 1, result = 'Готово' WHERE id = ?").run(stepId);
    const review = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers,
      payload: { state: "review", comment: "Готово" },
    });
    expect(review.statusCode).toBe(200);
    const job = db
      .prepare(
        "SELECT reason, actor_id, status FROM role_run_jobs WHERE task_id = ? AND reason = 'review'",
      )
      .get(taskId) as any;
    expect(job).toEqual({
      reason: "review",
      actor_id: "role_builder",
      status: "queued",
    });
  });

  // Снимок работы слота (владелец 04.10.2026). Здесь важны два свойства:
  // остановка без сдачи НЕ ждёт модель вечно (потолок по времени есть, а при
  // молчании остаётся техснимок), и снимок предыдущей попытки реально
  // приходит в задание следующей — иначе «где остановились» существует
  // только в базе, а в модель не попадает.
  const slotWithPlan = (title: string): { taskId: string; stepId: string } => {
    const { taskId, stepId } = builderTask(title);
    const planId = taskId + "-plan";
    db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES(?,?,77,'approved','manual','test',?)").run(planId, taskId, ownerId);
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,?,'work','builder',1,'Код')").run(planId + "-node", planId);
    db.prepare("UPDATE subtasks SET collaboration_plan_id=?,plan_node_key='work',agent_id='role_builder',agent_state='in_progress' WHERE id=?").run(planId, stepId);
    return { taskId, stepId };
  };

  it("ход слота без сдачи оставляет техснимок и не ждёт модель", async () => {
    const { taskId, stepId } = slotWithPlan("Остановка без сдачи " + Date.now());
    // Модель в этом тесте молчит: у сессии нет ни одного сообщения, поэтому
    // резюме прийти не может — и ход всё равно обязан закончиться.
    script.steps = async () => {};
    try {
      await runRoleInProcess({ taskId, role: "builder", subtaskId: stepId, mode: "work" });
      await _settleInProcessRunsForTests();
    } finally {
      script.steps = null;
    }
    const row = db
      .prepare("SELECT * FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(stepId) as any;
    expect(row).toBeTruthy();
    expect(row.reason).toBe("stopped");
    expect(row.is_complete).toBe(0);
    expect((db.prepare("SELECT done FROM subtasks WHERE id = ?").get(stepId) as { done: number }).done).toBe(0);
  });

  it("шаг плана с прогрессом без сдачи: продолжение реально стартует, а не ждёт замок своего же хода", async () => {
    // Регрессия 19.10.2026 (шаг 38e1e969): settle ждали внутри хода, а
    // продолжение брало замок слота, который отпускается только после хода.
    const { taskId, stepId } = slotWithPlan("Продолжение шага " + Date.now());
    db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,routing_role,started_at,heartbeat_at) VALUES(?,?,?,'role_builder','builder',datetime('now'),datetime('now'))").run(`${taskId}-a1`, taskId, stepId);
    db.prepare("UPDATE subtasks SET current_attempt_id=? WHERE id=?").run(`${taskId}-a1`, stepId);
    const sessionsBefore = script.sessions.length;
    let turns = 0;
    script.steps = async (tools, prompt) => {
      if (prompt.includes("резюме") || prompt.includes("остановил")) return;
      turns += 1;
      // Первый ход двигается (три комментария = активность), но шаг не сдаёт.
      if (turns === 1) for (let i = 0; i < 3; i++) await tools.get("taskflow_comment").execute(`call-progress-${i}`, { id: taskId, text: `часть ${i}` });
    };
    try {
      await runRoleInProcess({ taskId, role: "builder", subtaskId: stepId, mode: "work" });
      // До правки второй сессии не появлялось никогда: продолжение висело на замке.
      await vi.waitFor(() => expect(script.sessions.length - sessionsBefore).toBeGreaterThanOrEqual(2), { timeout: 3000 });
      await vi.waitFor(async () => {
        await _settleInProcessRunsForTests();
        const open = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE subtask_id = ? AND ended_at IS NULL").get(stepId) as { n: number };
        expect(open.n).toBe(0);
      }, { timeout: 3000 });
    } finally {
      script.steps = null;
    }
    const outcomes = (db.prepare("SELECT outcome FROM attempts WHERE subtask_id = ? ORDER BY started_at, rowid").all(stepId) as { outcome: string }[]).map((r) => r.outcome);
    expect(outcomes[0]).toBe("continued");
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
  });

  it("снимок предыдущей попытки приходит в задание следующей", async () => {
    const { taskId, stepId } = slotWithPlan("Снимок в задании " + Date.now());
    db.prepare(
      "INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,ended_at,outcome) VALUES(?,?,?,'role_builder',datetime('now','-2 hours'),datetime('now','-1 hours'),'interrupted')",
    ).run(`${taskId}-old`, taskId, stepId);
    db.prepare(
      "INSERT INTO slot_work_snapshots(id,task_id,subtask_id,attempt_id,reason,is_complete,done_summary,left_summary,next_step,created_at) VALUES(?,?,?,?,'stopped',1,'Починил сборку','Осталась интеграция','Свести обе ветки',datetime('now','-1 hours'))",
    ).run(`${taskId}-snap`, taskId, stepId, `${taskId}-old`);

    const prompts: string[] = [];
    script.steps = async (_tools, prompt) => {
      prompts.push(prompt);
    };
    try {
      await runRoleInProcess({ taskId, role: "builder", subtaskId: stepId, mode: "work" });
      await _settleInProcessRunsForTests();
    } finally {
      script.steps = null;
    }
    expect(prompts[0]).toContain("На чём остановился предыдущий ход");
    expect(prompts[0]).toContain("Сделано: Починил сборку");
    expect(prompts[0]).toContain("Следующий шаг: Свести обе ветки");
  });
});
