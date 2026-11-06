// Локальные модели на видеокарте .110 (решение владельца 06.11.2026): постоянно живут
// ровно две — qwen3-8b-observer (фоновая работа) и bge-m3-embed (эмбеддинги). 27B-модели
// только разово по поручению. Ключ keep_alive=-1 в запросах к ним не даёт Ollama их выгрузить.
export const LOCAL_DEFAULT_MODEL = "qwen3-8b-observer:latest";
export const LOCAL_EMBED_MODEL = "bge-m3-embed:latest";
export const KEEP_ALIVE_FOREVER = -1;
const RESIDENT = new Set([LOCAL_DEFAULT_MODEL, LOCAL_EMBED_MODEL]);
const base = (m: string) => m.replace(/:latest$/, "");
/** Модель из постоянной пары — keep_alive=-1; чужим моделям (разовые 27B) срок не навязываем. */
export function isResidentModel(model: string): boolean {
  return [...RESIDENT].some((r) => base(r) === base(model));
}
export function keepAliveFor(model: string): { keep_alive?: number } {
  return isResidentModel(model) ? { keep_alive: KEEP_ALIVE_FOREVER } : {};
}
