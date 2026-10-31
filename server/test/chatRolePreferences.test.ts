// Выбор модели и уровня размышлений — в личном чате с ЛЮБОЙ ролью
// (владелец 29.10.2026: «с другими всеми ролями должна быть именно та
// схема — мозг и папка»).
//
// Раньше маршрут предпочтений пускал только чат с Помощником
// (u-secretary), и в чате с любой другой ролью «мозга» с уровнем
// рассуждений не было вовсе. Комната с несколькими ролями — отдельная
// схема (кольца контекста), там настройки хода не нужны.
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { piRuntime } from "../src/runtime/PiRuntimeAdapter.js";
import { readChatPreferences } from "../src/lib/chatSessionPreferences.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

describe("настройки хода в личном чате с любой ролью", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const catalog = [{ id: "flex", provider: "test", available: true, thinking: true, thinkingLevels: ["off", "low", "high"] }];
  const auth = () => ({ authorization: "Bearer " + app.jwt.sign({ id: "u1" }) });

  beforeAll(async () => {
    app = await buildApp();
    vi.spyOn(piRuntime, "listModels").mockResolvedValue(catalog as any);
    seedRoleAccounts(db);

    // Личный чат с ролью (не Помощник).
    db.prepare("INSERT INTO chats(id,kind,created_by) VALUES ('role-chat','direct','u1')").run();
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES ('role-chat','u1')").run();
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES ('role-chat','role_architect')").run();

    // Комната: ролей несколько.
    db.prepare("INSERT INTO chats(id,kind,created_by) VALUES ('room-chat','direct','u1')").run();
    for (const member of ["u1", "role_architect", "role_builder"]) {
      db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES ('room-chat',?)").run(member);
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("в личном чате с ролью выбираются модель и уровень размышлений", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/chats/role-chat/session-preferences",
      headers: auth(),
      payload: { model: "test/flex", thinkingLevel: "high" },
    });
    expect(response.statusCode).toBe(200);
    expect(readChatPreferences("role-chat")).toMatchObject({ model: "test/flex", thinkingLevel: "high", configured: true });
  });

  it("выбор читается обратно и переживает смену модели", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/chats/role-chat/session-preferences",
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ model: "test/flex", thinkingLevel: "high", configured: true });
  });

  it("в комнате ролей настройки хода недоступны", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/chats/room-chat/session-preferences",
      headers: auth(),
      payload: { model: "test/flex" },
    });
    expect(response.statusCode).toBe(400);
    expect(readChatPreferences("room-chat").configured).toBe(false);
  });

  it("роль не меняет настройки хода владельца", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/chats/role-chat/session-preferences",
      headers: { authorization: "Bearer " + app.jwt.sign({ id: "role_architect" }) },
      payload: { model: "test/flex" },
    });
    expect(response.statusCode).toBe(403);
  });
});
