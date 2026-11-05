import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/runtimeAi.js", () => ({ callRuntimeModel: vi.fn() }));

import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { callRuntimeModel } from "../src/lib/runtimeAi.js";
import { chatMemoryObserverPass, observeChatMemory } from "../src/runtime/chatMemoryObserver.js";
import { setSetting } from "../src/lib/serverSettings.js";

// Наблюдатель личного чата (владелец 05.11.2026): после 15 минут тишины и при закрытии сессии.
let app: any;
let auth: { authorization: string };
let owner: string;
const model = vi.mocked(callRuntimeModel);
const LESSON = JSON.stringify({ action: "remember", title: "Урок из чата", text: "Устойчивое правило из разговора.", kind: "lesson", confidence: 0.95 });
const LONG = "Обсудили, как правильно настроить кэш и почему инвалидировать его надо по версии записи, а не по времени. ".repeat(3);

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: `chatobs-${Date.now()}@test`, password: "password123" } });
  owner = reg.json().user.id;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  auth = { authorization: `Bearer ${reg.json().token}` };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 })));
  setSetting("memory_observer_enabled", true, null, "тест");
  setSetting("memory_observer_min_confidence", 60, null, "тест");
});
beforeEach(() => {
  model.mockReset();
  model.mockResolvedValue(LESSON);
  // Чаты прошлых тестов не должны попадать в проход этого.
  db.prepare("UPDATE chat_messages SET created_at=datetime('now','-30 day') WHERE created_at<=datetime('now','-1 minute')").run();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

function chat(opts: { room?: string | null; taskId?: string | null; subagent?: string | null } = {}) {
  const id = `chatobs_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO chats(id,title,kind,created_by,task_id,room_kind,subagent_role_id) VALUES (?,'Сессия','direct',?,?,?,?)").run(id, owner, opts.taskId ?? null, opts.room ?? null, opts.subagent ?? null);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,?)").run(id, owner);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,'role_builder')").run(id);
  return id;
}
function message(chatId: string, from: string, text: string, minutesAgo: number, type: string | null = null) {
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,message_type,created_at) VALUES (?,?,?,'chat',?,?,datetime('now',?))")
    .run(crypto.randomUUID(), from, text, chatId, type, `-${minutesAgo} minutes`);
}
const talk = (chatId: string, minutesAgo: number) => {
  message(chatId, owner, LONG, minutesAgo + 1);
  message(chatId, "role_builder", LONG, minutesAgo);
};
const events = (chatId: string) => db.prepare("SELECT outcome,role_key FROM memory_observer_events WHERE source_ref LIKE ?").all(`chatobs:${chatId}:%`) as Array<{ outcome: string; role_key: string }>;

it("после 15 минут тишины записывает урок в личную память роли", async () => {
  const id = chat();
  talk(id, 16);
  await chatMemoryObserverPass();
  expect(model).toHaveBeenCalledTimes(1);
  expect(model.mock.calls[0][0].userPrompt).toContain("Обсудили, как правильно настроить кэш");
  expect(events(id)).toEqual([{ outcome: "wrote", role_key: "builder" }]);
  const row = db.prepare("SELECT scope,role_key FROM memories WHERE source_ref LIKE ?").get(`chatobs:${id}:%`) as any;
  expect(row).toMatchObject({ scope: "role", role_key: "builder" });
});

it("пока тишины меньше 15 минут, не трогает разговор", async () => {
  const id = chat();
  talk(id, 10);
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
});

it("один разговор не читает дважды, а новые сообщения читает", async () => {
  const id = chat();
  talk(id, 40);
  await chatMemoryObserverPass();
  model.mockClear();
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
  message(id, owner, "Новое про очереди: " + LONG, 20);
  message(id, "role_builder", "Ответ про очереди: " + LONG, 19);
  await chatMemoryObserverPass();
  expect(model).toHaveBeenCalledTimes(1);
  expect(model.mock.calls[0][0].userPrompt).toContain("Новое про очереди");
  expect(model.mock.calls[0][0].userPrompt).not.toContain("Обсудили, как правильно настроить кэш и почему инвалидировать его надо по версии записи, а не по времени. Обсудили, как правильно настроить кэш и почему инвалидировать его надо по версии записи, а не по времени. Обсудили, как правильно настроить кэш и почему инвалидировать его надо по версии записи, а не по времени. \nНовое");
});

it("закрытие сессии запускает наблюдателя сразу, без ожидания тишины", async () => {
  const id = chat();
  talk(id, 1);
  const closed = await app.inject({ method: "POST", url: `/api/chats/${id}/close`, headers: auth, payload: { closed: true } });
  expect(closed.statusCode, closed.body).toBe(200);
  // Векторы в тесте одинаковые, поэтому урок может оказаться «похожим»: важно, что наблюдатель сработал.
  await vi.waitFor(() => expect(events(id)).toHaveLength(1));
  expect(model).toHaveBeenCalledTimes(1);
});

it("личная комната тоже читается", async () => {
  const id = chat({ room: "personal" });
  talk(id, 16);
  await chatMemoryObserverPass();
  expect(model).toHaveBeenCalledTimes(1);
});

it("чат карточки, субагент и переписка без владельца не читаются", async () => {
  const task = crypto.randomUUID();
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES (?,'Карточка',?)").run(task, owner);
  talk(chat({ taskId: task }), 16);
  talk(chat({ subagent: "role_builder" }), 16);
  const roles = chat();
  message(roles, "role_builder", LONG, 16);
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
});

it("короткий обмен не тратит модель, но виден в журнале", async () => {
  const id = chat();
  message(id, owner, "Привет", 17);
  message(id, "role_builder", "Привет!", 16);
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
  expect(events(id).map((e) => e.outcome)).toEqual(["skip"]);
});

it("пока роль отвечает, наблюдатель ждёт", async () => {
  const id = chat();
  talk(id, 16);
  db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,payload_json,status) VALUES (?,?,'role_builder',?,'{}','pending')").run(crypto.randomUUID(), id, crypto.randomUUID());
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
});

it("системные сообщения и чип не считаются разговором", async () => {
  const id = chat();
  message(id, "taskflow_system", "Память обновлена", 16, "system");
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
  await expect(observeChatMemory(id)).resolves.toMatchObject({ observed: 0 });
});

it("сбой модели виден в журнале и не зацикливается", async () => {
  model.mockRejectedValue(new Error("модель недоступна"));
  const id = chat();
  talk(id, 16);
  await chatMemoryObserverPass();
  expect(events(id).map((e) => e.outcome)).toEqual(["model"]);
  await chatMemoryObserverPass();
  expect(model).toHaveBeenCalledTimes(1);
});

it("выключенный наблюдатель не читает", async () => {
  setSetting("memory_observer_enabled", false, null, "тест");
  const id = chat();
  talk(id, 16);
  await chatMemoryObserverPass();
  expect(model).not.toHaveBeenCalled();
  setSetting("memory_observer_enabled", true, null, "тест");
});
