// Карточка 7efcc173, слот implement: сервер пишет в тему задачи строку
// прогресса при смене состояния шага плана.
//
// Проверяем ровно то, что обещано владельцу в «Критериях приёмки»:
//  1. три параллельные ветки — видно старт всех трёх и их сдачу, по одной
//     строке на смену, в правильном порядке, с названием карточки, шага,
//     роли и новым состоянием;
//  2. повторный вызов того же перехода и повтор сторожевого UPDATE не
//     плодят дубли;
//  3. перезапуск сервера не рассылает уже отправленное;
//  4. шаг без плана и ручная карточка молчат;
//  5. блок даёт ровно одну строку с причиной; возврат на доработку и новый
//     цикл допуска дают НОВЫЕ строки, а не повтор старых;
//  6. карточка, у которой темы нет и быть не может, не роняет работу.
//
// Лишние шаги `spare` и `loop` висят за узлом `gate`, у которого нет строки
// шага: открыться автоматически они не могут (предшественник не сдан), и
// строки от автостарта не портят счёт в проверке 1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { announceStepState } from "../src/runtime/stepTopicProgress.js";
import { ensureTaskRoom } from "../src/lib/projectTopics.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const uid = () => crypto.randomUUID();

type Row = { id: string; text: string; message_type: string | null; from_user_id: string; task_id: string | null };

function topicMessages(chatId: string): Row[] {
  return db
    .prepare("SELECT id, text, message_type, from_user_id, task_id FROM chat_messages WHERE chat_id=? ORDER BY rowid")
    .all(chatId) as Row[];
}

// Отключено 20.10.2026: вызовы строк о шагах сняты с переходов по решению
// владельца («голимый спам»); модуль оставлен под переделку в лёгкую
// системную плашку, которая заменяет предыдущую и ведёт в ленту активности.
// Вернуть тесты вместе с переделкой.
describe.skip("Строка прогресса о шаге плана в теме задачи", () => {
  let app: FastifyInstance;
  let auth: Record<string, string>;
  let taskId: string;
  let projectId: string;
  let planId: string;
  let topicId: string;
  let spareStepId: string;
  let loopStepId: string;
  const steps: Array<{ id: string; role: string; title: string }> = [];

  const addNode = (slot: string, role: string, title: string, position: number) => {
    const stepId = uid();
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position, collaboration_plan_id, plan_node_key, done, admission_cycle) VALUES (?, ?, ?, ?, ?, ?, 0, 1)",
    ).run(stepId, taskId, title, position, planId, slot);
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(uid(), planId, slot, role, title);
    db.prepare("UPDATE subtasks SET agent_id=? WHERE id=?").run(roleUserId(role), stepId);
    return stepId;
  };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "ProgressOwner", email: `progress-owner-${Date.now()}@test`, password: "password123" },
    });
    const body = r.json();
    auth = { authorization: `Bearer ${body.token}` };
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(body.user.id);

    const p = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { name: "Прогресс в чате" } });
    projectId = p.json().id;
    const t = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth,
      payload: { title: "Живой прогресс в чате", project_id: projectId },
    });
    taskId = t.json().task.id;

    // План из трёх параллельных веток: связей между ними нет, стартуют все.
    planId = uid();
    db.prepare(
      `INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by)
       VALUES (?, ?, 1, 'approved', 'manual', 'тест прогресса в чате', 'role_builder')`,
    ).run(planId, taskId);
    for (const [slot, role, title] of [
      ["build", "builder", "правка сервера"],
      ["analyze", "analyst", "разбор узких мест"],
      ["check", "qa", "проверка на стенде"],
    ] as const) {
      steps.push({ id: addNode(slot, role, title, steps.length + 1), role, title });
    }
    // Узел-ворота без строки шага: шаги за ним не откроются сами.
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result) VALUES (?, ?, 'gate', 'architect', 1, 'ворота')",
    ).run(uid(), planId);
    spareStepId = addNode("spare", "builder", "запасной шаг", 4);
    loopStepId = addNode("loop", "builder", "шаг в доработке", 5);
    for (const slot of ["spare", "loop"]) {
      db.prepare(
        "INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition) VALUES (?, ?, 'gate', ?, 'submitted')",
      ).run(uid(), planId, slot);
    }
    topicId = ensureTaskRoom(taskId)!;
    expect(topicId).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  const work = (id: string, body: unknown) =>
    app.inject({ method: "POST", url: `/api/subtasks/${id}/work`, headers: auth, payload: body as any });
  const patch = (id: string, body: unknown) =>
    app.inject({ method: "PATCH", url: `/api/subtasks/${id}`, headers: auth, payload: body as any });

  it("1. Три параллельные ветки: старт и сдача каждой — ровно одна строка", async () => {
    for (const s of steps) expect((await work(s.id, { state: "in_progress" })).statusCode).toBe(200);
    for (const s of steps) expect((await patch(s.id, { done: true, result: "готово" })).statusCode).toBe(200);

    const rows = topicMessages(topicId);
    expect(rows.map((r) => r.text)).toEqual([
      "«Живой прогресс в чате» — Разработчик · правка сервера — начал",
      "«Живой прогресс в чате» — Аналитик · разбор узких мест — начал",
      "«Живой прогресс в чате» — Лайф-тестировщик · проверка на стенде — начал",
      "«Живой прогресс в чате» — Разработчик · правка сервера — сдал",
      "«Живой прогресс в чате» — Аналитик · разбор узких мест — сдал",
      "«Живой прогресс в чате» — Лайф-тестировщик · проверка на стенде — сдал",
    ]);
    for (const r of rows) {
      expect(r.message_type).toBe("system");
      expect(r.from_user_id).toBe("taskflow_system");
      expect(r.task_id).toBe(taskId);
      // Название карточки в каждой строке — по критерию приёмки.
      expect(r.text).toContain("Живой прогресс в чате");
    }
    // Общий чат — не этот канал.
    const common = db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id='chat-common' AND task_id=?")
      .get(taskId) as { n: number };
    expect(common.n).toBe(0);
  });

  it("2. Повтор того же перехода и сторожевой UPDATE не плодят дубли", async () => {
    const before = topicMessages(topicId).length;
    // Прямой повтор вызова — то, что делает сторожевой тик, повторяя UPDATE.
    expect(announceStepState(steps[0].id, "submitted")).toBeNull();
    expect(announceStepState(steps[0].id, "submitted")).toBeNull();
    // Повтор блока через API: состояние не меняется — строки нет.
    expect((await work(spareStepId, { state: "blocked", result: "жду доступ к стенду" })).statusCode).toBe(200);
    const afterBlock = topicMessages(topicId).length;
    expect(afterBlock).toBe(before + 1);
    expect((await work(spareStepId, { state: "blocked", result: "жду доступ к стенду" })).statusCode).toBe(200);
    expect(announceStepState(spareStepId, "blocked", "жду доступ к стенду")).toBeNull();
    expect(topicMessages(topicId)).toHaveLength(afterBlock);
  });

  it("3. Перезапуск сервера не рассылает уже отправленное", async () => {
    const before = topicMessages(topicId);
    await app.close();
    app = await buildApp();
    // Повторяем те же переходы после рестарта — старых строк не прибавляется.
    for (const s of steps) expect(announceStepState(s.id, "submitted")).toBeNull();
    expect(announceStepState(spareStepId, "blocked", "жду доступ к стенду")).toBeNull();
    expect(topicMessages(topicId).map((r) => r.text)).toEqual(before.map((r) => r.text));
  });

  it("4. Шаг без плана и ручная карточка молчат", async () => {
    const before = topicMessages(topicId).length;
    const manual = uid();
    db.prepare("INSERT INTO subtasks (id, task_id, title, position, done) VALUES (?, ?, ?, 9, 0)").run(
      manual,
      taskId,
      "ручной пункт",
    );
    expect((await work(manual, { state: "in_progress" })).statusCode).toBe(200);
    expect((await patch(manual, { done: true, result: "сделано руками" })).statusCode).toBe(200);
    expect(announceStepState(manual, "started")).toBeNull();
    expect(topicMessages(topicId)).toHaveLength(before);
  });

  it("5. Блок с причиной, возврат на доработку и новый цикл — строки новые, а не повтор", async () => {
    const s = loopStepId;
    const before = topicMessages(topicId).length;
    expect((await work(s, { state: "blocked", result: "жду стенд на три машины" })).statusCode).toBe(200);
    // Повтор блока (продление аренды, тик сторожа) — ни строки.
    expect((await work(s, { state: "blocked", result: "жду стенд на три машины" })).statusCode).toBe(200);
    expect(announceStepState(s, "blocked", "жду стенд на три машины")).toBeNull();
    // Сдача и возврат на доработку владельцем.
    expect((await patch(s, { done: true, result: "первая попытка" })).statusCode).toBe(200);
    expect((await patch(s, { done: false })).statusCode).toBe(200);
    // Новый допуск — новый цикл (на сервере его так же поднимает
    // planSubtaskAdmission при старте шага).
    db.prepare("UPDATE subtasks SET admission_cycle=COALESCE(admission_cycle,0)+1 WHERE id=?").run(s);
    expect((await work(s, { state: "in_progress" })).statusCode).toBe(200);
    expect((await patch(s, { done: true, result: "вторая попытка" })).statusCode).toBe(200);

    const rows = topicMessages(topicId).slice(before);
    expect(rows.map((r) => r.text)).toEqual([
      "«Живой прогресс в чате» — Разработчик · шаг в доработке — заблокирован — жду стенд на три машины",
      "«Живой прогресс в чате» — Разработчик · шаг в доработке — сдал",
      "«Живой прогресс в чате» — Разработчик · шаг в доработке — вернулся на доработку",
      "«Живой прогресс в чате» — Разработчик · шаг в доработке — начал",
      "«Живой прогресс в чате» — Разработчик · шаг в доработке — сдал",
    ]);
    // Ровно по одной строке на смену: начал×1 (цикл 2), сдал×2 (циклы 1 и
    // 2), заблокирован×1 (повтор блока погашен), вернулся×1.
    const texts = topicMessages(topicId).map((r) => r.text).filter((t) => t.includes("шаг в доработке"));
    expect(texts.filter((t) => t.endsWith("начал"))).toHaveLength(1);
    expect(texts.filter((t) => t.endsWith("сдал"))).toHaveLength(2);
    expect(texts.filter((t) => t.includes("заблокирован"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("вернулся на доработку"))).toHaveLength(1);
  });

  it("6. Карточка без темы не роняет работу, карточка с темой пишет в неё", async () => {
    // Карточка без проекта: тема не создаётся (ensureTaskRoom вернёт null),
    // шаг молчит, но вызов не бросает — приёмка шага не зависит от сообщения.
    const t = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Карточка без проекта" } });
    const fresh = t.json().task.id;
    const plan = uid();
    db.prepare(
      `INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by)
       VALUES (?, ?, 1, 'approved', 'manual', 'тест', 'role_builder')`,
    ).run(plan, fresh);
    const step = uid();
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position, collaboration_plan_id, plan_node_key, done, admission_cycle) VALUES (?, ?, ?, 1, ?, 'only', 0, 1)",
    ).run(step, fresh, "единственный шаг", plan);
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result) VALUES (?, ?, 'only', 'builder', 1, 'результат')",
    ).run(uid(), plan);
    expect(announceStepState(step, "started")).toBeNull();
    expect(
      db.prepare("SELECT id FROM chats WHERE task_id=? AND room_kind='task'").get(fresh),
    ).toBeUndefined();
    // Чужой шаг (не существует) — тишина, а не исключение.
    expect(announceStepState("нет-такого-шага", "started")).toBeNull();
  });
});