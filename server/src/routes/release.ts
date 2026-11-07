// POST /api/tasks/:id/release — исполнитель возвращает карточку как чужую.
// (taskflow-pipeline-head-plan.md, шаг 3)
//
// Что делает одной транзакцией:
//   - assignee              = null
//   - agent_state           = 'blocked'
//   - agent_heartbeat_at    = null
//   - agent_session_id      = null
//   - current_attempt_id    = null
//   - block_type            = 'wrong_role'
//   - machine_selected_role = null
//   - role_exclusions       = role_exclusions + <роль, которая вернула>
//   - blocked_reason        = reason
//   - blocked_at            = now()
//   - block_notified        = false
//   + запись в историю: кто вернул, причина, suggested_role (если был)
//
// Права: только текущий исполнитель карточки, своим ролевым ключом.
// Чужой ролевой ключ -> 403. Служебный ключ -> 403 (служба не отказывается
// за агента — release вызывает только тот, кто реально взял задачу).
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskRow } from "./tasks.js";
import { logEvent } from "../agentState.js";
import { isServiceUser } from "./agent-state.js";
import { ROLE_NAMES } from "../roleRouting.js";

export function registerReleaseRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.post<{
    Params: { id: string };
    Body: {
      reason: string;
      suggested_role?: string;
    };
  }>("/api/tasks/:id/release", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const { id } = req.params;
      const body = req.body || {};
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      const suggestedRole =
        typeof body.suggested_role === "string" ? body.suggested_role : "";

      if (!reason) {
        return reply.code(400).send({
          error:
            "reason обязателен: что мешает и какая роль, по-твоему, подходит",
        });
      }

      if (
        suggestedRole &&
        !(ROLE_NAMES as readonly string[]).includes(suggestedRole)
      ) {
        return reply.code(400).send({
          error: `suggested_role должен быть одной из ролей: ${ROLE_NAMES.join(", ")}`,
        });
      }

      const callerId = req.userId;
      if (!callerId) return reply.code(401).send({ error: "auth required" });

      // Служебный ключ не может отказаться за агента — release вызывает
      // только тот, кто реально взял задачу.
      if (isServiceUser(callerId)) {
        return reply.code(403).send({
          error:
            "служебный ключ не может вызвать release — это действие исполнителя",
        });
      }

      const task = getTaskRow(id);
      if (!task) return reply.code(404).send({ error: "Not found" });

      if (task.assignee_id !== callerId) {
        return reply.code(403).send({
          error:
            "release может вызвать только текущий исполнитель карточки",
        });
      }

      if (task.status !== "active") {
        return reply.code(400).send({
          error: "карточка не активна — release невозможен",
        });
      }

      // Роль, которая вернула карточку, добавляем в role_exclusions.
      // role_exclusions — TEXT с JSON-массивом строк (миграция 042).
      const currentRole =
        (task as any).dispatched_role ||
        (task as any).machine_selected_role ||
        null;

      let exclusions: string[] = [];
      try {
        const raw = (task as any).role_exclusions;
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            exclusions = arr.filter(
              (x): x is string => typeof x === "string",
            );
          }
        }
      } catch {
        exclusions = [];
      }
      if (currentRole && !exclusions.includes(currentRole)) {
        exclusions.push(currentRole);
      }

      const rejectionRef: { current: { code: number; error: string } | null } =
        { current: null };

      const txn = db.transaction(() => {
        const latest = getTaskRow(id);
        if (!latest) {
          rejectionRef.current = { code: 404, error: "Not found" };
          return;
        }
        if (latest.status !== "active") {
          rejectionRef.current = {
            code: 400,
            error: "карточка больше не активна — release невозможен",
          };
          return;
        }
        if (latest.assignee_id !== callerId) {
          rejectionRef.current = {
            code: 403,
            error:
              "гонка за release проиграна — карточку уже взял другой исполнитель",
          };
          return;
        }

        db.prepare(
          `UPDATE tasks SET
              assignee_id = NULL,
              agent_state = 'blocked',
              agent_heartbeat_at = NULL,
              agent_session_id = NULL,
              current_attempt_id = NULL,
              block_type = 'wrong_role',
              blocked_reason = ?,
              blocked_at = datetime('now'),
              block_notified = false,
              machine_selected_role = NULL,
              role_exclusions = ?,
              updated_at = datetime('now')
            WHERE id = ?`,
        ).run(reason, JSON.stringify(exclusions), id);

        logEvent({
          taskId: id,
          actorId: callerId,
          kind: "released",
          field: "assignee_id",
          fromValue: callerId,
          toValue: null,
        });
        logEvent({
          taskId: id,
          actorId: callerId,
          kind: "field_changed",
          field: "blocked_reason",
          toValue: reason,
        });
        logEvent({
          taskId: id,
          actorId: callerId,
          kind: "field_changed",
          field: "role_exclusions",
          toValue: JSON.stringify(exclusions),
        });
        if (suggestedRole) {
          logEvent({
            taskId: id,
            actorId: callerId,
            kind: "suggested_role",
            field: "suggested_role",
            toValue: suggestedRole,
          });
        }
      });
      txn();

      if (rejectionRef.current) {
        return reply
          .code(rejectionRef.current.code)
          .send({ error: rejectionRef.current.error });
      }

      return { ok: true, role_exclusions: exclusions };
    },
  });
}
