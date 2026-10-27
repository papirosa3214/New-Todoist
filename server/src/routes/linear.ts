import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner, getProjectForFiling } from "../access.js";
import { listLinearIssues, listLinearProjects, fetchLinearSnapshot } from "../lib/linearSource.js";
import { createLinearPreview, commitLinearPreview } from "../lib/linearImport.js";
import { linearAutoImportState, setLinearAutoImportEnabled, runLinearAutoImportPass } from "../lib/linearAutoImport.js";
import { linearSyncHealth, setLinearSyncEnabled, runLinearSyncPass } from "../lib/linearSync.js";
import { LinearSourceError } from "../runtime/linearTransport.js";
import { broadcastTaskEvent } from "../ws.js";
import { getTaskRow, hydrateTask } from "./tasks.js";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function registerLinearRoutes(app: FastifyInstance) {
  const ownerOnly = async (req: any, reply: any) => {
    await authOrApiToken(req, reply);
    if (!reply.sent && !isOwner(req.userId)) reply.code(403).send({ error: "Импорт Linear доступен владельцу" });
  };
  const jobs = new Map<string, { owner: string; created: number; status: string; preview?: any; error?: string }>();
  function cleanupJobs() { for (const [id, job] of jobs) if (Date.now() - job.created > 15 * 60_000) jobs.delete(id); }
  app.get("/api/integrations/linear/previews/:id", { preHandler: ownerOnly }, async (req: any, reply) => {
    cleanupJobs();
    const job = jobs.get(req.params.id);
    if (!job || job.owner !== req.userId) return reply.code(404).send({ error: "Загрузка прервалась или устарела. Повторите предварительный просмотр." });
    return { job_id: req.params.id, status: job.status, preview: job.preview ?? null, error: job.error ?? null };
  });
  const failure = (reply: any, error: unknown) => reply.code(error instanceof LinearSourceError ? error.status : 500).send({ error: error instanceof LinearSourceError ? error.message : "Импорт Linear не завершён. Изменения не записаны." });
  app.get("/api/integrations/linear/issues", { preHandler: ownerOnly }, async (req: any, reply) => {
    const cursor = req.query.cursor ?? null;
    if (cursor !== null && (typeof cursor !== "string" || cursor.length > 1000)) return reply.code(422).send({ error: "Некорректная страница Linear" });
    const project = req.query.project_id ?? null;
    if (project !== null && (typeof project !== "string" || !UUID.test(project))) return reply.code(422).send({ error: "Некорректный проект Linear" });
    try { return await listLinearIssues(req.userId, cursor, undefined, project); } catch (error) { return failure(reply, error); }
  });
  // Проекты Linear — выбрать, откуда забирать задачи в ручном импорте.
  app.get("/api/integrations/linear/projects", { preHandler: ownerOnly }, async (req: any, reply) => {
    try {
      const { workspace, projects } = await listLinearProjects(req.userId);
      return { workspace, projects: projects.map(p => ({ id: p.id, name: p.name, state: p.state })) };
    } catch (error) { return failure(reply, error); }
  });
  app.post("/api/integrations/linear/preview", { preHandler: ownerOnly }, async (req: any, reply) => {
    const ids = req.body?.issue_ids, project = req.body?.project_id ?? null;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every(id => typeof id === "string" && UUID.test(id)) || (project !== null && typeof project !== "string")) return reply.code(422).send({ error: "Выберите от 1 до 50 задач Linear" });
    if (project && !getProjectForFiling(project, req.userId, null)) return reply.code(404).send({ error: "Проект назначения недоступен" });
    const selected = [...new Set<string>(ids)];
    if (req.body?.async === true) {
      cleanupJobs();
      if ([...jobs.values()].filter(j => j.owner === req.userId && j.status === "loading").length >= 2) return reply.code(429).send({ error: "Уже загружаются две структуры Linear. Дождитесь завершения." });
      const id = crypto.randomUUID(), job = { owner: req.userId, created: Date.now(), status: "loading" } as { owner: string; created: number; status: string; preview?: any; error?: string };
      jobs.set(id, job);
      void fetchLinearSnapshot(req.userId, selected).then(source => {
        job.preview = createLinearPreview(req.userId, source, project); job.status = "ready";
      }).catch(error => { job.error = error instanceof LinearSourceError ? error.message : "Не удалось подготовить структуру Linear. Карточки не записаны."; job.status = "failed"; });
      return reply.code(202).send({ job_id: id, status: "loading" });
    }
    try { return createLinearPreview(req.userId, await fetchLinearSnapshot(req.userId, selected), project); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/integrations/linear/import", { preHandler: ownerOnly }, async (req: any, reply) => {
    const id = req.body?.preview_id;
    if (typeof id !== "string" || !UUID.test(id)) return reply.code(422).send({ error: "Нужен предварительный просмотр" });
    try {
      const result = commitLinearPreview(req.userId, id);
      for (const item of result.task_ids) {
        const task = getTaskRow(item.task_id);
        if (task) broadcastTaskEvent([req.userId], { type: "task:updated", task: hydrateTask(task) });
      }
      return result;
    } catch (error) { return failure(reply, error); }
  });

  // Автоимпорт (карточка cc7caa43…): состояние службы и выключатель.
  // Только владелец; служба сама ходит раз в 5 минут в процессе сервера.
  app.get("/api/integrations/linear/autoimport", { preHandler: ownerOnly }, async (req: any) => {
    const state = linearAutoImportState(req.userId);
    return {
      enabled: state.enabled === 1,
      last_attempt_at: state.last_attempt_at,
      last_success_at: state.last_success_at,
      last_error: state.last_error,
      last_error_at: state.last_error_at,
      created_total: state.created_total,
      updated_total: state.updated_total,
    };
  });
  app.patch("/api/integrations/linear/autoimport", { preHandler: ownerOnly }, async (req: any, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(422).send({ error: "Нужно поле enabled (boolean)" });
    const state = setLinearAutoImportEnabled(req.userId, req.body.enabled);
    return { enabled: state.enabled === 1 };
  });
  // Ручной внеочередной проход — владельцу для проверки, той же службой.
  app.post("/api/integrations/linear/autoimport/run", { preHandler: ownerOnly }, async (req: any, reply) => {
    try { return await runLinearAutoImportPass(req.userId); } catch (error) { return failure(reply, error); }
  });

  // Обратная синхронизация TaskFlow → Linear (карточка 20e30338): состояние
  // очереди записи и выключатель. Пишутся только привязанные задачи.
  app.get("/api/integrations/linear/sync", { preHandler: ownerOnly }, async (req: any) => linearSyncHealth(req.userId));
  app.patch("/api/integrations/linear/sync", { preHandler: ownerOnly }, async (req: any, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(422).send({ error: "Нужно поле enabled (boolean)" });
    setLinearSyncEnabled(req.userId, req.body.enabled);
    return linearSyncHealth(req.userId);
  });
  // Ручной внеочередной проход синхронизации — владельцу, без ожидания таймера.
  app.post("/api/integrations/linear/sync/run", { preHandler: ownerOnly }, async (req: any, reply) => {
    try { return await runLinearSyncPass(req.userId, { retryFailed: true }); } catch (error) { return failure(reply, error); }
  });
}
