// Карточка 412f89f4: рабочая fallback-цепочка консультации.
// Владелец 09.10.2026: одна сессия = один POST /api/tasks/:id/consultation.
// Сервер сам проходит цепочку Opus → GPT-6.1 SOL (openai-codex) → OpenCode Go
// (DeepSeek V4.1 Flash, конфигурируемая замена) и записывает фактические
// провайдер/модель/ошибки в consultation_log. Лимит R6 (1 на попытку) тратится
// только при успешном ответе любой ступени.
//
// Цепочка линейная, повтор ступени запрещён: по тому же вопросу не дёргаем
// Opus дважды, даже если первый Opus вернул «бизнес-ошибку» (400/контент).
// Бизнес-ошибка провайдера возвращается как есть, лимит НЕ тратится, агент
// видит её и может решать сам.
//
// NOT WIRE-эффект: за время одной попытки не расходуем лимит зря — каждый
// шаг имеет короткий ceiling (60 с) и AbortController.

import { isProviderLimitText } from "../runtime/providerFailover.js";

/** Ступень fallback-цепочки. Тут только провайдер + id; env-переопределения
 *  (TASKFLOW_CONSULT_SOL_MODEL, TASKFLOW_CONSULT_GO_MODEL) разрешают сменить
 *  «что именно считается Opus/GPT-6.1 SOL/OpenCode Go». */
export interface ChainStep {
  /** id ступени — короткая метка для журнала (opus / gpt-6-1-sol / opencode-go). */
  key: string;
  provider: string;
  /** Разрешение id: сначала env с приставкой TASKFLOW_CONSULT_<KEY>_MODEL,
   *  иначе дефолт. Несколько вариантов — fallback внутри ступени (если у
   *  провайдера есть канонический и алиас от opencode-реестра). */
  modelIds: string[];
  /** Человекочитаемая метка — для логов и отчёта. */
  label: string;
}

const envModel = (slot: string, fallback: string): string => {
  const v = process.env[`TASKFLOW_CONSULT_${slot}_MODEL`]?.trim();
  return v && v.length > 0 ? v : fallback;
};

export function buildDefaultChain(): ChainStep[] {
  return [
    {
      key: "opus",
      provider: "anthropic",
      modelIds: [envModel("OPUS", "claude-opus-4-5")],
      label: "Opus (anthropic)",
    },
    {
      key: "gpt-6-1-sol",
      provider: "openai-codex",
      modelIds: [envModel("SOL", "gpt-6.1-sol")],
      label: "GPT-6.1 SOL (openai-codex)",
    },
    {
      key: "opencode-go",
      provider: "opencode-go",
      // В каталоге opencode-go у нас deepseek-v4.1-flash; «V4 Pro» из ТЗ — это
      // указание на семейство DeepSeek V4, концретный id провайдера берём
      // через переменную, по умолчанию тот, что доступен сейчас.
      modelIds: [envModel("GO", "deepseek-v4.1-flash")],
      label: "OpenCode Go (запасной Go-консультант)",
    },
  ];
}

/** Итог одной попытки. */
export type ChainAttemptOutcome =
  | { ok: true; answer: string }
  | {
      ok: false;
      /** Причина отказа провайдера. `transport` — лимит/5xx/timeout, в этом
       *  случае идём по цепочке дальше; `business` — всё остальное (битый
       *  промпт, контент-фильтр), возвращаем наружу сразу. */
      kind: "transport" | "business" | "missing_model";
      message: string;
    };

/** Один шаг по цепочке: забрать модель у ModelRuntime и сделать простой запрос. */
async function runOneStep(args: {
  rt: any;
  step: ChainStep;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  predictTokens: number;
  temperature: number;
}): Promise<ChainAttemptOutcome> {
  const { rt, step, systemPrompt, userPrompt, signal, predictTokens, temperature } = args;
  let model: any = null;
  for (const id of step.modelIds) {
    model = rt.getModel?.(step.provider, id);
    if (model) break;
  }
  if (!model) {
    const ids = step.modelIds.join(", ");
    return {
      ok: false,
      kind: "missing_model",
      message: `ступень ${step.key}: провайдер ${step.provider} не отдаёт модель (пробовали ${ids})`,
    };
  }
  let answer: any;
  try {
    answer = await rt.completeSimple(
      model,
      { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
      { maxTokens: predictTokens, signal, temperature },
    );
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      kind: isProviderLimitText(text) || /\b503\b|\b5\d\d\b|timeout|aborted|overloaded|unavailable/i.test(text) ? "transport" : "business",
      message: text.slice(0, 500),
    };
  }
  if (answer?.stopReason === "aborted") {
    return { ok: false, kind: "transport", message: "aborted" };
  }
  if (answer?.stopReason === "error") {
    const text = String(answer.errorMessage ?? "неизвестная ошибка модели");
    return {
      ok: false,
      kind: isProviderLimitText(text) || /\b503\b|\b5\d\d\b|timeout|overloaded|unavailable/i.test(text) ? "transport" : "business",
      message: text.slice(0, 500),
    };
  }
  const text = (answer?.content ?? [])
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("")
    .trim();
  if (!text) {
    return { ok: false, kind: "business", message: "модель вернула пустой текст" };
  }
  return { ok: true, answer: text };
}

/** Прогон цепочки. Каждая ступень с собственным дедлайном (60 с). При
 *  успешной ступени возвращаем ответ и какой шаг ответил; при «transport»
 *  ошибке идём к следующей ступени; при «business» возвращаем сразу — это
 *  значит провайдер живой, но отказал (контент-фильтр, плохой промпт и т.п.).
 *  «missing_model» — это не «живой ли провайдер», а конфигурационная
 *  ошибка: пропускаем, идём дальше, но в журнал пишем. */
export async function runConsultationChain(args: {
  systemPrompt: string;
  userPrompt: string;
  predictTokens?: number;
  temperature?: number;
  perStepTimeoutMs?: number;
  chain?: ChainStep[];
}): Promise<{
  ok: boolean;
  answer?: string;
  error?: string;
  winner?: { stepKey: string; provider: string; model: string };
  attempts: Array<{
    stepKey: string;
    provider: string;
    model: string;
    outcome: "ok" | "transport" | "business" | "missing_model" | "skipped_business";
    message?: string;
    durationMs: number;
  }>;
}> {
  const chain = args.chain ?? buildDefaultChain();
  const predictTokens = args.predictTokens ?? 1500;
  const temperature = args.temperature ?? 0.2;
  const perStepTimeoutMs = args.perStepTimeoutMs ?? 60_000;

  // Поднимаем runtime лениво — реальный ModelRuntime, тот же, что у ролей.
  const { getModelRuntime } = await import("../runtime/PiRuntimeAdapter.js");
  const rt: any = await getModelRuntime();

  const attempts: Array<{
    stepKey: string;
    provider: string;
    model: string;
    outcome: "ok" | "transport" | "business" | "missing_model" | "skipped_business";
    message?: string;
    durationMs: number;
  }> = [];

  for (const step of chain) {
    const startedAt = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), perStepTimeoutMs);
    const modelIdForLog =
      step.modelIds.find((id) => rt.getModel?.(step.provider, id)) ?? step.modelIds[0];
    try {
      const outcome = await runOneStep({
        rt,
        step,
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
        signal: ac.signal,
        predictTokens,
        temperature,
      });
      const durationMs = Date.now() - startedAt;
      if (outcome.ok) {
        attempts.push({
          stepKey: step.key,
          provider: step.provider,
          model: modelIdForLog,
          outcome: "ok",
          durationMs,
        });
        return {
          ok: true,
          answer: outcome.answer,
          winner: { stepKey: step.key, provider: step.provider, model: modelIdForLog },
          attempts,
        };
      }
      attempts.push({
        stepKey: step.key,
        provider: step.provider,
        model: modelIdForLog,
        outcome: outcome.kind,
        message: outcome.message,
        durationMs,
      });
      if (outcome.kind === "business") {
        // Провайдер живой, но отказал — повтор той же ступени не поможет.
        return {
          ok: false,
          error: `consultant_business_error: ${step.key}: ${outcome.message}`,
          attempts,
        };
      }
      // transport / missing_model — следующая ступень.
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    error: attempts.length
      ? `consultant_unavailable: ни одна ступень не ответила (${attempts.length} попыток: ${attempts
          .map((a) => `${a.stepKey}=${a.outcome}`)
          .join(", ")})`
      : "consultant_unavailable: цепочка пуста",
    attempts,
  };
}
