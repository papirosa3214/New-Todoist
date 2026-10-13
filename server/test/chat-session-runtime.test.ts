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
import { liveModelOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

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
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getLastAssistantText: ReturnType<typeof vi.fn>;
  emit: (event: unknown) => void;
}

interface WaiterSlot { resolve: () => void; }
const fakeSessions: FakeSession[] = [];
/** Следующий prompt упадёт этой ошибкой. */
let failNextPrompt: Error | null = null;
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
  const session: FakeSession = {
    options,
    sessionId: options?.sessionManager?.getSessionId?.() ?? `sess-${index + 1}`,
    prompt: vi.fn(async () => {
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
    abort: vi.fn(async () => { aborted?.(); }),
    dispose: vi.fn(() => {}),
    getLastAssistantText: vi.fn(() => "какой-то ответ"),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
  (session as any).subscribe = (listener: (event: unknown) => void) => {
    listeners.push(listener);
    return () => {};
  };
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
    expect(session.options.model.id).toBe(liveModelOf("architect"));
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
    expect(session.options.thinkingLevel).toBeUndefined();

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
