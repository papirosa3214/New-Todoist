// Готовность эмбеддингов для поиска по базе знаний.
// Модель может быть загружена и при этом не готова: видеокарта занята
// другой работой, и запрос встанет в очередь.
import { execFile } from "node:child_process";
import { DEFAULT_EMBEDDING_MODEL, OLLAMA_BASE_URL } from "./embeddingClient.js";

export type EmbedReadiness = {
  state: "ready" | "busy" | "down";
  model: string;
  loaded: boolean;
  gpu_util: number | null;
  label: string;
};

const norm = (name: string) => name.replace(/:latest$/, "");

/** Порог, после которого поиск по базе заметно ждёт видеокарту. */
export const EMBED_BUSY_GPU = 70;

export function classifyEmbedReadiness(input: {
  model: string;
  reachable: boolean;
  loaded: string[];
  gpuUtil: number | null;
}): EmbedReadiness {
  const loaded = input.reachable && input.loaded.some((name) => norm(name) === norm(input.model));
  const gpu = input.gpuUtil;
  if (!input.reachable) {
    return { state: "down", model: input.model, loaded: false, gpu_util: gpu, label: "Эмбеддинги не отвечают" };
  }
  if (!loaded) {
    return { state: "down", model: input.model, loaded: false, gpu_util: gpu, label: "Эмбеддинги не загружены" };
  }
  if (gpu !== null && gpu >= EMBED_BUSY_GPU) {
    return { state: "busy", model: input.model, loaded: true, gpu_util: gpu, label: "Эмбеддинги заняты — поиск подождёт" };
  }
  return { state: "ready", model: input.model, loaded: true, gpu_util: gpu, label: "Эмбеддинги готовы" };
}

function gpuUtil(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 1500 },
      (error, stdout) => {
        if (error) return resolve(null);
        const value = Number(String(stdout).split("\n")[0]?.trim());
        resolve(Number.isFinite(value) ? value : null);
      },
    );
  });
}

/** Живой снимок: Ollama держит модель эмбеддингов, видеокарта не забита. */
export async function readEmbedReadiness(): Promise<EmbedReadiness> {
  const model = DEFAULT_EMBEDDING_MODEL;
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return classifyEmbedReadiness({ model, reachable: false, loaded: [], gpuUtil: null });
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    const loaded = (body.models ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
    return classifyEmbedReadiness({ model, reachable: true, loaded, gpuUtil: await gpuUtil() });
  } catch {
    return classifyEmbedReadiness({ model, reachable: false, loaded: [], gpuUtil: null });
  }
}
