// Разовый запрос к обычной модели ролей (MiniMax-M3 и её цепочка) через тот же ModelRuntime, что
// и у ролей, — без локальной Ollama. Нужен фоновым помощникам вроде подготовки плана (владелец
// 07.10.2026: «убери локальную модель, поставь наш MiniMax, чтобы быстро»). Модель берётся из
// цепочки роли «аналитик» с учётом лимитов, то есть при лимите MiniMax сам уйдёт на запасную.
import { loadRoleRouting } from "../roleRouting.js";
import { parseModelRef } from "./attemptModel.js";

const TIMEOUT_MS = 90_000;

export async function callRuntimeModel(opts: { systemPrompt: string; userPrompt: string; maxTokens?: number }): Promise<string> {
  const { getModelRuntime } = await import("../runtime/PiRuntimeAdapter.js");
  const { pickStartModel } = await import("../runtime/providerFailover.js");
  const ref = pickStartModel(loadRoleRouting(), "analyst");
  const { provider, id } = parseModelRef(ref);
  const rt: any = await getModelRuntime();
  const model = rt.getModel?.(provider, id) ?? ((await rt.getAvailable?.()) ?? []).find((m: any) => m.id === id);
  if (!model) throw new Error(`Модель ${ref} недоступна в рантайме.`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const answer = await rt.completeSimple(
      model,
      { systemPrompt: opts.systemPrompt, messages: [{ role: "user", content: opts.userPrompt, timestamp: Date.now() }] },
      { maxTokens: opts.maxTokens ?? 4096, signal: ac.signal },
    );
    if (answer?.stopReason === "error") throw new Error(String(answer.errorMessage ?? "Модель ответила ошибкой."));
    const text = (answer?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("").trim();
    if (!text) throw new Error("Модель вернула пустой ответ.");
    return text;
  } finally {
    clearTimeout(timer);
  }
}
