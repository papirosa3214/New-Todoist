// Регрессия дефекта D1 (карточка 252c400e, доработка QA):
// итог обсуждения передавался в работу по УЧЁТНОЙ ЗАПИСИ роли
// ('role_builder'), а путь доставки ждёт КЛЮЧ роли ('builder').
// Результат: handoff уходил в no_recipient, исполнитель итог не
// получал, квитанция была невозможна.
//
// Проверка идёт по НАСТОЯЩЕМУ пути доставки (deliverChatToWork без
// мока): работающий этап в карточке + queued-задача роли в очереди
// запусков → доставка даёт 'queued' и durable отметку приёма в
// slot_topic_inbox, а handoff уходит в состояние 'awaiting'.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  closeDiscussion,
  deliverDiscussionHandoff,
  handoffReceipt,
  openDiscussion,
  readHandoff,
} from "../src/runtime/taskDiscussion.js";

const TASK = "task_discussion_delivery_d1";
const SLOT = "slot_discussion_delivery_d1";

beforeAll(async () => {
  migrate();
  runMigrations();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  db.prepare("INSERT INTO tasks(id,title,creator_id,status) VALUES(?,'Обсуждение D1','u1','active')").run(TASK);
  db.prepare(
    "INSERT INTO subtasks(id,task_id,title,agent_id,agent_state,done) VALUES(?,?,'Работа','role_builder','in_progress',0)",
  ).run(SLOT, TASK);
  // Очередь запуска роли: без неё работающего слота нет, и доставка
  // закономерно не находит адресата.
  db.prepare(
    "INSERT INTO role_run_jobs(id,task_id,reason,dedupe_key,status) VALUES(?,?,'assigned',?,'queued')",
  ).run(crypto.randomUUID(), TASK, crypto.randomUUID());
});

afterAll(() => {
  db.prepare("DELETE FROM role_run_jobs WHERE task_id=?").run(TASK);
  db.prepare("DELETE FROM subtasks WHERE id=?").run(SLOT);
  db.prepare("DELETE FROM chat_messages WHERE chat_id IN (SELECT chat_id FROM task_discussions)").run();
  db.prepare("DELETE FROM task_discussion_handoffs").run();
  db.prepare("DELETE FROM task_discussions").run();
  db.prepare("DELETE FROM tasks WHERE id=?").run(TASK);
});

describe("доставка итога обсуждения: адресат — ключ роли (D1)", () => {
  it("handoff к builder даёт queued с записью в slot_topic_inbox, а не no_recipient", async () => {
    const { discussion } = openDiscussion({
      taskId: TASK,
      subtaskId: SLOT,
      role: "builder",
      ownerUserId: "u1",
    });
    const closed = await closeDiscussion({
      discussionId: discussion.discussion_id,
      actorUserId: "u1",
    });
    const handoffId = closed.handoff!.handoff_id;
    // Получатель в handoff остаётся учётной записью — так он и лежит в БД.
    expect(readHandoff(handoffId)!.recipient_role_id).toBe("role_builder");

    const state = await deliverDiscussionHandoff({
      discussionId: discussion.discussion_id,
      handoffId,
    });
    expect(state).toBe("awaiting");
    expect(readHandoff(handoffId)!.state).toBe("awaiting");

    // Durable отметка приёма: исполнитель увидел ввод.
    const inbox = db
      .prepare("SELECT message_id,subtask_id FROM slot_topic_inbox WHERE subtask_id=?")
      .all(SLOT) as Array<{ message_id: string; subtask_id: string }>;
    expect(inbox.length).toBe(1);
    expect(inbox[0].subtask_id).toBe(SLOT);
    // Квитанция по handoff доступна — значит итог дошёл.
    expect(handoffReceipt(handoffId).received).toBe(false);
    db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id=?").run(inbox[0].message_id,SLOT);
    expect(handoffReceipt(handoffId).received).toBe(true);
  });
});
