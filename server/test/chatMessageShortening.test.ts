// Сокращение длинных сообщений агентов (карточка c19c9460).
//
// Проверяем ровно критерии приёмки: короткое сообщение доходит как есть;
// длинное — сервер не отклоняет, полный текст ложится документом в папку
// задачи, в чат уходит выжимка со ссылкой, а отправителю в ответе сказано
// про сокращение. Сообщения владельца не сокращаются, и старый жёсткий
// потолок для него остаётся.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

describe("Сокращение длинных сообщений агентов", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let agentId: string;
  let taskId: string;

  const register = async (name: string, email: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    return { token: res.json().token, id: res.json().user.id };
  };

  const send = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  beforeAll(async () => {
    app = await buildApp();
    // Единственный владелец — тот, кого заводит тест (см. helpers/seedOwner).
    demoteSeededOwner(db);

    const owner = await register("Хозяин", "owner@shorten.test");
    ownerToken = owner.token;
    ownerId = owner.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agent = await register("Агент", "agent@shorten.test");
    agentToken = agent.token;
    agentId = agent.id;

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача про длинное сообщение", assignee_id: agentId },
    });
    taskId = task.json().task.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("короткое сообщение агента доходит как есть", async () => {
    const res = await send(agentToken, {
      text: "Коротко и по делу",
      to_user_id: "all",
      task_id: taskId,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.сокращено).toBeUndefined();
    expect(body.text).toBe("Коротко и по делу");

    const row = db
      .prepare("SELECT text FROM chat_messages WHERE id = ?")
      .get(body.id) as { text: string };
    expect(row.text).toBe("Коротко и по делу");
  });

  it("длинное сообщение агента: в чат выжимка, полный текст — документом в папке задачи", async () => {
    const full = [
      "Первый тезис достаточно содержательный и должен попасть в выжимку.",
      "Второй тезис тоже часть короткой версии.",
      ...Array.from(
        { length: 60 },
        (_, i) => `Подробность номер ${i}: ${"д".repeat(20)}.`,
      ),
    ].join(" ");
    expect(full.length).toBeGreaterThan(600);

    const res = await send(agentToken, {
      text: full,
      to_user_id: "all",
      task_id: taskId,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Ответ агенту: факт сокращения и где полный текст.
    expect(body.сокращено).toBe(true);
    expect(body.длина_полного).toBe(full.length);
    expect(body.документ?.id).toBeTruthy();
    expect(body.документ?.title).toBeTruthy();

    // В чат ушла короткая версия со ссылкой.
    expect(body.text.length).toBeLessThan(full.length);
    expect(body.text).toContain("полный текст:");
    expect(body.text).toContain(body.документ.title);
    const chatRow = db
      .prepare("SELECT text FROM chat_messages WHERE id = ?")
      .get(body.id) as { text: string };
    expect(chatRow.text).toBe(body.text);

    // Документ лежит в папке задачи, с полным текстом.
    const task = db
      .prepare("SELECT artifact_folder_id FROM tasks WHERE id = ?")
      .get(taskId) as { artifact_folder_id: number | null };
    expect(task.artifact_folder_id).toBeTruthy();

    const note = db
      .prepare("SELECT id, title, folder_id FROM user_notes WHERE id = ?")
      .get(body.документ.id) as
      | { id: string; title: string; folder_id: number | null }
      | undefined;
    expect(note).toBeTruthy();
    expect(note!.folder_id).toBe(task.artifact_folder_id);
    expect(note!.title).toBe(body.документ.title);

    const read = await app.inject({
      method: "GET",
      url: `/api/notes/${body.документ.id}?format=markdown`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().markdown).toContain("Подробность номер 59");
  });

  it("длинное сообщение владельца не сокращается", async () => {
    const full = "Владелец пишет подробно. ".repeat(40); // ~1000 знаков, < TEXT_MAX
    const res = await send(ownerToken, { text: full, to_user_id: "all" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.сокращено).toBeUndefined();
    expect(body.text).toBe(full.trim());

    const row = db
      .prepare("SELECT text FROM chat_messages WHERE id = ?")
      .get(body.id) as { text: string };
    expect(row.text).toBe(full.trim());
  });

  it("очень длинное сообщение владельца (> TEXT_MAX) отклоняется как раньше", async () => {
    const res = await send(ownerToken, {
      text: "я".repeat(4500),
      to_user_id: "all",
    });
    expect(res.statusCode).toBe(400);
  });
});
