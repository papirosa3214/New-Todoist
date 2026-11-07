// /api/runs/:runId/tools — операции запуска внешнего агента для MCP-моста
// (scripts/run-mcp-bridge.mjs). Доступ — только по пропуску участника, которому
// этот запуск выдан; чужой или закрытый запуск отвечает 404.
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { callRunTool, mcpToolOf, runToolsFor } from "../runtime/runToolRegistry.js";

export function registerRunToolsRoutes(app: FastifyInstance): void {
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/tools", { preHandler: authOrApiToken }, async (req, reply) => {
    const tools = runToolsFor(req.params.runId, (req as any).userId);
    if (!tools) return reply.code(404).send({ error: "запуск не найден" });
    return { tools: tools.map(mcpToolOf) };
  });

  app.post<{ Params: { runId: string; name: string }; Body: { arguments?: Record<string, unknown> } }>(
    "/api/runs/:runId/tools/:name",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      const tools = runToolsFor(req.params.runId, (req as any).userId);
      if (!tools) return reply.code(404).send({ error: "запуск не найден" });
      const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
      return callRunTool(tools, req.params.runId, req.params.name, args);
    },
  );
}
