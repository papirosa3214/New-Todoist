// POST /api/tasks/:id/retry — подтверждение retry агентом после stop с
// reason_code='insufficient_capability' (спек 1.2, раздел 4.2). Сервер уже
// предложил `next_attempt_template` в ответе на /stop; агент присылает этот
// шаблон сюда вместе со своим attempt_id, и сервер атомарно:
//
//   1. Закрывает старый attempt с outcome='needs_escalation' (перезаписывая
//      outcome из stop'а, который был 'escalate_capability' — спека 1.2.3,
//      subtask 2: «закрыть старый attempt с outcome=needs_escalation»).
//   2. Открывает новый attempt на присланной модели и том же runner.
//   3. Возвращает задачу обратно в `in_progress`, выставляет новый
//      current_attempt_id и свежий heartbeat.
//
// Валидации:
//   - attempt_id должен совпасть с последним attempt этой задачи (иначе
//     «attempt_id_mismatch», защита от replay старого шаблона поверх новой
//     попытки и от двойного retry на одном и том же attempt_id).
//   - Последний attempt должен быть закрыт с reason_code='insufficient_
//     capability' и ended_at != NULL. Для других reason_code лесенка не
//     работает (R1/R4 спека 1.2), retry не к чему.
//   - attempts_count < 3 — потолок лесенки (R1). attempts_count >= 3
//     возвращает 400 без retry (владелец решает).
//   - Шаблон из тела должен совпасть с серверным next_attempt_template
//     (модель + runner) — агенту нельзя «улучшить» лесенку по своему
//     усмотрению, иначе теряется аудит attempt_policies.
//
// Все операции в одной транзакции (db.transaction) — если что-то упадёт
// посередине, старый attempt не получит лишний outcome, а новый не появится
// в «подвисшем» состоянии.
//
// Лесенка читается через `lib/attemptLadder.ts` — общий источник правды
// для /api/agent/attempt-policies и расчёта next_attempt_template в /stop
// (routes/agent-state.ts). Порядок ступеней — рекурсивный CTE по
// attempt_policies, не сортировка по id (id строк — порядок вставки
// миграции, а не лесенка).
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForWrite } from "../access.js";
import { broadcastTaskEvent } from "../ws.js";
import { getTaskRow, hydrateTask } from "./tasks.js";
import { logEvent } from "../agentState.js";
import { nextStep, nextAttemptTemplate } from "../lib/attemptLadder.js";

const MAX_LADDER_STEPS = 3;

export function registerRetryRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.post<{
    Params: { id: string };
    Body: {
      attempt_id: string;
      template: { model: string; runner?: string | null };
    };
  }>("/api/tasks/:id/retry", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const body = req.body ?? {};
      const attemptId =
        typeof body.attempt_id === "string" ? body.attempt_id : "";
      const template = body.template;
      if (
        !attemptId ||
        !template ||
        typeof template.model !== "string" ||
        template.model.length === 0
      ) {
        return reply.code(400).send({
          error:
            "body должен содержать attempt_id и template.model — что вернул /stop в next_attempt_template",
        });
      }

      // После /stop current_attempt_id уже сброшен, поэтому берём последнюю
      // начатую попытку. SQLite datetime имеет точность до секунды: два быстрых
      // retry получают одинаковый started_at, и UUID нельзя применять как
      // временной tie-breaker. rowid сохраняет порядок вставки при равных датах.
      const lastAttempt = db
        .prepare(
          `SELECT id, model, runner, reason_code, ended_at, outcome
             FROM attempts
            WHERE task_id = ?
            ORDER BY started_at DESC, rowid DESC
            LIMIT 1`,
        )
        .get(task.id) as
        | {
            id: string;
            model: string | null;
            runner: string | null;
            reason_code: string | null;
            ended_at: string | null;
            outcome: string | null;
          }
        | undefined;
      if (!lastAttempt) {
        return reply.code(400).send({
          error: "у задачи нет ни одной попытки — retry не к чему",
        });
      }

      // attempt_id_mismatch: либо присланный id не совпадает с последним
      // attempt'ом (чужой/устаревший), либо последняя попытка ещё жива
      // (нечего переоткрывать). Оба варианта — replay'и и атаки на старый
      // шаблон.
      if (lastAttempt.id !== attemptId) {
        return reply.code(400).send({
          error: `attempt_id_mismatch: ожидается ${lastAttempt.id}, прислан ${attemptId}`,
        });
      }
      if (!lastAttempt.ended_at) {
        return reply.code(400).send({
          error: `попытка ${attemptId} ещё активна — retry применим только к закрытой попытке`,
        });
      }
      if (lastAttempt.reason_code !== "insufficient_capability") {
        return reply.code(400).send({
          error:
            `последняя попытка закрыта с reason_code='${lastAttempt.reason_code ?? "null"}'; ` +
            "retry применим только после reason_code='insufficient_capability'",
        });
      }

      const attemptsCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?")
          .get(task.id) as { n: number }
      ).n;
      if (attemptsCount >= MAX_LADDER_STEPS) {
        return reply.code(400).send({
          error:
            `потолок лесенки: ${attemptsCount} попыток (max ${MAX_LADDER_STEPS}); ` +
            "retry не предлагается — решает владелец",
        });
      }

      // Серверный next_attempt_template — расчёт через общий
      // attemptLadder.ts (тот же, что и /api/agent/attempt-policies, и
      // /api/tasks/:id/stop). Если модель не входит в лесенку или лесенка
      // исчерпана — retry не предлагается.
      const nextModel = nextStep(
        "insufficient_capability",
        lastAttempt.model ?? "",
      );
      if (!nextModel) {
        return reply.code(400).send({
          error:
            `не удалось вычислить следующую ступень для модели '${lastAttempt.model ?? ""}'; ` +
            "retry не предлагается — задача уйдёт владельцу",
        });
      }
      const serverTemplate = {
        model: nextModel,
        runner: lastAttempt.runner ?? null,
      };
      const reqRunner = template.runner ?? null;
      if (
        serverTemplate.model !== template.model ||
        serverTemplate.runner !== reqRunner
      ) {
        return reply.code(400).send({
          error:
            `template_mismatch: сервер предлагает ${JSON.stringify(serverTemplate)}, ` +
            `прислан ${JSON.stringify({ model: template.model, runner: reqRunner })}`,
        });
      }

      const newAttemptId = crypto.randomUUID();
      const txn = db.transaction(() => {
        // Старый attempt — outcome='needs_escalation' (спека 1.2.3, subtask 2).
        // Stop уже закрыл его с outcome='escalate_capability' (см.
        // stopReasons.ts → STOP_REASON_POLICIES.insufficient_capability).
        // Перезаписываем outcome в retry: needs_escalation — это финальное
        // состояние attempt'а с точки зрения ретрая, тогда как
        // escalate_capability — это policy-метка от stop'а.
        db.prepare(
          `UPDATE attempts
              SET outcome = 'needs_escalation'
            WHERE id = ? AND ended_at IS NOT NULL`,
        ).run(attemptId);

        db.prepare(
          `INSERT INTO attempts
             (id, task_id, executor_id, runner, model,
              started_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        ).run(
          newAttemptId,
          task.id,
          req.userId,
          serverTemplate.runner,
          serverTemplate.model,
        );

        db.prepare(
          `UPDATE tasks
              SET agent_state = 'in_progress',
                  agent_heartbeat_at = datetime('now'),
                  current_attempt_id = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(newAttemptId, task.id);

        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "field_changed",
          field: "current_attempt_id",
          fromValue: attemptId,
          toValue: newAttemptId,
        });
        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "field_changed",
          field: "agent_state",
          fromValue: task.agent_state ?? null,
          toValue: "in_progress",
        });
      });
      txn();

      const updated = getTaskRow(task.id);
      const hydrated = hydrateTask(updated);
      broadcastTaskEvent([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });

      return {
        task: hydrated,
        attempt_id: newAttemptId,
        model: serverTemplate.model,
        runner: serverTemplate.runner,
      };
    },
  });
}
