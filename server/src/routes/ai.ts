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

async function callUnifiedAi(opts: {
  systemPrompt: string;
  userPrompt: string;
  provider?: string;
  localModel?: string;
  aiModel?: string;
  temperature?: number;
}): Promise<string> {
  const provider = (opts.provider || "local").toLowerCase();
  const requestedModel = opts.aiModel;

  // 1. Claude Code / Anthropic
  if (provider === "claude" && process.env.ANTHROPIC_API_KEY) {
    const claudeModel = requestedModel || process.env.CLAUDE_MODEL || "claude-sonnet-4.6";
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
    const hermesModel = requestedModel || process.env.HERMES_MODEL || "nousresearch/hermes-3-llama-3.1-405b";
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
    const deepseekModel = requestedModel || process.env.DEEPSEEK_MODEL || "deepseek-chat";
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

  // 4. Antigravity / Gemini
  if (provider === "antigravity" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const geminiModel = requestedModel || process.env.GEMINI_MODEL || "gemini-3.1-pro";
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${opts.systemPrompt}\n\n${opts.userPrompt}` }] }],
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
      console.warn("Antigravity/Gemini error, falling back to local Ollama:", e);
    }
  }

  // Default: Local Ollama on 192.168.1.110
  const targetModel = opts.localModel || process.env.OLLAMA_MODEL || "coder30b-abl:latest";
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: "system", content: `${opts.systemPrompt}\nРассуждай кратко. Верни СТРОГО результат.` },
          { role: "user", content: opts.userPrompt },
        ],
        stream: false,
        options: {
          num_ctx: 8192,
          num_predict: 2048,
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
    throw new OllamaError(`Локальная модель ${targetModel} ответила ошибкой (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as any;
  let content: string =
    data?.message?.content ||
    data?.choices?.[0]?.message?.content ||
    "";

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
const summaryCache = new Map<string, { summary: WeeklySummary; timestamp: number }>();

async function generateWeeklySummary(
  userId: string,
  provider?: string,
  localModel?: string,
  aiModel?: string,
): Promise<WeeklySummary> {
  const db = (await import("../db.js")).default;

  const completedRows = db
    .prepare(
      `SELECT title, description, completed_at 
       FROM tasks 
       WHERE user_id = ? AND status = 'completed' AND completed_at >= datetime('now', '-7 days')
       ORDER BY completed_at DESC 
       LIMIT 25`
    )
    .all(userId) as any[];

  const overdueRows = db
    .prepare(
      `SELECT title, description, due_date, priority 
       FROM tasks 
       WHERE user_id = ? AND status = 'active' AND due_date IS NOT NULL AND due_date < date('now')
       ORDER BY priority ASC, due_date ASC 
       LIMIT 15`
    )
    .all(userId) as any[];

  const activeRows = db
    .prepare(
      `SELECT title, description, due_date, priority 
       FROM tasks 
       WHERE user_id = ? AND status = 'active'
       ORDER BY priority ASC, (due_date IS NULL) ASC, due_date ASC 
       LIMIT 20`
    )
    .all(userId) as any[];

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
    systemPrompt: "Ты — аналитический AI-ассистент. Отвечай СТРОГО валидным JSON-объектом.",
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
    accomplishments: Array.isArray(parsed.accomplishments) ? parsed.accomplishments.map(String) : [],
    missed_or_overdue: Array.isArray(parsed.missed_or_overdue) ? parsed.missed_or_overdue.map(String) : [],
    next_week_focus: Array.isArray(parsed.next_week_focus) ? parsed.next_week_focus.map(String) : [],
    productivity_score: typeof parsed.productivity_score === "number" ? Math.min(100, Math.max(0, parsed.productivity_score)) : 80,
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
    title: typeof parsed?.title === "string" ? parsed.title.trim() : rawText.slice(0, 50),
    description: typeof parsed?.description === "string" ? parsed.description.trim() : rawText,
    subtasks: Array.isArray(parsed?.subtasks)
      ? parsed.subtasks.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0)
      : [],
    dueDate: typeof parsed?.due_date === "string" ? parsed.due_date.trim() : null,
    priority: typeof parsed?.priority === "number" && parsed.priority >= 1 && parsed.priority <= 4 ? parsed.priority : 4,
  };
}

export function registerAiRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Список доступных локальных моделей в Ollama
  app.get("/api/ai/local-models", {
    preHandler: authPre,
    handler: async () => {
      try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return { models: [] };
        const data = (await res.json()) as any;
        const models = (data.models || [])
          .filter((m: any) => m.name && !m.name.includes("embed"))
          .map((m: any) => ({
            name: m.name,
            size: m.size,
            details: m.details,
          }));
        return { models };
      } catch {
        return { models: [] };
      }
    },
  });

  // Получить недельную сводку (из кэша или сгенерировать)
  app.get<{ Querystring: { provider?: string; localModel?: string; aiModel?: string } }>("/api/ai/weekly-summary", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const provider = String(req.headers["x-ai-provider"] || req.query?.provider || "local");
      const localModel = String(req.headers["x-ollama-model"] || req.query?.localModel || "");
      const aiModel = String(req.headers["x-ai-model"] || req.query?.aiModel || "");
      const cacheKey = `${req.userId}:${provider}:${localModel}:${aiModel}`;
      const cached = summaryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 6 * 3600 * 1000) {
        return cached.summary;
      }
      try {
        const summary = await generateWeeklySummary(req.userId, provider, localModel, aiModel);
        summaryCache.set(cacheKey, { summary, timestamp: Date.now() });
        return summary;
      } catch (err: any) {
        if (cached) return cached.summary;
        return reply.code(502).send({ error: err?.message || "Не удалось сгенерировать недельную сводку" });
      }
    },
  });

  // Принудительное обновление недельной сводки
  app.post<{ Body: { provider?: string; localModel?: string; aiModel?: string } }>("/api/ai/weekly-summary/refresh", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const provider = String(req.headers["x-ai-provider"] || req.body?.provider || "local");
      const localModel = String(req.headers["x-ollama-model"] || req.body?.localModel || "");
      const aiModel = String(req.headers["x-ai-model"] || req.body?.aiModel || "");
      const cacheKey = `${req.userId}:${provider}:${localModel}:${aiModel}`;
      try {
        const summary = await generateWeeklySummary(req.userId, provider, localModel, aiModel);
        summaryCache.set(cacheKey, { summary, timestamp: Date.now() });
        return summary;
      } catch (err: any) {
        return reply.code(502).send({ error: err?.message || "Не удалось обновить недельную сводку" });
      }
    },
  });

  // Структурирование надиктованной задачи через выбранный AI Мозг
  app.post<{ Body: { text: string; provider?: string; localModel?: string; aiModel?: string } }>("/api/ai/structure-task", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const provider = String(req.headers["x-ai-provider"] || req.body?.provider || "local");
      const localModel = String(req.headers["x-ollama-model"] || req.body?.localModel || "");
      const aiModel = String(req.headers["x-ai-model"] || req.body?.aiModel || "");
      if (!text) {
        return reply.code(400).send({ error: "Текст диктовки не может быть пустым" });
      }

      try {
        const result = await structureTask(text, provider, localModel, aiModel);
        return result;
      } catch (err: any) {
        return reply.code(502).send({ error: err?.message || "Не удалось структурировать задачу" });
      }
    },
  });

  // Существующая задача — разбивка на подзадачи
  app.post<{
    Params: { id: string };
    Body: { title?: string; description?: string; provider?: string; localModel?: string } | undefined;
  }>("/api/tasks/:id/suggest-subtasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const provider = String(req.headers["x-ai-provider"] || req.body?.provider || "local");
      const localModel = String(req.headers["x-ollama-model"] || req.body?.localModel || "");
      const aiModel = String(req.headers["x-ai-model"] || req.body?.aiModel || "");
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
        const subtasks = await suggestSubtasks(title, description, provider, localModel, aiModel);
        return { subtasks };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось получить подзадачи" });
      }
    },
  });

  // Черновик задачи
  app.post<{ Body: { title?: string; description?: string; provider?: string; localModel?: string; aiModel?: string } }>(
    "/api/ai/suggest-subtasks",
    {
      preHandler: authPre,
      handler: async (req: any, reply) => {
        const provider = String(req.headers["x-ai-provider"] || req.body?.provider || "local");
        const localModel = String(req.headers["x-ollama-model"] || req.body?.localModel || "");
        const aiModel = String(req.headers["x-ai-model"] || req.body?.aiModel || "");
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
          const subtasks = await suggestSubtasks(title, description, provider, localModel, aiModel);
          return { subtasks };
        } catch (err: any) {
          return reply
            .code(502)
            .send({ error: err?.message || "Не удалось получить подзадачи" });
        }
      },
    },
  );
}
