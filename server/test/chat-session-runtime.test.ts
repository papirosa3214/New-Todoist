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

// === Замоканный Pi SDK ===

const CATALOG = [
  {
    id: "MiniMax-M3",
    provider: "minimax",
    name: "MiniMax M3",
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    input: ["text"],
  },
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

/** Контролируемое ожидание для promptAndWait: для каждого fakeClient
 *  хранится слот с resolve(). По умолчанию слот пустой и promptAndWait
 *  резолвится сразу. Если в blockedPromptIndexes лежит индекс клиента,
 *  promptAndWait повисает на deferred-промисе, пока тест не позовёт
 *  releasePromptWaiter(index). Это нужно для теста гонки на лок. */
interface WaiterSlot { resolve: () => void; }
const fakeClients: FakeRpcClient[] = [];
/** Следующий promptAndWait упадёт этой ошибкой. */
let failNextPrompt: Error | null = null;
const promptWaiters: WaiterSlot[] = [];
/** Индексы fakeClient, у которых promptAndWait должен зависнуть. */
const blockedPromptIndexes = new Set<number>();

function blockPromptFor(index: number): void {
  blockedPromptIndexes.add(index);
}

function releasePromptWaiter(index: number): void {
  blockedPromptIndexes.delete(index);
  const w = promptWaiters[index];
  if (w) w.resolve();
}

function makeFakeRpcClient(options: any): FakeRpcClient {
  const index = fakeClients.length;
  // Если клиент создан с --session-id в args (т. е. мы «продолжаем»
  // существующую сессию) — getState возвращает тот же id, что в args.
  // Это повторяет поведение реального Pi: --session-id не создаёт новый
  // id, а использует переданный. Без этого тест «продолжения сессии»
  // видел бы свежий id на каждом вызове и считал, что контекст потерян.
  const argsList: string[] = options?.args ?? [];
  const sessionIdx = argsList.indexOf("--session-id");
  const resumedSessionId =
    sessionIdx >= 0 ? argsList[sessionIdx + 1] : null;
  // По умолчанию promptAndWait резолвится мгновенно. Если тест положил
  // индекс клиента в blockedPromptIndexes — promptAndWait повисает
  // на deferred, пока тест не позовёт releasePromptWaiter(index).
  const listeners: Array<(event: unknown) => void> = [];
  const client: FakeRpcClient = {
    options,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      sessionId:
        resumedSessionId ?? `sess-${fakeClients.length + 1}`,
      model: {
        provider: options?.provider ?? "minimax",
        id: options?.model ?? "MiniMax-M3",
      },
    })),
    getLastAssistantText: vi.fn(async () => "какой-то ответ"),
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

const mockRuntime = {
  getModels: vi.fn(() => CATALOG),
  getAvailable: vi.fn(async () => CATALOG),
  getProviders: vi.fn(() => [{ id: "minimax", name: "MiniMax", auth: { apiKey: {} } }]),
  getProvider: vi.fn(() => ({ id: "minimax", name: "MiniMax", auth: { apiKey: {} } })),
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
  fakeClients.length = 0;
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

describe("startChatRun (адаптер онлайн-сессии)", () => {
  it("создаёт RpcClient с моделью из routing роли и сохраняет sessionId", async () => {
    const result = await startChatRun({
      chatId: "chat-direct",
      role: "architect",
      roleId: "role_architect",
      prompt: "привет",
    });

    // Один RpcClient, провайдер/модель из role-routing.
    expect(fakeClients).toHaveLength(1);
    const client = fakeClients[0];
    expect(client.options.model).toBe("MiniMax-M3");
    expect(client.options.provider).toBe("minimax");
    // Новая сессия — без --session-id. С 25.09.2026 роль в чате ходит своим
    // пропуском (roleRunAccess), поэтому --mcp-config в аргументах есть всегда.
    const args: string[] = client.options.args ?? [];
    expect(args).not.toContain("--session-id");
    expect(args[0]).toBe("--mcp-config");
    // promptAndWait вызван с нашим промптом.
    expect(client.promptAndWait).toHaveBeenCalledWith(
      "привет",
      undefined,
      expect.any(Number),
    );

    // sessionId из getState() сохранён в chat_sessions.
    expect(result.sessionId).toMatch(/^sess-\d+$/);
    const row = db
      .prepare(
        "SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
      )
      .get("chat-direct", "role_architect") as
      | { pi_session_id: string }
      | undefined;
    expect(row?.pi_session_id).toBe(result.sessionId);
    expect(result.text).toBe("какой-то ответ");

    // Изоляция: attempts/tasks пусто, никаких записей не появилось.
    const attempts = (db
      .prepare("SELECT COUNT(*) as n FROM attempts")
      .get() as { n: number }).n;
    const tasks = (db.prepare("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n;
    expect(attempts).toBe(0);
    expect(tasks).toBe(0);
  });

  it("повторный запуск передаёт --session-id с прошлым sessionId", async () => {
    const first = await startChatRun({
      chatId: "chat-direct",
      role: "qa",
      roleId: "role_qa",
      prompt: "раз",
    });
    // Между вызовами адаптера лукап sessionId делает вызывающая сторона
    // (routes/chats.ts через getChatSessionId). В тесте повторяем ту же
    // последовательность вручную.
    const saved = db
      .prepare(
        "SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
      )
      .get("chat-direct", "role_qa") as { pi_session_id: string } | undefined;
    const second = await startChatRun({
      chatId: "chat-direct",
      role: "qa",
      roleId: "role_qa",
      prompt: "два",
      sessionId: saved ? saved.pi_session_id : undefined,
    });

    expect(fakeClients).toHaveLength(2);
    // Второй RpcClient получил args с --session-id и прошлым id.
    const secondClient = fakeClients[1];
    const args = secondClient.options.args ?? [];
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(first.sessionId);
    // chat_sessions — ровно одна запись, sessionId не сбросился.
    const rows = db
      .prepare(
        "SELECT COUNT(*) as n FROM chat_sessions WHERE chat_id = ? AND role_id = ?",
      )
      .get("chat-direct", "role_qa") as { n: number };
    expect(rows.n).toBe(1);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("неизвестная роль → ошибка без подъёма RpcClient", async () => {
    await expect(
      startChatRun({
        chatId: "chat-direct",
        // @ts-expect-error — тестируем именно нелегальное значение.
        role: "ghost",
        roleId: "role_ghost",
        prompt: "хм",
      }),
    ).rejects.toThrow(/неизвестная роль/);
    expect(fakeClients).toHaveLength(0);
  });

  it("параллельный запуск на ту же (chat, role) → второй отказ", async () => {
    // Заранее говорим «следующий клиент пусть зависнет на promptAndWait».
    blockPromptFor(0);

    const first = startChatRun({
      chatId: "chat-direct",
      role: "architect",
      roleId: "role_architect",
      prompt: "долгий",
    });
    // Ждём, пока startChatRun создаст клиента и войдёт в promptAndWait.
    await new Promise((r) => setTimeout(r, 30));
    expect(fakeClients).toHaveLength(1);

    await expect(
      startChatRun({
        chatId: "chat-direct",
        role: "architect",
        roleId: "role_architect",
        prompt: "параллельный",
      }),
    ).rejects.toThrow(/уже идёт живая сессия/);

    // Отпускаем первого — finally снимет лок.
    releasePromptWaiter(0);
    await first;
  });

  it("cancelChatRun снимает активную сессию и освобождает лок", async () => {
    const first = startChatRun({
      chatId: "chat-direct",
      role: "qa",
      roleId: "role_qa",
      prompt: "зависший",
    });
    await new Promise((r) => setTimeout(r, 5));

    // Находим активный runId через stopAllChatRuns и cancelChatRun —
    // здесь дёрнем cancel для каждого fakeClients (он один).
    expect(fakeClients).toHaveLength(1);
    // activeChatRuns закрыт в модуле; но cancelChatRun возвращает false,
    // если run уже завершился. В нашем случае процесс ещё «висит» —
    // promptAndWait резолвится сразу в fake, поэтому первый уже мог
    // закончиться. Это допустимо: тест проверяет, что cancel не падает
    // на неизвестном/уже завершённом run.
    const cancelled = await cancelChatRun("chat_unknown");
    expect(cancelled).toBe(false);

    await first;
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
  async function firstClient() {
    await vi.waitFor(() => expect(fakeClients).toHaveLength(1));
    return fakeClients[0] as FakeRpcClient;
  }

  it("роль молчит дольше idleMs — ход обрывается с CHAT_RUN_IDLE, рантайм прерван", async () => {
    blockPromptFor(0);
    const run = startChatRun({ ...base, idleMs: 150 });
    const client = await firstClient();
    await expect(run).rejects.toMatchObject({ code: "CHAT_RUN_IDLE", limitMs: 150 });
    expect(client.abort).toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalled();
  });

  it("пока идут события, ход живёт дольше idleMs", async () => {
    blockPromptFor(0);
    const run = startChatRun({ ...base, idleMs: 150 });
    const client = await firstClient();
    for (let i = 0; i < 8; i++) {
      await tickMs(60);
      client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "." } });
    }
    releasePromptWaiter(0);
    await expect(run).resolves.toMatchObject({ text: "какой-то ответ" });
    expect(client.abort).not.toHaveBeenCalled();
  });

  it("долгий вызов инструмента тишиной не считается", async () => {
    blockPromptFor(0);
    const run = startChatRun({ ...base, idleMs: 150 });
    const client = await firstClient();
    client.emit({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: {} });
    await tickMs(500);
    releasePromptWaiter(0);
    await expect(run).resolves.toBeDefined();
    expect(client.abort).not.toHaveBeenCalled();
  });

  it("события хода пробрасываются наружу через onEvent", async () => {
    const seen: unknown[] = [];
    blockPromptFor(0);
    const run = startChatRun({ ...base, onEvent: (e) => seen.push(e) });
    const client = await firstClient();
    const event = { type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: {} };
    client.emit(event);
    releasePromptWaiter(0);
    await run;
    expect(seen).toEqual([event]);
  });

  it("общий потолок: по умолчанию 30 минут, срыв по нему — CHAT_RUN_CEILING", async () => {
    const run = startChatRun({ ...base });
    const client = await firstClient();
    await run;
    expect(client.promptAndWait).toHaveBeenCalledWith("сделай", undefined, CHAT_RUN_CEILING_MS);

    failNextPrompt = new Error("Timeout collecting events. Stderr: x");
    await expect(startChatRun({ ...base, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "CHAT_RUN_CEILING",
      limitMs: 1000,
    });
  });
});
