// Папки сессий Помощника (владелец 12.11.2026): сессия кладётся в проект —
// PATCH /api/chats/:id { project_id }. Проект чата уже даёт Помощнику память
// и контекст проекта; задачи из разговора живут в той же «папке».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Чаты: сессия в проекте-папке", () => {
  let app: FastifyInstance;
  let ownerAuth: Record<string, string>;
  let otherAuth: Record<string, string>;
  let otherId: string;
  let projectId: string;

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, auth: { authorization: `Bearer ${body.token}` } };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("FolderOwner", "owner");
    ownerAuth = owner.auth;
    const other = await reg("FolderOther");
    otherId = other.id;
    otherAuth = other.auth;
    const project = await app.inject({ method: "POST", url: "/api/projects", headers: ownerAuth, payload: { name: "Папка чатов" } });
    expect(project.statusCode).toBeLessThan(300);
    const body = project.json();
    projectId = body.project?.id ?? body.id;
    expect(projectId).toBeTruthy();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function session() {
    const res = await app.inject({ method: "POST", url: "/api/chats", headers: ownerAuth, payload: { member_ids: [otherId] } });
    return res.json().chat.id as string;
  }

  function move(auth: Record<string, string>, id: string, project: unknown) {
    return app.inject({ method: "PATCH", url: `/api/chats/${id}`, headers: auth, payload: { project_id: project } });
  }

  it("создатель кладёт сессию в проект и достаёт обратно", async () => {
    const id = await session();
    const moved = await move(ownerAuth, id, projectId);
    expect(moved.statusCode).toBe(200);
    expect(moved.json().chat.project_id).toBe(projectId);
    const back = await move(ownerAuth, id, null);
    expect(back.statusCode).toBe(200);
    expect(back.json().chat.project_id).toBeNull();
  });

  it("несуществующий проект — 400", async () => {
    const id = await session();
    expect((await move(ownerAuth, id, "нет-такого")).statusCode).toBe(400);
  });

  it("комнату задачи в проект не перекладывают — 409", async () => {
    const id = await session();
    db.prepare("UPDATE chats SET room_kind = 'task' WHERE id = ?").run(id);
    expect((await move(ownerAuth, id, projectId)).statusCode).toBe(409);
  });

  it("чужую сессию не трогают — 403", async () => {
    const id = await session();
    expect((await move(otherAuth, id, projectId)).statusCode).toBe(403);
  });
});
