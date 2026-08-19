// Вложения САМОЙ задачи — то, что прикладывается к её заметке в форме
// (просьба Максима 19.08.2026), в отличие от файлов в ленте, которые едут
// комментарием. Различает их колонка `kind` (миграция 006_attachment_kind);
// проверяется именно она — по одному comment_id виды неотличимы, и без
// этого разделения брошенный черновик комментария всплывал бы в карточке
// как вложение задачи.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

// Настоящий PNG 1×1 — тип проверяется и по Content-Type, и парсером тела.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("Файлы задачи: прикладываются к заметке, а не в ленту", () => {
  let app: FastifyInstance;
  let token: string;
  let taskId: string;
  // Файл для ленты, загруженный в третьем тесте — нужен четвёртому, где
  // проверяется, что комментарий забирает СВОЁ и только своё.
  let commentAttId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@attach.test",
        password: "password123",
      },
    });
    expect(reg.statusCode).toBe(200);
    token = reg.json().token;

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Задача со скриншотом" },
    });
    expect(task.statusCode).toBe(200);
    taskId = task.json().task.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const upload = (kind: string, name: string) =>
    app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(name)}&kind=${kind}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
      payload: PNG,
    });

  it("kind=task — файл принимается и возвращается с задачей", async () => {
    const res = await upload("task", "скриншот.png");
    expect(res.statusCode).toBe(201);
    expect(res.json().attachment.kind).toBe("task");

    const task = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const attachments = task.json().attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].file_name).toBe("скриншот.png");
    expect(attachments[0].size).toBe(PNG.length);
  });

  it("файл задачи скачивается теми же байтами", async () => {
    const task = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const attId = task.json().attachments[0].id;

    const file = await app.inject({
      method: "GET",
      url: `/api/attachments/${attId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
  });

  it("файл для ленты (kind по умолчанию) в заметку задачи не попадает", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/attachments?name=${encodeURIComponent("для-ленты.png")}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
      payload: PNG,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().attachment.kind).toBe("comment");
    commentAttId = res.json().attachment.id;

    const task = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    // По-прежнему один — тот, что с kind='task'. Второй ждёт своего
    // комментария и в карточке не показывается.
    expect(task.json().attachments).toHaveLength(1);
    expect(task.json().attachments[0].file_name).toBe("скриншот.png");
  });

  it("комментарий забирает свой файл и не трогает файл задачи", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const taskAttId = before.json().attachments[0].id;

    // В одном запросе оба вида сразу: так проверяются обе стороны сужения
    // выборки до kind='comment' — что своё по-прежнему подбирается (это
    // работало до сегодняшней правки и ломаться не должно) и что чужое
    // не уводится.
    const comment = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "свой файл и попытка увести чужой",
        attachment_ids: [commentAttId, taskAttId],
      },
    });
    expect(comment.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    // У задачи остался её файл, у комментария — ровно один, свой.
    expect(after.json().attachments).toHaveLength(1);
    expect(after.json().attachments[0].id).toBe(taskAttId);
    const comments = after.json().comments;
    const last = comments[comments.length - 1];
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments[0].id).toBe(commentAttId);
  });

  it("удаление файла убирает его из задачи", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const attId = before.json().attachments[0].id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/attachments/${attId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().attachments).toHaveLength(0);
  });
});
