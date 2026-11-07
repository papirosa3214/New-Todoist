// Заявки ролей на закрытые инструменты (миграция 152_role_tool_gain_requests).
//
// Закрытый инструмент раньше просто исчезал из каталога — роль не знала, что
// он есть, и не могла попросить. Теперь пишет заявку через
// taskflow_tool_request, владелец видит уведомление, решает здесь же.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/index.js";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  recordRoleToolRequest,
  ROLE_TOOL_REQUEST_NOTIFICATION_TYPE,
} from "../src/routes/role-tool-requests.js";

migrate();
runMigrations();

const secretaryId = "u-secretary";
const builderId = "role_builder";

let app: FastifyInstance;
let ownerToken = "";
let agentToken = "";

beforeAll(async () => {
  app = await buildApp();
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "OwnerTR", email: "owner@tool-request.test", password: "password123" },
  });
  ownerToken = owner.json().token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.json().user.id);
  // Ролевой аккаунт заводим по правилам 058_role_account_authority:
  // id = role_<role_key>, роль в users.role_key, а users.role — это ВЛАСТЬ.
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type,role_key,is_system_bot) VALUES(?,?,?,?,?,?,?,?)",
  ).run("role_builder", "Разработчик", "role_builder@tool-request.test", "x", "agent", "ai", "builder", 1);
  agentToken = app.jwt.sign({ id: "role_builder" }, { expiresIn: "1h" });
  // Помощник владельца — фиксированная учётка u-secretary, у неё role_key.
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type,role_key,is_system_bot) VALUES(?,?,?,?,?,?,?,?)",
  ).run(secretaryId, "Помощник", "u-secretary@tool-request.test", "x", "agent", "ai", "secretary", 1);
});

afterAll(async () => {
  await app.close();
});

function notifications(): any[] {
  return db
    .prepare("SELECT * FROM notifications WHERE type = ? ORDER BY created_at")
    .all(ROLE_TOOL_REQUEST_NOTIFICATION_TYPE) as any[];
}

describe("Заявки ролей на закрытые инструменты", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM role_tool_gain_requests").run();
    db.prepare("DELETE FROM notifications WHERE type = ?").run(ROLE_TOOL_REQUEST_NOTIFICATION_TYPE);
  });

  it("заявка сохраняется с ролью, инструментом и причиной", () => {
    db.prepare("INSERT OR IGNORE INTO tasks(id,title) VALUES(?,?)").run("task-1", "Карточка для заявки");
    const r = recordRoleToolRequest({
      role: "secretary",
      actorId: secretaryId,
      tool: "taskflow_subtask_add",
      why: "владелец попросил разбить карточку на шаги",
      taskId: "task-1",
    });
    expect(r.id).toBeTruthy();
    const row = db.prepare("SELECT * FROM role_tool_gain_requests WHERE id = ?").get(r.id) as any;
    expect(row.role).toBe("secretary");
    expect(row.tool).toBe("taskflow_subtask_add");
    expect(row.status).toBe("open");
    expect(row.task_id).toBe("task-1");
  });

  it("уведомление владельцу — одно в сутки на пару роль+инструмент (защита от лавины)", () => {
    const first = recordRoleToolRequest({
      role: "secretary",
      actorId: secretaryId,
      tool: "taskflow_subtask_add",
      why: "нужно добавить шаг в план",
    });
    expect(first.notified).toBe(true);
    expect(notifications()).toHaveLength(1);

    // Та же заявка снова: запись есть, уведомление не плодим.
    const second = recordRoleToolRequest({
      role: "secretary",
      actorId: secretaryId,
      tool: "taskflow_subtask_add",
      why: "нужно добавить шаг в план",
    });
    expect(second.notified).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM role_tool_gain_requests").get() as any).n).toBe(2);
    expect(notifications()).toHaveLength(1);

    // Другой инструмент той же роли — отдельное уведомление.
    const third = recordRoleToolRequest({
      role: "secretary",
      actorId: secretaryId,
      tool: "taskflow_slot_snapshot",
      why: "записать, где остановилась",
    });
    expect(third.notified).toBe(true);
    expect(notifications()).toHaveLength(2);
  });

  it("заявка из карточки попадает в ленту событий", () => {
    const taskId = "task-with-events";
    db.prepare("INSERT OR IGNORE INTO tasks(id,title) VALUES(?,?)").run(taskId, "Карточка для события");
    recordRoleToolRequest({
      role: "builder",
      actorId: builderId,
      tool: "taskflow_rules",
      why: "хочу править правила команды",
      taskId,
    });
    const events = db
      .prepare("SELECT * FROM task_events WHERE kind = 'role_tool_request' AND task_id = ?")
      .all(taskId) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].to_value).toBe("taskflow_rules");
  });

  it("без причины заявка не проходит, решение по заявке принимает только владелец", async () => {
    const noWhy = await app.inject({
      method: "POST",
      url: "/api/role-tool-requests",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { tool: "taskflow_subtask_add" },
    });
    expect(noWhy.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/role-tool-requests",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { tool: "taskflow_subtask_add", why: "владелец попросил разбить карточку на шаги" },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const requestId = ok.json().id as string;

    const byAgent = await app.inject({
      method: "POST",
      url: `/api/role-tool-requests/${requestId}/decision`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { status: "granted" },
    });
    expect(byAgent.statusCode).toBe(403);

    const byOwner = await app.inject({
      method: "POST",
      url: `/api/role-tool-requests/${requestId}/decision`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "granted" },
    });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().status).toBe("granted");

    const again = await app.inject({
      method: "POST",
      url: `/api/role-tool-requests/${requestId}/decision`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "rejected" },
    });
    expect(again.statusCode).toBe(404);
  });

  it("роль видит только свои заявки, владелец — все", async () => {
    recordRoleToolRequest({ role: "secretary", actorId: secretaryId, tool: "taskflow_claim", why: "взять карточку" });
    recordRoleToolRequest({ role: "builder", actorId: builderId, tool: "taskflow_rules", why: "править правила" });

    const ownerView = await app.inject({
      method: "GET",
      url: "/api/role-tool-requests",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerView.json().requests.length).toBeGreaterThanOrEqual(2);

    const builderView = await app.inject({
      method: "GET",
      url: "/api/role-tool-requests",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const rows = builderView.json().requests as any[];
    expect(rows.length, builderView.body).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.role === "builder")).toBe(true);
  });
  it("cannot attribute a request to a role supplied in JSON", async () => {
    const response = await app.inject({method:"POST", url:"/api/role-tool-requests",
      headers:{authorization:`Bearer ${agentToken}`}, payload:{role:"secretary", tool:"taskflow_library", why:"Need this operation for my current work"}});
    expect(response.statusCode).toBe(201);
    const row = db.prepare("SELECT role FROM role_tool_gain_requests WHERE id = ?").get(response.json().id) as any;
    expect(row.role).toBe("builder");
  });

});