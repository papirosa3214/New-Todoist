// Хостовые операции роли входят в общий каталог taskflow во всех режимах.
// Push остаётся привязан к ветке roles/<task_id>; attach — к активному слоту.
import path from "node:path";
import { Type } from "typebox";
import { runOperation } from "../host/gateway.js";
import { getTaskForRead } from "../access.js";
import { resolveRoleHost } from "./roleHost.js";
import { hostRepoPath, roleBranch } from "./roleWorkspace.js";
import { roleUserId } from "../roleRouting.js";
import type { Tool } from "./universalTaskflow.js";
import db from "../db.js";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", md: "text/markdown", txt: "text/plain", json: "application/json", mov: "video/quicktime", mp4: "video/mp4",
};
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
type Context = { role: string; taskId?: string; subtaskId?: string };

function taskForRole(context: Context, requestedTaskId?: string, requestedSubtaskId?: string) {
  const taskId = requestedTaskId || context.taskId;
  if (!taskId) throw new Error("Не указан task_id. Укажи ID задачи, где ты работаешь и назначен на неё, затем повтори вызов");
  if (context.taskId && context.taskId !== taskId) throw new Error("Указан другой task_id. Убери его и повтори вызов для текущей задачи");
  const subtaskId = requestedSubtaskId || context.subtaskId;
  if (context.subtaskId && subtaskId !== context.subtaskId) throw new Error("Указан другой subtask_id. Убери его и повтори вызов для своего текущего слота");
  const userId = roleUserId(context.role);
  const task = getTaskForRead(taskId, userId) as any;
  if (!task) throw new Error("Задача не найдена или недоступна этой роли. Проверь task_id; если ID верный, попроси владельца проверить доступ");
  const ownStep = db.prepare(
    "SELECT id FROM subtasks WHERE task_id=? AND agent_id=? AND done=0 AND (? IS NULL OR id=?) LIMIT 1",
  ).get(taskId, userId, subtaskId ?? null, subtaskId ?? null) as { id: string } | undefined;
  const assigned = task.dispatched_role === context.role || task.assignee_id === userId ||
    task.creator_id === userId || Boolean(ownStep);
  if (!assigned) throw new Error("Эта роль не назначена на задачу. Попроси владельца или оркестратора назначить тебя, затем повтори вызов");
  return { taskId, subtaskId, task, userId, ownStep };
}

function hostForTask(context: Context, taskId: string, subtaskId?: string) {
  const machineId = resolveRoleHost(taskId, subtaskId, context.role);
  if (!machineId) throw new Error("Для проекта задачи не настроен host. Попроси владельца подключить host к проекту и повтори вызов");
  const repo = hostRepoPath(taskId, machineId);
  if (!repo) throw new Error("На host не задан путь к репозиторию этого проекта. Попроси владельца настроить путь проекта и повтори вызов");
  return { machineId, repo };
}

export function createHostRoleTools(role: string, taskId?: string, subtaskId?: string): Tool[] {
  const context = { role, taskId, subtaskId };
  const taskFields = {
    task_id: Type.Optional(Type.String({ description: "ID задачи; в рабочем ходе можно опустить" })),
    subtask_id: Type.Optional(Type.String({ description: "ID своего активного слота, если у слотов разные машины" })),
  };
  return [
    {
      name: "taskflow_host_push",
      description:
        "Отправить ветку roles/<task_id> этой задачи в Gitea и origin через host. " +
        "Работает только для задачи, назначенной этой роли; произвольные ветки не отправляет. " +
        "В обычном чате передай task_id карточки, где ты назначен. Если назначения нет, попроси владельца или оркестратора назначить тебя.",
      parameters: Type.Object(taskFields),
      execute: async (_id: string, p: { task_id?: string; subtask_id?: string }) => {
        const target = taskForRole(context, p.task_id, p.subtask_id);
        const { machineId, repo } = hostForTask(context, target.taskId, target.subtaskId);
        const out: string[] = [];
        for (const remote of ["gitea", "origin"]) {
          const r = (await runOperation(machineId, "git_push", {
            repo, taskId: target.taskId, branch: roleBranch(target.taskId), remote,
          })) as any;
          out.push(r?.ok ? remote + ": отправлено" : remote + ": не отправлено — " + String(r?.error ?? "host не вернул причину") + ". Проверь подключение host и доступ к репозиторию; если повторится, передай владельцу эту ошибку");
        }
        return text(roleBranch(target.taskId) + "\n" + out.join("\n"));
      },
    },
    {
      name: "taskflow_host_attach",
      description:
        "Приложить файл из рабочей копии host к задаче. Требует активный слот этой роли. " +
        "В рабочем вызове ID подставятся автоматически; в чате укажи task_id карточки, subtask_id своего активного слота и абсолютный path. Если слота нет, попроси владельца или оркестратора назначить тебя.",
      parameters: Type.Object({
        ...taskFields,
        path: Type.String({ description: "Абсолютный путь файла в рабочей копии на host" }),
        name: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, p: { task_id?: string; subtask_id?: string; path: string; name?: string }) => {
        const target = taskForRole(context, p.task_id, p.subtask_id);
        if (!target.subtaskId || !target.ownStep) throw new Error("Файл можно приложить только из активного слота этой роли. Укажи свой subtask_id; если активного слота нет, попроси владельца или оркестратора назначить тебя на шаг");
        const { machineId } = hostForTask(context, target.taskId, target.subtaskId);
        const r = (await runOperation(machineId, "read", { path: p.path, encoding: "base64" })) as any;
        if (!r?.ok) throw new Error("Host не смог прочитать файл " + p.path + ": " + String(r?.error ?? "причина не возвращена") + ". Проверь абсолютный путь и подключение host; если повторится, передай владельцу эту ошибку");
        const body = Buffer.from(String(r.data?.content ?? ""), "base64");
        const filename = role + ": " + (p.name || path.basename(p.path));
        const mime = MIME[filename.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
        const { appRef } = await import("./inProcessRun.js");
        const app = appRef();
        if (!app) throw new Error("Сервер пока не готов принять вложение. Повтори вызов; если ошибка сохранится, передай владельцу");
        const token = app.jwt.sign({ id: roleUserId("code_orchestrator") }, { expiresIn: "5m" });
        const res = await app.inject({
          method: "POST",
          url: "/api/tasks/" + encodeURIComponent(target.taskId) + "/attachments?kind=task&name=" + encodeURIComponent(filename),
          headers: { authorization: "Bearer " + token, "content-type": mime },
          payload: body,
        });
        if (res.statusCode >= 300) throw new Error("Сервер не принял вложение (" + res.statusCode + "): " + res.body.slice(0, 200) + ". Если причина непонятна, передай владельцу этот текст.");
        return text("Приложено к карточке: " + filename + " (" + body.length + " байт)");
      },
    },
  ];
}
