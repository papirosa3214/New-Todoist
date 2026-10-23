import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  AUTO_BRANCH_ENABLED,
  shouldFanOutOwnerMessage,
  fanoutBranchAck,
  fanoutParentAck,
  fanoutTitle,
} from "../src/lib/chatOwnerFanout.js";

const baseFacts = {
  fromOwner: true,
  direct: true,
  roleMembers: 1,
  isBranch: false,
  isTaskTopic: false,
  isCommon: false,
  repliesToRole: false,
  roleBusy: true,
  openBranch: false,
};

describe("ветка на сообщение владельца: правила", () => {
  it("автоветвление выключено (владелец 23.10.2026)", () => {
    expect(AUTO_BRANCH_ENABLED).toBe(false);
    expect(shouldFanOutOwnerMessage(baseFacts)).toBe(false);
  });
  it("отбивки остались для ручной ветки", () => {
    expect(fanoutBranchAck("Исправь кнопку\nи проверь", true)).toContain("Принял: «Исправь кнопку»");
    expect(fanoutBranchAck("Исправь кнопку", false)).toContain("Приступаю сразу");
    expect(fanoutParentAck("Исправь кнопку")).toContain("открыл ветку");
    expect(fanoutTitle("x".repeat(90))).toContain("…");
  });
});

describe("ветка на сообщение владельца: живые данные", () => {
  let app: any;
  let owner: any;
  let chatId: string;
  const roleId = "role_builder";

  const auth = () => ({ authorization: `Bearer ${owner.token}` });

  beforeAll(async () => {
    app = await buildApp();
    const registered = (await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "fanout-owner", email: "fanout-owner@test.local", password: "fanout-pass-1" },
    })).json();
    owner = registered;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.user.id);
    db.prepare("INSERT OR IGNORE INTO roles(key,title,summary) VALUES('builder','Разработчик','')").run();
    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,role,type,role_key,is_system_bot) VALUES(?,?,'builder@test.local','x','agent','ai','builder',1)",
    ).run(roleId, "Разработчик");
    chatId = (await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(),
      payload: { kind: "direct", member_ids: [roleId] },
    })).json().chat.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("сообщение владельца не создаёт ветку и не пишет «открыл ветку»", async () => {
    const posted = (await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
      payload: { text: "Поправь кнопку на экране задач" },
    })).json().message;

    const branch = db
      .prepare("SELECT id FROM chats WHERE branch_of_chat_id=? AND branch_of_message_id=?")
      .get(chatId, posted.id);
    expect(branch).toBeUndefined();

    const ack = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND from_user_id=? AND text LIKE 'Принял: «%открыл ветку%'")
      .get(chatId, roleId) as { text: string } | undefined;
    expect(ack).toBeUndefined();
  });

  it("второе сообщение тоже остаётся в комнате", async () => {
    const second = (await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
      payload: { text: "И ещё: поправь заголовок" },
    })).json().message;
    expect(db.prepare("SELECT 1 FROM chats WHERE branch_of_message_id=?").get(second.id)).toBeUndefined();
  });
});
