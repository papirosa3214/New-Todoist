// Самозамена слота только с одобрения владельца (владелец 07.11.2026:
// «без меня никто ничего не сделает»). Проверяем ровно ограничитель:
//   * без ответа владельца замены нет;
//   * «Не заменять» — тоже нет;
//   * «Заменить» — замена ровно своего слота своей ролью;
//   * чужая роль — отказ до вопроса;
//   * живой (не зависший) слот — отказ до вопроса.
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import * as admission from "../src/runtime/planSubtaskAdmission.js";
import * as runtime from "../src/runtime/inProcessRun.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { requestSelfRestart } from "../src/runtime/slotSelfRestart.js";
import { applySlotReplacementAnswer } from "../src/runtime/slotReplacementApply.js";
import { slotReplacementRequest } from "../src/runtime/slotReplacementRequest.js";
import { deliverAnswer } from "../src/lib/questionWait.js";

const uid = () => crypto.randomUUID();
let app: any;

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
});
afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
});

function seedSlot(opts: { role?: string; heartbeatAgoMinutes?: number } = {}) {
  const role = opts.role ?? "builder";
  const task = uid();
  const plan = uid();
  const slot = uid();
  const attempt = uid();
  const chat = `chat-${uid()}`;
  db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES(?,'self restart','active','u1')").run(task);
  db.prepare(
    "INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES(?,?,1,'approved','manual','test','u1')",
  ).run(plan, task);
  db.prepare(
    "INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,?,'impl',?,1,'implement')",
  ).run(uid(), plan, role);
  db.prepare(
    "INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,agent_state,agent_id,agent_heartbeat_at) VALUES(?,?,'implement',1,?,'impl','in_progress',?,?)",
  ).run(
    slot,
    task,
    plan,
    `role_${role}`,
    opts.heartbeatAgoMinutes === undefined
      ? null
      : new Date(Date.now() - opts.heartbeatAgoMinutes * 60_000).toISOString().slice(0, 19).replace("T", " "),
  );
  db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id) VALUES(?,?,?,?)").run(attempt, task, slot, `role_${role}`);
  db.prepare("UPDATE subtasks SET current_attempt_id=? WHERE id=?").run(attempt, slot);
  db.prepare("INSERT INTO chats(id,kind,created_by,room_kind) VALUES(?,'direct','u1','personal')").run(chat);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,'u1')").run(chat);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat, `role_${role}`);
  // Сообщение владельца, на которое ссылается вопрос (reply_to_message_id — FK).
  const ownerMessage = uid();
  db.prepare(
    "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,'u1','завис, разберись','chat',?)",
  ).run(ownerMessage, chat);
  return { task, plan, slot, attempt, chat, ownerMessage };
}

const approve = { answers: [{ questionIndex: 0, selected: ["Заменить"] }] };
const reject = { answers: [{ questionIndex: 0, selected: ["Не заменять"] }] };

it("без ответа владельца замены нет: заявка остаётся pending, слот не тронут", async () => {
  const x = seedSlot({ heartbeatAgoMinutes: 60 });
  const spy = vi.spyOn(admission, "startPlanSubtaskRun").mockResolvedValue({ ok: true, runId: "x" } as any);
  // Ход оборван — владелец не ответил.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await requestSelfRestart({
    chatId: x.chat,
    messageId: x.ownerMessage,
    role: "builder",
    roleAccountId: "role_builder",
    subtaskId: x.slot,
    reason: "завис без heartbeat",
    signal: controller.signal,
  });
  expect(result.status).toBe("open");
  expect(spy).not.toHaveBeenCalled();
  expect(db.prepare("SELECT outcome FROM attempts WHERE id=?").get(x.attempt)).toMatchObject({ outcome: null });
  const request = slotReplacementRequest((result as any).request.id)!;
  expect(request.status).toBe("pending");
  spy.mockRestore();
});

it("«Не заменять» — отказ, слот не перезапускается", async () => {
  const x = seedSlot({ heartbeatAgoMinutes: 60 });
  const spy = vi.spyOn(admission, "startPlanSubtaskRun").mockResolvedValue({ ok: true, runId: "x" } as any);
  const controller = new AbortController();
  const run = requestSelfRestart({
    chatId: x.chat,
    messageId: x.ownerMessage,
    role: "builder",
    roleAccountId: "role_builder",
    subtaskId: x.slot,
    reason: "завис",
    signal: controller.signal,
  });
  // Владелец отвечает «Не заменять» так, как это делает маршрут ответа.
  const pending = await vi.waitFor(() => {
    const row = db
      .prepare("SELECT id, question_id FROM slot_replacement_requests WHERE subtask_id=? AND status='pending'")
      .get(x.slot) as any;
    if (!row?.question_id) throw new Error("нет вопроса");
    return row;
  });
  const applied = await applySlotReplacementAnswer(pending.question_id, reject, "u1");
  // Ровно так делает маршрут ответа: сохранил ответ и отдал его ждущему ходу.
  deliverAnswer(pending.question_id, reject as any);
  expect(applied?.replaced).toBe(false);
  const result = await run;
  expect(result.status).toBe("rejected");
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

it("«Заменить» — слот перезапускается той же ролью, попытка закрыта как reset", async () => {
  const x = seedSlot({ heartbeatAgoMinutes: 60 });
  const spy = vi.spyOn(admission, "startPlanSubtaskRun").mockResolvedValue({ ok: true, runId: "fresh" } as any);
  const controller = new AbortController();
  const run = requestSelfRestart({
    chatId: x.chat,
    messageId: x.ownerMessage,
    role: "builder",
    roleAccountId: "role_builder",
    subtaskId: x.slot,
    reason: "завис",
    signal: controller.signal,
  });
  const pending = await vi.waitFor(() => {
    const row = db
      .prepare("SELECT question_id FROM slot_replacement_requests WHERE subtask_id=? AND status='pending'")
      .get(x.slot) as any;
    if (!row?.question_id) throw new Error("нет вопроса");
    return row;
  });
  const applied = await applySlotReplacementAnswer(pending.question_id, approve, "u1");
  deliverAnswer(pending.question_id, approve as any);
  expect(applied?.replaced).toBe(true);
  const result = await run;
  expect(result.status).toBe("applied");
  expect(spy).toHaveBeenCalledWith(x.slot, "u1", { freshSession: true });
  expect(db.prepare("SELECT outcome FROM attempts WHERE id=?").get(x.attempt)).toMatchObject({ outcome: "reset" });
  spy.mockRestore();
});

it("чужую роль заменить нельзя: отказ до вопроса владельцу", async () => {
  const x = seedSlot({ role: "builder", heartbeatAgoMinutes: 60 });
  await expect(
    requestSelfRestart({
      chatId: x.chat,
      messageId: x.ownerMessage,
      role: "qa",
      roleAccountId: "role_qa",
      subtaskId: x.slot,
      reason: "хочу забрать",
    }),
  ).rejects.toThrow(/своей же роли/);
  expect(db.prepare("SELECT count(*) AS n FROM chat_questions WHERE chat_id=?").get(x.chat)).toEqual({ n: 0 });
});

it("живой слот не завис: владельца не спрашиваем", async () => {
  const x = seedSlot({ heartbeatAgoMinutes: 1 });
  vi.spyOn(runtime, "activeInProcessRun").mockReturnValue({ runId: "live" } as any);
  await expect(
    requestSelfRestart({
      chatId: x.chat,
      messageId: x.ownerMessage,
      role: "builder",
      roleAccountId: "role_builder",
      subtaskId: x.slot,
      reason: "просто так",
    }),
  ).rejects.toThrow(/не завис/);
  expect(db.prepare("SELECT count(*) AS n FROM chat_questions WHERE chat_id=?").get(x.chat)).toEqual({ n: 0 });
  vi.restoreAllMocks();
});
