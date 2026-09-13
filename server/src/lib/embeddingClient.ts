// Клиент к Ollama /api/embeddings (спек 1.2, 1.2.5). Обёртка с таймаутом
// и батч-лимитом — вынесена отдельно от роутера, чтобы тесты могли
// подменить её через vi.mock.
//
// Конфигурация через env:
//   OLLAMA_BASE_URL — дефолт http://192.168.1.110:11434
//   EMBEDDING_MODEL — дефолт bge-m3-embed:latest
//   EMBEDDING_TIMEOUT_MS — дефолт 30000
//   EMBEDDING_MAX_BATCH — дефолт 16
//
// На .110 уже поднят тег `bge-m3-embed:latest` (1.2 GB, 1024-dim, мультиязычный
// включая русский). До 04.08.2026 тег назывался `bge-m3-gpu`; конфигурация
// датасетов RAGFlow идёт через другое имя (`bge-m3-gpu@Ollama`) —
// специально оставлено, чтобы не ломать то, что на нём держится.

export const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL || "http://192.168.1.110:11434"
).replace(/\/+$/, "");

export const DEFAULT_EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "bge-m3-embed:latest";

export const EMBEDDING_TIMEOUT_MS = parseInt(
  process.env.EMBEDDING_TIMEOUT_MS || "30000",
  10,
);

export const EMBEDDING_MAX_BATCH = parseInt(
  process.env.EMBEDDING_MAX_BATCH || "16",
  10,
);

export class EmbeddingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export type EmbeddingResult = {
  embeddings: number[] | number[][];
  dim: number;
  durationMs: number;
};

async function fetchOne(
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<number[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EmbeddingError(
        502,
        `ollama returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new EmbeddingError(
        502,
        "ollama response missing embedding array",
      );
    }
    return data.embedding;
  } catch (e) {
    if (e instanceof EmbeddingError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new EmbeddingError(
        504,
        `embedding timeout after ${timeoutMs}ms (model=${model})`,
      );
    }
    throw new EmbeddingError(
      502,
      `embedding fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Получить эмбеддинги для одного текста или массива текстов через Ollama.
 * Батч обрабатывается последовательными запросами — у Ollama /api/embeddings
 * принимает по одному prompt, параллельные запросы с одним и тем же model
 * могут дать ему OOM на больших батчах. Лимит батча защищает от случайного
 * 10k-массива в одном HTTP-вызове.
 */
export async function getEmbeddings(
  input: string | string[],
  opts: {
    model?: string;
    timeoutMs?: number;
    maxBatch?: number;
  } = {},
): Promise<EmbeddingResult> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const timeoutMs = opts.timeoutMs ?? EMBEDDING_TIMEOUT_MS;
  const maxBatch = opts.maxBatch ?? EMBEDDING_MAX_BATCH;

  const inputs = Array.isArray(input) ? input : [input];
  if (inputs.length === 0) {
    throw new EmbeddingError(400, "input is empty");
  }
  if (inputs.length > maxBatch) {
    throw new EmbeddingError(
      400,
      `batch size ${inputs.length} exceeds limit ${maxBatch}`,
    );
  }

  const startedAt = Date.now();
  const out: number[][] = [];
  for (const prompt of inputs) {
    out.push(await fetchOne(prompt, model, timeoutMs));
  }
  const durationMs = Date.now() - startedAt;
  const dim = out[0]?.length ?? 0;

  return {
    embeddings: Array.isArray(input) ? out : out[0],
    dim,
    durationMs,
  };
}
