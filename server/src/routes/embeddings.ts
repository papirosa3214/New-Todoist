// POST /api/embeddings — обёртка над Ollama /api/embeddings (спек 1.2,
// 1.2.5). Один текст или батч — возвращает 1024-dim вектор от bge-m3-embed.
//
// Тело: { input: string | string[], model?: string }
// Ответ: { embedding: number[] | number[][], model, dim, duration_ms }
//
// Ошибки:
//   400 — пустой input, не строка, батч > лимита
//   502 — Ollama вернула ошибку / неожиданный формат
//   504 — таймаут
//
// Модель и провайдер задаются в embeddingClient.ts (через env OLLAMA_BASE_URL,
// EMBEDDING_MODEL, EMBEDDING_TIMEOUT_MS, EMBEDDING_MAX_BATCH). Дефолт —
// `bge-m3-embed:latest` на .110:11434, 30 секунд таймаут, 16 текстов в батче.
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import {
  EmbeddingError,
  getEmbeddings,
  DEFAULT_EMBEDDING_MODEL,
} from "../lib/embeddingClient.js";

export function registerEmbeddingsRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.post<{
    Body: {
      input: string | string[];
      model?: string;
    };
  }>("/api/embeddings", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const body = req.body ?? {};
      const input = body.input;
      const model =
        typeof body.model === "string" && body.model.trim().length > 0
          ? body.model.trim()
          : DEFAULT_EMBEDDING_MODEL;

      if (typeof input !== "string" && !Array.isArray(input)) {
        return reply.code(400).send({
          error: "input должен быть строкой или массивом строк",
        });
      }
      if (typeof input === "string" && input.length === 0) {
        return reply.code(400).send({ error: "input не должен быть пустым" });
      }
      if (Array.isArray(input)) {
        if (input.length === 0) {
          return reply.code(400).send({ error: "input[] не должен быть пустым" });
        }
        if (input.some((s) => typeof s !== "string")) {
          return reply
            .code(400)
            .send({ error: "input[] должен содержать только строки" });
        }
      }

      try {
        const { embeddings, dim, durationMs } = await getEmbeddings(input, { model });
        return {
          embedding: embeddings,
          model,
          dim,
          duration_ms: durationMs,
        };
      } catch (e) {
        if (e instanceof EmbeddingError) {
          return reply.code(e.status).send({ error: e.message });
        }
        return reply.code(502).send({
          error: `embedding failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
  });
}
