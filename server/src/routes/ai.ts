import { callUnifiedAi, OllamaError, parseJsonObject } from "../lib/aiClient.js";
export { callUnifiedAi } from "../lib/aiClient.js";
export { buildDictationSystemPrompt, getUserPrompt } from "../lib/taskPreparation.js";
import { INSTRUCTION_DEFAULTS } from "../runtime/instructionDefaults.js";
import { renderInstruction, applyOverride, revision, ownerPromptKey } from "../lib/roleContextResolver.js";
import db from "../db.js";
import { prepareTask, parseRole, parseWhere, buildDictationSystemPrompt, getUserPrompt } from "../lib/taskPreparation.js";
export { prepareTaskCard as structureDictationToCards } from "../lib/taskPreparation.js";
export type { DictationCards, DictationChild } from "../lib/taskPreparation.js";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, visibleScope } from "../access.js";
import { OBSERVER_SYSTEM_PROMPT } from "./activity.js";
import { ROLE_NAMES, rolesPromptBlock, type RoleName } from "../roleRouting.js";

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

const SYSTEM_PROMPT = INSTRUCTION_DEFAULTS["ai.subtasks"];

const STRUCTURE_SYSTEM_PROMPT = INSTRUCTION_DEFAULTS["ai.structure"];

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
// Шаблон постановки (владелец 22–23.09.2026): каркас карточки с подсказкой
// в каждом поле, исполнители одной строкой и два примера. Заменил длинную
// инструкцию: вместе со слоем владельца та занимала ~13 тыс. знаков, и
// модель к концу теряла начало. Проба на 14 надиктовках — ~/intake-lab.
const DICTATION_SYSTEM_PROMPT = INSTRUCTION_DEFAULTS["owner.task_intake"];

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

const EXTRACT_TASKS_SYSTEM_PROMPT = INSTRUCTION_DEFAULTS["owner.extract_tasks"];

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


async function suggestSubtasks(
  title: string,
  description: string | null | undefined,
  provider?: string,
  localModel?: string,
  aiModel?: string,
): Promise<string[]> {
  const content = await callUnifiedAi({
    systemPrompt: renderInstruction("secretary", "ai.subtasks", {}),
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


/** Достаёт JSON-объект из сырого ответа модели — тем же способом, что и
 *  соседние разборы: сначала как есть, потом по первой '{' и последней '}'. */



/** Роль из ответа модели — только из восьми канонических, иначе null. */

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

/** Подставить живой список ролей на место {{ИСПОЛНИТЕЛИ}} (таблица roles):
 *  новая роль сразу видна Секретарю, отключённая — пропадает. */
export function withRoles(prompt: string): string {
  return prompt.split("{{ИСПОЛНИТЕЛИ}}").join(rolesPromptBlock());
}

/**
 * Роль для карточки, заведённой РУКАМИ (или агентом), — той же моделью и
 * по тем же разделам шаблона, что у Секретаря (владелец 23.09.2026: «чтобы
 * не было большой разницы, ручками я задачу делаю или через секретаря»).
 *
 * Разделы «ИСПОЛНИТЕЛИ» и «ГДЕ» берутся из действующего текста постановки
 * (свой текст владельца, иначе шаблон) — одна правка в «Постановке задач»
 * действует на оба пути. null — модель не ответила или ответ не разобран:
 * тогда вызывающий берёт прежний подбор по словам.
 */
export async function pickRoleByModel(
  task: { title: string; description: string | null; subtasks: string[] },
  ownerId: string | null,
): Promise<{ role: RoleName | null; roleReason: string; where: string | null } | null> {
  // В тестах живую модель не зовём: она на .110 и грузится до минуты.
  // Тесты, которым подбор нужен, подменяют эту функцию.
  if (process.env.VITEST) return null;
  const source = withRoles(
    (ownerId ? await getUserPrompt(ownerId, "task_intake") : "").trim() || DICTATION_SYSTEM_PROMPT,
  );
  const section = (text: string, from: string, to: string): string => {
    const a = text.indexOf(from);
    if (a < 0) return "";
    const b = to ? text.indexOf(to, a + from.length) : -1;
    return text.slice(a, b > a ? b : undefined).trim();
  };
  const roles =
    section(source, "ИСПОЛНИТЕЛИ", "ПРИМЕРЫ") ||
    section(withRoles(DICTATION_SYSTEM_PROMPT), "ИСПОЛНИТЕЛИ", "ПРИМЕРЫ");
  const whereRule =
    section(source, "ГДЕ:", "НИЧЕГО НЕ ТЕРЯЙ") ||
    section(DICTATION_SYSTEM_PROMPT, "ГДЕ:", "НИЧЕГО НЕ ТЕРЯЙ");
  const systemPrompt =
    "Ты — секретарь. Для готовой карточки задачи выбери исполнителя и платформу.\n\n" +
    `${roles}\n\n${whereRule}\n\n` +
    'Верни ТОЛЬКО JSON: {"role": "исполнитель из списка или null", ' +
    '"role_reason": "почему он — одной фразой по сути работы", ' +
    '"where": "не указано | iphone | web | server | личное"}';
  const steps = task.subtasks.length
    ? `\nШаги:\n${task.subtasks.map((t) => `- ${t}`).join("\n")}`
    : "";
  try {
    const content = await callUnifiedAi({
      systemPrompt,
      userPrompt: `Карточка:\nНазвание: ${task.title}\nОписание: ${task.description ?? ""}${steps}`,
      temperature: 0.2,
      predictTokens: 400,
    });
    const parsed = parseJsonObject(content);
    return {
      role: parseRole(parsed?.role),
      roleReason: typeof parsed?.role_reason === "string" ? parsed.role_reason.trim() : "",
      where: parseWhere(parsed?.where),
    };
  } catch (err) {
    console.warn("подбор роли моделью не удался:", err);
    return null;
  }
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

export async function extractTasksFromText(
  text: string,
  provider?: string,
  localModel?: string,
  aiModel?: string,
  /** Опциональное per-user дополнение к дефолтному системному промпту
   *  (подмешивается через "\n\n# Дополнение от пользователя:\n"). Карточка
   *  04c916c8: пусто или undefined = вызов без дополнения. */
  userSystemPrompt?: string,
  /** Потолок входного текста. Дефолт 6000 — для диктовки; вложениям надо
   *  больше, вызывающий поднимает явно. */
  maxChars = 6000,
): Promise<ExtractedTaskResult[]> {
  const content = await callUnifiedAi({
    systemPrompt: composeSystemPrompt(
      EXTRACT_TASKS_SYSTEM_PROMPT,
      userSystemPrompt,
    ),
    userPrompt: text.trim().slice(0, maxChars),
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

export function registerAiRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;
  app.post("/api/task-preparation/prepare", { preHandler: authPre }, async (req:any, reply) => {
    if (typeof req.body?.text!=="string" || !req.body.text.trim() || req.body.text.length>12000) return reply.code(400).send({error:"Нужен текст до 12000 символов"});
    if (req.body.context!==undefined && typeof req.body.context!=="string") return reply.code(400).send({error:"context должен быть строкой"});
    if (req.body.source_record_id!==undefined && (typeof req.body.source_record_id!=="string" || req.body.source_record_id.length>256)) return reply.code(400).send({error:"source_record_id должен быть строкой до 256 символов"});
    // Каталог только доступных вызывающему проектов, без утечки чужих названий.
    const scope=visibleScope(req.userId,"owner_id");
    const projects = db.prepare(`SELECT id,name FROM projects WHERE ${scope.sql} ORDER BY name`).all(...scope.params) as Array<{id:string;name:string}>;
    try {
      return await prepareTask(req.body.text,projects,{ownerId:req.userId,context:req.body.context,sourceRecordId:req.body.source_record_id,maxChars:12000,provider:req.body.provider,localModel:req.body.localModel,aiModel:req.body.aiModel});
    } catch(error:any) { return reply.code(502).send({error:error.message}); }
  });


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
        const scope=visibleScope(req.userId,"owner_id");
        const projects=db.prepare(`SELECT id,name FROM projects WHERE ${scope.sql}`).all(...scope.params) as Array<{id:string;name:string}>;
        const prepared=await prepareTask(text,projects,{ownerId:req.userId,provider,localModel,aiModel});
        if (!prepared.card) return reply.code(422).send({error:prepared.question || "В сообщении нет поручения",...prepared});
        const c=prepared.card;
        return {title:c.title,description:c.description,subtasks:c.subtasks,dueDate:c.dueDate,priority:c.priority,preparation:c.preparation,question:c.question,children:c.children};
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
        // Штатные серверные промпты по скоупам — приложение показывает их
        // полупрозрачным placeholder'ом в окошке, чтобы владелец видел, из
        // чего состоит системный промпт. Пустое поле = применяется этот.
        defaults: {
          extract_tasks: EXTRACT_TASKS_SYSTEM_PROMPT,
          // Слой владельца «как собирать постановку» (scope task_intake):
          // стиль названия, глубина разбиения, когда одна карточка, а когда
          // дерево. Подмешивается в structureDictationToCards.
          task_intake: DICTATION_SYSTEM_PROMPT,
          journal_assist: (
            Object.entries(JOURNAL_ASSIST_PROMPTS) as [
              string,
              string,
            ][]
          )
            .map(([action, text]) => `# ${action}\n${text}`)
            .join("\n\n"),
          activity: OBSERVER_SYSTEM_PROMPT,
        },
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
      if (["task_intake","extract_tasks"].includes(scope)) {
        applyOverride({scope:"role",roleKey:"secretary",layer:"owner."+scope,text:prompt,action:prompt.trim() ? "set" : "reset",createdBy:req.userId,expectedVersion:revision("role","secretary","owner."+scope,req.userId),sourceKind:"db",sourceRef:"user_ai_prompts"});
      }
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
      if (["task_intake","extract_tasks"].includes(scope)) applyOverride({scope:"role",roleKey:"secretary",layer:"owner."+scope,text:"",action:"reset",createdBy:req.userId,expectedVersion:revision("role","secretary","owner."+scope,req.userId),sourceKind:"db",sourceRef:"user_ai_prompts"});
      const db = (await import("../db.js")).default;
      db.prepare(
        "DELETE FROM user_ai_prompts WHERE user_id = ? AND scope = ?",
      ).run(req.userId, scope);
      return { ok: true, scope };
    },
  });
}
