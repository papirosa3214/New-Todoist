// Датасет базы знаний у проекта: выбор при создании и защита от случайной
// переиндексации при смене (просьба владельца 08.09.2026 — «чтобы случайно
// в запаре не щёлкнул и не понеслась на полдня»).
//
// Через app.inject() на одноразовой базе (test/setup.ts) — живой сервер на
// :3001 и настоящий RAGFlow не задействованы: проверяется поведение TaskFlow,
// а не чужой индекс.
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Проект и его датасет базы знаний", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@knowledge.test",
        password: "password123",
      },
    });
    expect(reg.statusCode).toBe(200);
    ownerToken = reg.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
  });

  const auth = () => ({ authorization: `Bearer ${ownerToken}` });

  async function createProject(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth(),
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("без выбора датасет пустой — проект едет в общий", async () => {
    const project = await createProject({ name: "Обычный проект" });
    expect(project.knowledge_dataset_id ?? null).toBeNull();
  });

  it("датасет можно задать прямо при создании", async () => {
    const project = await createProject({
      name: "Бизнесовый проект",
      knowledge_dataset_id: "ds-business",
    });
    const row = db
      .prepare("SELECT knowledge_dataset_id AS id FROM projects WHERE id = ?")
      .get(project.id) as { id: string | null };
    expect(row.id).toBe("ds-business");
  });

  it("пустому проекту датасет меняется без подтверждения — переносить нечего", async () => {
    const project = await createProject({ name: "Пустой проект" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: auth(),
      payload: { knowledge_dataset_id: "ds-new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().knowledge_dataset_id).toBe("ds-new");
  });

  it("проекту с документами смена датасета без confirm_reindex отклоняется", async () => {
    const project = await createProject({ name: "Проект с доками", with_docs: true });
    const folderId = db
      .prepare("SELECT notes_folder_id AS id FROM projects WHERE id = ?")
      .get(project.id) as { id: number };
    expect(folderId.id).toBeTruthy();

    db.prepare(
      "INSERT INTO user_notes (id, title, content, folder_id) VALUES (?,?,?,?)",
    ).run("n-1", "Документ", "{}", folderId.id);

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: auth(),
      payload: { knowledge_dataset_id: "ds-other" },
    });
    expect(denied.statusCode).toBe(409);
    const body = denied.json();
    expect(body.documents).toBe(1);
    // Оценка времени обязана быть в ответе: ради неё предупреждение и заводили.
    expect(body.estimate_minutes).toBeGreaterThan(0);

    // Датасет при отказе остаться должен прежним, иначе предупреждение
    // бесполезно — операция уже случилась бы.
    const untouched = db
      .prepare("SELECT knowledge_dataset_id AS id FROM projects WHERE id = ?")
      .get(project.id) as { id: string | null };
    expect(untouched.id ?? null).toBeNull();

    const confirmed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: auth(),
      payload: { knowledge_dataset_id: "ds-other", confirm_reindex: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().knowledge_dataset_id).toBe("ds-other");
  });

  it("правка проекта, не трогающая датасет, подтверждения не требует", async () => {
    const project = await createProject({ name: "Переименуемый", with_docs: true });
    const folderId = db
      .prepare("SELECT notes_folder_id AS id FROM projects WHERE id = ?")
      .get(project.id) as { id: number };
    db.prepare(
      "INSERT INTO user_notes (id, title, content, folder_id) VALUES (?,?,?,?)",
    ).run("n-2", "Документ", "{}", folderId.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: auth(),
      payload: { name: "Переименованный" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Переименованный");
  });
});
