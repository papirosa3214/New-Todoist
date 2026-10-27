import {saveChatWorkPlan} from "../src/lib/subtaskWorkPlan.js";
import {reserveChatItemAction} from "../src/runtime/chatActionBudget.js";
import {setSetting,resetSetting} from "../src/lib/serverSettings.js";
// Прямой тест startChatRun: поднимаем онлайн-сессию через адаптер и
// проверяем, что RpcClient получает правильные аргументы, что sessionId
// пишется в chat_sessions, что attempts/tasks не трогаются. Без HTTP —
// на уровне адаптера.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { ensureRoleHome } from "../src/runtime/roleHome.js";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  CHAT_RUN_CEILING_MS,
  resetModelRuntime,
  startChatRun,
  cancelChatRun,
  stopAllChatRuns,
  _resetActiveChatRunsForTests,
} from "../src/runtime/PiRuntimeAdapter.js";
import {
  _resetChatRoleLocksForTests,
} from "../src/runtime/chatSession.js";
import {offerChatSteering} from "../src/runtime/chatSteering.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

// === Замоканный Pi SDK ===

// Каталог моделей — из боевого role-routing.yaml (helpers/liveRoutingModels):
// подделка Pi не должна знать про смену основной модели ролей (13.10.2026 —
// MiniMax-M3.1-Flash-Preview валила 11 тестов этого файла с
// model_not_available).
const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();

// Ход чата идёт внутри сервера (createAgentSession), без процесса Pi и
// MCP (владелец 02.10.2026). Подменяем сессию SDK: записываем, с чем её
// создали, и управляем prompt().
interface FakeSession {
  options: any;
  sessionId: string;
  prompt: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getLastAssistantText: ReturnType<typeof vi.fn>;
  emit: (event: unknown) => void;
}

interface WaiterSlot { resolve: () => void; }
const fakeSessions: FakeSession[] = [];
let budgetPromptHook: ((session:FakeSession,index:number)=>Promise<void>)|null=null;
/** Следующий prompt упадёт этой ошибкой. */
let failNextPrompt: Error | null = null;
let compactFailure: Error | null = null;
const promptWaiters: WaiterSlot[] = [];
/** Индексы сессий, у которых prompt должен зависнуть до releasePromptWaiter. */
const blockedPromptIndexes = new Set<number>();

function blockPromptFor(index: number): void {
  blockedPromptIndexes.add(index);
}

function releasePromptWaiter(index: number): void {
  blockedPromptIndexes.delete(index);
  const w = promptWaiters[index];
  if (w) w.resolve();
}

function makeFakeSession(options: any): FakeSession {
  const index = fakeSessions.length;
  const listeners: Array<(event: unknown) => void> = [];
  let aborted: (() => void) | null = null;
  let activeTools: string[] = [];
  const session: FakeSession = {
    options,
    compact: vi.fn(async()=>{if(compactFailure)throw compactFailure;return {summary:"native summary"};}),
    sessionId: options?.sessionManager?.getSessionId?.() ?? `sess-${index + 1}`,
    prompt: vi.fn(async () => {
      if(budgetPromptHook)await budgetPromptHook(session,index);
      if (failNextPrompt) {
        const error = failNextPrompt;
        failNextPrompt = null;
        throw error;
      }
      if (!blockedPromptIndexes.has(index)) return;
      const slot = { resolve: () => {} };
      promptWaiters[index] = slot;
      await new Promise<void>((resolve) => {
        slot.resolve = resolve;
        aborted = resolve;
      });
    }),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => { aborted?.(); }),
    dispose: vi.fn(() => {}),
    getLastAssistantText: vi.fn(() => "какой-то ответ"),
    getActiveToolNames: vi.fn(() => [...activeTools]),
    setActiveToolsByName: vi.fn((names: string[]) => { activeTools = [...new Set(names)]; }),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
  (session as any).subscribe = (listener: (event: unknown) => void) => {
    listeners.push(listener);
    return () => {};
  };
  (session as any).thinkingLevel="high";
  (session as any).setThinkingLevel=vi.fn((level:string)=>{(session as any).thinkingLevel=level;});
  fakeSessions.push(session);
  promptWaiters.push({ resolve: () => {} });
  return session;
}

const mockRuntime = {
  getModels: vi.fn(() => CATALOG),
  getAvailable: vi.fn(async () => CATALOG),
  getProviders: vi.fn(() => PROVIDERS),
  getProvider: vi.fn(() => PROVIDERS[0]),
  getProviderAuthStatus: vi.fn(() => ({ configured: true })),
  checkAuth: vi.fn(async () => ({ type: "api_key" })),
  login: vi.fn(async () => ({ type: "api_key" })),
  refresh: vi.fn(async () => ({})),
  getError: vi.fn(() => undefined),
  setRuntimeApiKey: vi.fn(async () => {}),
  isUsingOAuth: vi.fn(() => false),
  isUsingSubscription: vi.fn(() => false),
  hasConfiguredAuth: vi.fn(() => true),
  logout: vi.fn(async () => {}),
};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => { const actual=await importOriginal<any>(); return { ...actual,
  getPackageDir: () => "/mock/pi-pkg",
  ModelRuntime: {
    create: vi.fn(async () => mockRuntime),
  },
  createAgentSession: vi.fn(async (options: any) => ({ session: makeFakeSession(options) })),
}; });

let app: FastifyInstance | undefined;

beforeAll(async () => {
  app = await buildApp();
  // Владелец — для FK на chats.created_by.
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, email, password_hash, role, type)
     VALUES ('owner-test', 'Test Owner', 'owner@test', '!t', 'owner', 'human')`,
  ).run();
  // Минимальные роли для FK на chat_sessions.role_id.
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, role, role_key, type, email, password_hash, is_system_bot)
     VALUES ('role_architect', 'Архитектор', 'agent', 'architect', 'ai', 'arch@test', '!t', 1),
            ('role_qa', 'QA', 'agent', 'qa', 'ai', 'qa@test', '!t', 1)`,
  ).run();
  // Чат под FK на chat_sessions.chat_id.
  db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES ('chat-direct', 'Direct', 'group', 'owner-test')",
  ).run();
});

beforeEach(() => {
  budgetPromptHook=null;
  compactFailure=null;
  fakeSessions.length = 0;
  promptWaiters.length = 0;
  blockedPromptIndexes.clear();
  resetModelRuntime();
  _resetActiveChatRunsForTests();
  _resetChatRoleLocksForTests();
  db.prepare("DELETE FROM chat_sessions").run();
});

afterAll(async () => {
  await stopAllChatRuns();
  if (app) await app.close();
});

afterEach(async () => {
  await stopAllChatRuns();
});

describe("startChatRun (ход чата внутри сервера)", () => {

  it("native compaction uses SDK token defaults instead of character limits",async()=>{
    const sdk=await vi.importActual<any>("@earendil-works/pi-coding-agent");
    const expected=sdk.SettingsManager.inMemory().getCompactionSettings();
    await startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"hello"});
    expect(fakeSessions[0].options.settingsManager.getCompactionSettings()).toEqual(expected);
  });

  async function savedSession(large=false){
    const first=await startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"hello"});
    const manager=fakeSessions[0].options.sessionManager;
    manager.appendMessage({role:"user",content:[{type:"text",text:large?"x".repeat(150000):"user request"}],timestamp:Date.now()-1000});
    manager.appendMessage({role:"assistant",content:[{type:"text",text:"answer"}],api:"openai-completions",
      provider:liveCatalogEntryOf("architect").provider,model:liveCatalogEntryOf("architect").id,
      usage:{input:40000,output:10,cacheRead:0,cacheWrite:0,totalTokens:40010,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()});
    return first.sessionId!;
  }

  it("native compaction resumes a 150k-character history without an eager cut",async()=>{
    const sessionId=await savedSession(true);
    await startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"continue",sessionId});
    const resumed=fakeSessions[1];
    expect((resumed as any).compact).not.toHaveBeenCalled();
    expect(resumed.options.sessionManager.getEntries().filter((e:any)=>e.type==="compaction")).toHaveLength(0);
    const original=resumed.options.sessionManager.buildSessionContext().messages.find((m:any)=>m.role==="user");
    expect(original.content[0].text).toHaveLength(150000);
  });

  it("native compaction button invokes SDK compact exactly once",async()=>{
    const sessionId=await savedSession();
    await startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"",sessionId,compactOnly:true});
    expect((fakeSessions[1] as any).compact).toHaveBeenCalledExactlyOnceWith();
    expect(fakeSessions[1].prompt).not.toHaveBeenCalled();
  });

  it("native compaction failure propagates without a destructive local summary",async()=>{
    compactFailure=new Error("Connection error.");
    await expect(startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"",compactOnly:true})).rejects.toThrow("Connection error.");
    expect(fakeSessions[0].options.sessionManager.getEntries().filter((e:any)=>e.type==="compaction")).toHaveLength(0);
  });
  it("explicit session thinking overrides the role policy in a new SDK session",async()=>{
    const entry = CATALOG.find(m => m.id === liveCatalogEntryOf("architect").id && m.provider === liveCatalogEntryOf("architect").provider)!;
    const prior = {...entry};
    Object.assign(entry,{reasoning:true,thinkingLevelMap:{max:"max"}});
    try{
      await startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"test",thinkingLevel:"low"} as any);
      expect(fakeSessions[0].options.thinkingLevel).toBe("low");
      expect((fakeSessions[0] as any).setThinkingLevel).toHaveBeenCalledWith("low");
    }finally{Object.assign(entry,prior);delete (entry as any).thinkingLevelMap;}
  });
  // Дефолт ролей — low с 24.10.2026 (648f6eec, scripts/role-thinking.json).
  it.each([["architect", "max"], ["qa", "low"]])("owner thinking policy reaches chat SDK for %s", async (role, expected) => {
    // id в каталоге — без префикса провайдера, как у настоящего Pi.
    const entry = CATALOG.find(m => m.id === liveCatalogEntryOf(role).id && m.provider === liveCatalogEntryOf(role).provider)!;
    const prior = { ...entry };
    Object.assign(entry, {reasoning:true, thinkingLevelMap:{max:"max"}});
    try {
      await startChatRun({chatId:"chat-direct",role,roleId:"role_"+role,prompt:"test"});
      expect(fakeSessions[0].options.thinkingLevel).toBe(expected);
    } finally {
      Object.assign(entry, prior);
      delete (entry as any).thinkingLevelMap;
    }
  });

  it("сессия SDK в папке роли, с моделью роли и инструментами трекера — без MCP", async () => {
    const result = await startChatRun({
      chatId: "chat-direct",
      role: "architect",
      roleId: "role_architect",
      prompt: "привет",
    });

    expect(fakeSessions).toHaveLength(1);
    const session = fakeSessions[0];
    expect(session.options.cwd).toBe(ensureRoleHome("architect").workspace);
    expect(session.options.model.id).toBe(liveCatalogEntryOf("architect").id);
    // Инструменты трекера и чата — внутри сервера, отдельного процесса нет.
    // `tools` — имена (иначе SDK отключает все инструменты), каждое имя
    // разрешённого инструмента есть среди определений.
    expect(session.options.tools.every((t: unknown) => typeof t === "string")).toBe(true);
    const names: string[] = session.options.tools;
    const defined = new Set(session.options.customTools.map((t: any) => t.name));
    for (const name of names) expect(defined.has(name)).toBe(true);
    expect(names).toContain("bash");
    for (const name of ["taskflow_task", "taskflow_chat_send", "taskflow_weather", "taskflow_consult", "taskflow_remember", "taskflow_recall", "taskflow_plan_request"]) {
      expect(names).toContain(name);
    }
    expect(session.prompt).toHaveBeenCalledWith("привет");
    // Размышления не выключаем: уровень — по умолчанию Pi, как было у CLI.
    expect(session.options.thinkingLevel).toBe("off");

    const row = db
      .prepare("SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?")
      .get("chat-direct", "role_architect") as { pi_session_id: string } | undefined;
    expect(row?.pi_session_id).toBe(result.sessionId);
    expect(result.sessionId).toBe(session.sessionId);
    expect(result.text).toBe("какой-то ответ");
    expect(session.dispose).toHaveBeenCalled();

    // Изоляция: attempts/tasks пусто, никаких записей не появилось.
    expect((db.prepare("SELECT COUNT(*) as n FROM attempts").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n).toBe(0);
  });

  it("повторный ход продолжает ту же сессию", async () => {
    const first = await startChatRun({ chatId: "chat-direct", role: "qa", roleId: "role_qa", prompt: "раз" });
    const saved = db
      .prepare("SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?")
      .get("chat-direct", "role_qa") as { pi_session_id: string } | undefined;
    const second = await startChatRun({
      chatId: "chat-direct", role: "qa", roleId: "role_qa", prompt: "два",
      sessionId: saved?.pi_session_id,
    });
    expect(fakeSessions).toHaveLength(2);
    expect(fakeSessions[1].options.sessionManager.getSessionId()).toBe(first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    const rows = db
      .prepare("SELECT COUNT(*) as n FROM chat_sessions WHERE chat_id = ? AND role_id = ?")
      .get("chat-direct", "role_qa") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("режим планирования — только инструменты чтения", async () => {
    await startChatRun({ chatId: "chat-direct", role: "architect", roleId: "role_architect", prompt: "план", mode: "plan" });
    const opts = fakeSessions[0].options;
    const names: string[] = opts.tools;
    expect(names).toContain("read");
    expect(names).toContain("taskflow_task");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("taskflow_chat_send");
  });

  it("неизвестная роль → ошибка без создания сессии", async () => {
    await expect(
      startChatRun({
        chatId: "chat-direct",
        // @ts-expect-error — тестируем именно нелегальное значение.
        role: "ghost",
        roleId: "role_ghost",
        prompt: "хм",
      }),
    ).rejects.toThrow(/неизвестная роль/);
    expect(fakeSessions).toHaveLength(0);
  });

  it("обсуждение разрешает вопросы коллегам без рабочих команд и мутаций",async()=>{
    await startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"Спроси коллегу",mode:"discussion" as any});
    const names=fakeSessions.at(-1)!.options.tools as string[];
    for(const name of ["read","taskflow_chat_send","taskflow_chat_reply","taskflow_chat_read"])expect(names).toContain(name);
    for(const name of ["bash","write","edit","taskflow_claim","taskflow_subtask_done","taskflow_plan_request","taskflow_create_task","taskflow_doc_write"])expect(names).not.toContain(name);
  });

  it("параллельный запуск на ту же (chat, role) → второй отказ", async () => {
    blockPromptFor(0);
    const first = startChatRun({ chatId: "chat-direct", role: "architect", roleId: "role_architect", prompt: "долгий" });
    await vi.waitFor(() => expect(fakeSessions).toHaveLength(1));
    await expect(
      startChatRun({ chatId: "chat-direct", role: "architect", roleId: "role_architect", prompt: "параллельный" }),
    ).rejects.toThrow(/уже идёт живая сессия/);
    releasePromptWaiter(0);
    await first;
  });

  it("остановка владельцем прерывает сессию", async () => {
    blockPromptFor(0);
    const run = startChatRun({ chatId: "chat-direct", role: "qa", roleId: "role_qa", prompt: "зависший" });
    await vi.waitFor(() => expect(fakeSessions).toHaveLength(1));
    expect(await cancelChatRun("chat_unknown")).toBe(false);
    await stopAllChatRuns();
    await expect(run).rejects.toMatchObject({ code: "CHAT_RUN_CANCELLED" });
    expect(fakeSessions[0].abort).toHaveBeenCalled();
  });
});

describe("startChatRun: сторож тишины (владелец 27.09.2026)", () => {
  const tickMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const base = {
    chatId: "chat-direct",
    role: "architect" as const,
    roleId: "role_architect",
    prompt: "сделай",
  };
  async function firstSession() {
    await vi.waitFor(() => expect(fakeSessions).toHaveLength(1));
    return fakeSessions[0];
  }

  it("роль молчит дольше idleMs — ход обрывается с CHAT_RUN_IDLE, сессия прервана", async () => {
    blockPromptFor(0);
    const run = startChatRun({ ...base, idleMs: 150 });
    const session = await firstSession();
    await expect(run).rejects.toMatchObject({ code: "CHAT_RUN_IDLE", limitMs: 150 });
    expect(session.abort).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
  });

  it("пока идут события, ход живёт дольше idleMs", async () => {
    blockPromptFor(0);
    const run = startChatRun({ ...base, idleMs: 150 });
    const session = await firstSession();
    for (let i = 0; i < 8; i++) {
      await tickMs(60);
      session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "." } });
    }
    releasePromptWaiter(0);
    await expect(run).resolves.toMatchObject({ text: "какой-то ответ" });
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("долгий вызов инструмента тишиной не считается", async () => {
    blockPromptFor(0);
    const run = startChatRun({ ...base, idleMs: 150 });
    const session = await firstSession();
    session.emit({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: {} });
    await tickMs(500);
    releasePromptWaiter(0);
    await expect(run).resolves.toBeDefined();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("события хода пробрасываются наружу через onEvent", async () => {
    const seen: unknown[] = [];
    blockPromptFor(0);
    const run = startChatRun({ ...base, onEvent: (e) => seen.push(e) });
    const session = await firstSession();
    const event = { type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: {} };
    session.emit(event);
    releasePromptWaiter(0);
    await run;
    expect(seen).toEqual([event]);
  });

  it("общий потолок: срыв по нему — CHAT_RUN_CEILING, сессия прервана", async () => {
    expect(CHAT_RUN_CEILING_MS).toBe(30 * 60_000);
    blockPromptFor(0);
    const run = startChatRun({ ...base, timeoutMs: 200, idleMs: 60_000 });
    const session = await firstSession();
    await expect(run).rejects.toMatchObject({ code: "CHAT_RUN_CEILING", limitMs: 200 });
    expect(session.abort).toHaveBeenCalled();
  });

});


it("уточнение попадает в незавершённую SDK-сессию без второго prompt",async()=>{
 blockPromptFor(0);
 const running=startChatRun({chatId:"chat-direct",role:"architect",roleId:"role_architect",prompt:"начало",deliveryOutcome:Promise.resolve(true)});
 await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
 try {
  const receipt=await offerChatSteering("chat-direct","role_architect","clarification","уточнение сейчас");
  expect(receipt).not.toBeNull();
  expect(fakeSessions[0].steer).toHaveBeenCalledOnce();
  const text=fakeSessions[0].steer.mock.calls[0][0];
  fakeSessions[0].emit({type:"message_start",message:{role:"user",content:[{type:"text",text}]}});
  releasePromptWaiter(0);await running;
  expect(await receipt!.consumed).toBe(true);
  expect(fakeSessions[0].prompt).toHaveBeenCalledTimes(1);
 } finally {releasePromptWaiter(0);await running;}
});

it("HTTP: второе сообщение меняет работающий ход, durable закрывается после ответа",async()=>{
 const chatId="steering-http";
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES (?,?,?,?)").run(chatId,"Уточнения","direct","owner-test");
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?),(?,?)").run(chatId,"owner-test",chatId,"role_architect");
 const headers={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const send=(text:string)=>app!.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers,payload:{text}});
 blockPromptFor(0);
 try{
  expect((await send("начни проверку")).statusCode).toBe(200);
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  const second=await send("учти второе условие");
  expect(second.statusCode).toBe(200);
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  expect(fakeSessions).toHaveLength(1);
  const steered=fakeSessions[0].steer.mock.calls[0][0];
  fakeSessions[0].emit({type:"message_start",message:{role:"user",content:[{type:"text",text:steered}]}});
  const pending=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=? ORDER BY rowid").all(chatId) as any[];
  expect(pending).toHaveLength(2);
  expect(pending[1].status).not.toBe("done");
  releasePromptWaiter(0);
  await vi.waitFor(()=>{
   const rows=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=?").all(chatId) as any[];
   expect(rows.every(row=>row.status==="done")).toBe(true);
  });
  expect(fakeSessions).toHaveLength(1);
 }finally{releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id=?").run(chatId);}
});

it("HTTP: непрочитанное уточнение исполняется очередью, а не исчезает",async()=>{
 const chatId="steering-fallback";
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES (?,?,?,?)").run(chatId,"Fallback","direct","owner-test");
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?),(?,?)").run(chatId,"owner-test",chatId,"role_architect");
 const headers={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const send=(text:string)=>app!.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers,payload:{text}});
 blockPromptFor(0);
 try {
  await send("первый запрос");
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  await send("позднее уточнение");
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  // Нет user/message_start: SDK не успел применить уточнение.
  releasePromptWaiter(0);
  await vi.waitFor(()=>expect(fakeSessions).toHaveLength(2));
  await vi.waitFor(()=>{
   const rows=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=?").all(chatId) as any[];
   expect(rows).toHaveLength(2);expect(rows.every(row=>row.status==="done")).toBe(true);
  });
  expect(fakeSessions[1].prompt.mock.calls[0][0]).toContain("позднее уточнение");
 } finally {releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id=?").run(chatId);}
});

it("HTTP: fallback сохраняет место перед более поздним сообщением",async()=>{
 const chatId="steering-fallback-order";
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES (?,?,?,?)").run(chatId,"Fallback","direct","owner-test");
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?),(?,?)").run(chatId,"owner-test",chatId,"role_architect");
 const headers={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const send=(text:string)=>app!.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers,payload:{text}});
 blockPromptFor(0);
 try {
  await send("первый запрос");
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  await send("позднее уточнение");
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  fakeSessions[0].steer.mockRejectedValueOnce(new Error("closed input"));
  await send("третье сообщение");
  // B не прочитано, C поступило в обычную очередь.
  releasePromptWaiter(0);
  await vi.waitFor(()=>expect(fakeSessions).toHaveLength(3),{timeout:5000});
  await vi.waitFor(()=>{
   const rows=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=?").all(chatId) as any[];
   expect(rows).toHaveLength(3);expect(rows.every(row=>row.status==="done")).toBe(true);
  });
  expect(fakeSessions[1].prompt.mock.calls[0][0]).toContain("позднее уточнение");
  const prompts=fakeSessions.slice(1).map(s=>s.prompt.mock.calls[0][0] as string);
  const ids=db.prepare("SELECT id FROM chat_messages WHERE chat_id=? AND from_user_id=? ORDER BY rowid").all(chatId,"owner-test") as any[];
  expect(prompts[0]).toContain("Отвечаешь на сообщение "+ids[1].id);
  expect(prompts[1]).toContain("Отвечаешь на сообщение "+ids[2].id);
 } finally {releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id=?").run(chatId);}
});

it("HTTP: async steer не позволяет позднему сообщению обогнать уточнение",async()=>{
 const chatId="steering-async-order";
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES (?,?,?,?)").run(chatId,"Fallback","direct","owner-test");
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?),(?,?)").run(chatId,"owner-test",chatId,"role_architect");
 const headers={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const send=(text:string)=>app!.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers,payload:{text}});
 blockPromptFor(0);
 try {
  await send("первый запрос");
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  let accept!:()=>void;
  fakeSessions[0].steer.mockImplementationOnce(()=>new Promise<void>(r=>{accept=r;}));
  const second=send("позднее уточнение");
  // app.inject starts on awaiting its thenable.
  const secondDone=Promise.resolve(second);
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  fakeSessions[0].steer.mockRejectedValueOnce(new Error("closed input"));
  await send("третье сообщение");
  accept();await secondDone;
  // B не прочитано, C поступило в обычную очередь.
  releasePromptWaiter(0);
  await vi.waitFor(()=>expect(fakeSessions).toHaveLength(3),{timeout:5000});
  await vi.waitFor(()=>{
   const rows=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=?").all(chatId) as any[];
   expect(rows).toHaveLength(3);expect(rows.every(row=>row.status==="done")).toBe(true);
  });
  expect(fakeSessions[1].prompt.mock.calls[0][0]).toContain("позднее уточнение");
  const prompts=fakeSessions.slice(1).map(s=>s.prompt.mock.calls[0][0] as string);
  const ids=db.prepare("SELECT id FROM chat_messages WHERE chat_id=? AND from_user_id=? ORDER BY rowid").all(chatId,"owner-test") as any[];
  expect(prompts[0]).toContain("Отвечаешь на сообщение "+ids[1].id);
  expect(prompts[1]).toContain("Отвечаешь на сообщение "+ids[2].id);
 } finally {releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id=?").run(chatId);}
});

// === Умная очередь: уточнение занятой роли из любого чата и от кого угодно ===

function makeChat(id:string,title:string,kind="direct"){
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES (?,?,?,?)").run(id,title,kind,"owner-test");
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?),(?,?)").run(id,"owner-test",id,"role_architect");
}
it("HTTP: уточнение из другого чата меняет работающий ход роли",async()=>{
 const chatA="steering-cross-a",chatB="steering-cross-b";
 makeChat(chatA,"Первый чат");makeChat(chatB,"Второй чат");
 const headers={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const send=(chat:string,text:string)=>app!.inject({method:"POST",url:`/api/chats/${chat}/messages`,headers,payload:{text}});
 blockPromptFor(0);
 try{
  expect((await send(chatA,"начни проверку")).statusCode).toBe(200);
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  expect((await send(chatB,"учти и это")).statusCode).toBe(200);
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  const steered=fakeSessions[0].steer.mock.calls[0][0] as string;
  expect(steered).toContain("учти и это");
  // Пометка источника: от кого и откуда.
  expect(steered).toContain("Test Owner");
  expect(steered).toContain("Второй чат");
  fakeSessions[0].emit({type:"message_start",message:{role:"user",content:[{type:"text",text:steered}]}});
  releasePromptWaiter(0);
  await vi.waitFor(()=>{
   const rows=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=?").all(chatB) as any[];
   expect(rows).toHaveLength(1);expect(rows.every(row=>row.status==="done")).toBe(true);
  });
  // Второй чат не получил своего хода: сообщение ушло в ход первого.
  expect(fakeSessions).toHaveLength(1);
 }finally{releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id IN (?,?)").run(chatA,chatB);}
});

it("HTTP: уточнение от коллеги-роли тоже подмешивается в ход",async()=>{
 const chatId="steering-from-role";
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES (?,?,?,?)").run(chatId,"Коллеги","direct","owner-test");
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?),(?,?),(?,?)").run(chatId,"owner-test",chatId,"role_architect",chatId,"role_qa");
 const ownerHeaders={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const roleHeaders={authorization:"Bearer "+app!.jwt.sign({id:"role_qa"})};
 const send=(headers:any,text:string)=>app!.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers,payload:{text}});
 blockPromptFor(0);
 try{
  expect((await send(ownerHeaders,"@Архитектор начни проверку")).statusCode).toBe(200);
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  expect((await send(roleHeaders,"коллега, уточнение по твоей работе")).statusCode).toBe(200);
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  const steered=fakeSessions[0].steer.mock.calls[0][0] as string;
  expect(steered).toContain("коллега, уточнение по твоей работе");
  expect(steered).toContain("QA");
  fakeSessions[0].emit({type:"message_start",message:{role:"user",content:[{type:"text",text:steered}]}});
  releasePromptWaiter(0);
  await vi.waitFor(()=>{
   const rows=db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=? AND role_id=?").all(chatId,"role_architect") as any[];
   expect(rows.length).toBeGreaterThanOrEqual(1);
   expect(rows.every(row=>row.status==="done")).toBe(true);
  });
  expect(fakeSessions).toHaveLength(1);
 }finally{releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id=?").run(chatId);}
});

it("HTTP: уточнение в текущем чате не создаёт карточку координации",async()=>{
 const chatId="steering-service-row";
 makeChat(chatId,"Служебная строка");
 const headers={authorization:"Bearer "+app!.jwt.sign({id:"owner-test"})};
 const send=(text:string)=>app!.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers,payload:{text}});
 const card=()=>db.prepare("SELECT text,steps FROM chat_messages WHERE message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id') IS NOT NULL").get() as any;
 blockPromptFor(0);
 try{
  await send("начни проверку");
  await vi.waitFor(()=>expect(fakeSessions[0]?.prompt).toHaveBeenCalled());
  await send("уточнение в ход");
  await vi.waitFor(()=>expect(fakeSessions[0].steer).toHaveBeenCalledOnce());
  const steered=fakeSessions[0].steer.mock.calls[0][0] as string;
  fakeSessions[0].emit({type:"message_start",message:{role:"user",content:[{type:"text",text:steered}]}});
  await new Promise(r=>setTimeout(r,20));
  expect(card()).toBeUndefined();
  releasePromptWaiter(0);
  await vi.waitFor(()=>expect(fakeSessions[0].dispose).toHaveBeenCalled());
  expect(card()).toBeUndefined();
 }finally{releasePromptWaiter(0);await stopAllChatRuns();db.prepare("DELETE FROM chats WHERE id=?").run(chatId);}
});

it("budget overflow aborts/disposes the old SDK session before a single fresh 50-action attempt",async()=>{
 const ctx={chatId:"chat-direct",roleId:"role_architect"};
 setSetting("chat_item_max_actions",100,null);
 saveChatWorkPlan(ctx.chatId,ctx.roleId,0,[{id:"budget-one",title:"Бюджет",state:"pending"}]);
 for(let i=0;i<100;i++)reserveChatItemAction({...ctx,callId:"pre-"+i});
 budgetPromptHook=async(session,index)=>{
  if(index===0){
   const tool=session.options.customTools.find((t:any)=>t.name==="bash");
   try{await tool.execute("blocked-before-effect",{command:"exit 99"});}catch{}
  }else{
   expect(fakeSessions[0].abort).toHaveBeenCalledOnce();
   expect(fakeSessions[0].dispose).toHaveBeenCalledOnce();
   expect(session.sessionId).not.toBe(fakeSessions[0].sessionId);
   for(let i=0;i<50;i++)reserveChatItemAction({...ctx,callId:"fresh-"+i});
   const tool=session.options.customTools.find((t:any)=>t.name==="bash");
   try{await tool.execute("beyond-50",{command:"exit 99"});}catch{}
  }
 };
 try{
  await expect(startChatRun({...ctx,role:"architect",prompt:"Исходная работа"})).rejects.toMatchObject({code:"CHAT_ACTION_BUDGET"});
  expect(fakeSessions).toHaveLength(2);
  expect(fakeSessions[1].prompt).toHaveBeenCalledWith(expect.stringContaining("новая сессия"));
  const row=db.prepare('SELECT state,used FROM chat_budget_cases WHERE chat_id=? AND role_id=?').get(ctx.chatId,ctx.roleId) as any;
  expect(row.state).toBe("exhausted");expect(row.used).toBe(150);
 }finally{resetSetting("chat_item_max_actions",null);budgetPromptHook=null;}
});
