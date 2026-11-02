// История действий роли: не стирается, пока задача жива, и копится в журнале.
//
// Владелец 02.11.2026:
// — «когда заблокировано — не активно, я не могу посмотреть, что она делала»;
// — «пусть они потом это все стирают, но только когда задача уже уйдет в архив»;
// — «вся эта статистика должна прям в журналах копиться».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { sweepActivityBuffers } from "../src/routes/activity.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let owner: string;

const auth = () => ({ authorization: `Bearer ${token}` });

function setAgentState(id: string, state: string) {
  db.prepare("UPDATE tasks SET agent_state = ? WHERE id = ?").run(state, id);
}

beforeAll(async () => {
  app = await buildApp();
  owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
  token = app.jwt.sign({ id: owner });
  db.prepare(
    "INSERT INTO tasks (id,title,creator_id,status,assignee_id,agent_state) VALUES (?,?,?,?,?,?)",
  ).run("act-hist", "Задача с историей роли", owner, "active", owner, "in_progress");
  // Журнал `role_tool_audit` — как его пишет рантайм роли.
  const ins = db.prepare(
    `INSERT INTO role_tool_audit (id, role, task_id, subtask_id, action, tool, operation, outcome, error_message)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  ins.run("ah1", "architect", "act-hist", "slot-1", "invoke", "taskflow", "taskflow_doc_read", "ok", null);
  ins.run("ah2", "architect", "act-hist", "slot-1", "invoke", "taskflow", "taskflow_doc_read", "error", "Отказ сервера: вызов не выполнялся");
  ins.run("ah3", "architect", "act-hist", "slot-1", "invoke", "taskflow", "taskflow_work_plan", "ok", null);
});

afterAll(async () => {
  await app?.close();
});

describe("история действий роли", () => {
  it("статистика считается по журналу и переживает пустой буфер", async () => {
    const body = (await app.inject({
      method: "GET",
      url: "/api/tasks/act-hist/activity",
      headers: auth(),
    })).json() as { stats?: { total: number; ok: number; failed: number; by_operation: any[]; errors: any[] } };
    expect(body.stats).toBeTruthy();
    expect(body.stats!.total).toBe(3);
    expect(body.stats!.ok).toBe(2);
    expect(body.stats!.failed).toBe(1);
    const failed = body.stats!.by_operation.find((o) => o.operation === "taskflow_doc_read");
    expect(failed?.failed).toBe(1);
    expect(failed?.total).toBe(2);
    expect(body.stats!.errors[0].message).toContain("Отказ сервера");
  });

  it("действия роли не стираются, когда задача перестала быть в работе", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/tasks/act-hist/activity",
      headers: auth(),
      payload: { kind: "read", target: "src/lib/search.ts" },
    });
    expect(post.statusCode).toBe(200);
    expect((post.json() as { accepted: boolean }).accepted).toBe(true);

    // Роль встала: задача больше не «в работе».
    setAgentState("act-hist", "blocked");

    const body = (await app.inject({
      method: "GET",
      url: "/api/tasks/act-hist/activity",
      headers: auth(),
    })).json() as { actions: any[]; stats?: { total: number } };
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.actions[0].target).toBe("src/lib/search.ts");
    // Статистика из журнала — на месте.
    expect(body.stats?.total).toBe(3);
  });

  it("по шагу статистика есть даже когда буфер пуст — слоты знает журнал", async () => {
    // Буфер пуст (роль остановилась, сервер перезапустился) — но по шагу
    // статистика из журнала всё равно есть: без неё владелец не видит, что
    // роль делала и где ошибалась.
    const body = (await app.inject({
      method: "GET",
      url: "/api/tasks/act-hist/activity",
      headers: auth(),
    })).json() as { by_subtask?: Record<string, { stats?: { total: number; failed: number } }> };
    const slot = body.by_subtask?.["slot-1"];
    expect(slot).toBeTruthy();
    expect(slot!.stats?.total).toBe(3);
    expect(slot!.stats?.failed).toBe(1);
  });

  it("буфер живёт, пока задача не в архиве; в архиве — гаснет", async () => {
    setAgentState("act-hist", "blocked");
    // Буфер постарел (прошло больше TTL) — но задача жива, историю не трогаем.
    sweepActivityBuffers(Date.now() + 31 * 60 * 1000);
    let body = (await app.inject({
      method: "GET",
      url: "/api/tasks/act-hist/activity",
      headers: auth(),
    })).json() as { actions: any[] };
    expect(body.actions.length).toBeGreaterThan(0);

    // Задача выполнена — ушла в архив. Теперь историю можно гасить.
    db.prepare("UPDATE tasks SET status='completed', completed_at=datetime('now') WHERE id=?").run("act-hist");
    sweepActivityBuffers(Date.now() + 31 * 60 * 1000);
    body = (await app.inject({
      method: "GET",
      url: "/api/tasks/act-hist/activity",
      headers: auth(),
    })).json() as { actions: any[]; stats?: { total: number } };
    expect(body.actions.length).toBe(0);
    // Статистика из журнала остаётся даже после гашения буфера.
    expect(body.stats?.total).toBe(3);
  });
});
