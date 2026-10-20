// Учёт вызовов инструментов ролями: сводка и выгрузка (карточка
// 64af4c85-93ed-4926-bd78-5cdfaf6a9ba5).
//
//   GET /api/role-tool-audit/summary — сколько вызовов, сколько ошибок и
//     доля ошибок в разрезах роли, модели, операции и кода ошибки.
//   GET /api/role-tool-audit/export  — сырые записи об отказах: JSON или CSV.
//
// Данные лежат в `role_tool_audit` (отказы подробно) и
// `role_tool_audit_counters` (счётчики вызовов по часу) — см.
// `server/src/runtime/toolAuditStore.ts`. Значения аргументов в записях
// нет: только путь поля и тип ошибки.
//
// Доступ — тот же, что у `/api/tasks` и `/api/coordination/*`
// (`authOrApiToken`): владелец, оркестратор и агенты своего токена.

import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import {
  toolAuditCsv,
  toolAuditPeriod,
  toolAuditRecords,
  toolAuditSummary,
  type ToolAuditFilters,
} from "../runtime/toolAuditStore.js";

type Query = {
  from?: string;
  to?: string;
  role?: string;
  model?: string;
  operation?: string;
  code?: string;
  task_id?: string;
  subtask_id?: string;
  format?: string;
  limit?: string;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function filtersOf(query: Query): ToolAuditFilters {
  return {
    from: text(query?.from),
    to: text(query?.to),
    role: text(query?.role),
    model: text(query?.model),
    operation: text(query?.operation),
    code: text(query?.code),
    taskId: text(query?.task_id),
    subtaskId: text(query?.subtask_id),
  };
}

export function registerRoleToolAuditRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  // 1. Сводка за период.
  app.get<{ Querystring: Query }>(
    "/api/role-tool-audit/summary",
    { preHandler: authPre },
    async (req) => {
      const filters = filtersOf(req.query ?? {});
      return toolAuditSummary(filters);
    },
  );

  // 2. Выгрузка сырых записей: JSON (по умолчанию) или CSV.
  app.get<{ Querystring: Query }>(
    "/api/role-tool-audit/export",
    { preHandler: authPre },
    async (req, reply) => {
      const filters = filtersOf(req.query ?? {});
      const period = toolAuditPeriod(filters);
      const limit = Number(req.query?.limit ?? 1000);
      const records = toolAuditRecords(filters, Number.isFinite(limit) ? limit : 1000);
      const format = (req.query?.format ?? "json").toLowerCase();
      if (format === "csv") {
        const stamp = period.to.replace(/[:.]/g, "-");
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="role-tool-audit-${stamp}.csv"`,
          )
          .send(toolAuditCsv(records));
      }
      if (format !== "json")
        return reply
          .code(400)
          .send({ error: "unsupported_format", hint: "format: json или csv" });
      return {
        period: { from: period.from, to: period.to },
        count: records.length,
        records,
      };
    },
  );
}
