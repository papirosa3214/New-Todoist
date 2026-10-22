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
  roleBusy: true,
  openBranch: false,
};

describe("ветка на сообщение владельца: правила", () => {
  it("ветвит личную комнату с одной ролью, когда роль занята", () => {
    expect(shouldFanOutOwnerMessage(baseFacts)).toBe(true);
  });
  it("не ветвит, когда роль свободна или ветка уже открыта", () => {
    // Владелец 22.10.2026: «не на каждое же сообщение новая ветка» —
    // свободная роль отвечает обычным ходом.
    expect(shouldFanOutOwnerMessage({ ...baseFacts, roleBusy: false })).toBe(false);
    expect(shouldFanOutOwnerMessage({ ...baseFacts, openBranch: true })).toBe(false);
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
  let queueSeq = 0;

  const auth = () => ({ authorization: `Bearer ${owner.token}` });
  const branchesOf = (id: string) =>
    db.prepare("SELECT id, branch_of_message_id FROM chats WHERE branch_of_chat_id=?").all(id) as Array<{
      id: string;
      branch_of_message_id: string;
    }>;

  /** Роль занята: её сообщение ждёт в очереди (так выглядит идущий ход). */
  const occupyRole = () => {
    queueSeq += 1;
    const chat = db.prepare("SELECT id FROM chats WHERE id<>? LIMIT 1").get(chatId) as { id: string } | undefined;
    db.prepare(
      "INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,payload_json,status) VALUES(?,?,?,?,'{}','picked')",
    ).run(`q-${queueSeq}`, chat?.id ?? chatId, roleId, `d-${queueSeq}`);
  };
  const freeRole = () => {
    db.prepare("DELETE FROM chat_message_queue WHERE role_id=?").run(roleId);
  };
  const post = async (text: string) =>
    (await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
      payload: { text },
    })).json().message;

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

  it("свободная роль: ветки нет, сообщение обрабатывается в комнате", async () => {
    freeRole();
    const posted = await post("Поправь кнопку на экране задач");
    const branch = db
      .prepare("SELECT id FROM chats WHERE branch_of_chat_id=? AND branch_of_message_id=?")
      .get(chatId, posted.id);
    expect(branch).toBeUndefined();
  });

  it("занятая роль: сообщение получает свою ветку с отбивкой", async () => {
    occupyRole();
    const posted = await post("И ещё: поправь заголовок");
    const branch = db
      .prepare("SELECT id, title FROM chats WHERE branch_of_chat_id=? AND branch_of_message_id=?")
      .get(chatId, posted.id) as { id: string; title: string } | undefined;
    expect(branch).toBeTruthy();
    expect(branch!.title).toContain("Ветка:");

    const branchTexts = db
      .prepare("SELECT from_user_id, text FROM chat_messages WHERE chat_id=? ORDER BY created_at")
      .all(branch!.id) as Array<{ from_user_id: string; text: string }>;
    expect(branchTexts[0].text).toBe("И ещё: поправь заголовок");
    expect(branchTexts[1].from_user_id).toBe(roleId);
    expect(branchTexts[1].text).toContain("Принял:");

    const parentAck = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND from_user_id=? AND reply_to_message_id=?")
      .get(chatId, roleId, posted.id) as { text: string } | undefined;
    expect(parentAck?.text).toContain("открыл ветку");
  });

  it("пока ветка открыта, второе сообщение новую ветку не заводит", async () => {
    occupyRole();
    const before = branchesOf(chatId).length;
    const posted = await post("Третье: добавь отступ");
    const after = branchesOf(chatId);
    expect(after.length).toBe(before);
    expect(after.map((row) => row.branch_of_message_id)).not.toContain(posted.id);
  });

  it("после ответа роли в ветке следующее сообщение снова получает ветку", async () => {
    const openBranch = branchesOf(chatId)[0];
    const token = app.jwt.sign({ id: roleId }, { expiresIn: "5m" });
    await app.inject({
      method: "POST",
      url: `/api/chats/${openBranch.id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "## Готово\nПоправил кнопку, проверил на симуляторе." },
    });

    occupyRole();
    const before = branchesOf(chatId).length;
    await post("Четвёртое: поправь подвал");
    expect(branchesOf(chatId).length).toBe(before + 1);
  });

  it("в самой ветке новые ветки не плодятся", async () => {
    occupyRole();
    const branch = branchesOf(chatId)[0];
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
    const branch = branchesOf(chatId)[0];
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
