// Возврат на основную модель по ФАКТУ сброса лимита (владелец 07.10.2026: «как только лимиты
// сбрасываются у MiniMax — возврат автоматом»). Раньше метка «провайдер в лимите» жила пять
// часов от первой 429 и снималась только по таймеру — окно у MiniMax могло открыться раньше, а
// мы всё это время сидели на запасных. Теперь раз в несколько минут к каждому помеченному
// провайдеру уходит крошечный пробный запрос: ответил без ошибки лимита — метка снимается и
// новые запуски снова берут основную модель. Ответил лимитом — метка остаётся, а истечение по
// таймеру работает как раньше (страховка, если проба недоступна).
import db from "../db.js";
import { loadRoleRouting, type RoleRouting } from "../roleRouting.js";
import { parseModelRef } from "../lib/attemptModel.js";
import { isProviderLimitText } from "./providerFailover.js";

export type ProbeResult = "ok" | "limited" | "unknown";
export type ProbeFn = (modelRef: string) => Promise<ProbeResult>;

const PROBE_INTERVAL_MS = Number(process.env.PROVIDER_PROBE_INTERVAL_MS) || 5 * 60_000;
const PROBE_FIRST_DELAY_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Помеченные провайдеры, у которых метка ещё не истекла. */
function limitedProviders(): string[] {
  return (
    db
      .prepare(
        "SELECT provider FROM provider_limits WHERE unavailable_until IS NOT NULL AND unavailable_until > datetime('now')",
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
