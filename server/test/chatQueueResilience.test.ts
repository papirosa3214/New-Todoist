// Тест recovery-sweep: поведение карточки ebc4d338 (queue) при
// рестарте процесса.
//
// Покрывает:
//   1. Pending-холд виден sweep'у сразу после старта, даже
//      если in-memory очередь пуста (имитация рестарта).
//   2. Pending со старой generation fence-ится без постановки
//      в in-memory очередь.
//   3. bumpGeneration fence-ит «запоздавший ответ» старой сессии.
//   4. Pi бросил исключение — durable-запись закрывается failed,
//      а не висит picked.
//   5. Повторный запуск sweep после failure поднимает ход снова
//      (recovery от потери Pi-ответа).
//
// Pi-моки выставлены так же, как в chatQueueRoute.test.ts: проверяем
// серверную часть очереди/восстановления без реальных вызовов модели.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { _resetChatQueueForTests } from "../src/runtime/chatQueue.js";
import {
  _resetChatRoleLocksForTests,
  _resetChatRoleQueuesForTests,
  enqueueChatReply,
  isChatDeliveryScheduled,
} from "../src/runtime/chatSession.js";
import {
  startChatQueueRecovery,
  reclaimStalePickedDeliveries,
  recoveryBumpChatGeneration,
  sweepRecoverableDeliveries,
  recoverAgentDelivery,
} from "../src/runtime/chatQueueRecovery.js";
import {
  currentChatGeneration,
  fenceMessageDelivery,
  getMessageDelivery,
  startDeliveryHeartbeat,
  observeDeliveryActivity,
} from "../src/runtime/chatQueue.js";
import {
  resetModelRuntime,
  _resetActiveChatRunsForTests,
} from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRolePickerForTests } from "../src/routes/chats.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

const fakeClients: any[] = [];
const promptControl = {run: async (_text:string) => {},answer:"ок"};
const creationControl = {before:async()=>{},count:0,executed:[] as number[],disposed:[] as number[]};

/** Каталог и провайдеры — из боевого role-routing.yaml (helpers/liveRoutingModels):
 *  подделка не должна знать про смену основной модели ролей. */
const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();
const PRIMARY = liveCatalogEntryOf("qa");

function makeFakeRpcClient() {
  const client = {
    stop: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      sessionId: `sess-${fakeClients.length + 1}`,
      model: { provider: PRIMARY.provider, id: PRIMARY.id },
    })),
    getLastAssistantText: vi.fn(async () => "ок"),
    promptAndWait: vi.fn(async () => {}),
  };
  fakeClients.push(client);
  return client;
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

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPackageDir: () => "/mock/pi-pkg",
    ModelRuntime: { create: vi.fn(async () => mockRuntime) },
    createAgentSession: vi.fn(async (opts: any) => {
      const ordinal=++creationControl.count;
      await creationControl.before();
      makeFakeRpcClient();
      return {
        session: {
          sessionId: "sess-test",
          subscribe: () => () => {},
          prompt: async (text:string) => {creationControl.executed.push(ordinal);await promptControl.run(text);},
          abort: () => {},
          dispose: () => {creationControl.disposed.push(ordinal);},
          getLastAssistantText: () => promptControl.answer,
        },
      };
    }),
  };
});

vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(),
  addClient: vi.fn(),
  removeClient: vi.fn(),
  onUserGone: vi.fn(),
  broadcast: vi.fn(),
  broadcastTaskEvent: vi.fn(),
  broadcastToUsers: vi.fn(),
}));

let app: FastifyInstance | undefined;

const ROLE_USER = "role_builder";
const OWNER_USER = "owner_recovery_test";

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(OWNER_USER)) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Test Recovery Owner', ?, '!t', 'owner', 'human')`,
    ).run(OWNER_USER, `chat-queue-test-${OWNER_USER}@test`);
  }
  if (!db.prepare("SELECT 1 FROM chats WHERE id=?").get("chat_recovery_test")) {
    db.prepare(
      `INSERT INTO chats (id, title, kind, created_by) VALUES (?, 'Recovery chat', 'group', ?)`,
    ).run("chat_recovery_test", OWNER_USER);
    db.prepare(
      `INSERT INTO chat_members (chat_id, member_id, added_at) VALUES (?, ?, datetime('now')), (?, ?, datetime('now'))`,
    ).run("chat_recovery_test", OWNER_USER, "chat_recovery_test", ROLE_USER);
  }
});

beforeEach(() => {
  fakeClients.length = 0;
  promptControl.run = async () => {};
  promptControl.answer="ок";
  creationControl.before=async()=>{};creationControl.count=0;creationControl.executed=[];creationControl.disposed=[];
  process.env.TASKFLOW_CHAT_DELIVERY_MAX_RESTARTS = "2";
  _resetActiveChatRunsForTests();
  _resetChatRolePickerForTests();
  _resetChatQueueForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
});

afterAll(async () => {
  if (app) await app.close();
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function seedDelivery(id: string, chat = "chat_recovery_test", payload = "{}") {
  if (!db.prepare("SELECT 1 FROM chats WHERE id=?").get(chat)) {
    db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES(?,?,'group',?)").run(chat, chat, OWNER_USER);
    for (const member of [OWNER_USER, ROLE_USER])
      db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat, member);
  }
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)").run(id, OWNER_USER, id, chat);
  db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status) VALUES(?,?,?,?,?,1,?,'pending')")
    .run(id, chat, ROLE_USER, id, id, payload);
}
describe("доставка: очередь, независимость и бюджет повторов", () => {
  it("ожидающее сообщение остаётся pending до фактического выполнения", async () => {
    seedDelivery("wait-row");
    const gate = deferred();
    const first = enqueueChatReply("chat_recovery_test", ROLE_USER, () => gate.promise);
    const second = recoverAgentDelivery({chatId:"chat_recovery_test",roleId:ROLE_USER,deliveryId:"wait-row"});
    try {
      await new Promise(r => setTimeout(r, 25));
      expect(getMessageDelivery("wait-row")?.status).toBe("pending");
    } finally {
      gate.resolve();
      await Promise.all([first, second]);
    }
    expect(getMessageDelivery("wait-row")?.status).toBe("done");
  });
  it("просроченное ожидание не запускает поздний вызов и не обгоняет активного писателя", async () => {
    seedDelivery("deadline-row");
    const gate = deferred();
    const first = enqueueChatReply("chat_recovery_test", ROLE_USER, () => gate.promise);
    let invoked = false;
    const second = enqueueChatReply("chat_recovery_test", ROLE_USER, async () => { invoked=true; }, {deliveryId:"deadline-row",waitMs:15});
    const result = second.then(() => "started", (e:any) => e.code);
    try {
      expect(await Promise.race([result,new Promise(r=>setTimeout(()=>r("still-waiting"),80))])).toBe("CHAT_QUEUE_WAIT_TIMEOUT");
      expect(invoked).toBe(false);
      expect(getMessageDelivery("deadline-row")?.status).toBe("failed");
    } finally {
      gate.resolve();
      await first;
      await result;
    }
    expect(invoked).toBe(false);
  });
  it("зависший первый чат не задерживает независимый чат восстановления", async () => {
    seedDelivery("hold-first");
    seedDelivery("free-second", "other-recovery-chat");
    const gate = deferred();
    promptControl.run = async (text:string) => { if(text.includes("hold-first")) await gate.promise; };
    const sweep = sweepRecoverableDeliveries();
    try {
      await vi.waitFor(() => expect(getMessageDelivery("free-second")?.status).toBe("done"), {timeout:3000,interval:10});
      expect(getMessageDelivery("hold-first")?.status).toBe("picked");
    } finally {
      gate.resolve();
      await sweep;
      promptControl.run = async () => {};
    }
  });
  it("возврат аренды учитывает прежние повторы после ошибки и уведомляет один раз", () => {
    seedDelivery("mixed-budget", "chat_recovery_test", JSON.stringify({retryCount:2,reclaimCount:0}));
    db.prepare("UPDATE chat_message_queue SET status='picked',updated_at=datetime('now','-20 minutes') WHERE id='mixed-budget'").run();
    expect(reclaimStalePickedDeliveries(5)).toEqual({reclaimed:0,closed:1});
    expect(getMessageDelivery("mixed-budget")?.status).toBe("failed");
    expect(JSON.parse(getMessageDelivery("mixed-budget")!.payload_json)).toMatchObject({expired:1,retryExhausted:1});
    const count = () => (db.prepare("SELECT count(*) n FROM notifications WHERE type='delivery_retry_exhausted'").get() as any).n;
    const before = count();
    expect(before).toBeGreaterThan(0);
    reclaimStalePickedDeliveries(5);
    expect(count()).toBe(before);
  });
  it("рестарт сервера не обходит суммарный бюджет возвратов", async () => {
    seedDelivery("cold-budget", "chat_recovery_test", JSON.stringify({retryCount:1,reclaimCount:1}));
    db.prepare("UPDATE chat_message_queue SET status='picked',updated_at='2000-01-01 00:00:00' WHERE id='cold-budget'").run();
    startChatQueueRecovery(new Date("2001-01-01T00:00:00Z"));
    await new Promise(r=>setTimeout(r,50));
    expect(getMessageDelivery("cold-budget")?.status).toBe("failed");
    expect(JSON.parse(getMessageDelivery("cold-budget")!.payload_json)).toMatchObject({expired:1,retryExhausted:1});
  });
});

describe("границы очереди и восстановление", () => {
  it("соседний проход не дублирует ожидающий ход", async () => {
    seedDelivery("once-row");
    const gate=deferred();
    const first=enqueueChatReply("chat_recovery_test",ROLE_USER,()=>gate.promise);
    const recovery=recoverAgentDelivery({chatId:"chat_recovery_test",roleId:ROLE_USER,deliveryId:"once-row"});
    try {
      await new Promise(r=>setTimeout(r,20));
      await sweepRecoverableDeliveries();
      expect(getMessageDelivery("once-row")?.status).toBe("pending");
    } finally { gate.resolve(); await Promise.all([first,recovery]); }
    const replies=db.prepare("SELECT count(*) n FROM chat_messages WHERE reply_to_message_id='once-row' AND from_user_id=?").get(ROLE_USER) as any;
    expect(replies.n).toBe(1);
  });
  it("отмена поколения во время ожидания не запускает модель", async () => {
    seedDelivery("fenced-wait");
    const gate=deferred();
    const first=enqueueChatReply("chat_recovery_test",ROLE_USER,()=>gate.promise);
    const recovery=recoverAgentDelivery({chatId:"chat_recovery_test",roleId:ROLE_USER,deliveryId:"fenced-wait"});
    await new Promise(r=>setTimeout(r,20));
    recoveryBumpChatGeneration("chat_recovery_test",ROLE_USER);
    gate.resolve();
    await Promise.all([first,recovery]);
    expect(getMessageDelivery("fenced-wait")?.status).toBe("superseded");
    expect(fakeClients).toHaveLength(0);
  });
  it("общий предел восстановления действует и при перекрывающихся проходах", async () => {
    process.env.TASKFLOW_CHAT_RECOVERY_CONCURRENCY="2";
    for(let n=0;n<6;n++)seedDelivery("parallel-"+n,"parallel-chat-"+n);
    const gate=deferred();
    let running=0,peak=0,started=0;
    promptControl.run=async()=>{started++;running++;peak=Math.max(peak,running);await gate.promise;running--;};
    const sweep=sweepRecoverableDeliveries();
    try {
      await vi.waitFor(()=>expect(started).toBe(2));
      await sweepRecoverableDeliveries();
      expect(started).toBe(2);
      expect(peak).toBe(2);
    } finally {
      gate.resolve(); await sweep;
      delete process.env.TASKFLOW_CHAT_RECOVERY_CONCURRENCY;
    }
    expect(started).toBe(6);
    expect(peak).toBe(2);
  });
  it("таймер без событий не обновляет аренду бесконечно, долгий инструмент сохраняет её", async () => {
    seedDelivery("activity-row");
    db.prepare("UPDATE chat_message_queue SET status='picked' WHERE id='activity-row'").run();
    vi.useFakeTimers({toFake:["Date","setInterval","clearInterval"]});
    const stop=startDeliveryHeartbeat("activity-row",60_000);
    try {
      await vi.advanceTimersByTimeAsync(6*60_000);
      db.prepare("UPDATE chat_message_queue SET updated_at='2000-01-01 00:00:00' WHERE id='activity-row'").run();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getMessageDelivery("activity-row")?.updated_at).toBe("2000-01-01 00:00:00");
      observeDeliveryActivity("chat_recovery_test",ROLE_USER,{type:"tool_execution_start",toolCallId:"long-build"});
      await vi.advanceTimersByTimeAsync(10*60_000);
      expect(getMessageDelivery("activity-row")?.updated_at).not.toBe("2000-01-01 00:00:00");
      observeDeliveryActivity("chat_recovery_test",ROLE_USER,{type:"tool_execution_end",toolCallId:"long-build"});
      await vi.advanceTimersByTimeAsync(6*60_000);
      db.prepare("UPDATE chat_message_queue SET updated_at='2000-01-01 00:00:00' WHERE id='activity-row'").run();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getMessageDelivery("activity-row")?.updated_at).toBe("2000-01-01 00:00:00");
    } finally { stop(); vi.useRealTimers(); }
  });
});

it("завершение старого просроченного ожидания не снимает регистрацию нового повтора", async () => {
  seedDelivery("retry-wait-row");
  const a=deferred(), b=deferred();
  const first=enqueueChatReply("chat_recovery_test",ROLE_USER,()=>a.promise);
  const expired=enqueueChatReply("chat_recovery_test",ROLE_USER,async()=>{}, {deliveryId:"retry-wait-row",waitMs:10}).catch(()=>{});
  await expired;
  let thirdStarted=false;
  const third=enqueueChatReply("chat_recovery_test",ROLE_USER,async()=>{thirdStarted=true;await b.promise;});
  db.prepare("UPDATE chat_message_queue SET status='pending' WHERE id='retry-wait-row'").run();
  const retry=enqueueChatReply("chat_recovery_test",ROLE_USER,async()=>{}, {deliveryId:"retry-wait-row"});
  try {
    a.resolve(); await first;
    await vi.waitFor(()=>expect(thirdStarted).toBe(true));
    expect(isChatDeliveryScheduled("retry-wait-row")).toBe(true);
  } finally { b.resolve(); await Promise.all([third,retry]); }
});

it("зависшая подготовка освобождает чат; опоздавшая сессия не запускает модель", async () => {
  seedDelivery("preparation-held");
  const late=deferred();
  creationControl.before=async()=>{creationControl.before=async()=>{};await late.promise;};
  process.env.TASKFLOW_CHAT_PREPARATION_TIMEOUT_MS="1000";
  const first=recoverAgentDelivery({chatId:"chat_recovery_test",roleId:ROLE_USER,deliveryId:"preparation-held"});
  try {
    const outcome=await Promise.race([first,new Promise(r=>setTimeout(()=>r("still-held"),2000))]);
    expect(outcome).toMatchObject({status:"failed"});
    expect(getMessageDelivery("preparation-held")?.status).toBe("failed");
    seedDelivery("preparation-next");
    const second=await recoverAgentDelivery({chatId:"chat_recovery_test",roleId:ROLE_USER,deliveryId:"preparation-next"});
    expect(second.status).toBe("done");
    late.resolve();
    await new Promise(r=>setTimeout(r,30));
    expect(creationControl.executed).toEqual([2]);
    expect(creationControl.disposed).toContain(1);
  } finally {
    late.resolve(); await first;
    delete process.env.TASKFLOW_CHAT_PREPARATION_TIMEOUT_MS;
  }
});

import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
it.each([true,false])("сервер собирает один отчёт после двух отправок материала (модель включила ссылки: %s)", async (included) => {
  const triggerId="server-cleanup-report-"+included;
  seedDelivery(triggerId);
  const note="731fdc47-e893-4937-900c-e78ca7d152d3";
  db.prepare("INSERT OR IGNORE INTO user_notes(id,title,content) VALUES(?,'Материал проверки',?)").run(note,JSON.stringify({type:"doc",content:[]}));
  const material={kind:"document",title:"Материал проверки",ref:"note://"+note};
  promptControl.run=async()=>{
    const tools=buildRoleToolCatalog({role:"builder",mode:"work",runId:"server-cleanup-"+included,chatId:"chat_recovery_test",messageId:triggerId});
    for(const request of ["first","second"]){
      const result=await tools.customTools[0].execute("share-"+request,{action:"invoke",operation:"taskflow_chat_share_material",version:1,request_id:"cleanup-"+included+"-"+request,arguments:{note_id:note}});
      expect(JSON.parse((result as any).content[0].text).ok).toBe(true);
    }
    expect(JSON.parse(getMessageDelivery(triggerId)!.payload_json).sharedReportMaterials).toEqual([material]);
    promptControl.answer=JSON.stringify({schema_version:1,ok:true,output:[{type:"report",report_kind:"final",sections:{result:[{type:"text",text:"Готово"}],work:[],checks:[],limitations:[],materials:included?[material]:[]}}],artifacts:included?[material]:[],plan_artifact:null,error:null,next_hint:null});
  };
  const result=await recoverAgentDelivery({chatId:"chat_recovery_test",roleId:ROLE_USER,deliveryId:triggerId});
  expect(result.status).toBe("done");
  const messages=db.prepare("SELECT role_envelope_json FROM chat_messages WHERE reply_to_message_id=? AND from_user_id=?").all(triggerId,ROLE_USER) as any[];
  expect(messages).toHaveLength(1);
  const envelope=JSON.parse(messages[0].role_envelope_json);
  expect(envelope.artifacts).toEqual([]);
  expect(envelope.output[0].sections.materials).toEqual([material]);
});

it("история чата скрывает старую отдельную карточку материала, уже включённого в итоговый отчёт",async()=>{
 const triggerId="legacy-duplicate-history";
 seedDelivery(triggerId);
 const ref="note://731fdc47-e893-4937-900c-e78ca7d152d3";
 const card="\`\`\`widget\n"+JSON.stringify({type:"card",title:"Материал",link:{title:"Открыть в TaskFlow",url:ref}})+"\n\`\`\`";
 db.prepare("INSERT INTO chat_messages(id,from_user_id,chat_id,text,channel,reply_to_message_id) VALUES('legacy-card',?,'chat_recovery_test',?,'chat',?)").run(ROLE_USER,card,triggerId);
 const envelope={schema_version:1,ok:true,output:[{type:"report",report_kind:"final",sections:{result:[{type:"text",text:"Готово"}],work:[],checks:[],limitations:[],materials:[{kind:"document",title:"Материал",ref}]}}],artifacts:[],plan_artifact:null,error:null,next_hint:null};
 db.prepare("INSERT INTO chat_messages(id,from_user_id,chat_id,text,role_envelope_json,channel,reply_to_message_id) VALUES('legacy-report',?,'chat_recovery_test','Готово',?,'chat',?)").run(ROLE_USER,JSON.stringify(envelope),triggerId);
 // A document from another question must remain visible.
 db.prepare("INSERT INTO chat_messages(id,from_user_id,chat_id,text,channel,reply_to_message_id) VALUES('standalone-card',?,'chat_recovery_test',?,'chat',NULL)").run(ROLE_USER,card);
 const response=await app!.inject({method:"GET",url:"/api/chats/chat_recovery_test/messages",headers:{authorization:"Bearer "+app!.jwt.sign({id:OWNER_USER})}});
 expect(response.statusCode).toBe(200);
 const ids=response.json().messages.map((m:any)=>m.id);
 expect(ids).toContain("legacy-report");
 expect(ids).not.toContain("legacy-card");
 expect(ids).toContain("standalone-card");
 expect(db.prepare("SELECT id FROM chat_messages WHERE id='legacy-card'").get()).toBeDefined();
});
