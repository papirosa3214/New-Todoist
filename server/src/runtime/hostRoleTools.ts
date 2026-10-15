// Инструменты роли, работающей на машине через хост (16.10.2026).
//
// Под песочницей роль не может ни отправить свою ветку (нет учётных данных
// git, домашний каталог закрыт), ни приложить кадры к карточке (файлы на
// маке, вложения — на .110). Обе вещи делает сервер операциями хоста, вне
// песочницы: git_push только ветки этой карточки, read — байтами.
import path from "node:path";
import { Type } from "typebox";
import { runOperation } from "../host/gateway.js";
import { hostRepoPath, roleBranch } from "./roleWorkspace.js";
import { roleUserId } from "../roleRouting.js";
import { appRef } from "./inProcessRun.js";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", md: "text/markdown", txt: "text/plain", json: "application/json", mov: "video/quicktime", mp4: "video/mp4",
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export function createHostRoleTools(machineId: string, taskId: string, role: string): any[] {
  const repo = hostRepoPath(taskId, machineId);
  return [
    {
      name: "taskflow_host_push",
      label: "Мак · отправить ветку",
      description:
        "Отправить СВОЮ ветку этой карточки (roles/<карточка>) в общий репозиторий (gitea и GitHub). " +
        "git push из песочницы не работает — делай коммит, потом зови этот инструмент. Другие ветки не отправляет.",
      parameters: Type.Object({}),
      execute: async () => {
        if (!repo) throw new Error("для этой машины не заведён репозиторий проекта");
        const out: string[] = [];
        for (const remote of ["gitea", "origin"]) {
          const r = (await runOperation(machineId, "git_push", { repo, taskId, branch: roleBranch(taskId), remote })) as any;
          out.push(r?.ok ? `${remote}: отправлено` : `${remote}: ошибка — ${String(r?.error ?? "без текста")}`);
        }
        return text(`${roleBranch(taskId)}\n${out.join("\n")}`);
      },
    },
    {
      name: "taskflow_host_attach",
      label: "Мак · приложить файл к карточке",
      description:
        "Приложить файл с мака (кадр, отчёт, видео до 2,9 МБ) к карточке задачи — он появится во вложениях " +
        "и будет виден владельцу и другим ролям. path — абсолютный путь в рабочей копии на маке.",
      parameters: Type.Object({ path: Type.String(), name: Type.Optional(Type.String()) }),
      execute: async (_id: string, p: { path: string; name?: string }) => {
        const r = (await runOperation(machineId, "read", { path: p.path, encoding: "base64" })) as any;
        if (!r?.ok) throw new Error(`не прочитал ${p.path}: ${String(r?.error ?? "без текста")}`);
        const body = Buffer.from(String(r.data?.content ?? ""), "base64");
        const name = p.name || path.basename(p.path);
        const mime = MIME[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
        const app = appRef();
        if (!app) throw new Error("сервер ещё не поднят");
        const token = app.jwt.sign({ id: roleUserId(role) }, { expiresIn: "5m" });
        const res = await app.inject({
          method: "POST",
          url: `/api/tasks/${encodeURIComponent(taskId)}/attachments?kind=task&name=${encodeURIComponent(name)}`,
          headers: { authorization: `Bearer ${token}`, "content-type": mime },
          payload: body,
        });
        if (res.statusCode >= 300) throw new Error(`вложение не принято (${res.statusCode}): ${res.body.slice(0, 200)}`);
        return text(`приложено к карточке: ${name} (${body.length} байт)`);
      },
    },
  ];
}
