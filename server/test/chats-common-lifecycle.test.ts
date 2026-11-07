// Чаты: общий чат, жизненный цикл темы задачи, «только @» (карточка
// ca816271, документ проектирования d748e4f4).
//
// Проверяем ровно серверное поведение через app.inject; Pi-рантайм замокан
// тем же переходником, что в chats-online.test.ts, — реальный процесс не
// поднимается.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { resetModelRuntime, _resetActiveChatRunsForTests } from "../src/runtime/PiRuntimeAdapter.js";
import {
  _resetChatRoleLocksForTests,
  _resetChatRoleQueuesForTests,
} from "../src/runtime/chatSession.js";
import { _resetChatRolePickerForTests } from "../src/routes/chats.js";
import { COMMON_CHAT_ID, COMMON_REGULATOR_MESSAGE_ID, assertCommonChatWritable } from "../src/lib/chatCommon.js";
import { liveCatalogEntryOf, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

// Модели ролей — из боевого role-routing.yaml (helpers/liveRoutingModels):
// подделка каталога не должна знать про смену основной модели (13.10.2026).
const CATALOG = [
  { id: "claude-sonnet-5", provider: "anthropic", name: "Sonnet 5", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] },
  liveCatalogEntryOf("qa"),
];
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: {} } },
  ...liveRoutingProviders(),
];

const fakeClients: Array<{ options: any; getLastAssistantText: ReturnType<typeof vi.fn>; promptAndWait: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];

function makeFakeRpcClient(options: any) {
  const argsList: string[] = options?.args ?? [];
  const sessionIdx = argsList.indexOf("--session-id");
  const resumedSessionId = sessionIdx >= 0 ? argsList[sessionIdx + 1] : null;
  const client = {
    options,
    stop: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      sessionId: resumedSessionId ?? `sess-${fakeClients.length + 1}`,
      model: { provider: options?.provider ?? "anthropic", id: options?.model ?? "claude-sonnet-5" },
    })),
    getLastAssistantText: vi.fn(async () => "ответил агент"),
    promptAndWait: vi.fn(async () => {}),
  };
  fakeClients.push(client as any);
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

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPackageDir: () => "/mock/pi-pkg",
    ModelRuntime: { create: vi.fn(async () => mockRuntime) },
    createAgentSession: vi.fn(async (opts: any) => {
      const id: string | undefined = opts.sessionManager?.getSessionId?.();
      const resumed = id && !/^[0-9a-f-]{36}$/i.test(id) ? id : null;
      const planning = !opts.tools.includes("bash");
      const client = makeFakeRpcClient({
        cwd: opts.cwd,
        model: opts.model?.id,
        provider: opts.model?.provider,
        args: [...(resumed ? ["--session-id", resumed] : []), ...(planning ? ["--tools", "read"] : [])],
      });
      const state = await client.getState();
      let last = "";
      return {
        session: {
          sessionId: state.sessionId,
          subscribe: () => () => {},
          prompt: async () => {
            await client.promptAndWait();
            last = await client.getLastAssistantText();
          },
          abort: () => {},
          dispose: () => {},
          getLastAssistantText: () => last,
        },
      };
    }),
  };
});

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));

vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(),
  addClient: vi.fn(),
  removeClient: vi.fn(),
  onUserGone: vi.fn(),
  broadcast: vi.fn(),
  broadcastTaskEvent: vi.fn(),
  broadcastToUsers: vi.fn(),
}));

function seedRoleAccounts(): void {
  const roles = ["researcher", "analyst", "critic_verifier", "architect", "builder", "qa", "designer"];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (id, name, role, role_key, type, email, password_hash, is_system_bot)
     VALUES (?, ?, 'agent', ?, 'ai', ?, '!test', 1)`,
  );
  for (const r of roles) insert.run(`role_${r}`, r, r, `${r}@test`);
}

function ensureSecretaryAgain(): void {
  // Миграция уже включила secretary; на всякий случай не мешаем повтору.
  db.prepare("INSERT OR IGNORE INTO roles (key, title, summary, enabled, position) VALUES ('secretary','Помощник владельца','помощник владельца',1,7)").run();
}

async function tick(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("Чаты: общий чат, тема задачи, только @", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerAuth: string;
  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}-${Math.random()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts();
    ensureSecretaryAgain();
    // В тестовом окружении владельцем должен быть наш пользователь.
    db.prepare("UPDATE users SET role='agent' WHERE id='u1' AND role='owner'").run();
    const owner = await reg("ChatLifecycle");
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    // В тестовом окружении владелец заводится позже buildApp — добавляем его
    // в общий чат, как это делает ensureCommonChat для боевого владельца.
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(COMMON_CHAT_ID, ownerId);
  });

  beforeEach(() => {
    fakeClients.length = 0;
    resetModelRuntime();
    _resetActiveChatRunsForTests();
    _resetChatRoleLocksForTests();
    _resetChatRoleQueuesForTests();
    _resetChatRolePickerForTests();
  });

  afterEach(() => {
    db.prepare("DELETE FROM chats WHERE id NOT IN ('chat-common','chat-secretary')").run();
    db.prepare("DELETE FROM chat_messages WHERE chat_id NOT IN ('chat-common','chat-secretary')").run();
    db.prepare("DELETE FROM chat_sessions").run();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("Помощник владельца — обычная роль: role_key выставлен, спец-пути больше нет", () => {
    const row = db.prepare("SELECT role_key, type, role FROM users WHERE id='u-secretary'").get() as any;
    expect(row.role_key).toBe("secretary");
    expect(row.type).toBe("ai");
    expect(row.role).toBe("agent");
    const prompt = db.prepare("SELECT prompt FROM roles WHERE key='secretary'").get() as any;
    expect(prompt.prompt).toContain("taskflow_task_summary");
  });

  it("общий чат заведён: владелец в составе, регламент закреплён", () => {
    const chat = db.prepare("SELECT id, kind, pinned_message_id FROM chats WHERE id=?").get(COMMON_CHAT_ID) as any;
    expect(chat).toBeTruthy();
    expect(chat.kind).toBe("group");
    expect(chat.pinned_message_id).toBe(COMMON_REGULATOR_MESSAGE_ID);
    const pinned = db.prepare("SELECT message_type, text FROM chat_messages WHERE id=?").get(COMMON_REGULATOR_MESSAGE_ID) as any;
    expect(pinned.message_type).toBe("system");
    expect(pinned.text).toContain("@qa");
  });

  it("в общий чат не пускает серверные записи, но пускает владельца", async () => {
    expect(() => assertCommonChatWritable(COMMON_CHAT_ID, "system")).toThrow();
    expect(() => assertCommonChatWritable(COMMON_CHAT_ID, "bootstrap")).not.toThrow();
    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${COMMON_CHAT_ID}/messages`,
      headers: ownerAuth,
      payload: { text: "привет всем" },
    });
    expect(sent.statusCode).toBe(200);
    const count = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND from_user_id=?").get(COMMON_CHAT_ID, ownerId) as any;
    expect(count.n).toBe(1);
  });

  it("маркер новой сессии в общий чат не пишется (ручка new-session отбита)", async () => {
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(COMMON_CHAT_ID, "role_architect");
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${COMMON_CHAT_ID}/new-session`,
      headers: ownerAuth,
      payload: { role_id: "role_architect" },
    });
    expect(res.statusCode).toBe(403);
    const markers = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND is_session_marker=1").get(COMMON_CHAT_ID) as any;
    expect(markers.n).toBe(0);
  });

  it("тема задачи создаётся вместе с задачей проекта и закрывается с ней", async () => {
    const project = await app.inject({ method: "POST", url: "/api/projects", headers: ownerAuth, payload: { name: "Темы задач", with_docs: false } });
    expect(project.statusCode).toBe(200);
    const projectId = project.json().project?.id ?? project.json().id;
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Задача с темой", project_id: projectId },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id;
    const topic = db.prepare("SELECT id, closed_at FROM chats WHERE task_id=? AND room_kind='task'").get(taskId) as any;
    expect(topic).toBeTruthy();
    expect(topic.closed_at).toBeNull();

    // Список чатов показывает открытую тему.
    let list = (await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth })).json().chats.map((c: any) => c.id);
    expect(list).toContain(topic.id);

    // Закрываем задачу — тема закрывается и уходит из списка открытых.
    const done = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: ownerAuth, payload: { status: "completed" } });
    expect(done.statusCode).toBe(200);
    const closed = db.prepare("SELECT closed_at FROM chats WHERE id=?").get(topic.id) as any;
    expect(closed.closed_at).not.toBeNull();
    list = (await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth })).json().chats.map((c: any) => c.id);
    expect(list).not.toContain(topic.id);
    const all = (await app.inject({ method: "GET", url: "/api/chats?include_closed=1", headers: ownerAuth })).json().chats.map((c: any) => c.id);
    expect(all).toContain(topic.id);

    // В закрытую тему писать нельзя — 409.
    const write = await app.inject({ method: "POST", url: `/api/chats/${topic.id}/messages`, headers: ownerAuth, payload: { text: "ещё вопрос" } });
    expect(write.statusCode).toBe(409);

    // Возврат в работу открывает тему снова.
    await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: ownerAuth, payload: { status: "active" } });
    const reopened = db.prepare("SELECT closed_at FROM chats WHERE id=?").get(topic.id) as any;
    expect(reopened.closed_at).toBeNull();
  });

  it("в групповом чате без @ никто не просыпается, с @ — отвечает", async () => {
    const chat = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { kind: "group", member_ids: ["role_architect", "role_qa"] },
    });
    expect(chat.statusCode).toBe(200);
    const chatId = chat.json().chat.id;

    const quiet = await app.inject({ method: "POST", url: `/api/chats/${chatId}/messages`, headers: ownerAuth, payload: { text: "просто размышление вслух" } });
    expect(quiet.statusCode).toBe(200);
    await tick();
    expect(fakeClients).toHaveLength(0);
    const roles = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND from_user_id LIKE 'role_%'").get(chatId) as any;
    expect(roles.n).toBe(0);

    const wake = await app.inject({ method: "POST", url: `/api/chats/${chatId}/messages`, headers: ownerAuth, payload: { text: "@architect подскажи" } });
    expect(wake.statusCode).toBe(200);
    await vi.waitFor(() => expect(fakeClients).toHaveLength(1));
    const arch = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND from_user_id='role_architect'").get(chatId) as any;
    expect(arch.n).toBe(1);
    const qa = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND from_user_id='role_qa'").get(chatId) as any;
    expect(qa.n).toBe(0);
  });

  it("в личном чате роль отвечает и без @", async () => {
    const chat = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { kind: "direct", member_ids: ["role_architect"] },
    });
    expect(chat.statusCode).toBe(200);
    const chatId = chat.json().chat.id;
    const sent = await app.inject({ method: "POST", url: `/api/chats/${chatId}/messages`, headers: ownerAuth, payload: { text: "привет, как дела" } });
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(() => expect(fakeClients).toHaveLength(1));
    const arch = db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND from_user_id='role_architect'").get(chatId) as any;
    expect(arch.n).toBe(1);
  });
});
