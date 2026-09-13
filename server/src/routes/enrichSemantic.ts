// POST /api/tasks/:id/enrich-semantic — двухступенчатый семантический
// матчинг задачи на роль (спек 1.2, 1.2.6).
//
// Ступени:
//   1. Грубый фильтр (опционально, через body.tags): роли, у которых
//      есть хотя бы один общий тег с задачей. Если body.tags не задан —
//      пропускаем все 8 ролей.
//   2. Тонкий фильтр: cosine similarity между Query-эмбеддингом задачи
//      (title + description через bge-m3) и Key-эмбеддингом каждой
//      роли. Возвращаем top-K с самым высоким score.
//
// Контракт endpoint'а:
//   body: { tags?: string[], top_k?: number }
//   ответ: { matched: [{ role, score, tags }], top_k, duration_ms, dim }
//
// Гейт активации (включать ли этот шаг вообще в pipeline обогащения)
// вычисляется на стороне /api/tasks/:id/enrich (см. routes/enrichment.ts
// — там условие «доля эскалаций > порога»). Этот endpoint просто
// отдаёт результат матчинга, его можно вызвать напрямую для проверки.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead } from "../access.js";
import { getEmbeddings } from "../lib/embeddingClient.js";

const DEFAULT_TOP_K = 3;

type RoleEmbeddingRow = {
  role: string;
  embedding: Buffer;
  tags: string | null;
};

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function rowToVector(row: RoleEmbeddingRow): Float32Array {
  // Buffer хранится как little-endian float32; новый Float32Array с
  // тем же underlying ArrayBuffer отдаст корректное представление.
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

export function registerEnrichSemanticRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.post<{
    Params: { id: string };
    Body: { tags?: string[]; top_k?: number };
  }>("/api/tasks/:id/enrich-semantic", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const body = req.body ?? {};
      const taskTags: string[] = Array.isArray(body.tags)
        ? body.tags.filter((t: unknown) => typeof t === "string")
        : [];
      const topK = Math.max(
        1,
        Math.min(
          8,
          typeof body.top_k === "number" && Number.isFinite(body.top_k)
            ? Math.floor(body.top_k)
            : DEFAULT_TOP_K,
        ),
      );

      const startedAt = Date.now();
      const text = `${task.title ?? ""}\n${task.description ?? ""}`.trim();
      if (!text) {
        return reply.code(400).send({
          error: "у задачи пустые title и description — нечего векторизовать",
        });
      }

      // Ступень 1: грубый фильтр по тегам (если заданы).
      // Ступень 2: cosine по эмбеддингам.
      const rows = db
        .prepare(
          "SELECT role, embedding, tags FROM role_embeddings",
        )
        .all() as RoleEmbeddingRow[];

      let candidates: RoleEmbeddingRow[];
      if (taskTags.length > 0) {
        const tagSet = new Set(taskTags.map((t) => t.toLowerCase()));
        candidates = rows.filter((r) => {
          const rTags = parseTags(r.tags).map((t) => t.toLowerCase());
          return rTags.some((t) => tagSet.has(t));
        });
        if (candidates.length === 0) {
          // Ничего не прошло грубый фильтр — возвращаем пустой результат
          // без вызова модели (дешевле, и на таком входе матчинг всё равно
          // не поможет).
          return {
            matched: [],
            top_k: topK,
            duration_ms: Date.now() - startedAt,
            dim: 0,
            filter: { tags: taskTags, kept: 0 },
          };
        }
      } else {
        candidates = rows;
      }

      // Запрос вектора для задачи. Роли уже векторизованы (см.
      // scripts/seed-role-embeddings.ts).
      const { embeddings, dim } = await getEmbeddings(text);
      if (!Array.isArray(embeddings) || dim === 0) {
        return reply
          .code(502)
          .send({ error: "embedding service returned empty result" });
      }
      const queryVec = embeddings as number[];
      if (queryVec.length !== dim) {
        return reply.code(502).send({
          error: `embedding dim mismatch: query=${queryVec.length}, expected=${dim}`,
        });
      }
      const queryF32 = new Float32Array(queryVec);

      const scored = candidates.map((row) => {
        const rowVec = rowToVector(row);
        return {
          role: row.role,
          score: cosine(queryF32, rowVec),
          tags: parseTags(row.tags),
        };
      });
      scored.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

      return {
        matched: scored.slice(0, topK),
        top_k: topK,
        duration_ms: Date.now() - startedAt,
        dim,
        filter: { tags: taskTags, kept: candidates.length },
      };
    },
  });
}
