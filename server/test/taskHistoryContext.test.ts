// «Что уже было по этой карточке» — сервер собирает сводку прошлых ходов БЕЗ
// модели и кладёт её в задание каждого шага (владелец 06.10.2026). Здесь
// проверяется сам сборщик: результат прошлого шага со ссылкой, дефекты
// QA/Критика, комментарии владельца, пометка «первый шаг» и потолок размера.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { buildTaskHistory, TASK_HISTORY_BLOCK_MAX } from "../src/runtime/taskHistoryContext.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("Сводка прошлых шагов в задании роли", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "History owner", email: `history-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    ownerToken = `Bearer ${reg.json().token}`;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeTask(title: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerToken }, payload: { title } });
    return res.json().task.id as string;
  }

  function addSubtask(input: {
    taskId: string;
    title: string;
    done: number;
    roleId: string | null;
    result?: string | null;
    slot?: string | null;
  }): string {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, agent_id, agent_state, result, plan_node_key) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
    ).run(id, input.taskId, input.title, input.done, input.roleId, input.done ? "done" : "in_progress", input.result ?? null, input.slot ?? null);
    return id;
  }

  function addArtifact(subtaskId: string, key: string, summary: string): void {
    db.prepare(
      `INSERT INTO subtask_artifact_versions
         (id, subtask_id, version_no, artifact_key, artifact_type, artifact_format, summary, payload_json, evidence_json, status, created_by)
       VALUES (?, ?, 1, ?, 'specification', 'json', ?, '{}', '[]', 'accepted', ?)`,
    ).run(crypto.randomUUID(), subtaskId, key, summary, ownerId);
  }

  function addComment(taskId: string, userId: string, text: string): string {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)").run(id, taskId, userId, text);
    return id;
  }

  it("у шага после сданного Разработчика есть его результат и ссылка на артефакт", async () => {
    const taskId = await makeTask("История: разработчик затем проверка");
    const stepId = addSubtask({ taskId, title: "Реализация", done: 1, roleId: "role_builder", result: "Собрал блок, commit abc1234", slot: "executor" });
    addArtifact(stepId, "feature_spec", "Согласованное решение");
    const currentId = addSubtask({ taskId, title: "Проверка", done: 0, roleId: "role_qa", slot: "qa" });

    const history = buildTaskHistory({ taskId, subtaskId: currentId });
    expect(history.status).toBe("ok");
    expect(history.past_steps).toBe(1);
    expect(history.block).toContain("Реализация");
    expect(history.block).toContain("Собрал блок");
    expect(history.block).toContain("feature_spec v1");
    expect(history.block).toContain("abc1234");
    // Текущий шаг сам себя в «прошлое» не подставляет.
    expect(history.block).not.toContain("Проверка");
    expect(history.block.length).toBeLessThanOrEqual(TASK_HISTORY_BLOCK_MAX);
  });

  it("у доработки видны дефекты из вердикта и комментарии владельца", async () => {
    const taskId = await makeTask("История: вердикт и владелец");
    addSubtask({ taskId, title: "Реализация", done: 1, roleId: "role_builder", result: "Первая версия" });
    const currentId = addSubtask({ taskId, title: "Доработка 1", done: 0, roleId: "role_builder", slot: "builder_fix" });
    const verdictId = addComment(taskId, "role_qa", "Ревьюер вернул на доработку: 1) нет теста на пустой блок");
    const ownerCommentId = addComment(taskId, ownerId, "Не забудь про лимит размера");

    const history = buildTaskHistory({ taskId, subtaskId: currentId });
    expect(history.block).toContain("нет теста на пустой блок");
    expect(history.block).toContain(verdictId);
    expect(history.block).toContain("Не забудь про лимит размера");
    expect(history.block).toContain(ownerCommentId);
  });

  it("у первого шага блок помечен «первый шаг»", async () => {
    const taskId = await makeTask("История: первый шаг");
    const currentId = addSubtask({ taskId, title: "Исследование", done: 0, roleId: "role_researcher", slot: "research" });

    const history = buildTaskHistory({ taskId, subtaskId: currentId });
    expect(history.status).toBe("empty");
    expect(history.past_steps).toBe(0);
    expect(history.block).toContain("Первый шаг");
  });

  it("размер блока ограничен даже при длинной истории", async () => {
    const taskId = await makeTask("История: много шагов");
    for (let i = 0; i < 12; i += 1) {
      addSubtask({ taskId, title: `Шаг ${i}`, done: 1, roleId: "role_builder", result: "Результат ".repeat(60), slot: `s${i}` });
    }
    const currentId = addSubtask({ taskId, title: "Текущий", done: 0, roleId: "role_qa", slot: "qa" });

    const history = buildTaskHistory({ taskId, subtaskId: currentId });
    expect(history.block.length).toBeLessThanOrEqual(TASK_HISTORY_BLOCK_MAX);
  });
});
