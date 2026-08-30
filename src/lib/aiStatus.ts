// Статус серверной модели — той, что крутится в Ollama на .110.
//
// Телефон до Ollama не дотягивается: она слушает на своей машине, а
// приложение знает только адрес сервера TaskFlow. Поэтому спрашиваем сервер,
// он проверяет и отдаёт готовый ответ (GET /api/ai/status).
import { api } from "../api/client";

export interface ServerAIStatus {
  online: boolean;
  model: string;
  host: string;
  /** Модель из конфига могли удалить с сервера — тогда «работает» врёт. */
  installed?: boolean;
}

export async function fetchServerAIStatus(): Promise<ServerAIStatus | null> {
  try {
    return await api.get<ServerAIStatus>("/api/ai/status");
  } catch {
    // Раздел просто покажет «нет связи» — падать из-за статуса нельзя.
    return null;
  }
}

/**
 * Человеческое имя серверной модели: из `qwen3.6-27b-iq4-16k:latest` делаем
 * «Qwen 3.6 · 27B». В интерфейсе не место тегам и квантованию — они нужны
 * только тому, кто эту модель ставит на сервере.
 */
export function serverModelName(raw: string): string {
  if (!raw) return "Неизвестная модель";
  const base = raw.split(":")[0];
  const size = base.match(/(\d+)b\b/i);
  const family = /qwen/i.test(base)
    ? "Qwen"
    : /llama/i.test(base)
      ? "Llama"
      : /deepseek/i.test(base)
        ? "DeepSeek"
        : /hermes/i.test(base)
          ? "Hermes"
          : base.split(/[-_.]/)[0];
  const version = base.match(/(\d+\.\d+)/);
  const parts = [family];
  if (version) parts.push(version[1]);
  const name = parts.join(" ");
  return size ? `${name} · ${size[1]}B` : name;
}
