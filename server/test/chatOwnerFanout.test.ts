import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
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
};

describe("ветка на сообщение владельца: правила", () => {
  it("ветвит личную комнату с одной ролью", () => {
    expect(shouldFanOutOwnerMessage(baseFacts)).toBe(true);
  });
  it("не ветвит сообщения роли, ветки, темы задач и общий чат", () => {
    expect(shouldFanOutOwnerMessage({ ...baseFacts, fromOwner: false })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, isBranch: true })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, isTaskTopic: true })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, isCommon: true })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, repliesToRole: true })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, roleMembers: 2 })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, direct: false })).toBe(false);
  });
  it("отбивка называет принятое и держит последовательность", () => {
    expect(fanoutBranchAck("Исправь кнопку\nи проверь", true)).toContain("Принял: «Исправь кнопку»");
    expect(fanoutBranchAck("Исправь кнопку", true)).toContain("доделаю то, что в работе");
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

  it("на сообщение владельца появляется ветка с отбивкой", async () => {
    const posted = (await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
      payload: { text: "Поправь кнопку на экране задач" },
    })).json().message;

    const branch = db
      .prepare("SELECT id, title, branch_of_message_id FROM chats WHERE branch_of_chat_id=? AND branch_of_message_id=?")
      .get(chatId, posted.id) as { id: string; title: string; branch_of_message_id: string } | undefined;
    expect(branch).toBeTruthy();
    expect(branch!.title).toContain("Ветка:");

    const branchTexts = (db.prepare("SELECT from_user_id, text FROM chat_messages WHERE chat_id=? ORDER BY created_at").all(branch!.id) as Array<{ from_user_id: string; text: string }>);
    expect(branchTexts[0].text).toBe("Поправь кнопку на экране задач");
    expect(branchTexts[1].from_user_id).toBe(roleId);
    expect(branchTexts[1].text).toContain("Принял:");

    const parentAck = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND from_user_id=? AND reply_to_message_id=?")
      .get(chatId, roleId, posted.id) as { text: string } | undefined;
    expect(parentAck?.text).toContain("открыл ветку");
  });

  it("второе сообщение получает свою ветку, а не чужую", async () => {
    const first = (await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
      payload: { text: "И ещё: поправь заголовок" },
    })).json().message;
    const second = (await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
      payload: { text: "Третье: добавь отступ" },
    })).json().message;
    const branches = db
      .prepare("SELECT branch_of_message_id FROM chats WHERE branch_of_chat_id=? ORDER BY created_at")
      .all(chatId) as Array<{ branch_of_message_id: string }>;
    const ids = branches.map((row) => row.branch_of_message_id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it("в самой ветке новые ветки не плодятся", async () => {
    const branch = db
      .prepare("SELECT id FROM chats WHERE branch_of_chat_id=? LIMIT 1")
      .get(chatId) as { id: string };
    const posted = (await app.inject({
      method: "POST",
      url: `/api/chats/${branch.id}/messages`,
      headers: auth(),
      payload: { text: "Уточнение внутри ветки" },
    })).json().message;
    const nested = db
      .prepare("SELECT id FROM chats WHERE branch_of_chat_id=? AND branch_of_message_id=?")
      .get(branch.id, posted.id);
    expect(nested).toBeUndefined();
  });

  it("ответ роли в ветке возвращается в комнату одной строкой", async () => {
    const branch = db
      .prepare("SELECT id FROM chats WHERE branch_of_chat_id=? ORDER BY created_at LIMIT 1")
      .get(chatId) as { id: string };
    const token = app.jwt.sign({ id: roleId }, { expiresIn: "5m" });
    const answer = await app.inject({
      method: "POST",
      url: `/api/chats/${branch.id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "## Готово\nПоправил кнопку, проверил на симуляторе." },
    });
    expect(answer.statusCode).toBe(200);
    const mirror = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND text LIKE 'Ветка «%» — готово.%' ORDER BY created_at DESC")
      .get(chatId) as { text: string } | undefined;
    expect(mirror?.text).toContain("— готово.");
    expect(mirror?.text).toContain("Готово");
  });
});
