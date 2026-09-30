// Чаты с ролями-агентами, этап 2 (миграция 054, онлайн-сессия Пи): живой
// ответ роли через RpcClient, сохранение ответа как сообщения, изоляция от
// tasks/attempts/agent_state.
//
// Тесты гоняются через app.inject (тот же контракт наружу, что у клиентов),
// SDK замокирован целиком — ModelRuntime.create и RpcClient не поднимают Pi.
//
// Что проверяем:
//   1. explicit @роль в тексте → адресат определён, ответ сохранён от
//      role_<role>, attempts пустая;
//   2. следующее сообщение в том же чате продолжает ту же сессию
//      (chat_sessions.pi_session_id не сбрасывается, RpcClient получает
//      --session-id);
//   3. без @роли и без member-ролей — авто-ответа нет (только сообщение
//      пользователя);
//   4. attempts/tasks/agent_state НЕ модифицируются ни в одном исходе.
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
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  resetModelRuntime,
  _resetActiveChatRunsForTests,
} from "../src/runtime/PiRuntimeAdapter.js";
import {
  acquireChatRoleLock,
  isChatRoleLocked,
  _resetChatRoleLocksForTests,
  _resetChatRoleQueuesForTests,
} from "../src/runtime/chatSession.js";
import { _resetChatRolePickerForTests } from "../src/routes/chats.js";

// === Замоканный Pi SDK ===
//
// Те же ответы, что в PiRuntimeAdapter.test.ts: getModels() возвращает
// каталог, RpcClient — это наш fakeClient, где promptAndWait пишет ответ
// и зовёт getLastAssistantText. Это позволяет дёргать startChatRun
// ровно как в проде — минуя реальный Pi.

const CATALOG = [
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    name: "Sonnet 5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },
  {
    // В role-routing.yaml модель ролей именно «MiniMax-M3» — имя с
    // большой буквы. Каталог замокирован под это имя, иначе startChatRun
    // упадёт на model_not_available.
    id: "MiniMax-M3",
    provider: "minimax",
    name: "MiniMax M3",
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    input: ["text"],
  },
];

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: {} } },
  { id: "minimax", name: "MiniMax", auth: { apiKey: {} } },
];

interface FakeRpcClient {
  options: any;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  getLastAssistantText: ReturnType<typeof vi.fn>;
  promptAndWait: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  emit: (event: unknown) => void;
}

// === Контроль над promptAndWait для тестов B5 (сериализация) ===
//
// Тест гонки хочет, чтобы ПЕРВЫЙ ход задержался, а второй встал в
// очередь. Для этого у каждого fakeClient есть «блокирующий» waiter —
// если индекс клиента лежит в blockedPromptIndexes, promptAndWait
// зависает на deferred, пока тест не позовёт releasePromptWaiter(idx).
const blockedPromptIndexes = new Set<number>();
const promptWaiters: Array<{ resolve: () => void }> = [];

function blockPromptFor(index: number): void {
  blockedPromptIndexes.add(index);
}

function releasePromptWaiter(index: number): void {
  blockedPromptIndexes.delete(index);
  const w = promptWaiters[index];
  if (w) w.resolve();
}

const fakeClients: FakeRpcClient[] = [];
/** Следующий promptAndWait упадёт этой ошибкой — сорванный ход рантайма. */
let failNextPrompt: Error | null = null;
/** Текст ответа по номеру клиента (хода); null — стандартный ответ. */
let replyTextFor: ((index: number) => string) | null = null;

function makeFakeRpcClient(options: any): FakeRpcClient {
  // Имитируем --session-id в Pi: если в args передан --session-id, getState
  // возвращает именно его. Без этого повторный ход терял бы общий id.
  const argsList: string[] = options?.args ?? [];
  const sessionIdx = argsList.indexOf("--session-id");
  const resumedSessionId =
    sessionIdx >= 0 ? argsList[sessionIdx + 1] : null;
  const index = fakeClients.length;
  const listeners: Array<(event: unknown) => void> = [];
  const client: FakeRpcClient = {
    options,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      sessionId: resumedSessionId ?? `sess-${options?.model ?? "x"}-${fakeClients.length + 1}`,
      model: {
        provider: options?.provider ?? "anthropic",
        id: options?.model ?? "claude-sonnet-5",
      },
    })),
    getLastAssistantText: vi.fn(async () => (replyTextFor ? replyTextFor(index) : "ответил агент")),
    promptAndWait: vi.fn(async () => {
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
      });
    }),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
  fakeClients.push(client);
  promptWaiters.push({ resolve: () => {} });
  return client;
}

function lastClient(): FakeRpcClient {
  const client = fakeClients.at(-1);
  if (!client) throw new Error("no fake RpcClient created");
  return client;
}

const mockRuntime = {
  getModels: vi.fn(() => CATALOG),
  getAvailable: vi.fn(async () => CATALOG),
  getProviders: vi.fn(() => PROVIDERS),
  getProvider: vi.fn((id: string) => PROVIDERS.find((p) => p.id === id)),
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
  RpcClient: vi.fn().mockImplementation(function (options: any) {
    return makeFakeRpcClient(options);
  }),
}; });

// === Замоканный embeddingClient ===
//
// Семантический подбор роли («Авто») ходит в Ollama через этот клиент. На
// тестах эмбеддинги нам не нужны — мы тестируем @упоминание, и пусть
// «Авто» тихо вернёт null, чтобы не зависеть от сетевых вызовов и
// содержимого role_embeddings.

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({
    embeddings: [],
    dim: 0,
    durationMs: 0,
  })),
}));

// === Замоканный ../src/ws.js — ловим бродкасты chats:typing ===
//
// Реальные фактические экспорты ws.ts (проверено grep -n "^export"):
// resetAllOffline, addClient, removeClient, onUserGone, broadcast,
// broadcastTaskEvent, broadcastToUsers. Мокаем все, чтобы не уронить
// код, который может дёрнуть их за пределами этого теста (WS-роуты в
// buildApp()); broadcastToUsers пишет вызовы в broadcastCalls для
// проверки поля tool в chats:typing.
const broadcastCalls: Array<{ userIds: unknown; event: any }> = [];

vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(),
  addClient: vi.fn(),
  removeClient: vi.fn(),
  onUserGone: vi.fn(),
  broadcast: vi.fn(),
  broadcastTaskEvent: vi.fn(),
  broadcastToUsers: vi.fn((userIds: unknown, event: any) => {
    broadcastCalls.push({ userIds, event });
  }),
}));

// === Вспомогательные штуки ===

function seedRoleAccounts(): void {
  const roles = [
    "researcher", "analyst", "critic_verifier",
    "architect", "builder", "qa", "designer",
  ];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, role, role_key, type, email, password_hash, is_system_bot)
     VALUES (?, ?, 'agent', ?, 'ai', ?, '!test', 1)`,
  );
  for (const r of roles) {
    insert.run(`role_${r}`, r, r, `${r}@test`);
  }
}

function chatMessageCount(chatId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as n FROM chat_messages WHERE chat_id = ?")
    .get(chatId) as { n: number };
  return row.n;
}

function messagesByAuthor(chatId: string, fromUserId: string) {
  return db
    .prepare(
      `SELECT id, text, channel, chat_id FROM chat_messages
        WHERE chat_id = ? AND from_user_id = ? ORDER BY created_at ASC`,
    )
    .all(chatId, fromUserId) as Array<{
      id: string;
      text: string;
      channel: string;
      chat_id: string;
    }>;
}

async function tick(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Чаты (этап 2, онлайн-сессия Пи)", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerAuth: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name,
        email: `${name}-${Date.now()}-${Math.random()}@test`,
        password: "password123",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return { id: body.user.id as string, jwt: body.token as string };
  }

  async function createChat(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload,
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts();
    const owner = await reg("ChatOwner2");
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);
  });

  beforeEach(() => {
    fakeClients.length = 0;
    blockedPromptIndexes.clear();
    promptWaiters.length = 0;
    broadcastCalls.length = 0;
    replyTextFor = null;
    // Сбрасываем in-memory карту активных сессий и лок, чтобы тесты
    // не цеплялись друг за друга. На каждый тест — чистое состояние.
    resetModelRuntime();
    _resetActiveChatRunsForTests();
    _resetChatRoleLocksForTests();
    _resetChatRoleQueuesForTests();
    _resetChatRolePickerForTests();
  });

  afterEach(async () => {
    // Сбрасываем чаты и их сообщения, чтобы каждый тест начинал с пустого
    // множества. Каскад ON DELETE CASCADE уберёт chat_members и
    // chat_sessions автоматически.
    db.prepare("DELETE FROM chats").run();
    db.prepare("DELETE FROM chat_messages").run();
    db.prepare("DELETE FROM chat_sessions").run();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("planning is persisted and reaches the guarded runtime; next work turn restores work", async () => {
    const chatId = (await createChat({kind: "direct", member_ids: ["role_architect"]})).json().chat.id;
    const plan = await app.inject({method: "POST",url: `/api/chats/${chatId}/messages`, headers: ownerAuth,
      payload: {text: "Составь план", work_mode: "plan"}});
    expect(plan.statusCode).toBe(200);
    expect(plan.json().message.work_mode).toBe("plan");
    await vi.waitFor(() => expect(fakeClients).toHaveLength(1));
    await vi.waitFor(() => expect(fakeClients[0].stop).toHaveBeenCalled());
    expect(fakeClients[0].options.args).toContain("--tools");
    expect(fakeClients[0].promptAndWait.mock.calls[0][0]).toContain("Режим этого хода: Планирование");
    await app.inject({method: "POST",url: `/api/chats/${chatId}/messages`,headers: ownerAuth,
      payload: {text: "Теперь выполни", work_mode: "work"}});
    await vi.waitFor(() => expect(fakeClients).toHaveLength(2));
    await vi.waitFor(() => expect(fakeClients[1].stop).toHaveBeenCalled());
    expect(fakeClients[1].options.args).not.toContain("--tools");
    expect(fakeClients[1].promptAndWait.mock.calls[0][0]).toContain("Режим этого хода: Работа");
  });

  it("invalid and unavailable modes do not save or execute the message",async()=>{
    const chatId=(await createChat({kind:"direct",member_ids:["role_architect"]})).json().chat.id;
    for(const mode of ["bad","deep_research"]) {
      const sent=await app.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers:ownerAuth,
        payload:{text:"Проверка",work_mode:mode}});
      expect(sent.statusCode).toBe(400);
    }
    expect(chatMessageCount(chatId)).toBe(0);
    expect(fakeClients).toHaveLength(0);
  });

  it("deep research targets researcher even in a group",async()=>{
    const chatId=(await createChat({kind:"group",member_ids:["role_architect","role_researcher"]})).json().chat.id;
    const sent=await app.inject({method:"POST",url:`/api/chats/${chatId}/messages`,headers:ownerAuth,
      payload:{text:"Исследуй варианты",work_mode:"deep_research"}});
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(()=>expect(fakeClients).toHaveLength(1));
    await vi.waitFor(()=>expect(fakeClients[0].stop).toHaveBeenCalled());
    expect(fakeClients[0].promptAndWait.mock.calls[0][0]).toContain("Глубокое исследование");
    expect(messagesByAuthor(chatId,"role_researcher")).toHaveLength(1);
    expect(messagesByAuthor(chatId,"role_architect")).toHaveLength(0);
  });

  it("explicit @роль в тексте → ответ от role_<role>, attempts пустая", async () => {
    const chat = await createChat({
      title: "Диалог с архитектором",
      kind: "group",
      member_ids: ["role_architect", "role_qa"],
    });
    expect(chat.statusCode).toBe(200);
    const chatId = chat.json().chat.id;

    const baselineAttempts = (db
      .prepare("SELECT COUNT(*) as n FROM attempts")
      .get() as { n: number }).n;

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@architect подскажи архитектуру" },
    });
    expect(sent.statusCode).toBe(200);

    // Ответ приходит асинхронно через startChatRun → чуть подождём.
    await tick(120);

    const archMessages = messagesByAuthor(chatId, "role_architect");
    expect(archMessages).toHaveLength(1);
    expect(archMessages[0].text).toBe("ответил агент");
    expect(archMessages[0].channel).toBe("chat");
    expect(archMessages[0].chat_id).toBe(chatId);

    // QA НЕ должна была ответить — адресация была к архитектору.
    const qaMessages = messagesByAuthor(chatId, "role_qa");
    expect(qaMessages).toHaveLength(0);

    // Попыток в attempts не появилось — онлайн-сессия не пишет туда.
    const finalAttempts = (db
      .prepare("SELECT COUNT(*) as n FROM attempts")
      .get() as { n: number }).n;
    expect(finalAttempts).toBe(baselineAttempts);

    // chat_sessions сохранил pi_session_id для архитектора.
    const sess = db
      .prepare(
        "SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
      )
      .get(chatId, "role_architect") as { pi_session_id: string } | undefined;
    expect(sess?.pi_session_id).toMatch(/^sess-/);

    // RpcClient был создан ровно один раз, без --session-id (новый).
    expect(fakeClients).toHaveLength(1);
    const client = lastClient();
    expect(client.options.args ?? []).not.toContain("--session-id");
  });

  it("во время хода роли chats:typing несёт tool из toolcall_start", async () => {
    const chat = await createChat({
      title: "Диалог с архитектором",
      kind: "group",
      member_ids: ["role_architect", "role_qa"],
    });
    const chatId = chat.json().chat.id;

    blockPromptFor(0);
    const sendPromise = app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@architect подскажи архитектуру" },
    });
    await tick(30);

    const client = lastClient();
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", id: "t1", toolName: "read" },
    });
    await tick(30);

    releasePromptWaiter(0);
    const sent = await sendPromise;
    expect(sent.statusCode).toBe(200);
    await tick(30);

    const stepCall = broadcastCalls.find(
      (c) => c.event?.type === "chats:typing" && c.event?.tool === "read",
    );
    expect(stepCall).toBeDefined();
    expect(stepCall?.event.active).toBe(true);
    expect(stepCall?.event.chat_id).toBe(chatId);

    const finalStop = broadcastCalls.find(
      (c) => c.event?.type === "chats:typing" && c.event?.active === false,
    );
    expect(finalStop).toBeDefined();
    expect(finalStop?.event.tool).toBeUndefined();
  });

  // Живой ход как в Claude Code (владелец 27.09.2026).
  it("во время хода роли идёт chats:live с текстом и шагами, шаги ложатся в историю", async () => {
    const chat = await createChat({
      title: "Живой ход",
      kind: "group",
      member_ids: ["role_architect"],
    });
    const chatId = chat.json().chat.id;

    blockPromptFor(0);
    const sendPromise = app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@architect глянь конфиг" },
    });
    await tick(30);
    const client = lastClient();
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Смотрю конфиг." },
    });
    client.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/home/maksim/app/config.yaml" },
    });
    await tick(200);

    // Открыл чат посреди хода — снимок отдаётся запросом.
    const live = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/live`,
      headers: ownerAuth,
    });
    expect(live.statusCode).toBe(200);
    const turn = live.json().turns[0];
    expect(turn.user_id).toBe("role_architect");
    expect(turn.items).toEqual([
      { kind: "text", text: "Смотрю конфиг." },
      expect.objectContaining({ kind: "step", tool: "read", detail: "~/app/config.yaml", status: "running" }),
    ]);
    expect(
      broadcastCalls.some((c) => c.event?.type === "chats:live" && c.event?.turn?.items?.length === 2),
    ).toBe(true);

    client.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "ответил агент" },
    });
    releasePromptWaiter(0);
    await sendPromise;
    await tick(50);

    expect(
      broadcastCalls.some((c) => c.event?.type === "chats:live" && c.event?.turn === null),
    ).toBe(true);
    const done = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/live`,
      headers: ownerAuth,
    });
    expect(done.json().turns).toEqual([]);

    const history = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
    });
    const reply = history
      .json()
      .messages.find((m: any) => m.from_user_id === "role_architect");
    expect(reply.text).toBe("ответил агент");
    expect(reply.steps.items).toEqual([
      { kind: "text", text: "Смотрю конфиг." },
      expect.objectContaining({ kind: "step", tool: "read", status: "done" }),
    ]);
    expect(typeof reply.steps.duration_ms).toBe("number");
  });

  it("сорванный ход — в чат ложится сообщение с причиной, а не тишина", async () => {
    const chat = await createChat({
      title: "Обрыв",
      kind: "group",
      member_ids: ["role_architect"],
    });
    const chatId = chat.json().chat.id;

    failNextPrompt = new Error("provider exploded\nStderr: trace");
    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@architect сделай" },
    });
    expect(sent.statusCode).toBe(200);
    await tick(80);

    const replies = messagesByAuthor(chatId, "role_architect");
    expect(replies.map((r) => r.text)).toEqual(["Не смог ответить: provider exploded"]);
    expect(
      broadcastCalls.some((c) => c.event?.type === "chats:live" && c.event?.turn === null),
    ).toBe(true);
  });

  it("второе сообщение в чат продолжает ту же pi_session_id", async () => {
    const chat = await createChat({
      title: "Продолжение",
      kind: "group",
      member_ids: ["role_qa"],
    });
    const chatId = chat.json().chat.id;

    // Первое сообщение — создаст сессию.
    await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@qa первый вопрос" },
    });
    await tick(120);

    const firstSession = (db
      .prepare(
        "SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
      )
      .get(chatId, "role_qa") as { pi_session_id: string }).pi_session_id;
    expect(fakeClients).toHaveLength(1);
    expect((lastClient().options.args ?? [])).not.toContain("--session-id");

    // Второе сообщение — обязано продолжать ту же сессию.
    await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@qa второй вопрос" },
    });
    await tick(120);

    // Новый RpcClient поднялся (на каждый user message — свежий процесс),
    // и в его args теперь --session-id с прошлым id.
    expect(fakeClients).toHaveLength(2);
    const secondClient = lastClient();
    const args = secondClient.options.args ?? [];
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(firstSession);

    // chat_sessions хранит ровно одну запись, sessionId не сбросился.
    const sessions = db
      .prepare(
        "SELECT COUNT(*) as n FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
      )
      .get(chatId, "role_qa") as { n: number };
    expect(sessions.n).toBe(1);

    // Два ответа от QA — по одному на сообщение.
    const qaMessages = messagesByAuthor(chatId, "role_qa");
    expect(qaMessages).toHaveLength(2);
  });

  it("без @роли и без семантики — авто-ответа нет, ложится только текст владельца", async () => {
    // Чат без ролевых участников — значит, «Авто» не из кого выбирать.
    // member_ids пуст → POST вернёт 400. Поэтому делаем прямой INSERT
    // через sqlite, чтобы чат жил без ролей.
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO chats (id, title, kind, created_by) VALUES (?, ?, 'group', ?)",
    ).run(id, "Только владелец", ownerId);
    db.prepare(
      "INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?)",
    ).run(id, ownerId);

    const baseline = chatMessageCount(id);
    const beforeAttempts = (db
      .prepare("SELECT COUNT(*) as n FROM attempts")
      .get() as { n: number }).n;

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
      payload: { text: "просто поговорить" },
    });
    expect(sent.statusCode).toBe(200);

    // Даже если бы роль подобралась, fakeClients всё равно пуст —
    // значит startChatRun не вызывался вообще.
    await tick(120);
    expect(fakeClients).toHaveLength(0);

    const messages = db
      .prepare(
        "SELECT from_user_id, text FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC",
      )
      .all(id) as Array<{ from_user_id: string; text: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].from_user_id).toBe(ownerId);
    expect(messages[0].text).toBe("просто поговорить");

    // attempts не появилось.
    const afterAttempts = (db
      .prepare("SELECT COUNT(*) as n FROM attempts")
      .get() as { n: number }).n;
    expect(afterAttempts).toBe(beforeAttempts);
    // И в ленте чата — ровно одно сообщение (только владелец).
    expect(chatMessageCount(id)).toBe(baseline + 1);
  });

  it("онлайн-сессия не трогает tasks.agent_state и не создаёт attempt", async () => {
    const chat = await createChat({
      title: "Без побочек",
      kind: "group",
      member_ids: ["role_designer"],
    });
    const chatId = chat.json().chat.id;

    const beforeState = (db
      .prepare("SELECT COUNT(*) as n FROM tasks")
      .get() as { n: number }).n;
    const beforeAttempts = (db
      .prepare("SELECT COUNT(*) as n FROM attempts")
      .get() as { n: number }).n;

    await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@designer макет" },
    });
    await tick(120);

    // Никакой новой задачи, никакой новой попытки, никаких правок статусов.
    expect((db.prepare("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n)
      .toBe(beforeState);
    expect((db.prepare("SELECT COUNT(*) as n FROM attempts").get() as { n: number }).n)
      .toBe(beforeAttempts);

    // Сообщение-ответ всё-таки легло — это и есть «живой разговор».
    const replies = messagesByAuthor(chatId, "role_designer");
    expect(replies).toHaveLength(1);
  });

  it("повторный запуск на ту же (chat, role) блокируется локом — chat не зависает", async () => {
    const chat = await createChat({
      title: "Гонка",
      kind: "group",
      member_ids: ["role_analyst"],
    });
    const chatId = chat.json().chat.id;

    // Эмулируем «уже идёт сессия»: ставим лок вручную, как если бы
    // startChatRun был внутри. Тогда следующее сообщение должно пройти
    // через HTTP, а в ленте появится только сообщение пользователя —
    // startChatRun бросит и мы это залогируем, не уронив запрос.
    _resetChatRoleLocksForTests();
    expect(acquireChatRoleLock(chatId, "role_analyst")).toBe(true);

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@analyst срочно" },
    });
    // Запрос пользователя прошёл — текст в ленте, ошибка не выплюнута.
    expect(sent.statusCode).toBe(200);
    await tick(120);

    // Лок НЕ снят: освобождение лежит внутри startChatRun, который в
    // нашем сценарии не был вызван (гонка снята проверкой раньше).
    expect(isChatRoleLocked(chatId, "role_analyst")).toBe(true);

    // Лента — только сообщение владельца, ответа нет.
    const analystReplies = messagesByAuthor(chatId, "role_analyst");
    expect(analystReplies).toHaveLength(0);
  });

  // B5 (замечание Гермеса 21.09.2026): deliverAgentReply НЕ должен
  // запускаться параллельно на одну пару (chat, role) — иначе два
  // быстрых сообщения подряд получают ответы в случайном порядке. Здесь
  // первый ход «зависает» на promptAndWait, второй приходит и встаёт в
  // очередь. Проверяем, что ответы появляются именно в порядке
  // присылки: первый отвечает раньше, второй ждёт.
  it("B5: два быстрых сообщения подряд на одну роль отвечают в порядке присылки", async () => {
    const chat = await createChat({
      title: "Сериализация",
      kind: "group",
      member_ids: ["role_qa"],
    });
    const chatId = chat.json().chat.id;

    // Блокируем ПЕРВЫЙ promptAndWait: пока он висит, второй ход
    // должен встать в очередь, а не стартануть параллельно.
    blockPromptFor(0);

    // Первое сообщение — уйдёт в очередь и зависнет на promptAndWait.
    const firstSent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@qa первый" },
    });
    expect(firstSent.statusCode).toBe(200);
    // Даём первому ходу дойти до promptAndWait.
    await tick(50);

    // К моменту второго сообщения очередь на (chat, role_qa)
    // не пуста — значит, второй ход будет ждать, а не стартанёт
    // параллельно.
    const secondSent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "@qa второй" },
    });
    expect(secondSent.statusCode).toBe(200);
    await tick(50);

    // После второго сообщения у нас РОВНО ОДИН fakeClient — второй
    // ход ещё не стартанул, потому что ждёт в очереди. Это и есть
    // сериализация.
    expect(fakeClients).toHaveLength(1);

    // В ленте — пока только сообщения пользователя, ни одного ответа:
    // первый ход завис, второй ждёт.
    const repliesBefore = messagesByAuthor(chatId, "role_qa");
    expect(repliesBefore).toHaveLength(0);

    // Отпускаем первый — он дописывает ответ в ленту и снимает лок/очередь.
    releasePromptWaiter(0);
    await tick(80);

    // После того как первый ответ появился, второй стартует. Проверяем,
    // что всего РОВНО 2 RpcClient (по одному на ход) и оба завершились.
    expect(fakeClients).toHaveLength(2);
    releasePromptWaiter(1);
    await tick(80);

    const repliesAfter = messagesByAuthor(chatId, "role_qa");
    expect(repliesAfter).toHaveLength(2);
  });
  async function send(chatId: string, text: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text },
    });
    expect(res.statusCode).toBe(200);
    return res.json().message;
  }

  it("ответ роли: chat:new несёт готовое сообщение раньше, чем «ход закончен»", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_architect"] })).json().chat.id;
    blockPromptFor(0);
    await send(chatId, "@architect глянь");
    await tick(30);
    lastClient().emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/a" } });
    lastClient().emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false });
    releasePromptWaiter(0);
    await tick(80);

    const newIdx = broadcastCalls.findIndex(
      (c) => c.event?.type === "chat:new" && c.event.message?.from_user_id === "role_architect",
    );
    const endIdx = broadcastCalls.findIndex((c) => c.event?.type === "chats:live" && c.event.turn === null);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(newIdx);
    const message = broadcastCalls[newIdx].event.message;
    expect(broadcastCalls[endIdx].event.message_id).toBe(message.id);
    // Формат тот же, что у истории: шаги объектом, флаги булевы, вложения массивом.
    expect(message.is_session_marker).toBe(false);
    expect(message.steps.items[0]).toMatchObject({ kind: "step", tool: "read" });
    expect(message.attachments).toEqual([]);
  });

  it("ошибка модели с пустым ответом — в чат ложится причина, а не тишина", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_architect"] })).json().chat.id;
    replyTextFor = () => "";
    blockPromptFor(0);
    await send(chatId, "@architect ты тут?");
    await tick(30);
    lastClient().emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Request timed out." }],
    });
    releasePromptWaiter(0);
    await tick(80);
    expect(messagesByAuthor(chatId, "role_architect").map((m) => m.text)).toEqual([
      "Не смог ответить: Request timed out.",
    ]);
  });

  it("несколько @упоминаний — отвечает каждая упомянутая роль", async () => {
    const chatId = (
      await createChat({ kind: "group", member_ids: ["role_architect", "role_qa", "role_builder"] })
    ).json().chat.id;
    await send(chatId, "@architect и @qa, что думаете?");
    await tick(150);
    expect(messagesByAuthor(chatId, "role_architect")).toHaveLength(1);
    expect(messagesByAuthor(chatId, "role_qa")).toHaveLength(1);
    expect(messagesByAuthor(chatId, "role_builder")).toHaveLength(0);
  });

  it("роль зовёт коллегу через @имя — тот отвечает следом в том же чате", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_architect", "role_qa"] })).json().chat.id;
    replyTextFor = (i) => (i === 0 ? "@qa проверь, пожалуйста, граничные случаи" : "Проверил, всё в порядке");
    await send(chatId, "@architect спроектируй");
    await tick(250);
    expect(messagesByAuthor(chatId, "role_architect")).toHaveLength(1);
    expect(messagesByAuthor(chatId, "role_qa").map((m) => m.text)).toEqual(["Проверил, всё в порядке"]);
    // QA получил сообщение архитектора как новое сообщение хода.
    const qaPrompt = String(fakeClients[1].promptAndWait.mock.calls[0][0]);
    expect(qaPrompt).toContain("architect: @qa проверь");
  });

  it("пинг-понг ролей ограничен — без человека разговор затихает", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_architect", "role_qa"] })).json().chat.id;
    replyTextFor = (i) => (i % 2 === 0 ? "@qa твой ход" : "@architect твой ход");
    await send(chatId, "@architect начни");
    await tick(700);
    // Первый ответ + MAX_AGENT_HOPS передач.
    expect(fakeClients).toHaveLength(5);
  });

  it("продолжение сессии получает только новое, без повторной инструкции и истории", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_qa"] })).json().chat.id;
    await send(chatId, "@qa первый вопрос");
    await tick(120);
    await send(chatId, "@qa второй вопрос");
    await tick(120);
    const first = String(fakeClients[0].promptAndWait.mock.calls[0][0]);
    const second = String(fakeClients[1].promptAndWait.mock.calls[0][0]);
    expect(first).toContain("Участники чата:");
    expect(second).toContain("Продолжаем разговор");
    expect(second).toContain("второй вопрос");
    expect(second).not.toContain("первый вопрос");
    expect(second).not.toContain("Участники чата:");
  });

  it("«Остановить» прерывает ход, написанное ролью остаётся в чате", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_architect"] })).json().chat.id;
    blockPromptFor(0);
    await send(chatId, "@architect длинная работа");
    await tick(30);
    lastClient().emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Начал разбирать конфиг" },
    });
    const stop = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/stop`,
      headers: ownerAuth,
      payload: {},
    });
    expect(stop.json()).toEqual({ stopped: 1 });
    expect(lastClient().abort).toHaveBeenCalled();
    releasePromptWaiter(0);
    await tick(80);
    expect(messagesByAuthor(chatId, "role_architect").map((m) => m.text)).toEqual([
      "Начал разбирать конфиг\n\n_Остановлено._",
    ]);
  });
  it("список чатов: виджет и артефакт в превью — словом, а не кодом", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_architect"] })).json().chat.id;
    replyTextFor = () => "Держи калькулятор:\n```html\n<button>1</button>\n```";
    await send(chatId, "@architect сделай калькулятор");
    await tick(120);
    const list = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    const row = list.json().chats.find((c: any) => c.id === chatId);
    expect(row.last_message.text).toBe("Держи калькулятор:\n✦ Интерактив");
    // В самой истории ответ целиком — его рисует клиент.
    expect(messagesByAuthor(chatId, "role_architect")[0].text).toContain("<button>1</button>");
  });

  it("первый ход роли знает про таблицы, виджеты и интерактив", async () => {
    const chatId = (await createChat({ kind: "group", member_ids: ["role_qa"] })).json().chat.id;
    await send(chatId, "@qa привет");
    await tick(120);
    const prompt = String(fakeClients[0].promptAndWait.mock.calls[0][0]);
    expect(prompt).toContain("```widget");
    expect(prompt).toContain("taskflow_weather");
    expect(prompt).toContain("языком html");
  });
});
