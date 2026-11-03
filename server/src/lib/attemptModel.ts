// MAK-77: модель и провайдер роли пишутся в попытку запуска, а запись вида
// «провайдер/модель» разбирается в одном месте.
import db from "../db.js";
import { providerOfModel } from "../roleRouting.js";

/** Провайдеры, которые Pi-рантайм знает под этими именами (префикс записи `провайдер/модель`). */
export const KNOWN_MODEL_PROVIDERS = [
  "opencode-go",
  "opencode",
  "minimax",
  "anthropic",
  "openai-codex",
  "openai",
  "kimi-coding",
  "ollama",
  "xai",
] as const;

export type ModelRef = { provider: string; id: string };

/**
 * Разбор записи модели. `opencode-go/qwen3.8-flash` → провайдер `opencode-go`,
 * модель `qwen3.8-flash`. Запись без известного префикса работает по-старому:
 * провайдера определяет `providerOfModel` (для всего чужого — `minimax`).
 */
export function parseModelRef(ref: string): ModelRef {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1);
    if (rest && (KNOWN_MODEL_PROVIDERS as readonly string[]).includes(prefix)) {
      return { provider: prefix, id: rest };
    }
  }
  return { provider: providerOfModel(trimmed), id: trimmed };
}

/**
 * Записывает модель и провайдера в текущую открытую попытку: у шага — по
 * `subtasks.current_attempt_id`, у задачи без шага — по `tasks.current_attempt_id`.
 * Уже записанную модель не перезаписывает. Возвращает число обновлённых строк.
 */
export function recordAttemptModel(params: {
  taskId: string;
  subtaskId?: string | null;
  modelId: string;
  provider: string;
}): number {
  const row = params.subtaskId
    ? (db.prepare("SELECT current_attempt_id AS id FROM subtasks WHERE id = ?").get(params.subtaskId) as { id: string | null } | undefined)
    : (db.prepare("SELECT current_attempt_id AS id FROM tasks WHERE id = ?").get(params.taskId) as { id: string | null } | undefined);
  if (!row?.id) return 0;
  return db
    .prepare(
      `UPDATE attempts SET model = ?, provider = ?
        WHERE id = ? AND ended_at IS NULL AND (model IS NULL OR model = '')`,
    )
    .run(params.modelId, params.provider, row.id).changes;
}

/** Модель роли в рантайме Pi по записи из routing. Запись «провайдер/модель»
 *  разбирается: в каталоге id без приставки (владелец 27.10.2026 — обсуждение
 *  карточки и беседа шага искали по полной записи и всегда получали
 *  «модель недоступна»). */
export async function findRuntimeModel(runtime: any, ref: string | undefined): Promise<any> {
  if (!ref) return undefined;
  const { provider, id } = parseModelRef(ref);
  return runtime?.getModel?.(provider, id) ??
    ((await runtime?.getAvailable?.()) ?? []).find((m: any) => m.id === id && (!m.provider || m.provider === provider));
}
