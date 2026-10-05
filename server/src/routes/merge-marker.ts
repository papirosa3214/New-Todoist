// MAK-70: ручка «влито» + список веток/копий на решение владельца.
//
// Три эндпоинта:
//
//   POST /api/tasks/:id/merge-marker   — владелец отмечает «влито» (ветка
//                                       roles/<id> влита в main) и/или
//                                       «ветка убрана», «копия убрана».
//                                       Запрещено агенту: только владелец
//                                       принимает решение о вливании.
//
//   GET  /api/tasks/:id/merge-state    — текущее состояние признака
//                                       «влито»/уборки (для карточки и
//                                       для админ-ленты).
//
//   GET  /api/admin/role-branches      — список ВСЕХ веток roles/* + всех
//                                       рабочих копий. Используется
//                                       владельцем, чтобы решить, что
//                                       влить, а что удалить. Один раз
//                                       пришёл — увидел, что́ оседает на
//                                       диске и в git; дальше владелец
//                                       командует по конкретным id.
//
// Все три доступны только владельцу: и влитие, и уборка — его
// единоличное решение, агенты в эти ручки не лезут (владелец 04.10.2026:
// «ветки и копии удаляются только по списку, одобренному владельцем»).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { liveServerRepo } from "../runtime/roleWorkspace.js";
import { logEvent } from "../agentState.js";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

function worktreesBase(): string {
  return (
    process.env.TASKFLOW_ROLE_WORKTREES ||
    path.join(os.homedir(), ".local", "state", "taskflow-runs", "worktrees")
  );
}

interface MergeState {
  merged: boolean;
  merged_at: string | null;
  merged_into_commit: string | null;
  merged_into_branch: string | null;
  merged_by: string | null;
  branch_cleared: boolean;
  branch_cleared_at: string | null;
  workspace_cleared: boolean;
  workspace_cleared_at: string | null;
  // Из git/диска — для подсказки владельцу. Если ветки уже нет на
  // диске, а признак не выставлен — наоборот, «по факту убрана».
  branch_exists: boolean;
  workspace_exists: boolean;
}

function loadMergeState(taskId: string): MergeState {
  const row = db
    .prepare(
      "SELECT merged_at, merged_into_commit, merged_into_branch, merged_by, " +
        "branch_cleared_at, workspace_cleared_at FROM tasks WHERE id = ?",
    )
    .get(taskId) as
    | {
        merged_at: string | null;
        merged_into_commit: string | null;
        merged_into_branch: string | null;
        merged_by: string | null;
        branch_cleared_at: string | null;
        workspace_cleared_at: string | null;
      }
    | undefined;
  if (!row) {
    // Задачи нет — отдаём «пустое» состояние, фильтрация будет снаружи.
    return {
      merged: false,
      merged_at: null,
      merged_into_commit: null,
      merged_into_branch: null,
      merged_by: null,
      branch_cleared: false,
      branch_cleared_at: null,
      workspace_cleared: false,
      workspace_cleared_at: null,
      branch_exists: false,
      workspace_exists: false,
    };
  }
  const live = process.env.MAK70_LIVE_REPO || liveServerRepo();
  const branchExists = git(live, ["rev-parse", "--verify", "--quiet", `refs/heads/roles/${taskId}`]) !== null;
  const workspacePath = path.join(worktreesBase(), taskId);
  const workspaceExists = fs.existsSync(path.join(workspacePath, ".git"));
  return {
    merged: Boolean(row.merged_at),
    merged_at: row.merged_at,
    merged_into_commit: row.merged_into_commit,
    merged_into_branch: row.merged_into_branch,
    merged_by: row.merged_by,
    branch_cleared: Boolean(row.branch_cleared_at),
    branch_cleared_at: row.branch_cleared_at,
    workspace_cleared: Boolean(row.workspace_cleared_at),
    workspace_cleared_at: row.workspace_cleared_at,
    branch_exists: branchExists,
    workspace_exists: workspaceExists,
  };
}

export function registerMergeMarkerRoutes(app: FastifyInstance): void {
  const ownerOnly = { preHandler: authOrApiToken };

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/merge-state",
    ownerOnly,
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
      if (!task) return reply.code(404).send({ error: "Not found" });
      return loadMergeState(req.params.id);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      merged?: boolean;
      merged_into_commit?: string;
      merged_into_branch?: string;
      branch_cleared?: boolean;
      workspace_cleared?: boolean;
    };
  }>("/api/tasks/:id/merge-marker", ownerOnly, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
    const task = db.prepare("SELECT id, merged_at FROM tasks WHERE id = ?").get(req.params.id) as
      | { id: string; merged_at: string | null }
      | undefined;
    if (!task) return reply.code(404).send({ error: "Not found" });

    const body = req.body ?? {};
    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.merged === true) {
      // Принимаем «влито» с явным коммитом и целевой веткой; без них
      // отметка ничего не стоит (владелец не сможет потом найти, куда
      // влито). SHA берётся из владельческого `git rev-parse`, ветка —
      // обычно main.
      const commit = typeof body.merged_into_commit === "string" ? body.merged_into_commit.trim() : "";
      const into = typeof body.merged_into_branch === "string" ? body.merged_into_branch.trim() : "main";
      if (!commit) {
        return reply.code(400).send({
          error: "merged_into_commit обязателен: SHA, на который влито",
        });
      }
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
        return reply.code(400).send({
          error: "merged_into_commit должен выглядеть как SHA (7-64 hex)",
        });
      }
      fields.push("merged_at = datetime('now')");
      values.push(commit);
      fields.push("merged_into_commit = ?");
      values.push(into);
      fields.push("merged_into_branch = ?");
      fields.push("merged_by = ?");
      values.push(req.userId);
    } else if (body.merged === false) {
      // Снять «влито» — нужно, если владелец ошибся и хочет вернуть
      // карточку в активное состояние (например, чтобы QA ещё раз
      // прошёл). Раньше такой ручки не было: ошибочное «влито» оставалось
      // навсегда и путало в карточке.
      fields.push("merged_at = NULL");
      fields.push("merged_into_commit = NULL");
      fields.push("merged_into_branch = NULL");
      fields.push("merged_by = NULL");
    }

    if (body.branch_cleared === true) {
      fields.push("branch_cleared_at = datetime('now')");
    } else if (body.branch_cleared === false) {
      fields.push("branch_cleared_at = NULL");
    }
    if (body.workspace_cleared === true) {
      fields.push("workspace_cleared_at = datetime('now')");
    } else if (body.workspace_cleared === false) {
      fields.push("workspace_cleared_at = NULL");
    }

    if (!fields.length) {
      return reply.code(400).send({
        error: "ничего не передано: ожидаются merged / branch_cleared / workspace_cleared (true|false)",
      });
    }

    values.push(req.params.id);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    logEvent({
      taskId: req.params.id,
      actorId: req.userId,
      kind: "merge_marker_changed",
      field: "merged_at",
      toValue: String(body.merged ?? ""),
    });
    return loadMergeState(req.params.id);
  });

  app.get("/api/admin/role-branches", ownerOnly, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
    const live = process.env.MAK70_LIVE_REPO || liveServerRepo();
    const branchesRaw = git(live, ["for-each-ref", "--format=%(refname:short)", "refs/heads/roles/"]) || "";
    const branches = branchesRaw.split("\n").filter(Boolean).map((ref) => {
      const taskId = ref.replace(/^roles\//, "");
      const tip = git(live, ["rev-parse", "--short", `refs/heads/${ref}`]);
      const subjectRaw = git(live, ["log", "-1", "--format=%s", `refs/heads/${ref}`]);
      const aheadRaw = git(live, ["rev-list", "--count", `main..${ref}`]);
      const state = loadMergeState(taskId);
      return {
        task_id: taskId,
        branch: ref,
        tip: tip ?? null,
        subject: subjectRaw ?? null,
        ahead_main: aheadRaw ? Number(aheadRaw) || 0 : 0,
        ...state,
      };
    });

    const base = worktreesBase();
    const workspaces: Array<{ task_id: string; path: string; has_git: boolean }> = [];
    if (fs.existsSync(base)) {
      for (const entry of fs.readdirSync(base)) {
        const full = path.join(base, entry);
        if (!fs.statSync(full).isDirectory()) continue;
        const hasGit = fs.existsSync(path.join(full, ".git"));
        workspaces.push({ task_id: entry, path: full, has_git: hasGit });
      }
    }
    // Подтянем состояние по каждой копии (если там есть задача в БД —
    // будет видно «влито»/«не влито»).
    const workspacesWithState = workspaces.map((ws) => ({ ...ws, ...loadMergeState(ws.task_id) }));

    return {
      live_repo: live,
      worktrees_base: base,
      branches,
      workspaces: workspacesWithState,
    };
  });
}
