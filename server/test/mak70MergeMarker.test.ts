// MAK-70: правило Критика, проверка коммита при сдаче шага, признак
// «влито», список веток/копий.
//
// Тест проверяет каждый кусок отдельно и сквозной сценарий: ветка
// `roles/<id>` создаётся с одним коммитом поверх main, агент закрывает
// шаг — проходит; убираем коммит — закрытие отклоняется с понятной
// ошибкой. Затем владелец отмечает «влито» через /merge-marker, и
// состояние видно в /admin/role-branches.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleCommitCheck, commitGuardError, inspectRoleBranch } from "./helpers/roleCommitCheck.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe("MAK-70: проверка коммита, признак «влито», список веток", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let agentId: string;
  let taskId: string;
  let subtaskId: string;
  // Временный live-репозиторий, чтобы не дёргать боевой.
  const live = fs.mkdtempSync(path.join(os.tmpdir(), "mak70-live-"));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mak70-wt-"));
  const previousLive = process.env.TASKFLOW_ROLE_WORKTREES;

  beforeAll(async () => {
    // Подготовим временный репозиторий: main + первый коммит.
    git(live, "init", "-q", "-b", "main");
    git(live, "config", "user.email", "t@t");
    git(live, "config", "user.name", "t");
    fs.writeFileSync(path.join(live, "README.md"), "init\n");
    git(live, "add", "README.md");
    git(live, "commit", "-q", "-m", "init");
    process.env.TASKFLOW_ROLE_WORKTREES = base;
    process.env.MAK70_LIVE_REPO = live;
    roleCommitCheck.setLiveRepo(live);

    app = await buildApp();

    // Регистрация владельца и агента.
    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Owner", email: "owner@mak70.test", password: "password123" },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Agent", email: "agent@mak70.test", password: "password123" },
    });
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type='ai' WHERE id=?").run(agentId);
    const apiResp = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentReg.json().token}` },
    });
    agentToken = apiResp.json().api_token;

    // Карточка с одним шагом — для сдачи.
    const taskResp = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "MAK-70 demo", assignee_id: agentId },
    });
    taskId = taskResp.json().task.id;

    const subResp = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Сделать коммит и сдать" },
    });
    subtaskId = subResp.json().id;

    // Готовность и захват.
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { ready_for_pickup: 1 },
    });
    expect(
      (await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/claim`,
        headers: { authorization: `Bearer ${agentToken}` },
      })).statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    process.env.TASKFLOW_ROLE_WORKTREES = previousLive;
    process.env.MAK70_LIVE_REPO = undefined;
    roleCommitCheck.setLiveRepo(null);
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  // Не сбрасываем ветки между тестами: каждый тест готовит свой
  // taskId, чтобы не мешать соседу.
  afterEach(() => {
    // Чистим свежесозданные ветки/копии, чтобы не накапливались.
    const branches = git(live, "branch", "--list", "roles/*").split("\n").map((s) => s.trim().replace(/^\* /, "")).filter(Boolean);
    for (const b of branches) {
      try { git(live, "branch", "-D", b); } catch { /* ветки уже нет — ок */ }
    }
    for (const entry of fs.readdirSync(base)) {
      fs.rmSync(path.join(base, entry), { recursive: true, force: true });
    }
  });

  it("inspectRoleBranch: ветки нет — hasCommits=false, branchExists=false", () => {
    const r = inspectRoleBranch("no-such-task", "main", live);
    expect(r.hasCommits).toBe(false);
    expect(r.branchExists).toBe(false);
    expect(r.aheadCount).toBe(0);
  });

  it("inspectRoleBranch: ветка есть, ahead=0 — коммитов для сдачи нет", () => {
    git(live, "branch", `roles/t-empty`, "main");
    const r = inspectRoleBranch("t-empty", "main", live);
    expect(r.branchExists).toBe(true);
    expect(r.aheadCount).toBe(0);
    expect(r.hasCommits).toBe(false);
  });

  it("inspectRoleBranch: ahead=1 — коммит есть", () => {
    git(live, "checkout", "-q", "-b", "roles/t-ahead");
    fs.writeFileSync(path.join(live, "x.txt"), "x\n");
    git(live, "add", "x.txt");
    git(live, "commit", "-q", "-m", "ahead");
    const r = inspectRoleBranch("t-ahead", "main", live);
    expect(r.branchExists).toBe(true);
    expect(r.aheadCount).toBe(1);
    expect(r.hasCommits).toBe(true);
  });

  it("commitGuardError: чужой проект (ветки нет) — пропуск", () => {
    expect(commitGuardError("t-missing", live)).toBeNull();
  });

  it("commitGuardError: ветка есть, ahead=0 — отказ с подсказкой пути", () => {
    git(live, "branch", `roles/t-zero`, "main");
    const err = commitGuardError("t-zero", live);
    expect(err).toBeTruthy();
    expect(String(err)).toMatch(/ahead=0/);
    expect(String(err)).toMatch(/roles\/t-zero/);
  });

  it("закрытие шага отклоняется, пока нет коммита на ветке роли", async () => {
    // Создадим ветку роли без коммитов — ahead=0.
    git(live, "branch", `roles/${taskId}`, "main");
    expect(
      (await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/work`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { state: "in_progress" },
      })).statusCode,
    ).toBe(200);
    const closeRes = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { done: true, result: "Готово" },
    });
    expect(closeRes.statusCode).toBe(400);
    expect(String(closeRes.json().error)).toMatch(/ahead=0/);
  });

  it("закрытие шага проходит, когда на ветке roles/<id> есть ahead>=1", async () => {
    // Подвинем ветку: один коммит поверх main.
    git(live, "checkout", "-q", "-b", `roles/${taskId}`, "main");
    fs.writeFileSync(path.join(live, "result.txt"), "ok\n");
    git(live, "add", "result.txt");
    git(live, "commit", "-q", "-m", "result");
    git(live, "checkout", "-q", "main");

    expect(
      (await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/work`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { state: "in_progress" },
      })).statusCode,
    ).toBe(200);

    const closeRes = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { done: true, result: "Готово" },
    });
    expect(closeRes.statusCode).toBe(200);
  });

  it("POST /api/tasks/:id/merge-marker ставит «влито»", async () => {
    const sha = git(live, "rev-parse", "main");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/merge-marker`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { merged: true, merged_into_commit: sha, merged_into_branch: "main" },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json();
    expect(state.merged).toBe(true);
    expect(state.merged_into_commit).toBe(sha);
    expect(state.merged_into_branch).toBe("main");
  });

  it("merge-marker требует merged_into_commit; без него 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/merge-marker`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { merged: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("merge-marker доступен только владельцу", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/merge-marker`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { merged: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /api/admin/role-branches возвращает список веток и копий", async () => {
    // Перед проверкой — заново создадим ветку для нашей taskId (после
    // afterEach её могли удалить), чтобы она попала в список вместе
    // с уже поставленным «merged=true».
    git(live, "branch", `roles/${taskId}`, "main");
    // Сделаем свежую ветку, чтобы попала в список.
    git(live, "branch", "roles/mak70-list-demo", "main");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/role-branches",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live_repo).toBe(live);
    expect(body.worktrees_base).toBe(base);
    const branch = body.branches.find((b: { task_id: string }) => b.task_id === "mak70-list-demo");
    expect(branch).toBeDefined();
    expect(branch.branch).toBe("roles/mak70-list-demo");
    // По нашей taskId влитие уже стоит — отдаст merged=true.
    const merged = body.branches.find((b: { task_id: string }) => b.task_id === taskId);
    expect(merged).toBeDefined();
    expect(merged.merged).toBe(true);
  });

  it("GET /api/tasks/:id/merge-state возвращает текущее состояние", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/merge-state`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json();
    expect(state.merged).toBe(true);
  });
});
