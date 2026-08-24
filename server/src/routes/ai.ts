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

async function suggestSubtasks(
  title: string,
  description: string | null | undefined,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(title, description) },
        ],
        stream: false,
        options: {
          num_ctx: 16384,
          temperature: 0.4,
        },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new OllamaError(
        "Локальная модель не ответила вовремя. Попробуйте ещё раз.",
      );
    }
    throw new OllamaError(
      "Не удалось связаться с локальной моделью (Ollama). Проверьте, что она запущена.",
    );
  }

  if (!res.ok) {
    // 404 от Ollama обычно означает "модель не загружена".
    throw new OllamaError(
      `Локальная модель ответила ошибкой (HTTP ${res.status}). Проверьте, что модель "${OLLAMA_MODEL}" загружена в Ollama.`,
    );
  }

  const data = (await res.json()) as any;
  const content: string | undefined =
    data?.message?.content || data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new OllamaError("Модель вернула пустой ответ.");
  }

  try {
    return parseSubtasks(content);
  } catch {
    throw new OllamaError(
      "Не удалось разобрать ответ модели как список подзадач. Попробуйте ещё раз.",
    );
  }
}

export function registerAiRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Существующая задача — берём title/description из БД, но тело запроса
  // может их переопределить: в форме редактирования пользователь мог
  // поправить заголовок/описание и ещё не сохранить их, а разбивать хочет
  // уже по свежему тексту.
  app.post<{
    Params: { id: string };
    Body: { title?: string; description?: string } | undefined;
  }>("/api/tasks/:id/suggest-subtasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

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
        const subtasks = await suggestSubtasks(title, description);
        return { subtasks };
      } catch (err: any) {
        return reply
          .code(502)
          .send({ error: err?.message || "Не удалось получить подзадачи" });
      }
    },
  });

  // Черновик задачи, которая ещё не создана (форма создания, без id).
  app.post<{ Body: { title?: string; description?: string } }>(
    "/api/ai/suggest-subtasks",
    {
      preHandler: authPre,
      handler: async (req: any, reply) => {
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
          const subtasks = await suggestSubtasks(title, description);
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
