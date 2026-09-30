// POST /api/tasks/:id/consultation — консультация B+ (спек 1.2, раздел 3.2).
//
// Агент в рамках одной попытки чувствует неуверенность и хочет второе
// мнение от более думающей модели. Сервер собирает вокруг запроса
// полный контекст (задача + attempts.history + текущее состояние +
// контекст от агента), вызывает модель-консультанта через существующую
// инфраструктуру (callUnifiedAi), логирует в consultation_log и
// возвращает ответ агенту.
//
// Лимит R6: одна консультация на попытку (attempts.consultation_count).
// Проверяется ДО вызова модели, инкремент — после (чтобы failed
// консультация не съедала лимит; спека требует строгий лимит 1 на
// "удачную" консультацию — лог фиксирует и неудачные тоже, для аудита).
//
// consultant_model принимается в коротких алиасах (opus/sonnet/haiku)
// или как явное имя провайдера — маппинг через CONSULTANT_MODEL_MAP.
// Если алиас незнакомый, отдаём в claude как есть: модель может
// оказаться в DSH_MODEL_ALIASES у trigger.py и вернуться через
// провайдерский fallback внутри callUnifiedAi.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForWrite } from "../access.js";
import { callUnifiedAi } from "./ai.js";
import {
  CONSULTATION_REASONS,
  recordConsultationSuggestion,
  getConsultationSuggestionReasons,
} from "../lib/consultationTriggers.js";

const MAX_QUESTION_LENGTH = 4000;
const MAX_CONTEXT_BYTES = 64 * 1024;

// Короткие алиасы → пары для callUnifiedAi. Совпадает по смыслу с
// ANTIGRAVITY_MODEL_ALIASES в trigger.py (там длинные имена) и с
// дефолтами callUnifiedAi.
const CONSULTANT_MODEL_MAP: Record<
  string,
  { provider: string; aiModel?: string; localModel?: string }
> = {
  opus: { provider: "claude", aiModel: "claude-opus-4-6-thinking" },
  sonnet: { provider: "claude", aiModel: "claude-sonnet-4-6" },
  haiku: { provider: "local", localModel: "qwen3.6-27b-iq4-16k:latest" },
};

function resolveConsultant(
  name: string,
): { provider: string; aiModel?: string; localModel?: string } {
  const key = name.toLowerCase();
  if (CONSULTANT_MODEL_MAP[key]) return CONSULTANT_MODEL_MAP[key];
  // Не алиас — передаём как явное имя модели провайдеру claude;
  // если её там нет, отработает fallback на локальную Ollama внутри
  // callUnifiedAi.
  return { provider: "claude", aiModel: name };
}

type ConsultTask = { id: string; title: string; description?: string | null; status: string; assignee_id?: string | null };
type ConsultAttempt = { id: string; consultation_count: number; model: string | null; runner: string | null };

/** Вызов консультанта с полным контекстом задачи и попыток + журнал.
 *  Общее для POST /api/tasks/:id/consultation и POST /api/consult. */
export async function performConsultation(args: {
  task: ConsultTask;
  attempt: ConsultAttempt;
  consultantModel: string;
  question: string;
  agentContext: unknown;
  triggeredBy: string;
}): Promise<
  | { ok: true; success: { consultation_id: string; answer: string; duration_ms: number; model: string; consultation_count: number } }
  | { ok: false; failure: { error: string; consultation_id: string; duration_ms: number; consultation_count: number } }
> {
  const { task, attempt, consultantModel, question, triggeredBy } = args;
  const used = attempt.consultation_count;
  const history = db
    .prepare(
      `SELECT id, model, runner, started_at, ended_at, outcome, reason_code, reason
         FROM attempts WHERE task_id = ? ORDER BY started_at ASC, id ASC`,
    )
    .all(task.id);

  const contextPayload = {
    task: {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      status: task.status,
      assignee_id: task.assignee_id ?? null,
    },
    current_attempt: {
      id: attempt.id,
      model: attempt.model,
      runner: attempt.runner,
      consultation_count: used,
    },
    attempts_history: history,
    agent_context: args.agentContext ?? null,
    question,
  };

  const route = resolveConsultant(consultantModel);
  const consultationId = crypto.randomUUID();
  const startedAt = Date.now();
  let answer = "";
  let errorMsg: string | null = null;
  try {
    answer = await callUnifiedAi({
      systemPrompt: CONSULTANT_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(contextPayload, null, 2),
      provider: route.provider,
      aiModel: route.aiModel,
      localModel: route.localModel,
      temperature: 0.2,
      predictTokens: 1500,
    });
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - startedAt;

  // Логируем ВСЕГДА (включая неудачные), чтобы аудит видел причины
  // отказов провайдера.
  db.prepare(
    `INSERT INTO consultation_log
       (id, attempt_id, task_id, consultant_model, question, context_json,
        answer, duration_ms, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    consultationId,
    attempt.id,
    task.id,
    consultantModel,
    question,
    JSON.stringify(contextPayload),
    answer || null,
    durationMs,
    errorMsg ? `error:${triggeredBy}` : triggeredBy,
  );

  // Счётчик — только при успешном вызове: отказ провайдера не съедает лимит.
  if (!errorMsg) {
    db.prepare(
      `UPDATE attempts SET consultation_count = COALESCE(consultation_count, 0) + 1 WHERE id = ?`,
    ).run(attempt.id);
    return {
      ok: true,
      success: { consultation_id: consultationId, answer, duration_ms: durationMs, model: consultantModel, consultation_count: used + 1 },
    };
  }
  return {
    ok: false,
    failure: { error: `consultant model error: ${errorMsg}`, consultation_id: consultationId, duration_ms: durationMs, consultation_count: used },
  };
}

/** Советы в чате (без задачи): отметки времени по роли, в памяти процесса. */
const chatConsults = new Map<string, number[]>();
const CHAT_CONSULTS_PER_HOUR = 3;

const CONSULTANT_SYSTEM_PROMPT = [
  "Ты — старший консультант, к которому агент обращается за вторым мнением в рамках своей попытки.",
  "Отвечай конкретно, по существу заданного вопроса. Не пересказывай историю попыток — она уже дана в контексте.",
  "Если вопрос требует указать на конкретный файл/строку/действие — укажи. Если предлагаешь план — короткими шагами.",
].join("\n");

export function registerConsultationRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.post<{
    Params: { id: string };
    Body: {
      attempt_id: string;
      consultant_model: string;
      question: string;
      context?: Record<string, unknown> | null;
      triggered_by?: string;
    };
  }>("/api/tasks/:id/consultation", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const body = req.body ?? {};
      const attemptId =
        typeof body.attempt_id === "string" ? body.attempt_id : "";
      const consultantModel =
        typeof body.consultant_model === "string"
          ? body.consultant_model.trim()
          : "";
      const question =
        typeof body.question === "string" ? body.question.trim() : "";
      const triggeredBy =
        typeof body.triggered_by === "string"
          ? body.triggered_by.trim()
          : "manual";

      if (!attemptId || !consultantModel || !question) {
        return reply.code(400).send({
          error:
            "attempt_id, consultant_model и question обязательны",
        });
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        return reply.code(400).send({
          error: `вопрос слишком длинный (${question.length} символов, предел ${MAX_QUESTION_LENGTH})`,
        });
      }
      if (body.context !== undefined && body.context !== null) {
        const ctxSize = JSON.stringify(body.context).length;
        if (ctxSize > MAX_CONTEXT_BYTES) {
          return reply.code(400).send({
            error: `context слишком большой (${ctxSize} байт, предел ${MAX_CONTEXT_BYTES})`,
          });
        }
      }

      const attempt = db
        .prepare(
          "SELECT id, consultation_count, model, runner FROM attempts WHERE id = ? AND task_id = ?",
        )
        .get(attemptId, task.id) as
        | {
            id: string;
            consultation_count: number | null;
            model: string | null;
            runner: string | null;
          }
        | undefined;

      if (!attempt) {
        return reply.code(400).send({
          error: `attempt_id_mismatch: у задачи ${task.id} нет попытки ${attemptId}`,
        });
      }

      // R6: лимит 1 на попытку. Инкрементируем ПОСЛЕ удачного вызова,
      // ниже — но проверяем счётчик ДО старта, чтобы повторный запрос
      // с тем же attempt_id сразу получил отказ.
      const used = attempt.consultation_count ?? 0;
      if (used >= 1) {
        return reply.code(400).send({
          error: `limit_exceeded: на попытке ${attemptId} уже ${used} консультаций; лимит 1 на попытку (спек 1.2 §3.2 R6)`,
        });
      }

      const result = await performConsultation({
        task,
        attempt: { ...attempt, consultation_count: used },
        consultantModel,
        question,
        agentContext: body.context ?? null,
        triggeredBy,
      });
      if (!result.ok) return reply.code(502).send(result.failure);
      return result.success;
    },
  });

  // POST /api/consult — «посоветоваться со старшей моделью» для роли
  // (владелец 01.10.2026: «как у тебя — когда нужно посовещаться с
  // вышестоящей моделью, такие же наработки дать моим агентам»). Роли не
  // нужно знать ни attempt_id, ни имя модели:
  //   • с task_id/subtask_id — сервер берёт её текущую попытку по задаче
  //     (шагу) и ведёт тот же журнал и лимит, что /tasks/:id/consultation;
  //   • без задачи (разговор в чате) — вопрос с присланным контекстом,
  //     не больше CHAT_CONSULTS_PER_HOUR в час на роль.
  // Модель консультанта — TASKFLOW_CONSULTANT_MODEL (по умолчанию opus).
  app.post<{
    Body: { question?: unknown; context?: unknown; task_id?: unknown; subtask_id?: unknown };
  }>("/api/consult", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const body = req.body ?? {};
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (!question) return reply.code(400).send({ error: "question обязателен: о чём нужен совет" });
      if (question.length > MAX_QUESTION_LENGTH) {
        return reply.code(400).send({ error: `вопрос слишком длинный (${question.length}, предел ${MAX_QUESTION_LENGTH})` });
      }
      if (body.context !== undefined && JSON.stringify(body.context).length > MAX_CONTEXT_BYTES) {
        return reply.code(400).send({ error: `context больше ${MAX_CONTEXT_BYTES} байт` });
      }
      const consultantModel = (process.env.TASKFLOW_CONSULTANT_MODEL || "opus").trim();

      let taskId = typeof body.task_id === "string" ? body.task_id : "";
      let attemptId: string | null = null;
      // Роль на шаге плана часто не исполнитель задачи целиком — совет по
      // СВОЕМУ шагу ей положен всё равно.
      let ownsStep = false;
      if (typeof body.subtask_id === "string" && body.subtask_id) {
        const step = db.prepare("SELECT task_id, current_attempt_id, agent_id FROM subtasks WHERE id = ?").get(body.subtask_id) as
          | { task_id: string; current_attempt_id: string | null; agent_id: string | null }
          | undefined;
        if (!step) return reply.code(404).send({ error: "шаг не найден" });
        taskId = step.task_id;
        attemptId = step.current_attempt_id;
        ownsStep = step.agent_id === req.userId;
      }

      if (taskId) {
        const task = getTaskForWrite(taskId, req.userId)
          ?? (ownsStep ? db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) : undefined);
        if (!task) return reply.code(404).send({ error: "Not found" });
        attemptId ??= (
          db.prepare(
            `SELECT id FROM attempts WHERE task_id = ? AND executor_id = ? AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1`,
          ).get(task.id, req.userId) as { id: string } | undefined
        )?.id ?? (task as { current_attempt_id?: string | null }).current_attempt_id ?? null;
        const attempt = attemptId
          ? (db.prepare("SELECT id, consultation_count, model, runner FROM attempts WHERE id = ? AND task_id = ?").get(attemptId, task.id) as
              | { id: string; consultation_count: number | null; model: string | null; runner: string | null }
              | undefined)
          : undefined;
        if (!attempt) return reply.code(409).send({ error: "у тебя нет идущей попытки по этой задаче — совет берут в работе" });
        const used = attempt.consultation_count ?? 0;
        if (used >= 1) {
          return reply.code(429).send({ error: "в этой попытке совет уже был — решай сам или спроси владельца" });
        }
        const result = await performConsultation({
          task,
          attempt: { ...attempt, consultation_count: used },
          consultantModel,
          question,
          agentContext: body.context ?? null,
          triggeredBy: "role_tool",
        });
        if (!result.ok) return reply.code(502).send(result.failure);
        return result.success;
      }

      // Разговор без задачи.
      const now = Date.now();
      const recent = (chatConsults.get(req.userId) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= CHAT_CONSULTS_PER_HOUR) {
        return reply.code(429).send({ error: `совет в чате — не больше ${CHAT_CONSULTS_PER_HOUR} раз в час` });
      }
      chatConsults.set(req.userId, [...recent, now]);
      const route = resolveConsultant(consultantModel);
      const startedAt = Date.now();
      try {
        const answer = await callUnifiedAi({
          systemPrompt: CONSULTANT_SYSTEM_PROMPT,
          userPrompt: JSON.stringify({ question, agent_context: body.context ?? null }, null, 2),
          provider: route.provider,
          aiModel: route.aiModel,
          localModel: route.localModel,
          temperature: 0.2,
          predictTokens: 1500,
        });
        return { answer, model: consultantModel, duration_ms: Date.now() - startedAt };
      } catch (e) {
        chatConsults.set(req.userId, recent);
        return reply.code(502).send({ error: `consultant model error: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
  });

  // POST /api/tasks/:id/attempts/:attempt_id/suggest-consultation — спек
  // 1.2, 1.2.7 (R7). trigger.py зовёт это после каждого действия агента,
  // если сработал авто-триггер («>2 правок в файле без тестов» или
  // «diff > 300 строк»). Сервер записывает причины в попытку и в ленту
  // задачи; агент видит их в context через GET /api/tasks/:id.
  //
  // Тело: { reasons: ["diff_size", "edits_no_tests"] } — допустимы только
  // коды из CONSULTATION_REASONS. Пустой массив = no-op (защита).
  app.post<{
    Params: { id: string; attempt_id: string };
    Body: { reasons?: unknown };
  }>("/api/tasks/:id/attempts/:attempt_id/suggest-consultation", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const body = req.body ?? {};
      const raw = body.reasons;
      if (raw !== undefined && !Array.isArray(raw)) {
        return reply.code(400).send({
          error: "reasons: ожидается массив строк",
        });
      }
      const incoming = (raw as unknown[] | undefined ?? []).filter(
        (v): v is string => typeof v === "string",
      );

      const result = recordConsultationSuggestion({
        taskId: req.params.id,
        attemptId: req.params.attempt_id,
        reasons: incoming,
        actorId: req.userId,
      });

      if (!result.attemptFound) {
        return reply.code(404).send({
          error: "попытка не найдена для этой задачи",
        });
      }

      return {
        reasons: result.reasons,
        added: result.added,
      };
    },
  });

  // GET /api/tasks/:id/attempts/:attempt_id/consultation-suggestion —
  // снимок пометки (для UI и тестов). Возвращает пустой массив, если
  // пометки нет. Это часть спек 1.2.7: агент может опросить состояние
  // пометки отдельно, не перечитывая всю задачу.
  app.get<{
    Params: { id: string; attempt_id: string };
  }>("/api/tasks/:id/attempts/:attempt_id/consultation-suggestion", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const reasons = getConsultationSuggestionReasons(
        req.params.id,
        req.params.attempt_id,
      );
      // Пустой массив — нормальный ответ (пометки нет). Отличать «попытки
      // нет» от «попытка есть, пометки нет» клиенту незачем: и так и так
      // список причин пуст, и для UI и тестов этого достаточно. 404
      // возвращаем только на POST — там операция записи и подмена
      // attempt_id имеет смысл как ошибка.
      return { reasons };
    },
  });
}
