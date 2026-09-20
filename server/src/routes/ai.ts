import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead } from "../access.js";

// ═══════════ AI-разбивка задачи на подзадачи (локальная модель) ═══════════
// Дёргает Ollama (OpenAI-совместимый /v1/chat/completions) на домашнем
// сервере .110. Owner подтверждает/правит список ПЕРЕД сохранением —
// сервер только предлагает, ничего не создаёт сам (см. TaskFormScreen).
const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL || "http://192.168.1.110:11434"
).replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.6-27b-iq4-16k:latest";

// Модель «думающая» (reasoning:true) — рассуждения могут занимать десятки
// секунд ДО того, как пойдёт сам ответ. 23с ушло на тривиальное «привет»
// в живом тесте — на реальный промпт закладываем запас, но не задаём
// max_tokens/num_predict: низкий потолок обрежет reasoning-фазу и урежет
// JSON-массив на середине строки, а это ровно то, что должно парситься.
const OLLAMA_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `Ты помощник, который разбивает задачи на конкретные подзадачи.
Дан заголовок и (опционально) описание задачи. Разбей её на 3-6 конкретных, выполнимых шагов на русском языке.
Ответь СТРОГО валидным JSON-массивом строк и ничем больше — без markdown, без нумерации, без пояснений до или после.
Пример формата ответа: ["Первый шаг", "Второй шаг", "Третий шаг"]`;

const STRUCTURE_SYSTEM_PROMPT = `Ты умный персональный ассистент по планированию задач.
Пользователь надиктовал свои мысли голосом (в тексте могут быть слова-паразиты, повторы).
Твоя задача — преобразовать этот текст в чистую, структурированную задачу:
1. "title": Короткий, ёмкий заголовок задачи (3-7 слов, начинающийся с глагола действия).
2. "description": Очищенное от слов-паразитов, грамотно оформленное подробное описание задачи.
3. "subtasks": Массив строк — конкретные пошаговые шаги/подзадачи (2-6 пунктов).
4. "due_date": Дата/время если упоминаются в формате "YYYY-MM-DD" или "YYYY-MM-DD HH:mm", иначе null.
5. "priority": Число 1-4 (1 — срочно, 2 — высокий, 3 — средний, 4 — обычный).

Ответь СТРОГО в формате JSON без markdown:
{
  "title": "...",
  "description": "...",
  "subtasks": ["шаг 1", "шаг 2"],
  "due_date": null,
  "priority": 4
}`;

// ═══════════ Надиктовка в чат → пачка карточек ═══════════
//
// 10.09.2026, карточка 4396f8c9. Мост выше (STRUCTURE_SYSTEM_PROMPT) собирает
// ОДНУ карточку — название, описание, шаги, срок, приоритет — и этого хватало,
// пока разбор жил в форме задачи: владелец сам решал, одна это карточка или
// пять. В окне постановки задач решать некому, а замысел владельца — «самому
// сидеть и расписывать это всё мне вообще не хочется». Поэтому здесь модель
// отвечает и за разбиение: родительская карточка плюс дочерние, с порядком
// между ними и предложенным проектом.
//
// Дочерние — не всегда: надиктовка про одно дело остаётся одной карточкой с
// шагами, и пустой children в ответе это нормальный, а не бракованный разбор.
// Дробить одно дело на карточки ради дробления хуже, чем не дробить: владелец
// получит доску из огрызков и будет их склеивать руками.
const DICTATION_SYSTEM_PROMPT = `Ты разбираешь надиктовку владельца трекера задач в готовую постановку.
Текст надиктован голосом: в нём есть слова-паразиты, повторы и оговорки — их надо убрать, смысл сохранить.

Верни ОДИН JSON-объект такой формы:
{
  "title": "короткое название главной задачи, 3-8 слов",
  "description": "чистое описание: что надо сделать и зачем, без слов-паразитов",
  "result": "по чему поймём, что задача сделана — проверяемый признак",
  "subtasks": ["шаг 1", "шаг 2"],
  "due_date": null,
  "priority": 4,
  "project": null,
  "question": null,
  "children": [
    {"title": "название дочерней карточки", "description": "что в ней сделать", "result": "проверяемый признак готовности", "subtasks": ["шаг"], "after": null, "question": null}
  ]
}

ГЛАВНОЕ РЕШЕНИЕ — сколько в надиктовке ДЕЛ:
- Одно дело — это один результат, который сдают целиком. Тогда "children" пустой, а вся конкретика идёт в "subtasks".
- Несколько дел — это разные результаты: их можно сдать по отдельности, делать в разное время и поручить разным людям. Тогда КАЖДОЕ становится дочерней карточкой в "children", даже если названы они в одном предложении.
- Признаки, что дел несколько: «а ещё», «отдельно», «потом», «заодно», «и не связанное с этим», перечисление через «во-первых/во-вторых», разные предметы работы (одно про интерфейс, другое про документацию).
- Не превращай шаги ОДНОГО дела в дочерние карточки: «купить масло», «слить старое», «залить новое» — это шаги, а не отдельные дела.

Пример надиктовки с несколькими делами: «почини кнопку в приложении, потом когда починишь добавь туда фильтр, и отдельно напиши инструкцию для новичков, это срочно».
Правильный разбор: "children" из трёх карточек — «Починить кнопку» (after: null), «Добавить фильтр» (after: 1 — ждёт первую), «Написать инструкцию для новичков» (after: null — ни от чего не зависит).

Остальные правила:
- "subtasks" главной задачи — 2-6 конкретных шагов. Когда есть дочерние карточки, шаги главной не пересказывают их названия: там остаётся только общее (например, свести результат или проверить целиком). Нечего написать — пустой массив.
- У КАЖДОЙ дочерней карточки — свои 2-5 шагов в её "subtasks". Карточка без шагов заставит владельца дописывать их руками, а расписывать всё должен ты.
- "after" у дочерней карточки — номер той дочерней карточки из этого же списка (1 — первая), которую надо закончить ДО неё. Можно начинать сразу — null.
- Дочерние карточки перечисляй в том порядке, в котором их разумно делать.
- "due_date" — "ГГГГ-ММ-ДД" или "ГГГГ-ММ-ДД ЧЧ:ММ", если срок назван или ясен из слов вроде «до пятницы»; иначе null.
- "priority" — 1 срочно, 2 высокий, 3 средний, 4 обычный. Не назван — 4.
- "project" — название проекта РОВНО из предложенного списка, если работа явно про него; иначе null. Не выдумывай проектов, которых нет в списке.
- "result" — по чему будет видно, что работа сделана: проверяемый признак, а не пересказ названия. «Кнопка сохраняет черновик и он виден после перезахода» — годится; «кнопка починена» — нет. У каждой дочерней карточки свой "result". Совсем нечего проверить — пустая строка.
- "question" — ОДИН короткий вопрос владельцу, если без ответа работу нельзя сделать надёжно: не назван предмет работы, не ясно, о какой из двух систем речь, не хватает доступа. Всё понятно — null. Не задавай вопросов ради вежливости и не переспрашивай то, что можно решить разумным умолчанием: заданный вопрос ОСТАНАВЛИВАЕТ запуск работы и ждёт владельца.

Ответь ТОЛЬКО этим JSON, без markdown и без пояснений.`;

// ═══════════ Дневник: AI-действия над текстом + мост в задачи ═══════════
// 25.08.2026, владелец: «дневник с ии мостом в проекты». Три действия над
// выделением (или всей записью, если ничего не выделено) плюс отдельное
// извлечение задач из текста — см. NoteEditorScreen.tsx.
const JOURNAL_ASSIST_PROMPTS: Record<
  "continue" | "shorten" | "expand",
  string
> = {
  continue: `Ты помогаешь человеку писать личный дневник. Тебе дан текст — последняя часть его мысли. Продолжи мысль естественно, от того же лица, в том же тоне, 1-3 предложения. Ответь ТОЛЬКО продолжением текста, без кавычек, без вступлений и пояснений.`,
  shorten: `Сократи присланный текст до сути, сохранив смысл и авторский тон. Результат — не длиннее половины исходного объёма. Ответь ТОЛЬКО сокращённым текстом, без пояснений.`,
  expand: `Разверни присланную мысль в конкретный список пунктов — что сделать или на что обратить внимание. Ответь маркированным списком, каждый пункт с новой строки, начинается с "- ". Без вступления и пояснений.`,
};

const EXTRACT_TASKS_SYSTEM_PROMPT = `Ты помощник, который находит в тексте личного дневника конкретные дела и намерения — то, что человек хочет СДЕЛАТЬ, а не просто мысли или наблюдения.
Дан текст дневниковой записи. Извлеки из него только конкретные, выполнимые задачи (0-10 штук). Если в тексте нет ничего похожего на задачу — верни пустой массив.
Ответь СТРОГО валидным JSON-массивом объектов и ничем больше — без markdown, без пояснений до или после:
[{"title": "Короткий заголовок задачи, начинается с глагола", "description": "", "priority": 4, "due_date": null}]
"priority" — число 1-4 (1 — срочно, 4 — обычный; если из текста не ясно — 4).
"due_date" — "YYYY-MM-DD", если дата явно упомянута или ясна из контекста, иначе null.`;

function buildUserPrompt(
  title: string,
  description: string | null | undefined,
): string {
  // Простая страховка от чрезмерно длинного описания в промпте.
  const desc = (description || "").trim().slice(0, 4000);
  return desc
    ? `Заголовок задачи: ${title}\n\nОписание: ${desc}`
    : `Заголовок задачи: ${title}`;
}

/** Срезает ```json ... ``` / ``` ... ``` обвязку, если модель её добавила. */
function stripCodeFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1] : s;
}

/** Срезает <think>...</think> — «размышления» reasoning-модели, если они
 *  всё же оказались встроены в content, а не пришли отдельным полем. */
function stripThinkTags(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Достаёт массив строк-подзадач из сырого content ответа модели. */
function parseSubtasks(rawContent: string): string[] {
  const cleaned = stripCodeFences(stripThinkTags(rawContent)).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Модель могла добавить текст вокруг JSON, несмотря на промпт —
    // вытаскиваем первый '[' и последний ']' и пробуем ещё раз.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON array found");
    }
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }

  if (!Array.isArray(parsed)) throw new Error("not an array");

  const items = parsed
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);

  if (items.length === 0) throw new Error("empty subtask list");

  return items.slice(0, 10);
}

class OllamaError extends Error {
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
}): Promise<string> {
  const provider = (opts.provider || "local").toLowerCase();
  const requestedModel = opts.aiModel;

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

  // 2. Hermes / OpenRouter
  if (provider === "hermes" && process.env.OPENROUTER_API_KEY) {
    const hermesModel =
      requestedModel ||
      process.env.HERMES_MODEL ||
      "nousresearch/hermes-3-llama-3.1-405b";
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: hermesModel,
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
      console.warn("Hermes/OpenRouter error, falling back to local Ollama:", e);
    }
  }

  // 3. DeepSeek API
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

  const ANTIGRAVITY_TO_GEMINI_API_MAP: Record<string, string> = {
    "gemini-3.7-flash-high": "gemini-3-flash-preview",
    "gemini-3.7-flash-medium": "gemini-3-flash-preview",
    "gemini-3.7-flash-low": "gemini-3-flash-preview",
    "gemini-3.6-flash-high": "gemini-3-flash-preview",
    "gemini-3.6-flash-medium": "gemini-3-flash-preview",
    "gemini-3.6-flash-low": "gemini-3-flash-preview",
    "gemini-3.5-flash-high": "gemini-2.5-flash",
    "gemini-3.5-flash-medium": "gemini-2.5-flash",
    "gemini-3.5-flash-low": "gemini-2.5-flash",
    "gemini-3.1-pro-high": "gemini-3.1-pro-preview",
    "gemini-3.1-pro-low": "gemini-3.1-pro-preview",
    "claude-sonnet-4-6": "gemini-3.1-pro-preview",
    "claude-sonnet-4.6": "gemini-3.1-pro-preview",
    "claude-opus-4-6-thinking": "gemini-3.1-pro-preview",
    "claude-opus-4.6": "gemini-3.1-pro-preview",
    "gpt-oss-120b-medium": "gemini-2.5-pro",
    "gpt-oss-120b": "gemini-2.5-pro",
  };

  // 4. Antigravity / Direct Gemini API
  if (
    (provider === "antigravity" || provider === "gemini") &&
    (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
  ) {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const mappedModel = requestedModel
      ? ANTIGRAVITY_TO_GEMINI_API_MAP[requestedModel] || requestedModel
      : undefined;
    const geminiModel =
      mappedModel || process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: `${opts.systemPrompt}\n\n${opts.userPrompt}` }],
              },
            ],
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (res.ok) {
        const d = (await res.json()) as any;
        const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      }
    } catch (e) {
      console.warn(
        "Antigravity/Gemini error, falling back to local Ollama:",
        e,
      );
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
          num_ctx: 8192,
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
}

async function suggestSubtasks(
  title: string,
  description: string | null | undefined,
  provider?: string,
  localModel?: string,
  aiModel?: string,
): Promise<string[]> {
  const content = await callUnifiedAi({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(title, description),
    provider,
    localModel,
    aiModel,
    temperature: 0.4,
  });

  try {
    return parseSubtasks(content);
  } catch {
    throw new OllamaError(
      "Не удалось разобрать ответ модели как список подзадач. Попробуйте ещё раз.",
    );
  }
}

interface StructuredTaskResult {
  title: string;
  description: string;
  subtasks: string[];
  dueDate: string | null;
  priority: number;
}

export interface WeeklySummary {
  greeting: string;
  accomplishments: string[];
  missed_or_overdue: string[];
  next_week_focus: string[];
  productivity_score: number;
  stats: {
    completed_count: number;
    overdue_count: number;
    active_count: number;
  };
  generated_at: string;
}

// In-memory кэш сводки на пользователя (срок жизни 6 часов, чтобы не долбить модель при каждом входе)
const summaryCache = new Map<
  string,
  { summary: WeeklySummary; timestamp: number }
>();

async function generateWeeklySummary(
  userId: string,
  provider?: string,
  localModel?: string,
  aiModel?: string,
): Promise<WeeklySummary> {
  const db = (await import("../db.js")).default;

  // ВАЖНО: в таблице tasks НЕТ колонки user_id — есть creator_id и
  // assignee_id (см. server/src/db.ts). Запросы ниже спрашивали user_id и
  // валились с «no such column: user_id» — сводка не работала вообще
  // (Максим 26.08.2026: «не работает сводка недели, ошибку выдаёт»).
  // Принадлежность задачи пользователю здесь — «создал ИЛИ назначен на
  // него», ровно как её понимает остальной сервер (access.ts).
  const OWNED = "(creator_id = ? OR assignee_id = ?)";

  const completedRows = db
    .prepare(
      `SELECT title, description, completed_at 
       FROM tasks 
       WHERE ${OWNED} AND status = 'completed' AND completed_at >= datetime('now', '-7 days')
       ORDER BY completed_at DESC 
       LIMIT 25`,
    )
    .all(userId, userId) as any[];

  const overdueRows = db
    .prepare(
      `SELECT title, description, due_date, priority 
       FROM tasks 
       WHERE ${OWNED} AND status = 'active' AND due_date IS NOT NULL AND due_date < date('now')
       ORDER BY priority ASC, due_date ASC 
       LIMIT 15`,
    )
    .all(userId, userId) as any[];

  const activeRows = db
    .prepare(
      `SELECT title, description, due_date, priority 
       FROM tasks 
       WHERE ${OWNED} AND status = 'active'
       ORDER BY priority ASC, (due_date IS NULL) ASC, due_date ASC 
       LIMIT 20`,
    )
    .all(userId, userId) as any[];

  const todayStr = new Date().toISOString().slice(0, 10);
  const prompt = `Ты — персональный AI-коуч по продуктивности и Second Brain.
Твоя задача — составить живую, честную, емкую и полезную недельную сводку для пользователя на русском языке.

Данные пользователя за прошедшую неделю:
- Выполненные задачи за 7 дней (${completedRows.length} шт):
${completedRows.map((r) => `  * ${r.title}`).join("\n") || "  (нет завершенных задач)"}

- Просроченные / зависшие задачи (${overdueRows.length} шт):
${overdueRows.map((r) => `  * [P${r.priority}] ${r.title} (дедлайн был: ${r.due_date})`).join("\n") || "  (просрочек нет, отлично!)"}

- Активные задачи в работе / на сегодня (${activeRows.length} шт):
${activeRows.map((r) => `  * [P${r.priority}] ${r.title} ${r.due_date ? `(до ${r.due_date})` : ""}`).join("\n") || "  (список пуст)"}

Сегодняшняя дата: ${todayStr}

Формат ответа — СТРОГО чистый валидный JSON без markdown, без кавычек \`\`\`json:
{
  "greeting": "Краткое приветствие и общий бодрый тон (1 предложение)",
  "accomplishments": ["Главное достижение 1", "Достижение 2"],
  "missed_or_overdue": ["На что обратить внимание / где пробуксовка"],
  "next_week_focus": ["Фокус 1 на будущее", "Фокус 2"],
  "productivity_score": 85
}`;

  const raw = await callUnifiedAi({
    systemPrompt:
      "Ты — аналитический AI-ассистент. Отвечай СТРОГО валидным JSON-объектом.",
    userPrompt: prompt,
    provider,
    localModel,
    aiModel,
    temperature: 0.3,
  });

  const cleaned = stripCodeFences(stripThinkTags(raw)).trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } else {
      throw new OllamaError("Не удалось разобрать ответ как JSON");
    }
  }

  return {
    greeting: String(parsed.greeting || "Вот ваша сводка за неделю:"),
    accomplishments: Array.isArray(parsed.accomplishments)
      ? parsed.accomplishments.map(String)
      : [],
    missed_or_overdue: Array.isArray(parsed.missed_or_overdue)
      ? parsed.missed_or_overdue.map(String)
      : [],
    next_week_focus: Array.isArray(parsed.next_week_focus)
      ? parsed.next_week_focus.map(String)
      : [],
    productivity_score:
      typeof parsed.productivity_score === "number"
        ? Math.min(100, Math.max(0, parsed.productivity_score))
        : 80,
    stats: {
      completed_count: completedRows.length,
      overdue_count: overdueRows.length,
      active_count: activeRows.length,
    },
    generated_at: new Date().toISOString(),
  };
}

async function structureTask(
  rawText: string,
  provider?: string,
  localModel?: string,
  aiModel?: string,
): Promise<StructuredTaskResult> {
  const content = await callUnifiedAi({
    systemPrompt: STRUCTURE_SYSTEM_PROMPT,
    userPrompt: `Текст диктовки: "${rawText}"`,
    provider,
    localModel,
    aiModel,
    temperature: 0.2,
  });

  const cleaned = stripCodeFences(stripThinkTags(content)).trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } else {
      throw new OllamaError("Не удалось разобрать JSON от модели.");
    }
  }

  return {
    title:
      typeof parsed?.title === "string"
        ? parsed.title.trim()
        : rawText.slice(0, 50),
    description:
      typeof parsed?.description === "string"
        ? parsed.description.trim()
        : rawText,
    subtasks: Array.isArray(parsed?.subtasks)
      ? parsed.subtasks
          .map((s: any) => String(s).trim())
          .filter((s: string) => s.length > 0)
      : [],
    dueDate:
      typeof parsed?.due_date === "string" ? parsed.due_date.trim() : null,
    priority:
      typeof parsed?.priority === "number" &&
      parsed.priority >= 1 &&
      parsed.priority <= 4
        ? parsed.priority
        : 4,
  };
}

// ── Разбор надиктовки в пачку карточек (карточка 4396f8c9) ──────────────

export interface DictationChild {
  title: string;
  description: string;
  /** Проверяемый признак готовности (раздел 7 спецификации от 14.09.2026).
   *  Пустая строка — модель ничего проверяемого не назвала. */
  result: string;
  /** Вопрос владельцу, без ответа на который работу нельзя сделать
   *  надёжно. null — всё понятно. Заданный вопрос останавливает
   *  автоматический запуск: спрашивать ради вежливости нельзя. */
  question: string | null;
  subtasks: string[];
  /** Номер дочерней карточки (1-based) в этом же списке, после которой можно
   *  браться за эту. null — ни от чего не зависит. */
  after: number | null;
}

export interface DictationCards {
  title: string;
  description: string;
  /** Проверяемый признак готовности (раздел 7 спецификации). */
  result: string;
  /** Вопрос владельцу; блокирует автоматический запуск дерева. */
  question: string | null;
  subtasks: string[];
  dueDate: string | null;
  priority: number;
  /** id проекта из переданного списка. null — модель не выбрала или назвала
   *  несуществующий: класть карточку наугад хуже, чем оставить без проекта,
   *  владелец поправит одним касанием. */
  projectId: string | null;
  children: DictationChild[];
}

/** Достаёт JSON-объект из сырого ответа модели — тем же способом, что и
 *  соседние разборы: сначала как есть, потом по первой '{' и последней '}'. */
function parseJsonObject(rawContent: string): any {
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

function cleanTitles(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === "string" ? s.trim() : String(s ?? "").trim()))
    .filter((s) => s.length > 0)
    .slice(0, limit);
}

/**
 * Надиктовка → родительская карточка, дочерние и порядок между ними.
 *
 * Кривой ответ модели НЕ роняет разбор целиком: не разобрались дети —
 * остаётся одна карточка с шагами, не разобрался проект — карточка без
 * проекта. Владелец увидит черновик и поправит; полный отказ на месте
 * сомнительного поля означал бы, что надиктовка пропала зря.
 */
/**
 * Склеить системный слой постановки с пожеланиями владельца.
 *
 * Раздел 6 спецификации от 14.09.2026. Системный слой — технический
 * контракт: схема ответа, допустимые проекты, диапазоны, запрет поднимать
 * флаг. Он принадлежит серверу и на редактирование не отдаётся.
 *
 * Слой владельца (scope `task_intake`) управляет смыслом: стиль названия,
 * глубина декомпозиции, когда одна карточка, а когда дерево. Он идёт
 * ПОСЛЕ системного и с явной рамкой — текст владельца не переопределяет
 * формат ответа.
 *
 * Рамка в промпте — не единственная защита и не главная: разобранный
 * ответ всё равно проходит валидацию в structureDictationToCards (схема,
 * сверка проекта по имени, срезка полей), поэтому сломать контракт
 * пользовательский слой не может физически, что бы в нём ни написали.
 */
export function buildDictationSystemPrompt(ownerLayer: string): string {
  const layer = (ownerLayer || "").trim();
  if (!layer) return DICTATION_SYSTEM_PROMPT;
  return (
    DICTATION_SYSTEM_PROMPT +
    "\n\n— — —\nДополнительные пожелания владельца к смыслу постановки " +
    "(стиль, глубина разбиения, предпочтения по проектам). Они НЕ меняют " +
    "формат ответа, набор полей и запрет запускать задачу — формат выше " +
    "остаётся обязательным:\n" +
    layer
  );
}

export async function structureDictationToCards(
  rawText: string,
  projects: Array<{ id: string; name: string }>,
  opts?: {
    provider?: string;
    localModel?: string;
    aiModel?: string;
    /** Владелец, чей смысловой слой постановки подмешать (scope
     *  `task_intake`). Без него разбор идёт на одном системном промпте —
     *  как было до 14.09.2026. */
    ownerId?: string;
  },
): Promise<DictationCards> {
  const today = new Date().toISOString().slice(0, 10);
  const projectList = projects.length
    ? projects.map((p) => `- ${p.name}`).join("\n")
    : "(проектов нет)";

  // Двухслойный промпт постановки (раздел 6 спецификации от 14.09.2026).
  // Системный слой — технический контракт: схема ответа, допустимые
  // проекты, диапазоны, запрет поднимать флаг. Он принадлежит серверу и
  // на редактирование не отдаётся.
  //
  // Слой владельца (scope `task_intake`) управляет СМЫСЛОМ: стиль
  // названия, глубина декомпозиции, когда одна карточка, а когда дерево.
  // Он дописывается после системного и явно ограничен рамкой: текст
  // владельца не может переопределить формат ответа. Это не только
  // просьба в промпте — разобранный ответ всё равно проходит нашу
  // валидацию ниже (схема, сверка проекта по имени, срезка полей), так
  // что сломать контракт пользовательский слой не может физически.
  const ownerLayer = opts?.ownerId
    ? await getUserPrompt(opts.ownerId, "task_intake")
    : "";
  const systemPrompt = buildDictationSystemPrompt(ownerLayer);

  const content = await callUnifiedAi({
    systemPrompt,
    userPrompt:
      `Сегодня ${today}.\n\n` +
      `Проекты, из которых можно выбрать:\n${projectList}\n\n` +
      `Надиктовка:\n"${rawText.trim().slice(0, 6000)}"`,
    provider: opts?.provider,
    localModel: opts?.localModel,
    aiModel: opts?.aiModel,
    temperature: 0.2,
    // Родитель с шагами плюс несколько детей со своими шагами в 2048 токенов
    // не всегда влезают, а обрезанный JSON не парсится вовсе.
    predictTokens: 4096,
  });

  const parsed = parseJsonObject(content);

  const title =
    typeof parsed?.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : rawText.trim().slice(0, 60);

  // Проект сверяем по имени: скопировать UUID маленькая модель промахивается
  // куда чаще, чем повторить название, а сверка всё равно наша.
  let projectId: string | null = null;
  if (typeof parsed?.project === "string" && parsed.project.trim()) {
    const wanted = parsed.project.trim().toLowerCase();
    projectId =
      projects.find((p) => p.name.toLowerCase() === wanted)?.id ??
      projects.find((p) => p.name.toLowerCase().includes(wanted))?.id ??
      null;
  }

  const children: DictationChild[] = Array.isArray(parsed?.children)
    ? parsed.children
        .map((c: any): DictationChild | null => {
          const t = typeof c?.title === "string" ? c.title.trim() : "";
          if (!t) return null;
          const after =
            typeof c?.after === "number" && Number.isInteger(c.after)
              ? c.after
              : null;
          const q = typeof c?.question === "string" ? c.question.trim() : "";
          return {
            title: t,
            description:
              typeof c?.description === "string" ? c.description.trim() : "",
            result: typeof c?.result === "string" ? c.result.trim() : "",
            question: q || null,
            subtasks: cleanTitles(c?.subtasks, 10),
            after,
          };
        })
        .filter((c: DictationChild | null): c is DictationChild => c !== null)
        .slice(0, 10)
    : [];

  // Ссылка «после карточки N» проверяется здесь, а не на месте использования:
  // модель охотно ставит after на саму себя или на карточку ниже по списку, и
  // такой порядок нарисовал бы очередь, которую никто не пройдёт.
  children.forEach((child, i) => {
    if (child.after === null) return;
    if (child.after < 1 || child.after > i) child.after = null;
  });

  return {
    title,
    description:
      typeof parsed?.description === "string" && parsed.description.trim()
        ? parsed.description.trim()
        : rawText.trim(),
    result: typeof parsed?.result === "string" ? parsed.result.trim() : "",
    question:
      typeof parsed?.question === "string" && parsed.question.trim()
        ? parsed.question.trim()
        : null,
    subtasks: cleanTitles(parsed?.subtasks, 10),
    dueDate:
      typeof parsed?.due_date === "string" && parsed.due_date.trim()
        ? parsed.due_date.trim()
        : null,
    priority:
      typeof parsed?.priority === "number" &&
      parsed.priority >= 1 &&
      parsed.priority <= 4
        ? parsed.priority
        : 4,
    projectId,
    children,
  };
}

async function journalAssist(
  text: string,
  action: "continue" | "shorten" | "expand",
  provider?: string,
  localModel?: string,
  aiModel?: string,
  /** Опциональное per-user дополнение к дефолтному системному промпту
   *  (подмешивается через "\n\n# Дополнение от пользователя:\n"). Карточка
   *  04c916c8: пусто или undefined = вызов без дополнения. */
  userSystemPrompt?: string,
): Promise<string> {
  const raw = await callUnifiedAi({
    systemPrompt: composeSystemPrompt(
      JOURNAL_ASSIST_PROMPTS[action],
      userSystemPrompt,
    ),
    userPrompt: text.trim().slice(0, 6000),
    provider,
    localModel,
    aiModel,
    temperature: action === "continue" ? 0.6 : 0.3,
    // Дневник — единственное место с включённым «думанием» (Максим
    // 26.08.2026): качество текста здесь важнее скорости ответа.
    think: true,
  });
  const cleaned = stripCodeFences(stripThinkTags(raw)).trim();
  if (!cleaned) {
    throw new OllamaError("Модель вернула пустой ответ. Попробуйте ещё раз.");
  }
  return cleaned;
}

interface ExtractedTaskResult {
  title: string;
  description: string;
  priority: number;
  due_date: string | null;
}

/** Достаёт массив предложенных задач из сырого content ответа модели. */
function parseExtractedTasks(rawContent: string): ExtractedTaskResult[] {
  const cleaned = stripCodeFences(stripThinkTags(rawContent)).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON array found");
    }
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }

  if (!Array.isArray(parsed)) throw new Error("not an array");

  const items = parsed
    .map((x): ExtractedTaskResult | null => {
      if (!x || typeof x !== "object") return null;
      const title =
        typeof (x as any).title === "string" ? (x as any).title.trim() : "";
      if (!title) return null;
      const description =
        typeof (x as any).description === "string"
          ? (x as any).description.trim()
          : "";
      const priority =
        typeof (x as any).priority === "number" &&
        (x as any).priority >= 1 &&
        (x as any).priority <= 4
          ? (x as any).priority
          : 4;
      const due_date =
        typeof (x as any).due_date === "string"
          ? (x as any).due_date.trim()
          : "";
      return { title, description, priority, due_date: due_date || null };
    })
    .filter((x): x is ExtractedTaskResult => x !== null);

  return items.slice(0, 10);
}

async function extractTasksFromText(
  text: string,
  provider?: string,
  localModel?: string,
  aiModel?: string,
  /** Опциональное per-user дополнение к дефолтному системному промпту
   *  (подмешивается через "\n\n# Дополнение от пользователя:\n"). Карточка
   *  04c916c8: пусто или undefined = вызов без дополнения. */
  userSystemPrompt?: string,
): Promise<ExtractedTaskResult[]> {
  const content = await callUnifiedAi({
    systemPrompt: composeSystemPrompt(
      EXTRACT_TASKS_SYSTEM_PROMPT,
      userSystemPrompt,
    ),
    userPrompt: text.trim().slice(0, 6000),
    provider,
    localModel,
    aiModel,
    temperature: 0.2,
  });

  try {
    return parseExtractedTasks(content);
  } catch {
    throw new OllamaError(
      "Не удалось разобрать ответ модели как список задач. Попробуйте ещё раз.",
    );
  }
}

/**
 * Склеивает дефолтный серверный промпт и пользовательское дополнение.
 * Подмешивание, а не замена — пользователь указывает «что ещё важно
 * учитывать», а дефолт остаётся контрактным форматом ответа. Пустое
 * дополнение = чистый дефолт.
 */
function composeSystemPrompt(
  defaultPrompt: string,
  userPrompt: string | null | undefined,
): string {
  const trimmed = userPrompt?.trim();
  if (!trimmed) return defaultPrompt;
  return `${defaultPrompt}\n\n# Дополнение от пользователя:\n${trimmed}`;
}

/**
 * Достаёт per-user промпт из `user_ai_prompts`. Возвращает "" для не-
 * существующей строки (не null), чтобы вызывающий мог просто склеивать.
 * Миграция таблицы — `db.ts`, см. CREATE TABLE IF NOT EXISTS user_ai_prompts.
 */
async function getUserPrompt(userId: string, scope: string): Promise<string> {
  const db = (await import("../db.js")).default;
  const row = db
    .prepare(
      "SELECT prompt FROM user_ai_prompts WHERE user_id = ? AND scope = ?",
    )
    .get(userId, scope) as { prompt: string } | undefined;
  return row?.prompt ?? "";
}

export function registerAiRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Короткий статус серверной модели — для раздела «ИИ» в настройках.
  //
  // Владелец 26.08.2026 хочет видеть ВСЕ модели системы в одном месте, включая
  // ту, что крутится на сервере: «локальная модель на сервере, крупная,
  // большая, отвечающая за такие-то функции». Списка моделей (local-models)
  // для этого мало — нужен ответ «работает или нет» и какая выбрана.
  //
  // Телефон сам до Ollama не ходит: она слушает на .110, а приложение знает
  // только адрес сервера. Поэтому проверяет сервер и отдаёт готовый ответ.
  app.get("/api/ai/status", {
    preHandler: authPre,
    handler: async () => {
      const model = process.env.OLLAMA_MODEL || OLLAMA_MODEL;
      try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return { online: false, model, host: OLLAMA_BASE_URL };
        const data = (await res.json()) as any;
        const names = (data.models || []).map((m: any) => m.name);
        return {
          online: true,
          model,
          host: OLLAMA_BASE_URL,
          // Модель из конфига могли удалить с сервера — тогда «работает» врёт.
          installed: names.includes(model),
        };
      } catch {
        return { online: false, model, host: OLLAMA_BASE_URL };
      }
    },
  });

  // Список доступных локальных моделей в Ollama
  app.get("/api/ai/local-models", {
    preHandler: authPre,
    handler: async () => {
      try {
        // tags — что вообще лежит на диске; ps — что реально загружено в
        // память прямо сейчас и какая доля весов попала в VRAM. Второй запрос
        // необязателен: Ollama может не ответить, тогда отдаём только размеры.
        const [tagsRes, psRes] = await Promise.all([
          fetch(`${OLLAMA_BASE_URL}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          }),
          fetch(`${OLLAMA_BASE_URL}/api/ps`, {
            signal: AbortSignal.timeout(3000),
          }).catch(() => null),
        ]);
        if (!tagsRes.ok) return { models: [] };
        const data = (await tagsRes.json()) as any;
        const running = new Map<string, { size: number; size_vram: number }>();
        if (psRes && psRes.ok) {
          const ps = (await psRes.json()) as any;
          for (const m of ps.models || []) {
            if (m?.name) {
              running.set(m.name, {
                size: m.size ?? 0,
                size_vram: m.size_vram ?? 0,
              });
            }
          }
        }
        const models = (data.models || [])
          .filter((m: any) => m.name && !m.name.includes("embed"))
          .map((m: any) => {
            const live = running.get(m.name);
            return {
              name: m.name,
              // Загруженная модель отдаёт фактический размер в памяти, а не
              // размер файла; size_vram — сколько из него на GPU.
              size: live?.size ?? m.size,
              details: m.details,
              loaded: !!live,
              size_vram: live?.size_vram ?? null,
            };
          });
        return { models };
      } catch {
        return { models: [] };
      }
    },
  });

  // Получить недельную сводку (из кэша или сгенерировать)
  app.get<{
    Querystring: { provider?: string; localModel?: string; aiModel?: string };
  }>("/api/ai/weekly-summary", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const provider = String(
        req.headers["x-ai-provider"] || req.query?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.query?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.query?.aiModel || "",
      );
      const cacheKey = `${req.userId}:${provider}:${localModel}:${aiModel}`;
      const cached = summaryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 6 * 3600 * 1000) {
        return cached.summary;
      }
      try {
        const summary = await generateWeeklySummary(
          req.userId,
          provider,
          localModel,
          aiModel,
        );
        summaryCache.set(cacheKey, { summary, timestamp: Date.now() });
        return summary;
      } catch (err: any) {
        if (cached) return cached.summary;
        return reply.code(502).send({
          error: err?.message || "Не удалось сгенерировать недельную сводку",
        });
      }
    },
  });

  // Принудительное обновление недельной сводки
  app.post<{
    Body: { provider?: string; localModel?: string; aiModel?: string };
  }>("/api/ai/weekly-summary/refresh", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const provider = String(
        req.headers["x-ai-provider"] || req.body?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.body?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.body?.aiModel || "",
      );
      const cacheKey = `${req.userId}:${provider}:${localModel}:${aiModel}`;
      try {
        const summary = await generateWeeklySummary(
          req.userId,
          provider,
          localModel,
          aiModel,
        );
        summaryCache.set(cacheKey, { summary, timestamp: Date.now() });
        return summary;
      } catch (err: any) {
        return reply.code(502).send({
          error: err?.message || "Не удалось обновить недельную сводку",
        });
      }
    },
  });

  // Структурирование надиктованной задачи через выбранный AI Мозг
  app.post<{
    Body: {
      text: string;
      provider?: string;
      localModel?: string;
      aiModel?: string;
    };
  }>("/api/ai/structure-task", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const text =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const provider = String(
        req.headers["x-ai-provider"] || req.body?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.body?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.body?.aiModel || "",
      );
      if (!text) {
        return reply
          .code(400)
          .send({ error: "Текст диктовки не может быть пустым" });
      }

      try {
        const result = await structureTask(text, provider, localModel, aiModel);
        return result;
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось структурировать задачу" });
      }
    },
  });

  // Существующая задача — разбивка на подзадачи
  app.post<{
    Params: { id: string };
    Body:
      | {
          title?: string;
          description?: string;
          provider?: string;
          localModel?: string;
        }
      | undefined;
  }>("/api/tasks/:id/suggest-subtasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const provider = String(
        req.headers["x-ai-provider"] || req.body?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.body?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.body?.aiModel || "",
      );
      const bodyTitle = req.body?.title;
      const bodyDescription = req.body?.description;
      const title =
        typeof bodyTitle === "string" && bodyTitle.trim()
          ? bodyTitle.trim()
          : task.title;
      const description =
        typeof bodyDescription === "string"
          ? bodyDescription
          : task.description;

      if (!title || !title.trim()) {
        return reply
          .code(400)
          .send({ error: "название задачи не может быть пустым" });
      }

      try {
        const subtasks = await suggestSubtasks(
          title,
          description,
          provider,
          localModel,
          aiModel,
        );
        return { subtasks };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось получить подзадачи" });
      }
    },
  });

  // Черновик задачи
  app.post<{
    Body: {
      title?: string;
      description?: string;
      provider?: string;
      localModel?: string;
      aiModel?: string;
    };
  }>("/api/ai/suggest-subtasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const provider = String(
        req.headers["x-ai-provider"] || req.body?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.body?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.body?.aiModel || "",
      );
      const title =
        typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        return reply
          .code(400)
          .send({ error: "название задачи не может быть пустым" });
      }
      const description =
        typeof req.body?.description === "string"
          ? req.body.description
          : undefined;

      try {
        const subtasks = await suggestSubtasks(
          title,
          description,
          provider,
          localModel,
          aiModel,
        );
        return { subtasks };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось получить подзадачи" });
      }
    },
  });

  // Дневник: действие над текстом (выделение или вся запись) — продолжить/
  // сократить/развить в шаги. Ничего не сохраняет сам — результат подставляет
  // клиент (NoteEditorScreen).
  app.post<{
    Body: {
      text: string;
      action?: string;
      provider?: string;
      localModel?: string;
      aiModel?: string;
    };
  }>("/api/ai/journal-assist", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const text =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const action = req.body?.action;
      if (!text) {
        return reply.code(400).send({ error: "Текст не может быть пустым" });
      }
      if (
        action !== "continue" &&
        action !== "shorten" &&
        action !== "expand"
      ) {
        return reply.code(400).send({ error: "Неизвестное действие" });
      }
      const provider = String(
        req.headers["x-ai-provider"] || req.body?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.body?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.body?.aiModel || "",
      );

      // Per-user системный промпт подмешивается СЕРВЕРОМ, а не передаётся
      // клиентом — иначе это дыра: любой мог бы подсунуть свой промпт и
      // заставить чужой запрос следовать чужим инструкциям. Карточка
      // 04c916c8: scope = 'journal_assist_<action>', общий дефолт один и
      // тот же для всех трёх действий (continue/shorten/expand делят
      // стилистические правила владельца).
      const userPrompt = await getUserPrompt(req.userId, "journal_assist");

      try {
        const result = await journalAssist(
          text,
          action,
          provider,
          localModel,
          aiModel,
          userPrompt,
        );
        return { result };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось получить ответ от AI" });
      }
    },
  });

  // Дневник → Проекты: извлечь из текста конкретные задачи. Владелец
  // подтверждает/правит список ПЕРЕД созданием (TasksFromTextSheet) —
  // этот эндпоинт только предлагает, ничего не создаёт сам.
  app.post<{
    Body: {
      text: string;
      provider?: string;
      localModel?: string;
      aiModel?: string;
    };
  }>("/api/ai/extract-tasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const text =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) {
        return reply.code(400).send({ error: "Текст не может быть пустым" });
      }
      const provider = String(
        req.headers["x-ai-provider"] || req.body?.provider || "local",
      );
      const localModel = String(
        req.headers["x-ollama-model"] || req.body?.localModel || "",
      );
      const aiModel = String(
        req.headers["x-ai-model"] || req.body?.aiModel || "",
      );

      // Per-user промпт читается сервером по req.userId; клиент system_prompt
      // НЕ передаёт — см. карточку 04c916c8 и контракт безопасности.
      const userPrompt = await getUserPrompt(req.userId, "extract_tasks");

      try {
        const tasks = await extractTasksFromText(
          text,
          provider,
          localModel,
          aiModel,
          userPrompt,
        );
        return { tasks };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось извлечь задачи" });
      }
    },
  });

  // Per-user системные промпты — настройки владельца, попадают в модель
  // автоматически при вызовах /extract-tasks и /journal-assist. Контракт:
  //   GET  /api/ai/prompts                  → { prompts: [{scope, prompt, updated_at}] }
  //   PUT  /api/ai/prompts/:scope           → { prompt: string } (upsert)
  //   DELETE /api/ai/prompts/:scope         → сброс на дефолт (row удаляется)
  // Скоупы: 'extract_tasks', 'journal_assist'. Любая строка валидна —
  // сервер не валидирует whitelist, чтобы не ломать обратную совместимость
  // при добавлении новых применений.
  app.get("/api/ai/prompts", {
    preHandler: authPre,
    handler: async (req: any) => {
      const db = (await import("../db.js")).default;
      const rows = db
        .prepare(
          "SELECT scope, prompt, updated_at FROM user_ai_prompts WHERE user_id = ? ORDER BY scope",
        )
        .all(req.userId) as Array<{
        scope: string;
        prompt: string;
        updated_at: string;
      }>;
      return {
        prompts: rows.map((r) => ({
          scope: r.scope,
          prompt: r.prompt,
          updated_at: r.updated_at,
        })),
      };
    },
  });

  app.put<{
    Params: { scope: string };
    Body: { prompt: string };
  }>("/api/ai/prompts/:scope", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const scope = String(req.params.scope || "").trim();
      if (!scope) {
        return reply.code(400).send({ error: "scope обязателен" });
      }
      // Разрешаем только разумные scope'ы: латиница/цифры/подчёркивание/дефис.
      // Без этого — open door для произвольных строк в БД (и для sql-smuggle
      // в path-segment, если такая дыра есть в sqlite-драйвере).
      if (!/^[a-z0-9_-]{1,64}$/i.test(scope)) {
        return reply
          .code(400)
          .send({ error: "scope: только латиница/цифры/_/- длиной 1..64" });
      }
      const raw = req.body?.prompt;
      if (typeof raw !== "string") {
        return reply
          .code(400)
          .send({ error: "prompt обязателен и должен быть строкой" });
      }
      // Лимит на размер промпта: 16 КБ — заведомо больше того, что человек
      // напишет руками, и обрезает попытки залить байтовую кашу.
      const prompt = raw.slice(0, 16_384);
      const db = (await import("../db.js")).default;
      db.prepare(
        `INSERT INTO user_ai_prompts (user_id, scope, prompt, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, scope) DO UPDATE SET
           prompt = excluded.prompt,
           updated_at = datetime('now')`,
      ).run(req.userId, scope, prompt);
      const row = db
        .prepare(
          "SELECT scope, prompt, updated_at FROM user_ai_prompts WHERE user_id = ? AND scope = ?",
        )
        .get(req.userId, scope) as
        { scope: string; prompt: string; updated_at: string } | undefined;
      return {
        ok: true,
        scope: row?.scope ?? scope,
        prompt: row?.prompt ?? prompt,
        updated_at: row?.updated_at ?? new Date().toISOString(),
      };
    },
  });

  app.delete<{
    Params: { scope: string };
  }>("/api/ai/prompts/:scope", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const scope = String(req.params.scope || "").trim();
      if (!scope) {
        return reply.code(400).send({ error: "scope обязателен" });
      }
      if (!/^[a-z0-9_-]{1,64}$/i.test(scope)) {
        return reply
          .code(400)
          .send({ error: "scope: только латиница/цифры/_/- длиной 1..64" });
      }
      const db = (await import("../db.js")).default;
      db.prepare(
        "DELETE FROM user_ai_prompts WHERE user_id = ? AND scope = ?",
      ).run(req.userId, scope);
      return { ok: true, scope };
    },
  });
}
