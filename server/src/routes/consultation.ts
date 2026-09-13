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

      const history = db
        .prepare(
          `SELECT id, model, runner, started_at, ended_at, outcome, reason_code, reason
             FROM attempts WHERE task_id = ? ORDER BY started_at ASC, id ASC`,
        )
        .all(task.id) as Array<{
        id: string;
        model: string | null;
        runner: string | null;
        started_at: string;
        ended_at: string | null;
        outcome: string | null;
        reason_code: string | null;
        reason: string | null;
      }>;

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
        agent_context: body.context ?? null,
        question,
      };

      const systemPrompt = [
        "Ты — старший консультант, к которому агент обращается за вторым мнением в рамках своей попытки.",
        "Отвечай конкретно, по существу заданного вопроса. Не пересказывай историю попыток — она уже дана в контексте.",
        "Если вопрос требует указать на конкретный файл/строку/действие — укажи. Если предлагаешь план — короткими шагами.",
      ].join("\n");
      const userPrompt = JSON.stringify(contextPayload, null, 2);

      const route = resolveConsultant(consultantModel);

      const consultationId = crypto.randomUUID();
      const startedAt = Date.now();
      let answer = "";
      let errorMsg: string | null = null;
      try {
        answer = await callUnifiedAi({
          systemPrompt,
          userPrompt,
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
      // отказов провайдера. answer может быть пустым, error — в
      // triggered_by с префиксом "error:" для удобства grep'а по логам.
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

      // Инкрементируем счётчик ТОЛЬКО при успешном вызове — иначе
      // повторная попытка после отказа провайдера застрянет на
      // limit_exceeded, хотя реальной консультации не было.
      if (!errorMsg) {
        db.prepare(
          `UPDATE attempts
              SET consultation_count = COALESCE(consultation_count, 0) + 1
            WHERE id = ?`,
        ).run(attempt.id);
      }

      if (errorMsg) {
        return reply.code(502).send({
          error: `consultant model error: ${errorMsg}`,
          consultation_id: consultationId,
          duration_ms: durationMs,
          consultation_count: used,
        });
      }

      return {
        consultation_id: consultationId,
        answer,
        duration_ms: durationMs,
        model: consultantModel,
        consultation_count: used + 1,
      };
    },
  });
}
