// Спек 1.2, задача 1.2.6: семантический матчинг как второй уровень обогащения.
// Используется в routes/enrichment.ts (POST /api/tasks/:id/enrich) после
// детерминированного enricher'а — когда тот не смог уверенно подобрать
// профиль. Гейт активации: доля pending-эскалаций за 30 дней > порога
// (по умолчанию 0.3, конфигурируется через SEMANTIC_GATE_THRESHOLD).

import db from "../db.js";
import { getEmbeddings } from "../lib/embeddingClient.js";

export const SEMANTIC_GATE_THRESHOLD = (() => {
  const raw = process.env.SEMANTIC_GATE_THRESHOLD;
  const parsed = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.3;
})();

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
  return new Float32Array(
    row.embedding.buffer,
    row.embedding.byteOffset,
    row.embedding.byteLength / 4,
  );
}

export type SemanticRoleMatch = {
  role: string;
  score: number;
  tags: string[];
};

export type SemanticEnrichResult = {
  matched: SemanticRoleMatch[];
  escalation_rate: number;
  gate_open: boolean;
  threshold: number;
  duration_ms: number;
};

/**
 * Ядро подбора: топ-K ролей по косинусу для ПРОИЗВОЛЬНОГО текста, без гейта
 * эскалаций и без привязки к конкретной задаче — `semanticEnrich` ниже это
 * же самое, только с гейтом и текстом, взятым из задачи. Вынесено 30.09.2026
 * для подбора роли по тексту ОДНОЙ подзадачи (умная параллелизация —
 * `subtaskRoleFanout.ts`), где гейт эскалаций не имеет смысла: подзадача не
 * эскалирует сама по себе, решение принимает не пользователь по кнопке.
 */
export async function matchRoleForText(
  text: string,
  opts: { topK?: number } = {},
): Promise<{ matched: SemanticRoleMatch[]; duration_ms: number }> {
  const startedAt = Date.now();
  const trimmed = text.trim();
  if (!trimmed) return { matched: [], duration_ms: Date.now() - startedAt };

  const rows = db
    .prepare("SELECT role, embedding, tags FROM role_embeddings")
    .all() as RoleEmbeddingRow[];
  if (rows.length === 0) return { matched: [], duration_ms: Date.now() - startedAt };

  const { embeddings, dim } = await getEmbeddings(trimmed);
  if (!Array.isArray(embeddings) || dim === 0) return { matched: [], duration_ms: Date.now() - startedAt };
  const queryF32 = new Float32Array(embeddings as number[]);

  const scored: SemanticRoleMatch[] = rows.map((row) => ({
    role: row.role,
    score: cosine(queryF32, rowToVector(row)),
    tags: parseTags(row.tags),
  }));
  scored.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

  return { matched: scored.slice(0, opts.topK ?? 3), duration_ms: Date.now() - startedAt };
}

/**
 * Доля pending-эскалаций за последние `windowDays` дней. Если эскалаций
 * нет вообще — возвращаем 0 (gate_open станет false, fallback на enricher).
 */
export function getEscalationRate(windowDays = 30): number {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM enrichment_escalations
       WHERE created_at >= datetime('now', ?)`,
    )
    .get(`-${windowDays} days`) as
    { total: number; pending: number | null } | undefined;
  const total = Number(row?.total ?? 0);
  if (total === 0) return 0;
  const pending = Number(row?.pending ?? 0);
  return pending / total;
}

/**
 * Семантический матчинг задачи на роли. Использует role_embeddings
 * (заполняются scripts/seed-role-embeddings.ts) и getEmbeddings.
 *
 * Возвращает top-K ролей, отсортированных по cosine. plus метрики
 * гейта — нужны для логирования решения «использовать / fallback».
 */
export async function semanticEnrich(
  taskId: string,
  opts: {
    topK?: number;
    windowDays?: number;
    /**
     * Пропустить гейт эскалаций и считать матчинг всегда.
     *
     * Гейт задумывался для обогащения по кнопке: там сначала отвечает
     * детерминированный enricher, и тратиться на эмбеддинги имеет смысл,
     * только когда он часто промахивается. Для выбора РОЛИ у диспетчера
     * такой развилки нет: enricher подбирает старые личности
     * (claude_bot, hermes, …), а не восемь канонических ролей, и другого
     * источника роли, кроме этого матчинга, не существует. С закрытым
     * гейтом — а он закрыт, пока эскалаций нет вовсе — диспетчер получал
     * бы пустой ответ и вечно ставил дефолт.
     */
    ignoreGate?: boolean;
  } = {},
): Promise<SemanticEnrichResult> {
  const startedAt = Date.now();
  const task = db
    .prepare("SELECT id, title, description FROM tasks WHERE id = ?")
    .get(taskId) as
    | { id: string; title: string | null; description: string | null }
    | undefined;
  if (!task) {
    return {
      matched: [],
      escalation_rate: 0,
      gate_open: false,
      threshold: SEMANTIC_GATE_THRESHOLD,
      duration_ms: Date.now() - startedAt,
    };
  }

  const escalationRate = getEscalationRate(opts.windowDays ?? 30);
  const gateOpen = opts.ignoreGate || escalationRate > SEMANTIC_GATE_THRESHOLD;
  if (!gateOpen) {
    return {
      matched: [],
      escalation_rate: escalationRate,
      gate_open: false,
      threshold: SEMANTIC_GATE_THRESHOLD,
      duration_ms: Date.now() - startedAt,
    };
  }

  const text = `${task.title ?? ""}\n${task.description ?? ""}`.trim();
  const { matched } = await matchRoleForText(text, { topK: opts.topK });
  return {
    matched,
    escalation_rate: escalationRate,
    gate_open: true,
    threshold: SEMANTIC_GATE_THRESHOLD,
    duration_ms: Date.now() - startedAt,
  };
}
