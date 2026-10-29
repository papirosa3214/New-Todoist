// Обращение роли к роли через сессии (владелец 29.10.2026).
//
// Схема: вопрос уходит в ПОСТОЯННУЮ сессию адресата (его личку) обычным
// сообщением; в сессии отправителя появляется только карточка обращения
// («кто кому», вопрос, статус) — само сообщение там не дублируется.
//
// Покрывает:
//   1. Вопрос лежит в личке адресата, а в сессии отправителя — только карточка.
//   2. Карточка указывает на комнату доставки (там идёт работа, там работает
//      «Остановить обращение»).
//   3. Отдельный чат «роль↔роль» не создаётся.
//   4. Ответ адресата закрывает карточку, и его текст виден в карточке
//      (в нитке отправителя ответа нет).

import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { postToRoleSession } from "../src/runtime/roleCrossSessionMessage.js";
import { coordinationAnswered } from "../src/runtime/chatCoordination.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

const SENDER = "role_qa";
const RECIPIENT = "role_architect";
const OWNER = "u1";

const cardOf = (questionId: string) => {
  const row = db
    .prepare(
      "SELECT id,chat_id,steps FROM chat_messages WHERE message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?",
    )
    .get(questionId) as { id: string; chat_id: string; steps: string } | undefined;
  return row ? { id: row.id, chat_id: row.chat_id, ...(JSON.parse(row.steps).coordination ?? {}) } : undefined;
};

describe("обращение роли к роли через сессии", () => {
  let senderChatId: string;

  beforeAll(() => {
    migrate();
    runMigrations();
    seedRoleAccounts(db);
    senderChatId = crypto.randomUUID();
    // Сессия отправителя: комната, где сидят отправитель и владелец.
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,'Сессия отправителя','direct',?)").run(
      senderChatId,
      OWNER,
    );
    for (const member of [OWNER, SENDER]) {
      db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(
        senderChatId,
        member,
      );
    }
  });

  it("вопрос уходит в личку адресата, в сессии отправителя — карточка", () => {
    const posted = postToRoleSession({
      senderId: SENDER,
      senderChatId,
      recipientId: RECIPIENT,
      text: "Проверь, как это работает",
    });

    // Вопрос — обычным сообщением в постоянной сессии адресата.
    const inRoom = db
      .prepare("SELECT id,from_user_id,text FROM chat_messages WHERE chat_id=? AND from_user_id=?")
      .get(posted.roomId, SENDER) as { id: string; from_user_id: string; text: string } | undefined;
    expect(inRoom).toBeTruthy();
    expect(inRoom!.text).toBe("Проверь, как это работает");
    expect(posted.roomId).not.toBe(senderChatId);

    // В сессии отправителя — только карточка, само сообщение не дублируется.
    const plain = db
      .prepare("SELECT COUNT(*) n FROM chat_messages WHERE chat_id=? AND from_user_id=? AND message_type IS NULL")
      .get(senderChatId, SENDER) as { n: number };
    expect(plain.n).toBe(0);

    const card = cardOf(posted.questionId);
    expect(card).toBeTruthy();
    expect(card!.chat_id).toBe(senderChatId);
    expect(card!.question).toBe("Проверь, как это работает");
    expect(card!.recipient_id).toBe(RECIPIENT);
    // Работа идёт в личке адресата — там и останавливается ход.
    expect(card!.child_chat_id).toBe(posted.roomId);

    // Отдельного чата «роль↔роль» не создано.
    const dms = db
      .prepare("SELECT COUNT(*) n FROM chats WHERE room_kind='dm'")
      .get() as { n: number };
    expect(dms.n).toBe(0);
  });

  it("ответ адресата закрывает карточку, текст ответа виден в карточке", () => {
    const posted = postToRoleSession({
      senderId: SENDER,
      senderChatId,
      recipientId: RECIPIENT,
      text: "Второй вопрос",
    });
    // Ответ адресата лег в его личку — это другая комната, чем карточка.
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)",
    ).run(crypto.randomUUID(), RECIPIENT, "Ответ: всё работает", posted.roomId, posted.questionId);
    coordinationAnswered(posted.questionId, RECIPIENT, "Ответ: всё работает", false, posted.roomId);

    const card = cardOf(posted.questionId);
    expect(card!.terminal).toBe(true);
    expect(card!.answer).toContain("всё работает");
  });
});
