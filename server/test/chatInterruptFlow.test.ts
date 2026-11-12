// Этап 2 плана карточки 252c400e: сквозной сценарий обычного чата.
//
// Сценарий «уточнение прерывает прежнюю работу, новая идёт с новым
// контекстом» через настоящий HTTP-маршрут /api/chats/:id/messages:
//   1. владелец пишет — роль начинает ход (фальшивый Pi виснет на долгом
//      действии);
//   2. владелец пишет ещё раз — прежняя работа останавливается: поколение
//      пары увеличивается (старые доставки гасятся), ход прежнего поколения
//      закрыт, частичный ответ сохранён с признаком прерывания;
//   3. следующий ход продолжает ТУ ЖЕ сессию со всей прежней памятью
//      (владелец 31.10.2026): новое поколение не стартует, выжимка не
//      подменяет прежний разговор.
//
// Pi замокан: внешняя работа имитируется «висящим» prompt, который
// отпускается по abort. Сети и живых моделей нет.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";
import { currentChatGeneration } from "../src/runtime/chatQueue.js";
import { _resetActiveChatRunsForTests } from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRoleLocksForTests, _resetChatRoleQueuesForTests } from "../src/runtime/chatSession.js";

const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();
const PRIMARY = liveCatalogEntryOf("qa");

/** Журнал вызовов фальшивого Pi: какие сессии открывались и с каким промптом. */
const sessions: Array<{ sessionId: string; prompts: string[]; aborted: boolean; waiting: boolean }> = [];
/** Сессия, чей промпт содержит эту строку, висит до abort. Признак по
 *  тексту, а не по индексу: фоновые ходы прошлых сценариев могут создать
 *  сессию раньше и сдвинуть индекс. */
let hangText = "";

function makeSession(sessionId: string) {
  const record = { sessionId, prompts: [] as string[], aborted: false, waiting: false };
  sessions.push(record);
  return {
    record,
    session: {
      sessionId,
      subscribe: () => () => {},
      prompt: async (text: string) => {
        record.prompts.push(text);
        if (hangText && text.includes(hangText)) {
          record.waiting = true;
          // Висим, пока ход не отменят.
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (record.aborted) {
                clearInterval(timer);
                resolve();
              }
            }, 5);
            timer.unref?.();
          });
          const error = Object.assign(new Error("ход остановлен владельцем"), {
            code: "CHAT_RUN_CANCELLED",
          });
          throw error;
        }
      },
      abort: async () => {
        record.aborted = true;
      },
      waitForIdle: async () => {},
      dispose: () => {},
      getLastAssistantText: () => "ок",
    },
  };
}

/** Сессия, которую тест удерживает открытой. */
function hung() {
  return sessions.find((s) => hangText && s.prompts.some((p) => p.includes(hangText)));
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

let sessionCounter = 0;

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPackageDir: () => "/mock/pi-pkg",
    ModelRuntime: { create: vi.fn(async () => mockRuntime) },
    createAgentSession: vi.fn(async (opts: any) => {
      sessionCounter += 1;
      const existing = opts.sessionManager?.getSessionId?.();
      // Продолжение той же сессии владелец теперь требует и после
      // остановки (31.10.2026): сохранённый id должен дойти до адаптера.
      const id = existing ? String(existing) : `sess-new-${sessionCounter}`;
      return makeSession(id);
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
let ownerHeader: Record<string, string> = {};
let chatId = "";
let roleUserId = "";

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "OwnerInterrupt",
      email: `owner-interrupt-${Date.now()}@test`,
      password: "password123",
    },
  });
  ownerHeader = { authorization: `Bearer ${reg.json().token}` };
  // Зарегистрированная учётка — обычный человек; владельцем её делает
  // сервер (права владельца включают остановку хода по уточнению).
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(reg.json().user.id);
  roleUserId = (db
    .prepare("SELECT id FROM users WHERE role_key='builder' AND type='ai' LIMIT 1")
    .get() as { id: string }).id;
});

beforeEach(async () => {
  sessions.length = 0;
  hangText = "";
  sessionCounter = 0;
  _resetActiveChatRunsForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
  // Свой чат на каждый сценарий: фоновые ходы прошлого теста дописывают
  // сессию в свой чат и больше не могут подменить её в следующем.
  const chat = await app!.inject({
    method: "POST",
    url: "/api/chats",
    headers: ownerHeader,
    payload: { kind: "direct", member_ids: ["role_builder"] },
  });
  chatId = chat.json().chat.id;
  db.prepare("DELETE FROM chat_sessions WHERE chat_id=?").run(chatId);
  // Таблицы выжимки на старом коде ещё нет — чистка не должна падать,
  // чтобы падение теста было про поведение, а не про схему.
  try {
    db.prepare("DELETE FROM chat_checkpoints WHERE chat_id=?").run(chatId);
    // Указатель переноса выжимки переживает чат: без очистки следующий
    // сценарий увидел бы «перенесённую выжимку» и стартовал бы заново.
    db.prepare("DELETE FROM chat_checkpoint_transfers").run();
  } catch {
    /* на старом коде таблицы нет */
  }
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id=?").run(chatId);
});

afterEach(async () => {
  // Даём фоновым ходам прошлого теста действительно встать: иначе их
  // поздний upsert сессии прилетает уже после очистки и ломает следующий
  // сценарий (тот же класс гонки, что и в живом сервере после «Стоп»).
  await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(async () => {
  if (app) await app.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Граница прерывания хода: кнопка «Стоп» (новое сообщение ход больше не прерывает). */
const ownerStop = () =>
  app!.inject({ method: "POST", url: `/api/chats/${chatId}/stop`, headers: ownerHeader, payload: {} });

describe("обычный чат: остановка хода владельцем", () => {
  it("прежний ход остановлен, поколение увеличено, новый ход идёт с выжимкой", async () => {
    // Первая сессия «висит» на долгом действии.
    hangText = "Начни долгую работу А";
    const first = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Начни долгую работу А" },
    });
    expect(first.statusCode).toBe(200);
    // Ждём, пока ход действительно начался и повис.
    for (let i = 0; i < 100 && !(hung()?.waiting ?? false); i += 1) await sleep(20);
    expect(hung()?.waiting).toBe(true);
    const generationBefore = currentChatGeneration(chatId, roleUserId);

    // Второе сообщение владельца — уточнение: прежняя работа прерывается.
    const second = await ownerStop();
    expect(second.statusCode).toBe(200);

    // Граница сработала: поколение пары увеличилось.
    expect(currentChatGeneration(chatId, roleUserId)).toBeGreaterThan(generationBefore);
    // Прежний ход реально остановлен (abort дошёл до фальшивого Pi).
    await sleep(50);
    expect(
      sessions
        .filter((s) => hangText && s.prompts.some((p) => p.includes(hangText)))
        .some((s) => s.aborted),
    ).toBe(true);
    // Ходы прежнего поколения закрыты — восстановление их не повторит.
    const stale = db
      .prepare("SELECT status FROM chat_message_queue WHERE chat_id=? AND role_id=? AND session_generation<=?")
      .all(chatId, roleUserId, generationBefore) as Array<{ status: string }>;
    expect(stale.every((row) => row.status !== "pending" && row.status !== "picked")).toBe(true);
  });

  it("прерванный ответ помечен: почему прерван и что он частичный", async () => {
    hangText = "Начни работу, потом уточню Б";
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Начни работу, потом уточню Б" },
    });
    for (let i = 0; i < 100 && !(hung()?.waiting ?? false); i += 1) await sleep(20);
    expect(hung()?.waiting).toBe(true);
    await ownerStop();
    for (let i = 0; i < 100; i += 1) {
      const marked = db
        .prepare(
          "SELECT id, stop_reason, partial FROM chat_messages WHERE chat_id=? AND from_user_id=? AND stop_reason IS NOT NULL",
        )
        .all(chatId, roleUserId) as Array<{ id: string; stop_reason: string; partial: number }>;
      if (marked.length) {
        expect(marked[0].stop_reason).toBe("owner_interrupt");
        expect(marked[0].partial).toBe(1);
        return;
      }
      await sleep(20);
    }
    throw new Error("прерванный ответ не помечен stop_reason");
  });

  it("после прерывания продолжается та же сессия со всей прежней памятью", async () => {
    // Первая сессия «висит» на долгом действии.
    hangText = "Начни долгую работу В";
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Начни долгую работу В" },
    });
    for (let i = 0; i < 100 && !(hung()?.waiting ?? false); i += 1) await sleep(20);
    expect(hung()?.waiting).toBe(true);

    // Владелец останавливает ход и пишет новое (сообщение во время хода
    // теперь встаёт в очередь — test/chatQueued.test.ts, 12.11.2026).
    await ownerStop();
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Стоп, теперь другое В" },
    });
    let next: (typeof sessions)[number] | undefined;
    for (let i = 0; i < 200 && !next; i += 1) {
      next = [...sessions]
        .reverse()
        .find((s) => s.prompts.some((p) => p.includes("Стоп, теперь другое В")));
      if (!next) await sleep(20);
    }
    expect(next).toBeDefined();
    if (!next) throw new Error("ход на уточнение не стартовал");
    // Та же сессия: продолжение разговора, а не свежий ход с выжимкой.
    const prompt = next!.prompts.join("\n");
    expect(prompt).toContain("Продолжаем разговор в чате TaskFlow");
    expect(prompt).not.toContain("Что выполнить");
    // Следующий ход — обычное продолжение разговора.
    expect(prompt).toContain("Стоп, теперь другое В");
    // Поколение сессии догнало текущее: next-ход не считается устаревшим.
    const savedAfter = db
      .prepare("SELECT generation FROM chat_sessions WHERE chat_id=? AND role_id=?")
      .get(chatId, roleUserId) as { generation: number } | undefined;
    expect(savedAfter?.generation).toBe(currentChatGeneration(chatId, roleUserId));
  });
});
