// Этап 4 плана карточки 252c400e: закрытие обсуждения, durable handoff
// и квитанция.
//
// Проверяем по HTTP-маршрутам и тестовой SQLite:
//   • закрытие фиксирует согласованный итог (три раздела) и создаёт
//     ровно одно обязательство;
//   • повторный close возвращает тот же handoff и не создаёт второго;
//   • закрытие во время идущего ответа ждёт его и суммирует полный
//     разговор;
//   • падение после записи handoff, но до доставки, не теряет
//     обязательство: возобновление доставляет тот же handoff;
//   • смена адресата: закрытый этап или чужая роль → no_recipient, без
//     второго рабочего исполнителя;
//   • принятие без квитанции невозможно.
//
// Модель и Pi замоканы: проверяется серверная часть и SQLite.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const harness = vi.hoisted(() => ({
  delivered: [] as Array<{ role: string; messageId: string; recipient: string | undefined }>,
  outcome: "working" as "queued" | "idle" | "busy" | "working",
  /** Квитанция приёма: сервер отмечает ввод в slot_topic_inbox. */
  receipt: true,
}));
vi.mock("../src/runtime/inProcessRun.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/inProcessRun.js")>()),
  slotWorkspace: () => "/tmp",
  deliverChatToWork: async (role: string, chatId: string, messageId: string, text: string, recipientSubtaskId?: string) => {
    harness.delivered.push({ role, messageId, recipient: recipientSubtaskId });
    if (harness.receipt && recipientSubtaskId) {
      const db = (await import("../src/db.js")).default;
      db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(
        messageId,
        recipientSubtaskId,
      );
      db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id=?").run(messageId,recipientSubtaskId);
    }
    return harness.outcome;
  },
}));
vi.mock("../src/runtime/PiRuntimeAdapter.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/PiRuntimeAdapter.js")>()),
  getModelRuntime: async () => ({ getModel: (_provider: string, id: string) => ({ id }) }),
}));

import db, { migrate } from "../src/db.js";
import { buildApp } from "../src/index.js";
import { runMigrations } from "../src/migrations.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  acceptHandoff,
  closeDiscussion,
  deliverDiscussionHandoff,
  handoffReceipt,
  openDiscussion,
  readDiscussion,
  readHandoff,
  resumePendingHandoffs,
  trackDiscussionAnswer,
} from "../src/runtime/taskDiscussion.js";

let app: FastifyInstance;
let token: string;
const TASK = "task_discussion_stage4";
const SLOT = "slot_discussion_stage4";

beforeAll(async () => {
  migrate();
  runMigrations();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  app = await buildApp();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Owner", email: `disc-owner-${process.pid}@test`, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json();
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(body.user.id);
  token = body.token as string;
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,'Обсуждение','u1')").run(TASK);
  db.prepare(
    "INSERT INTO subtasks(id,task_id,title,agent_id,agent_state) VALUES(?,?,'Работа','role_builder','in_progress')",
  ).run(SLOT, TASK);
});

afterAll(async () => {
  db.prepare("DELETE FROM subtasks WHERE id=?").run(SLOT);
  db.prepare("DELETE FROM tasks WHERE id=?").run(TASK);
  await app.close();
});

beforeEach(() => {
  harness.delivered.length = 0;
  harness.outcome = "working";
  harness.receipt = true;
  db.prepare("DELETE FROM chat_messages WHERE chat_id IN (SELECT chat_id FROM task_discussions)").run();
  db.prepare("DELETE FROM task_discussion_handoffs").run();
  db.prepare("DELETE FROM task_discussions").run();
});

function auth() {
  return { Authorization: `Bearer ${token}` };
}

function newDiscussion(subtaskId = SLOT) {
  return openDiscussion({ taskId: TASK, subtaskId, role: "builder", ownerUserId: "u1" });
}

describe("закрытие обсуждения: итог, handoff, квитанция", () => {
  it("HTTP: закрытие фиксирует итог и одно обязательство; повтор close не создаёт второго", async () => {
    const { discussion } = newDiscussion();
    const open = await app.inject({
      method: "POST",
      url: `/api/tasks/${TASK}/discussions`,
      headers: auth(),
      payload: { subtask_id: SLOT, role: "builder" },
    });
    expect(open.statusCode).toBe(201);
    const discussionId = open.json().discussion.discussion_id;
    const chatId = open.json().discussion.chat_id;
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('c1','u1','Договорились так','chat',?)",
    ).run(chatId);

    const first = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussionId}/close`,
      headers: auth(),
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.discussion.state).toBe("closed");
    expect(body.handoff.handoff_id).toBeTruthy();
    expect(body.summary.goal).toContain("Договорились так");

    const second = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussionId}/close`,
      headers: auth(),
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().repeated).toBe(true);
    expect(second.json().handoff.handoff_id).toBe(body.handoff.handoff_id);
    const handoffs = db
      .prepare("SELECT count(*) n FROM task_discussion_handoffs WHERE discussion_id=?")
      .get(discussionId) as { n: number };
    expect(handoffs.n).toBe(1);
  });

  it("закрытие во время идущего ответа ждёт его и суммирует полный разговор", async () => {
    const { discussion } = newDiscussion();
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('c2','u1','Вопрос','chat',?)",
    ).run(discussion.chat_id);
    let release!: () => void;
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    trackDiscussionAnswer(discussion.discussion_id, answer);
    const closing = closeDiscussion({ discussionId: discussion.discussion_id, actorUserId: "u1" });
    // Пока ответ не дошёл, обсуждение в состоянии closing — новые реплики запрещены.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readDiscussion(discussion.discussion_id)!.state).toBe("closing");
    release();
    const closed = await closing;
    expect(closed.discussion.state).toBe("closed");
    expect(closed.summary!.goal).toContain("Вопрос");
  });

  it("падение после записи handoff, но до доставки: возобновление доставляет тот же handoff", async () => {
    const { discussion } = newDiscussion();
    const closed = await closeDiscussion({ discussionId: discussion.discussion_id, actorUserId: "u1" });
    const handoffId = closed.handoff!.handoff_id;
    // Доставка не состоялась (процесс упал между commit и steer).
    harness.outcome = "idle";
    const failed = await deliverDiscussionHandoff({
      discussionId: discussion.discussion_id,
      handoffId,
    });
    expect(failed).toBe("no_recipient");
    expect(readHandoff(handoffId)!.state).toBe("no_recipient");
    // Возобновление: handoff с awaiting доставляется заново, id прежний.
    db.prepare("UPDATE task_discussion_handoffs SET state='awaiting' WHERE handoff_id=?").run(handoffId);
    harness.outcome = "working";
    const resumed = await resumePendingHandoffs();
    expect(resumed).toBeGreaterThanOrEqual(1);
    const handoffs = db
      .prepare("SELECT count(*) n FROM task_discussion_handoffs WHERE discussion_id=?")
      .get(discussion.discussion_id) as { n: number };
    expect(handoffs.n).toBe(1);
  });

  it("смена адресата: закрытый этап или чужая роль → no_recipient, второго исполнителя нет", async () => {
    const { discussion } = newDiscussion();
    db.prepare(
      "INSERT INTO subtasks(id,task_id,title,agent_id,agent_state,done) VALUES('slot_done',?,'Закрытый этап','role_builder','done',1)",
    ).run(TASK);
    const closed = await closeDiscussion({
      discussionId: discussion.discussion_id,
      actorUserId: "u1",
      recipientSubtaskId: "slot_done",
    });
    expect(closed.delivery).toBe("awaiting");
    const delivery = await deliverDiscussionHandoff({
      discussionId: discussion.discussion_id,
      handoffId: closed.handoff!.handoff_id,
    });
    expect(delivery).toBe("no_recipient");
    expect(harness.delivered).toHaveLength(0);
    // Рабочий этап остался в работе — новый исполнитель не появился.
    expect(
      (db.prepare("SELECT agent_state,done FROM subtasks WHERE id=?").get(SLOT) as any).done,
    ).toBe(0);
  });

  it("принятие без квитанции невозможно; с квитанцией — обязательство принято", async () => {
    const { discussion } = newDiscussion();
    const closed = await closeDiscussion({ discussionId: discussion.discussion_id, actorUserId: "u1" });
    const handoffId = closed.handoff!.handoff_id;
    harness.receipt = false;
    await deliverDiscussionHandoff({ discussionId: discussion.discussion_id, handoffId });
    expect(handoffReceipt(handoffId).received).toBe(false);
    const refused = acceptHandoff({ handoffId, actorUserId: "u1" });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("Квитанции нет");

    harness.receipt = true;
    const again = await deliverDiscussionHandoff({ discussionId: discussion.discussion_id, handoffId });
    expect(again).toBe("awaiting");
    expect(handoffReceipt(handoffId).received).toBe(true);
    const accepted = acceptHandoff({ handoffId, actorUserId: "u1" });
    expect(accepted.ok).toBe(true);
    expect(readDiscussion(discussion.discussion_id)!.accepted_at).toBeTruthy();
  });

  it("HTTP: принять обязательство без квитанции отказ", async () => {
    const { discussion } = newDiscussion();
    const closed = await closeDiscussion({ discussionId: discussion.discussion_id, actorUserId: "u1" });
    harness.receipt = false;
    await deliverDiscussionHandoff({
      discussionId: discussion.discussion_id,
      handoffId: closed.handoff!.handoff_id,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussion.discussion_id}/accept`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Квитанции нет");
  });
  it("integration: concurrent close creates one durable handoff", async () => {
    const {discussion} = newDiscussion();
    let release!: () => void;
    trackDiscussionAnswer(discussion.discussion_id, new Promise<void>(resolve => {release=resolve;}));
    const a=closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1",waitForAnswerMs:1000});
    const b=closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1",waitForAnswerMs:1000});
    release();
    const [first,second]=await Promise.all([a,b]);
    expect(first.handoff!.handoff_id).toBe(second.handoff!.handoff_id);
    expect(db.prepare("SELECT count(*) n FROM task_discussion_handoffs WHERE discussion_id=?").get(discussion.discussion_id)).toEqual({n:1});
  });
  it("integration: timeout never closes an unfinished answer", async () => {
    const {discussion} = newDiscussion();
    let release!: () => void;
    trackDiscussionAnswer(discussion.discussion_id,new Promise<void>(resolve=>{release=resolve;}));
    try {
      await expect(closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1",waitForAnswerMs:1})).rejects.toThrow("Ответ обсуждения ещё не завершён");
      expect(readDiscussion(discussion.discussion_id)!.state).toBe("closing");
      expect(readDiscussion(discussion.discussion_id)!.handoff_id).toBeNull();
    } finally {release();}
  });
  it("integration: regular chat endpoint rejects replies after close", async () => {
    const opened=await app.inject({method:"POST",url:`/api/tasks/${TASK}/discussions`,headers:auth(),payload:{subtask_id:SLOT,role:"builder"}});
    expect(opened.statusCode).toBe(201);
    const d=opened.json().discussion;
    await closeDiscussion({discussionId:d.discussion_id,actorUserId:"u1"});
    const before=db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id=?").get(d.chat_id);
    const response=await app.inject({method:"POST",url:`/api/chats/${d.chat_id}/messages`,headers:auth(),payload:{text:"Late reply"}});
    expect(response.statusCode).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id=?").get(d.chat_id)).toEqual(before);
  });
  it("integration: recovery does not redeliver a handoff with receipt", async () => {
    const {discussion}=newDiscussion();
    const closed=await closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1"});
    await deliverDiscussionHandoff({discussionId:discussion.discussion_id,handoffId:closed.handoff!.handoff_id});
    const first=readHandoff(closed.handoff!.handoff_id)!.receipt_message_id;
    await resumePendingHandoffs();
    expect(readHandoff(closed.handoff!.handoff_id)!.receipt_message_id).toBe(first);
    expect(harness.delivered).toHaveLength(1);
  });
  it("integration: changed recipient is not sent to the former role", async () => {
    const {discussion}=newDiscussion();
    const closed=await closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1"});
    db.prepare("UPDATE subtasks SET agent_id='role_analyst' WHERE id=?").run(SLOT);
    try {
      expect(await deliverDiscussionHandoff({discussionId:discussion.discussion_id,handoffId:closed.handoff!.handoff_id})).toBe("no_recipient");
      expect(harness.delivered).toHaveLength(0);
    } finally {db.prepare("UPDATE subtasks SET agent_id='role_builder' WHERE id=?").run(SLOT);}
  });

  it("integration: queued input is not a consumption receipt", async () => {
    const {discussion}=newDiscussion();
    const closed=await closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1"});
    await deliverDiscussionHandoff({discussionId:discussion.discussion_id,handoffId:closed.handoff!.handoff_id,deliver:async args=>{
      db.prepare("INSERT INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(args.messageId,args.recipientSubtaskId);
      return "queued";
    }});
    expect(handoffReceipt(closed.handoff!.handoff_id).received).toBe(false);
    expect(acceptHandoff({handoffId:closed.handoff!.handoff_id,actorUserId:"u1"}).ok).toBe(false);
  });
  it("integration: failed steer with unconsumed inbox can retry", async () => {
    const {discussion}=newDiscussion();
    const closed=await closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1"});
    let calls=0;
    const deliver=async(args:{messageId:string;recipientSubtaskId:string})=>{
      calls++;
      db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(args.messageId,args.recipientSubtaskId);
      if(calls===1)throw new Error("steer failed");
      db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id=?").run(args.messageId,args.recipientSubtaskId);
      return "working" as const;
    };
    const args={discussionId:discussion.discussion_id,handoffId:closed.handoff!.handoff_id,deliver};
    expect(await deliverDiscussionHandoff(args)).toBe("failed");
    expect(await deliverDiscussionHandoff(args)).toBe("awaiting");
    expect(calls).toBe(2);
    expect(handoffReceipt(closed.handoff!.handoff_id).received).toBe(true);
  });
  it("integration: unrelated role cannot inject discussion owner messages", async () => {
    const {discussion}=newDiscussion();
    const roleToken=app.jwt.sign({id:"role_analyst"});
    const before=db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id=?").get(discussion.chat_id);
    const response=await app.inject({method:"POST",url:`/api/discussions/${discussion.discussion_id}/messages`,headers:{authorization:`Bearer ${roleToken}`},payload:{text:"Unrelated role input"}});
    expect(response.statusCode).toBe(403);
    expect(db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id=?").get(discussion.chat_id)).toEqual(before);
  });

});
