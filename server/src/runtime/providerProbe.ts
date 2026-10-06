// Возврат на основную модель по ФАКТУ сброса лимита — только для случая «упёрлись сразу при
// старте» (владелец 07.10.2026): остаток до сброса неизвестен, поэтому раз в несколько минут к
// такому провайдеру (provider_limits.mode = 'probe') уходит крошечный запрос. Ответил без ошибки
// лимита — метка снимается и новые запуски снова берут основную модель. Ответил лимитом — метка
// остаётся; пять часов по таймеру — страховка, если проба недоступна. Провайдеры, которые до
// лимита работали (mode = 'timer'), не прощупываются: у них возврат через 5 ч 5 мин.
import db from "../db.js";
import { loadRoleRouting, type RoleRouting } from "../roleRouting.js";
import { parseModelRef } from "../lib/attemptModel.js";
import { isProviderLimitText } from "./providerFailover.js";
import { getFailoverSettings } from "../lib/failoverSettings.js";

export type ProbeResult = "ok" | "limited" | "unknown";
export type ProbeFn = (modelRef: string) => Promise<ProbeResult>;

const PROBE_INTERVAL_MS = Number(process.env.PROVIDER_PROBE_INTERVAL_MS) || 5 * 60_000;
const PROBE_FIRST_DELAY_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Провайдеры в режиме probe, у которых метка ещё не истекла. */
function limitedProviders(): string[] {
  return (
    db
      .prepare(
        "SELECT provider FROM provider_limits WHERE mode = 'probe' AND unavailable_until IS NOT NULL AND unavailable_until > datetime('now')",
      )
      .all() as { provider: string }[]
  ).map((r) => r.provider);
}

/** Любая модель этого провайдера из цепочек ролей — на ней и пробуем. */
export function modelForProvider(routing: RoleRouting, provider: string): string | null {
  const refs = new Set<string>();
  for (const m of Object.values(routing.models ?? {})) if (m) refs.add(m as string);
  for (const list of Object.values(routing.fallbacks ?? {})) for (const m of (list as string[]) ?? []) refs.add(m);
  for (const ref of refs) if (parseModelRef(ref).provider === provider) return ref;
  return null;
}

/** Настоящая проба: минимальный запрос через тот же ModelRuntime, что и у ролей. */
export const realProbe: ProbeFn = async (modelRef) => {
  const { getModelRuntime } = await import("./PiRuntimeAdapter.js");
  const { provider, id } = parseModelRef(modelRef);
  const rt: any = await getModelRuntime();
  const model = rt.getModel?.(provider, id) ?? ((await rt.getAvailable?.()) ?? []).find((m: any) => m.id === id);
  if (!model) return "unknown";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const answer = await rt.completeSimple(
      model,
      { messages: [{ role: "user", content: "ok", timestamp: Date.now() }] },
      { maxTokens: 8, signal: ac.signal },
    );
    if (answer?.stopReason === "error") {
      return isProviderLimitText(String(answer.errorMessage ?? "")) ? "limited" : "unknown";
    }
    return "ok";
  } catch (error) {
    return isProviderLimitText(error instanceof Error ? error.message : String(error)) ? "limited" : "unknown";
  } finally {
    clearTimeout(timer);
  }
};

/** Один проход: снимает метки у провайдеров, чей лимит уже сброшен. Возвращает снятые. */
export async function runProviderProbe(
  probe: ProbeFn = realProbe,
  routing: RoleRouting = loadRoleRouting(),
): Promise<string[]> {
  const restored: string[] = [];
  // Автовозврат выключен — сами метки не снимаем, это делает владелец кнопкой.
  if (!getFailoverSettings().autoReturn) return restored;
  for (const provider of limitedProviders()) {
    const ref = modelForProvider(routing, provider);
    if (!ref) continue;
    let result: ProbeResult = "unknown";
    try {
      result = await probe(ref);
    } catch {
      result = "unknown";
    }
    if (result === "ok") {
      db.prepare(
        "UPDATE provider_limits SET unavailable_until = datetime('now'), reason = 'лимит сброшен (проба)', updated_at = datetime('now') WHERE provider = ?",
      ).run(provider);
      restored.push(provider);
    }
  }
  return restored;
}

export function startProviderProbe(): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const restored = await runProviderProbe();
        if (restored.length) console.log(`[provider-probe] лимит сброшен, возврат на основную: ${restored.join(", ")}`);
      } catch (error) {
        console.warn(`[provider-probe]: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    })();
  };
  const first = setTimeout(tick, PROBE_FIRST_DELAY_MS);
  const timer = setInterval(tick, PROBE_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
