// Возврат на основную модель по ФАКТУ сброса лимита — только для случая «упёрлись сразу при
// старте» (владелец 07.10.2026): остаток до сброса неизвестен, поэтому раз в несколько минут к
// такому провайдеру (provider_limits.mode = 'probe') уходит крошечный запрос. Ответил без ошибки
// лимита — метка снимается и новые запуски снова берут основную модель. Ответил лимитом — метка
// остаётся; пять часов по таймеру — страховка, если проба недоступна. Провайдеры, которые до
// Владелец 12.10.2026: «лимиты восстановились, а эта страховка душит». Раньше
// прощупывался ТОЛЬКО режим 'probe', а провайдеры, которые до лимита работали ('timer'),
// ждали свои 5 часов вслепую — именно на них «базарит пять часов». Теперь проба идёт по всем
// помеченным: ответил провайдер без ошибки лимита — метка снята, возврат по ФАКТУ, а не по
// расписанию. Пятичасовое окно остаётся страховкой на случай, если проба недоступна.
import db from "../db.js";
import { loadRoleRouting, type RoleRouting } from "../roleRouting.js";
import { parseModelRef } from "../lib/attemptModel.js";
import { isProviderLimitText } from "./providerFailover.js";
import { getFailoverSettings } from "../lib/failoverSettings.js";
import { readProviderQuota } from "../lib/providerQuota.js";

export type ProbeResult = "ok" | "limited" | "unknown";
export type ProbeFn = (modelRef: string) => Promise<ProbeResult>;

import { getSetting, onChange } from "../lib/serverSettings.js";
// MAK-95: интервал пробы приходит из реестра и пересоздаётся при смене,
// иначе остался бы старый setInterval и число проб не подстроилось под
// новое значение.
let PROBE_INTERVAL_MS = getSetting("provider_probe_interval_ms");
const PROBE_FIRST_DELAY_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Провайдеры в режиме probe, у которых метка ещё не истекла. */
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
/** Провайдеры, у которых стоит спрашивать остаток: все, что встречаются в
 *  моделях ролей. */
function quotaAwareProviders(routing: RoleRouting): string[] {
  const providers = new Set<string>();
  for (const ref of Object.values(routing.models ?? {})) {
    if (!ref) continue;
    const p = parseModelRef(ref as string).provider;
    if (p) providers.add(p);
  }
  for (const p of limitedProviders()) providers.add(p);
  return [...providers];
}

/** Окно по умолчанию, когда провайдер не назвал время сброса. */
function defaultWindowEnd(): string {
  return new Date(Date.now() + 5 * 60 * 60_000).toISOString().replace("T", " ").slice(0, 19);
}

export async function runProviderProbe(
  probe: ProbeFn = realProbe,
  routing: RoleRouting = loadRoleRouting(),
): Promise<string[]> {
  const restored: string[] = [];

  // Владелец 12.10.2026: «почему лимиты не считаются». Метка ставилась только
  // ПОСЛЕ упавшего запроса, поэтому система вела себя так: лимит кончился —
  // ход упал с 429, и только потом появилась метка. Теперь остаток спрашивается
  // у каждого провайдера, который его отдаёт, на каждом проходе: лимит виден
  // ДО того, как упёрлись, а метка сразу ставится с его собственным временем
  // сброса. Раньше помеченным это делалось только для тех, кто уже помечен.
  for (const provider of quotaAwareProviders(routing)) {
    const quota = await readProviderQuota(provider);
    if (!quota.known) continue;
    if (quota.limited) {
      db.prepare(
        `UPDATE provider_limits SET unavailable_until = ?, reason = ?, updated_at = datetime('now'), mode = 'probe'
           WHERE provider = ? AND (unavailable_until IS NULL OR unavailable_until <= datetime('now') OR unavailable_until <> ?)`,
      ).run(quota.resetAt?.toISOString().replace("T", " ").slice(0, 19) ?? defaultWindowEnd(), quota.detail ?? "лимит по остатку провайдера", provider, quota.resetAt?.toISOString().replace("T", " ").slice(0, 19) ?? defaultWindowEnd());
      if (quota.resetAt) {
        console.log(`[provider-probe] ${provider}: лимит, сброс ${quota.resetAt.toISOString()}`);
      }
    } else if (getFailoverSettings().autoReturn) {
      // Провайдер жив — снимаем возможную протухшую метку. При выключенном
      // автовозврате метку снимает только владелец кнопкой.
      db.prepare(
        "UPDATE provider_limits SET unavailable_until = datetime('now'), reason = 'лимит сброшен (остаток от провайдера)', updated_at = datetime('now') WHERE provider = ? AND unavailable_until IS NOT NULL AND unavailable_until > datetime('now')",
      ).run(provider);
      restored.push(provider);
    }
  }
  // Автовозврат выключен — сами метки не снимаем, это делает владелец кнопкой.
  if (!getFailoverSettings().autoReturn) return restored;
  for (const provider of limitedProviders()) {
    // Владелец 12.10.2026: сперва спрашиваем у провайдера сам остаток. Он и
    // снимает метку, и ставит её с его собственным временем сброса. Реальный
    // запрос к модели — только когда провайдер остаток не отдаёт.
    const quota = await readProviderQuota(provider);
    if (quota.known) {
      if (!quota.limited) {
        db.prepare(
          "UPDATE provider_limits SET unavailable_until = datetime('now'), reason = 'лимит сброшен (остаток от провайдера)', updated_at = datetime('now') WHERE provider = ?",
        ).run(provider);
        restored.push(provider);
      } else if (quota.resetAt) {
        db.prepare(
          "UPDATE provider_limits SET unavailable_until = ?, reason = ?, updated_at = datetime('now'), mode = 'probe' WHERE provider = ?",
        ).run(quota.resetAt.toISOString().replace("T", " ").slice(0, 19), quota.detail ?? null, provider);
      }
      continue;
    }
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
  let first = setTimeout(tick, PROBE_FIRST_DELAY_MS);
  let timer = setInterval(tick, PROBE_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  // Пересоздаём таймер при смене интервала через реестр. ВАЖНО: каждый
  // обработчик ровно один — повторный старт startProviderProbe() создаст
  // ещё одну подписку и продублирует тики. Вызывающий код гарантирует
  // единственный вызов (как и раньше с хардкодом).
  const off = onChange("provider_probe_interval_ms", (v) => {
    PROBE_INTERVAL_MS = v;
    clearTimeout(first);
    clearInterval(timer);
    first = setTimeout(tick, PROBE_FIRST_DELAY_MS);
    timer = setInterval(tick, PROBE_INTERVAL_MS);
    first.unref?.();
    timer.unref?.();
  });
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    off();
  };
}
