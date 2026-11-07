// Закрытие пунктов плана: конец хода (unclosed), одна отметка виджета/плана, вложенность и контроль вызвавшей роли.
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  chatPlanTree, chatPlanView, openChatPlanItem, saveChatWorkPlan, submitChatWorkItem, ChatItemSubmitError,
} from "../src/lib/subtaskWorkPlan.js";
import { ensurePlanItemClosed, PLAN_CLOSE_PROMPT } from "../src/runtime/chatPlanClose.js";
import { setPlanLink, clearPlanLink } from "../src/runtime/chatPlanLinks.js";
import { syncChecklistMarkWithPlan } from "../src/lib/chatChecklistPlanSync.js";

let app: any;
const caller = "role_architect", callee = "role_builder";
const items = [
  { id: "context", title: "Собрать контекст", state: "pending" as const },
  { id: "impl", title: "Реализовать", state: "pending" as const },
];
beforeAll(async () => { app = await buildApp(); await app.ready(); seedRoleAccounts(db); });
afterAll(async () => { await app.close(); });

function mkChat(roles: string[]) {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chatId);
  for (const m of ["u1", ...roles]) db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, m);
  return chatId;
}
function liveDelivery(chatId: string, role: string) {
  const messageId = crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','x',datetime('now'))").run(messageId, chatId);
  db.prepare("INSERT OR IGNORE INTO chat_session_generation(chat_id,role_id,generation) VALUES(?,?,1)").run(chatId, role);
  const d = crypto.randomUUID();
  db.prepare(`INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at)
    VALUES(?,?,?,?,?,1,'{}','picked',datetime('now'))`).run(d, chatId, role, d, messageId);
  return messageId;
}

describe("п.1 конец хода: пункт сдан или unclosed", () => {
  it("несданный пункт: один дожим, затем отметка unclosed; план не выполнен", async () => {
    const chatId = mkChat([callee]);
    liveDelivery(chatId, callee);
    saveChatWorkPlan(chatId, callee, 0, items as any);
    const prompts: string[] = [];
    const r = await ensurePlanItemClosed(chatId, callee, async (t) => { prompts.push(t); });
    expect(r).toBe("unclosed");
    expect(prompts).toEqual([PLAN_CLOSE_PROMPT]);
    expect(PLAN_CLOSE_PROMPT).toContain("taskflow_work_item_submit");
    const view = chatPlanView(chatId, callee)!;
    expect(view.items[0].state).toBe("unclosed");
    expect(view.status).not.toBe("finished");
    // повторный конец хода не дожимает снова
    expect(await ensurePlanItemClosed(chatId, callee, async (t) => { prompts.push(t); })).toBe("none");
    expect(prompts).toHaveLength(1);
  });
  it("сдал после дожима — closed, unclosed нет", async () => {
    const chatId = mkChat([callee]);
    const messageId = liveDelivery(chatId, callee);
    saveChatWorkPlan(chatId, callee, 0, items as any);
    const r = await ensurePlanItemClosed(chatId, callee, async () => {
      submitChatWorkItem({ chatId, roleId: callee, itemId: "context", outcome: "done", result: "Контекст собран", messageId });
    });
    expect(r).toBe("closed");
    expect(chatPlanView(chatId, callee)!.items[0].state).toBe("done");
  });
  it("нет плана или пункт заблокирован — ход не трогаем", async () => {
    const chatId = mkChat([callee]);
    expect(await ensurePlanItemClosed(chatId, callee, async () => { throw new Error("не должно звать"); })).toBe("none");
    const messageId = liveDelivery(chatId, callee);
    saveChatWorkPlan(chatId, callee, 0, items as any);
    submitChatWorkItem({ chatId, roleId: callee, itemId: "context", outcome: "blocked", blockType: "needs_input", reason: "нужен ответ", messageId });
    expect(openChatPlanItem(chatId, callee)).toBeNull();
  });
});

describe("п.2 галочка виджета = сдача пункта плана", () => {
  it("отметка текущего пункта сдаёт его; не текущего — отказ без отметки; снять сданный нельзя", () => {
    const chatId = mkChat([callee]);
    liveDelivery(chatId, callee);
    saveChatWorkPlan(chatId, callee, 0, items as any);
    expect(syncChecklistMarkWithPlan({ chatId, itemKey: "x", label: "нет такого", done: true, userId: "u1" })).toEqual({ matched: false });
    expect(() => syncChecklistMarkWithPlan({ chatId, itemKey: "impl", label: "Реализовать", done: true, userId: "u1" })).toThrow(ChatItemSubmitError);
    const ok: any = syncChecklistMarkWithPlan({ chatId, itemKey: "k", label: "собрать  Контекст", done: true, userId: "u1" });
    expect(ok.matched).toBe(true);
    const v = chatPlanView(chatId, callee)!;
    expect(v.items[0]).toMatchObject({ state: "done", marked_by: "owner:u1" });
    expect(() => syncChecklistMarkWithPlan({ chatId, itemKey: "context", label: "", done: false, userId: "u1" })).toThrow(/уже сдан/);
  });
});

describe("п.3-4 вложенность и контроль вызвавшей роли", () => {
  it("план вызванной роли связан с планом вызвавшей и отдаётся как children с прогрессом", () => {
    const chatId = mkChat([caller, callee]);
    liveDelivery(chatId, caller);
    saveChatWorkPlan(chatId, caller, 0, [{ id: "ask", title: "Спросить", state: "pending" }, { id: "sum", title: "Свести", state: "pending" }] as any);
    setPlanLink(chatId, callee, { parentRoleId: caller, questionId: "q-1" });
    try { saveChatWorkPlan(chatId, callee, 0, items as any); } finally { /* связь остаётся живой для проверки сдачи */ }
    const { flat, tree } = chatPlanTree(chatId);
    expect(flat.find((p) => p.role_id === callee)).toMatchObject({ parent_role_id: caller, question_id: "q-1" });
    expect(tree).toHaveLength(1);
    expect(tree[0].role_id).toBe(caller);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0]).toMatchObject({ role_id: callee, question_id: "q-1", progress: { done: 0, total: 2, blocked: 0, unclosed: 0 } });
    clearPlanLink(chatId, callee);
  });
  it("субагент сдаёт свой пункт без очереди доставки (раньше — run_stale)", () => {
    const chatId = mkChat([caller, callee]);
    setPlanLink(chatId, callee, { parentRoleId: caller, questionId: null });
    try {
      saveChatWorkPlan(chatId, callee, 0, items as any);
      const r = submitChatWorkItem({ chatId, roleId: callee, itemId: "context", outcome: "done", result: "готово" });
      expect(r.item.state).toBe("done");
    } finally { clearPlanLink(chatId, callee); }
  });
  it("вызвавшая роль сдаёт/блокирует пункт вложенного плана с записью кто отметил; чужая — нельзя", () => {
    const chatId = mkChat([caller, callee, "role_qa"]);
    setPlanLink(chatId, callee, { parentRoleId: caller, questionId: "q-2" });
    saveChatWorkPlan(chatId, callee, 0, items as any);
    clearPlanLink(chatId, callee);
    expect(() => submitChatWorkItem({ chatId, roleId: callee, markedBy: "role_qa", itemId: "context", outcome: "done", result: "x" }))
      .toThrowError(/позвала/);
    const r = submitChatWorkItem({ chatId, roleId: callee, markedBy: caller, itemId: "context", outcome: "done", result: "Принято по результату субагента" });
    expect(r.item).toMatchObject({ state: "done", marked_by: caller });
    const b = submitChatWorkItem({ chatId, roleId: callee, markedBy: caller, itemId: "impl", outcome: "blocked", blockType: "dependency", reason: "ждём данные" });
    expect(b.item.state).toBe("blocked");
  });
});
