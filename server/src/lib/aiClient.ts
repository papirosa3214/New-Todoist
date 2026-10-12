// Общий AI-транспорт; маршруты и подготовка задач используют один клиент.
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://192.168.1.110:11434").replace(/\/+$/, "");
const OLLAMA_TIMEOUT_MS = 120_000;
const stripCodeFences=(s:string):string=>s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? s;
const stripThinkTags=(s:string):string=>s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

export async function callUnifiedAi(opts: {
  systemPrompt: string;
  userPrompt: string;
  provider?: string;
  localModel?: string;
  aiModel?: string;
  temperature?: number;
  /** Включить reasoning-фазу («думание») у локальной модели. По умолчанию
   *  ВЫКЛ — для разбивки задач и наблюдателя скорость важнее (10с против
   *  60-76с). Максим 26.08.2026: для Дневника пусть думает — там качество
   *  текста важнее секунд. */
  think?: boolean;
  /** Потолок ответа локальной модели. По умолчанию его хватает всем прежним
   *  вызовам (замер: ~200 токенов на разбивку). Разбор надиктовки на пачку
   *  карточек длиннее в разы, и обрезанный на середине JSON не парсится
   *  вовсе — там потолок поднимается явно. */
  predictTokens?: number;
  /** Окно контекста локальной модели. Дефолт 8192 — хватало прежним мелким
   *  вызовам. Разбору БОЛЬШОГО текста (постановка из заметки/файла) этого
   *  мало: вход + системный промпт + ответ не влезают, и Ollama молча
   *  обрезает НАЧАЛО промпта — модель теряет правила и лепит одну убогую
   *  карточку. Там окно поднимается явно. */
  numCtx?: number;
}): Promise<string> {
  const provider = (opts.provider || "local").toLowerCase();
  const requestedModel = opts.aiModel;

  // 0. Обычная модель ролей (MiniMax-M3 и её цепочка), без локальной Ollama.
  if (provider === "minimax") {
    const { callRuntimeModel } = await import("./runtimeAi.js");
    return callRuntimeModel({ systemPrompt: opts.systemPrompt, userPrompt: opts.userPrompt, maxTokens: opts.predictTokens });
  }

  // 1. Claude Code / Anthropic
  if (provider === "claude" && process.env.ANTHROPIC_API_KEY) {
    const claudeModel =
      requestedModel || process.env.CLAUDE_MODEL || "claude-sonnet-4.6";
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 2000,
          system: opts.systemPrompt,
          messages: [{ role: "user", content: opts.userPrompt }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const d = (await res.json()) as any;
        const text = d?.content?.[0]?.text;
        if (text) return text;
      }
    } catch (e) {
      console.warn("Claude API error, falling back to local Ollama:", e);
    }
  }

  // 2. DeepSeek API
  if (provider === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    const deepseekModel =
      requestedModel || process.env.DEEPSEEK_MODEL || "deepseek-chat";
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: deepseekModel,
          messages: [
            { role: "system", content: opts.systemPrompt },
            { role: "user", content: opts.userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const d = (await res.json()) as any;
        const text = d?.choices?.[0]?.message?.content;
        if (text) return text;
      }
    } catch (e) {
      console.warn("DeepSeek error, falling back to local Ollama:", e);
    }
  }

  // Default: Local Ollama on 192.168.1.110
  //
  // ПОПРАВКА 26.08.2026 (Максим): coder30b-abl НЕ битая. Вчерашний диагноз
  // «CUDA error / битый GGUF» был ложной тревогой — временный тупняк
  // сервера (после перезагрузки воспроизвести не удаётся: живые прогоны
  // 26.08 отрабатывают чисто, ~12с на реальную разбивку задачи). Модель
  // оставлена в списке выбора как вариант. Дефолт — qwen3.6-27b: она
  // reasoning-класса и по умолчанию отвечает без «думания» (см. think
  // ниже), для Дневника думание включается точечно.
  const targetModel =
    opts.localModel || process.env.OLLAMA_MODEL || "qwen3.6-27b-iq4-16k:latest";
  let res: Response;
  try {
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          {
            role: "system",
            content: `${opts.systemPrompt}\nРассуждай кратко. Верни СТРОГО результат.`,
          },
          { role: "user", content: opts.userPrompt },
        ],
        stream: false,
        think: opts.think ?? false,
        options: {
          num_ctx: opts.numCtx ?? 8192,
          // С выключенным think реальный ответ укладывается в ~200 токенов
          // (замер), 2048 — щедрый запас. С включённым (Дневник) бюджет
          // должен вместить и <think>, и сам текст — поэтому больше.
          num_predict: opts.predictTokens ?? (opts.think ? 4096 : 2048),
          temperature: opts.temperature ?? 0.2,
        },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new OllamaError("Модель не ответила вовремя. Попробуйте ещё раз.");
    }
    throw new OllamaError("Не удалось связаться с локальной моделью (Ollama).");
  }

  if (!res.ok) {
    throw new OllamaError(
      `Локальная модель ${targetModel} ответила ошибкой (HTTP ${res.status}).`,
    );
  }

  const data = (await res.json()) as any;
  let content: string =
    data?.message?.content || data?.choices?.[0]?.message?.content || "";

  // Если модель reasoning поместила результат в thinking или content пуст:
  if (!content || !content.trim()) {
    const thinking = data?.message?.thinking || data?.thinking || "";
    if (thinking && typeof thinking === "string") {
      content = thinking;
    }
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    throw new OllamaError("Модель вернула пустой ответ. Попробуйте ещё раз.");
  }
  return content;
  } catch (localErr) {
    // Локальная Ollama на .110 периодически залипает и отвечает
    // «server busy (maximum pending requests exceeded)» на ЛЮБУЮ модель: из-за
    // этого голос Секретаря не мог ни составить задачу, ни найти сводку
    // (владелец 12.10.2026). При таком отказе уходим в облако MiniMax —
    // он быстрый и от локальной машины не зависит.
    if (process.env.CLOUD_FALLBACK === "0") throw localErr;
    const ref = process.env.CLOUD_FALLBACK_MODEL || "minimax/MiniMax-M2.7-highspeed";
    try {
      const { callRuntimeModel } = await import("./runtimeAi.js");
      const text = await callRuntimeModel({
        systemPrompt: `${opts.systemPrompt}\nРассуждай кратко. Верни СТРОГО результат.`,
        userPrompt: opts.userPrompt,
        maxTokens: opts.predictTokens ?? 2048,
        modelRef: ref,
      });
      if (text && text.trim()) {
        console.warn(`Локальная модель не ответила (${(localErr as Error)?.message ?? localErr}) — ответил ${ref}`);
        return text;
      }
      throw new Error("облако вернуло пустой ответ");
    } catch (cloudErr) {
      console.warn("Локальная модель не ответила, и облачный запасной путь тоже:", cloudErr);
      throw localErr instanceof OllamaError
        ? localErr
        : new OllamaError("Локальная модель не ответила, и облачный запасной путь не сработал.");
    }
  }
}

export function parseJsonObject(rawContent: string): any {
  const cleaned = stripCodeFences(stripThinkTags(rawContent)).trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new OllamaError("Не удалось разобрать ответ модели как JSON.");
    }
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // Иначе наружу ушёл бы текст самого JSON.parse («Unexpected token …
      // at position 143»), а его читает владелец в чате: причина отказа
      // должна быть на человеческом языке, а не машинной строкой.
      throw new OllamaError("Не удалось разобрать ответ модели как JSON.");
    }
  }
}
