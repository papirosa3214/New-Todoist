// POST /api/tasks/:id/activity — живой поток действий агента.
//
// Максим 25.08.2026: «меня раздражает абсолютное непонимание, чем занимается
// в данный момент агент… я должен видеть, куда он полез, что начал делать».
// На доске видно только «работает» и крутилку у шага — этого мало.
//
// ПОЧЕМУ НЕ task_events. Журнал — это факты пути задачи (claimed,
// subtask_done, state_changed), их за месяцы накопилось около полутора
// тысяч. Действий агента будет столько же за час активной работы: лента в
// карточке утонет, а индекс по (task_id, created_at) перестанет спасать.
// AGENT-PROTOCOL.md разделяет комментарий («то, что кто-то решил написать»)
// и журнал («то, что случилось»); телеметрия не является ни тем, ни другим.
// Поэтому здесь СВОЙ канал: кольцевой буфер в памяти + вещание по WS, в базу
// не пишется ничего и миграций нет.
//
// ЧТО ПОКАЗЫВАЕМ. Не сырой вызов инструмента, а намерение, собранное из двух
// слоёв (третий — интерпретация локальной моделью — отдельный шаг):
//   слой 1: название шага, над которым агент работает прямо сейчас;
//   слой 2: типизация глагола по инструменту и по пути/команде.
// «Read JournalScreen.tsx» немо, «Клавиатура в Дневнике · разбирается в
// JournalScreen.tsx» — нет.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { getTaskForWrite } from "../access.js";
import { broadcastToUsers } from "../ws.js";
import { hydrateTask, getTaskRow } from "./tasks.js";

export type ActivityKind =
  | "read"
  | "edit"
  | "write"
  | "search"
  | "run"
  | "think"
  | "web"
  | "image"
  | "test"
  | "build"
  | "git"
  | "attach";

const KINDS: ActivityKind[] = [
  "read",
  "edit",
  "write",
  "search",
  "run",
  "think",
  "web",
  "image",
  "test",
  "build",
  "git",
  "attach",
];

/** Сколько действий помним на задачу — хватает на раскрывающийся список. */
const RING = 50;
/** Не чаще одного вещания в это окно: при массовом Read их десятки в секунду. */
const EMIT_THROTTLE_MS = 2000;
/** Буфер брошенной задачи умирает сам, без чьей-либо уборки. */
const TTL_MS = 30 * 60 * 1000;

interface Action {
  kind: ActivityKind;
  target: string;
  detail?: string;
  actor: string;
  at: number;
  /** Кусок правки — материал для модели НА ТЕЛЕФОНЕ, которая объясняет,
   *  что агент делает (25.08.2026: «правит он что, блядь? Файл правит,
   *  какую... что это такое вообще?»). По одному имени файла ответить
   *  нечего, нужен сам текст изменения. Хранится обрезанным и
   *  замаскированным: он уходит в чужой процесс и в промпт модели. */
  diff?: string;
}

interface Entry {
  actions: Action[];
  lastEmitAt: number;
  lastText: string;
  /** Сколько действий уже отдавали наблюдателю (тикет ollama-observer) —
   * чтобы не спрашивать модель повторно про тот же хвост буфера. */
  observerSeenCount?: number;
  /** Запрос к Ollama уже летит — второй за тот же тик не запускаем. */
  observerPending?: boolean;
  /** Когда карточку задачи в последний раз ЧИТАЛИ (GET activity). Максим
   * 26.08.2026: интерпретация моделью нужна, только пока он реально
   * смотрит в карточку — фоном гонять Ollama незачем. Клиент, пока
   * карточка открыта, шлёт GET периодически (useTaskActivity), так что
   * свежесть этой метки и есть «на задачу смотрят». */
  lastWatchedAt?: number;
}

const buffers = new Map<string, Entry>();

/**
 * Маскирование секретов — ДО того, как строка ляжет в буфер.
 *
 * В Bash регулярно летят ключи и токены. Строка уходит не только в браузер,
 * но и в промпт локальной модели-интерпретатора, поэтому чистим на входе, а
 * не при показе: иначе один забытый путь показа сливает ключ.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b[0-9a-f]{24,}\b/gi, "***")
    .replace(/\b(tf_|sk-|ghp_|gho_)[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/(--?(?:token|key|secret|password|pass)[= ])\S+/gi, "$1***")
    .replace(/(Bearer\s+)\S+/gi, "$1***");
}

/** Команда целиком не нужна: имя и первые аргументы уже говорят, что идёт. */
function shortCommand(cmd: string): string {
  const clean = maskSecrets(cmd.trim().replace(/\s+/g, " "));
  const parts = clean.split(" ");
  const head = parts.slice(0, 3).join(" ");
  return head.length > 48 ? head.slice(0, 47) + "…" : head;
}

/**
 * Кусок правки для модели: маскируем и режем.
 *
 * Предел жёсткий — модель на телефоне работает с коротким контекстом, а
 * длинный дифф её только замедлит и уведёт в пересказ вместо сути. Берём
 * начало: там объявление функции и первые изменённые строки, то есть ровно
 * то, по чему видно, ЧТО меняется.
 */
const DIFF_LIMIT = 400;

function shortDiff(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = maskSecrets(raw).trim();
  if (!clean) return undefined;
  return clean.length > DIFF_LIMIT ? clean.slice(0, DIFF_LIMIT) + "…" : clean;
}

/** Абсолютный путь занимает всю ширину экрана телефона и ничего не добавляет. */
function shortPath(p: string): string {
  const clean = maskSecrets(p.trim());
  const m = clean.match(/(?:^|\/)((?:src|server|ios|scripts)\/.*)$/);
  return m ? m[1] : clean.split("/").slice(-2).join("/");
}

/**
 * Слой 2 — глагол. Детерминированная таблица, никакой модели: инструмент
 * плюс расширение файла уже отвечают на «что он делает», а промах здесь
 * дороже, чем сухость.
 */
function verbFor(a: Action): string {
  const t = a.target.toLowerCase();
  switch (a.kind) {
    case "search":
      return "ищет";
    case "edit":
      return "правит";
    case "write":
      return "создаёт";
    case "think":
      return "обдумывает";
    case "web":
      return "смотрит в сети";
    case "image":
      return "разглядывает картинку";
    case "test":
      return "прогоняет тесты";
    case "build":
      return "собирает";
    case "git":
      return "работает с историей";
    case "attach":
      return "прикладывает";
    case "run": {
      const c = (a.detail || a.target).toLowerCase();
      if (/\b(test|vitest|jest|pytest)\b/.test(c)) return "проверяет";
      if (/^git\b/.test(c)) return "сверяет историю";
      if (/\b(build|tsc|vite)\b/.test(c)) return "собирает";
      return "запускает";
    }
    default:
      break;
  }
  if (/\.test\.[tj]sx?$/.test(t)) return "проверяет поведение";
  if (/\.md$/.test(t)) return "сверяется с документацией";
  return "разбирается в";
}

/** Активный шаг — тот, что сервер СЧИТАЕТ идущим (withSubtaskState). */
function runningStepTitle(task: any): string | null {
  const step = (task?.subtasks || []).find((s: any) => s.state === "running");
  const title = (step?.title || "").trim();
  if (!title) return null;
  return title.length > 40 ? title.slice(0, 39) + "…" : title;
}

/** Русское склонение «файл» — иначе «11 файла» режет глаз в карточке. */
function pluralFiles(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "файл";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "файла";
  return "файлов";
}

/**
 * Схлопывание: подряд идущие однотипные действия в одной папке — это одно
 * занятие, а не пять. «читает 4 файла в src/api» вместо четырёх строк.
 * Считаем РАЗНЫЕ файлы, не действия: десять Read одного и того же файла —
 * это не «10 файлов», это перечитывание одного.
 */
function collapse(actions: Action[]): string {
  const last = actions[actions.length - 1];
  const dir = last.target.includes("/")
    ? last.target.slice(0, last.target.lastIndexOf("/"))
    : "";
  const targets = new Set<string>();
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    const aDir = a.target.includes("/")
      ? a.target.slice(0, a.target.lastIndexOf("/"))
      : "";
    if (a.kind !== last.kind || aDir !== dir) break;
    if (last.at - a.at > 30_000) break;
    targets.add(a.target);
  }
  const verb = verbFor(last);
  const same = targets.size;
  if (same >= 3 && dir) return `${verb} ${same} ${pluralFiles(same)} в ${dir}`;
  if (last.kind === "run") return `${verb}: ${last.detail || last.target}`;
  return `${verb} ${last.target}`;
}

/** Слой 1 + слой 2 вместе: контекст шага впереди, действие следом. */
export function buildText(task: any, actions: Action[]): string {
  const body = collapse(actions);
  const step = runningStepTitle(task);
  return step ? `${step} · ${body}` : body;
}

/**
 * Человеческая формулировка ОДНОГО действия: глагол слоя 2 плюс цель.
 * «разбирается в src/lib/search.ts», а не «src/lib/search.ts».
 */
export function describeAction(a: Action): string {
  const verb = verbFor(a);
  if (a.kind === "run") return `${verb}: ${a.detail || a.target}`;
  return `${verb} ${a.target}`;
}

/** Последние действия задачи — для раскрывающегося списка в карточке. */
export function recentActivity(taskId: string) {
  const metrics = taskStopMetrics(taskId);
  const e = buffers.get(taskId);
  if (!e) return { text: null, actions: [] as Action[], metrics };
  // Каждому действию — ГОТОВАЯ формулировка, а не голый путь. Владелец
  // 25.08.2026, увидев раскрытый список на телефоне: «нахуя мне вот эта
  // сырая хуета». Он прав: наверху строка шла с глаголом, а внутри сыпались
  // `src/lib/search.ts` и `npm test` — тот самый перечень вызовов, вместо
  // которого всё и затевалось. Клиент печатает text как есть.
  return {
    text: e.lastText,
    actions: e.actions
      .slice(-20)
      .map((a) => ({ ...a, text: describeAction(a) })),
    metrics,
  };
}

/**
 * Сводка контура для владельца. Это агрегаты по задаче, а не телеметрия
 * каждого shell-вызова: очередь считается от создания до первого claim,
 * содержательные попытки — строками attempts, технические повторы — своей
 * таблицей, потери аренды — структурированным исходом, возвраты — review с
 * verdict=changes_requested.
 */
export function taskStopMetrics(taskId: string) {
  const task = db
    .prepare("SELECT created_at FROM tasks WHERE id = ?")
    .get(taskId) as { created_at?: string } | undefined;
  const firstClaim = db
    .prepare(
      `SELECT created_at FROM task_events
        WHERE task_id = ? AND kind = 'claimed'
        ORDER BY created_at, rowid LIMIT 1`,
    )
    .get(taskId) as { created_at?: string } | undefined;
  const attempts = db
    .prepare(
      "SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND subtask_id IS NULL",
    )
    .get(taskId) as { n: number };
  const retries = db
    .prepare(
      `SELECT COUNT(*) AS n FROM attempt_retries r
         JOIN attempts a ON a.id = r.attempt_id
        WHERE a.task_id = ? AND a.subtask_id IS NULL`,
    )
    .get(taskId) as { n: number };
  const leaseLosses = db
    .prepare(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ? AND subtask_id IS NULL
          AND (reason_code = 'lease_expired' OR outcome = 'lease_expired')`,
    )
    .get(taskId) as { n: number };
  const versionReturns = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reviews
        WHERE task_id = ? AND verdict = 'changes_requested'`,
    )
    .get(taskId) as { n: number };
  const queueDelta =
    task?.created_at && firstClaim?.created_at
      ? (db
          .prepare("SELECT strftime('%s', ?) - strftime('%s', ?) AS n")
          .get(firstClaim.created_at, task.created_at) as { n: number })
      : undefined;
  const queueSeconds = queueDelta ? Math.max(0, Number(queueDelta.n)) : null;
  const substantiveAttempts = Number(attempts.n || 0);
  const repeatedAttempts = Math.max(0, substantiveAttempts - 1);
  return {
    queue_time_seconds: queueSeconds,
    substantive_attempts: substantiveAttempts,
    repeated_substantive_attempts: repeatedAttempts,
    repeated_attempt_rate:
      substantiveAttempts > 0 ? repeatedAttempts / substantiveAttempts : 0,
    technical_retries: Number(retries.n || 0),
    lease_losses: Number(leaseLosses.n || 0),
    result_version_returns: Number(versionReturns.n || 0),
  };
}

/** Задачу отдали или аренда протухла — строка должна погаснуть. */
export function clearActivity(taskId: string) {
  buffers.delete(taskId);
}

function sweep(now: number) {
  for (const [id, e] of buffers) {
    const last = e.actions[e.actions.length - 1];
    if (!last || now - last.at > TTL_MS) buffers.delete(id);
  }
}

// ═══════════ Слой 3 (тикет ollama-observer) — намерение, а не перечень ═══════
//
// Улучшение поверх слоёв 1-2, не замена: если модель не ответила, ответила
// ошибкой, простынёй или её выключили — buildText() слоёв 1-2 остаётся как
// ни в чём не бывало. Инвариант из тикета: наблюдатель никогда не является
// условием того, что строка вообще существует.
//
// Раз в OBSERVER_INTERVAL_MS сервер сам смотрит, у каких задач в буфере
// появились НОВЫЕ действия с прошлого раза, и спрашивает у локальной
// модели одну короткую фразу вместо них — «читает JournalScreen.tsx» →
// «разбирается, почему тап не попадает в contenteditable».
const OBSERVER_ENABLED =
  (process.env.ACTIVITY_OBSERVER_ENABLED ?? "true") !== "false";
// Свой URL/модель, не общие с server/src/routes/ai.ts (там свой сценарий —
// разбивка задачи на подзадачи): наблюдателя должно быть можно выключить
// или переключить на другую модель одной строкой конфига, не трогая тот
// путь. База совпадает по умолчанию — тот же домашний Ollama на .110.
const OBSERVER_BASE_URL = (
  process.env.OLLAMA_BASE_URL || "http://192.168.1.110:11434"
).replace(/\/+$/, "");
// 25.08.2026: дефолт был coder30b-abl:latest — роняет llama-server на любом
// не-тривиальном промпте (CUDA illegal memory access, похоже битый GGUF —
// см. комментарий в routes/ai.ts, тот же день). qwen3.6-27b-iq4-16k — уже
// принятая в проекте замена; think:false обязателен, иначе «думающая»
// модель тратит 60-70с на один ответ вместо ~10с (тот же комментарий).
const OBSERVER_MODEL =
  process.env.ACTIVITY_OBSERVER_MODEL || "qwen3.6-27b-iq4-16k:latest";
const OBSERVER_INTERVAL_MS = 5_000;
const OBSERVER_TIMEOUT_MS = 25_000;
/** Сколько живёт метка «на задачу смотрят» после последнего GET. Клиент
 * при открытой карточке перечитывает activity раз в WATCH_HEARTBEAT
 * (15 с, см. useTaskActivity) — 45 с покрывают два пропущенных стука. */
const WATCH_TTL_MS = 45_000;
/** «Простыня» — сигнал отклонить ответ целиком, а не обрезать (тикет:
 * обрезанный мусор хуже, чем строка слоёв 1-2). Заметно выше целевых ~60
 * символов из тикета, чтобы не резать честный ответ впритык. */
const OBSERVER_MAX_CHARS = 70;

export const OBSERVER_SYSTEM_PROMPT =
  "Ты наблюдаешь за работой ИИ-агента над задачей в трекере. По названию " +
  "задачи, текущему шагу и списку последних технических действий выдай " +
  "ОДНУ короткую фразу по-русски (до 60 символов) о том, ЗАЧЕМ агент это " +
  "делает — намерение, а не пересказ вызовов. Без кавычек, без markdown, " +
  "без пояснений — только сама фраза.";

/** Технический факт для промпта модели — не для показа человеку, поэтому
 * годится тот же глагол слоя 2, просто разложенный подробнее. */
function describeForPrompt(a: Action): string {
  const verb = verbFor(a);
  return a.detail ? `${verb} ${a.target}: ${a.detail}` : `${verb} ${a.target}`;
}

/** Первая задача с необсмотренным хвостом буфера — не занятая прошлым
 * запросом и (26.08.2026) ТОЛЬКО та, на которую сейчас смотрят: карточка
 * открыта — клиент недавно стучался GET'ом (lastWatchedAt свежий). Фоном
 * модель не гоняем — некому показывать. Один кандидат за тик: локальная
 * модель на .110 общая, гонять её параллельно на несколько задач разом —
 * тратить чужую видеопамять ради строки, которую никто не видит. */
function pickObserverCandidate(): [string, Entry] | null {
  const now = Date.now();
  for (const [taskId, entry] of buffers) {
    if (entry.observerPending) continue;
    if (entry.actions.length === 0) continue;
    if (entry.actions.length <= (entry.observerSeenCount ?? 0)) continue;
    if (!entry.lastWatchedAt || now - entry.lastWatchedAt > WATCH_TTL_MS)
      continue;
    return [taskId, entry];
  }
  return null;
}

async function interpretOnce(): Promise<void> {
  if (!OBSERVER_ENABLED) return;
  const picked = pickObserverCandidate();
  if (!picked) return;
  const [taskId, entry] = picked;
  const consumedCount = entry.actions.length;
  entry.observerPending = true;
  try {
    const task = hydrateTask(getTaskRow(taskId));
    // Задачу отдали или аренда протухла, пока фраза летела, — брифинг для
    // никого, буфер туда же, куда его гасят POST/GET (см. clearActivity).
    if (!task || task.agent_state !== "in_progress" || task.agent_stale) {
      clearActivity(taskId);
      return;
    }

    const recent = entry.actions.slice(-8);
    const step = runningStepTitle(task);

    // Пользовательский промпт владельца для расшифровки (scope 'activity').
    // Пусто/нет строки — работаем штатным серверным, как раньше. Смысл
    // промпта — стиль и акцент фразы; решение «что делать» он не меняет.
    let observerSystem = OBSERVER_SYSTEM_PROMPT;
    try {
      const row = db
        .prepare(
          "SELECT prompt FROM user_ai_prompts WHERE user_id = ? AND scope = 'activity'",
        )
        .get(task.creator_id) as { prompt?: string } | undefined;
      const custom = (row?.prompt || "").trim();
      if (custom) observerSystem = custom;
    } catch {
      // нет таблицы/строки — не повод терять расшифровку, остаёмся на штатном
    }

    const userPrompt =
      `Задача: ${task.title}\n` +
      (step ? `Текущий шаг: ${step}\n` : "") +
      `Последние действия агента:\n${recent.map(describeForPrompt).join("\n")}`;

    const res = await fetch(`${OBSERVER_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OBSERVER_MODEL,
        messages: [
          { role: "system", content: observerSystem },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        think: false,
        options: { num_ctx: 4096, num_predict: 64, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(OBSERVER_TIMEOUT_MS),
    });

    // С этой точки запрос состоялся (пусть и с ошибкой ответа) — повторно
    // спрашивать про ТЕ ЖЕ действия смысла нет, помечаем спрошенными и ждём
    // новых. Сетевой сбой/таймаут до этой строки НЕ помечает — как только
    // Ollama вернётся, тот же хвост стоит попробовать снова (см. catch).
    entry.observerSeenCount = consumedCount;

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    let phrase = String(data?.message?.content || "").trim();
    phrase = phrase
      .replace(/^[\s"'«»]+|[\s"'«»]+$/g, "")
      .split("\n")[0]
      .trim();
    // Пусто или простыня — оставляем buildText() слоёв 1-2, НЕ обрезаем
    // (обрезанная посреди слова фраза — тот самый «мусор» из тикета).
    if (!phrase || phrase.length > OBSERVER_MAX_CHARS) return;

    entry.lastText = phrase;
    broadcastToUsers([task.creator_id, task.assignee_id], {
      type: "task:activity",
      task_id: taskId,
      text: phrase,
      actor_name:
        recent[recent.length - 1]?.actor || task.assignee_name || "агент",
      session_id: null,
      at: Date.now(),
    });
  } catch (e: any) {
    // Ollama лежит, таймаут, не тот JSON — строка слоёв 1-2 просто остаётся
    // висеть, карточка не ломается. Одна строка в лог, не крик на каждый тик.
    console.warn(`[activity-observer] ${taskId}: ${e?.message || e}`);
  } finally {
    entry.observerPending = false;
  }
}

let observerTimer: ReturnType<typeof setInterval> | null = null;

/** Поднимает таймер слоя 3. Отдельно от registerActivityRoutes: регистрация
 * роутов не должна зависеть от того, включён ли наблюдатель. */
export function startActivityObserver(): void {
  if (!OBSERVER_ENABLED || observerTimer) return;
  observerTimer = setInterval(() => {
    interpretOnce().catch((e) => console.warn("[activity-observer]", e));
  }, OBSERVER_INTERVAL_MS);
  // Таймер не должен сам по себе держать процесс живым.
  observerTimer.unref?.();
}

export function registerActivityRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get<{ Params: { id: string } }>("/api/tasks/:id/activity/metrics", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const row = getTaskForWrite(req.params.id, req.userId);
      if (!row) return reply.code(404).send({ error: "Задача не найдена" });
      return { metrics: taskStopMetrics(row.id) };
    },
  });

  app.post<{
    Params: { id: string };
    Body: { kind?: string; target?: string; detail?: string };
  }>("/api/tasks/:id/activity", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      // Та же дверь, что у остальных data-роутов: писать активность может
      // только тот, кто может писать в задачу.
      const row = getTaskForWrite(req.params.id, req.userId);
      if (!row) return reply.code(404).send({ error: "Задача не найдена" });

      const kind = String(req.body?.kind || "") as ActivityKind;
      if (!KINDS.includes(kind)) {
        return reply.code(400).send({ error: `kind: ${KINDS.join("|")}` });
      }
      const rawTarget = String(req.body?.target || "").trim();
      if (!rawTarget)
        return reply.code(400).send({ error: "target обязателен" });

      const task = hydrateTask(getTaskRow(row.id));
      // Показывать нечего, если над задачей никто не работает: строка в
      // карточке — про «сейчас», а не про историю.
      if (task.agent_state !== "in_progress") {
        clearActivity(row.id);
        return { accepted: false, reason: "задача не в работе" };
      }

      // РАБОТА САМА ПОДТВЕРЖДАЕТ, ЧТО АГЕНТ ЖИВ (09.09.2026, решение
      // владельца). Раньше аренду держал только пинг: его слал хук внутри
      // Claude Code и служба-будильник. У остальных исполнителей хука нет
      // вовсе, а с выключенным будильником пинга не было ни у кого — и
      // работающий агент числился пропавшим через пять минут. При этом он
      // всё это время слал сюда «правлю такой-то файл»: самый прямой признак
      // работы сервер принимал, показывал владельцу и тут же считал автора
      // мёртвым.
      //
      // Теперь отметка живости обновляется по самому факту действия. Пинг
      // остаётся страховкой на случай, когда агент долго думает и ничего не
      // трогает, но больше не является единственным доказательством.
      //
      // Обновляем ДО проверки на протухшую аренду — иначе замкнутый круг:
      // аренда истекла, агент вернулся и работает, а его действия не
      // принимают, потому что аренда истекла. Забрать задачу у молчавшего
      // может владелец или сторож, сменив состояние; пока она числится за
      // ним и он работает — это и есть работа.
      if (task.assignee_id === req.userId) {
        db.prepare(
          "UPDATE tasks SET agent_heartbeat_at = datetime('now') WHERE id = ?",
        ).run(row.id);
      }

      const now = Date.now();
      sweep(now);

      const action: Action = {
        kind,
        target: kind === "run" ? shortCommand(rawTarget) : shortPath(rawTarget),
        detail: req.body?.detail
          ? shortCommand(String(req.body.detail))
          : undefined,
        diff: shortDiff(req.body?.diff),
        actor: task.assignee_name || "агент",
        at: now,
      };

      const entry = buffers.get(row.id) || {
        actions: [],
        lastEmitAt: 0,
        lastText: "",
      };
      entry.actions.push(action);
      if (entry.actions.length > RING)
        entry.actions.splice(0, entry.actions.length - RING);

      const text = buildText(task, entry.actions);
      entry.lastText = text;

      // Троттлинг только на ВЕЩАНИЕ: буфер всегда актуален, а в браузер
      // уходит не чаще раза в EMIT_THROTTLE_MS. Пропущенное действие не
      // теряется — следующее вещание покажет уже свёрнутую картину.
      const due = now - entry.lastEmitAt >= EMIT_THROTTLE_MS;
      if (due) {
        entry.lastEmitAt = now;
        broadcastToUsers([task.creator_id, task.assignee_id], {
          type: "task:activity",
          task_id: row.id,
          text,
          // Кусок правки едет вместе со строкой: модель ЖИВЁТ НА ТЕЛЕФОНЕ,
          // и запрашивать материал отдельным GET на каждое действие значило
          // бы удваивать трафик ради того, что уже собрано здесь.
          diff: action.diff,
          kind: action.kind,
          target: action.target,
          actor_name: action.actor,
          session_id: sessionOf(req),
          at: now,
        });
      }
      buffers.set(row.id, entry);

      return { accepted: true, text, emitted: due };
    },
  });

  // Чтение буфера — чтобы карточка, открытая посреди работы агента, сразу
  // показала текущую строку, не дожидаясь следующего действия.
  app.get<{ Params: { id: string } }>("/api/tasks/:id/activity", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const row = getTaskForWrite(req.params.id, req.userId);
      if (!row) return reply.code(404).send({ error: "Задача не найдена" });

      // Та же проверка, что при записи. Без неё строка «висит» до 30 минут
      // после того, как агент отдал задачу: он больше не постит действия,
      // и без этой проверки очистка буфера ждала бы события, которого не
      // будет.
      const task = hydrateTask(getTaskRow(row.id));
      if (task.agent_state !== "in_progress" || task.agent_stale) {
        clearActivity(row.id);
        return { text: null, actions: [] };
      }

      // Карточка открыта — этот GET и есть сигнал «на задачу смотрят»
      // (клиент стучится при открытии и дальше раз в 15 с). Наблюдатель
      // (слой 3) интерпретирует только такие задачи.
      const watched = buffers.get(row.id);
      if (watched) watched.lastWatchedAt = Date.now();

      return recentActivity(row.id);
    },
  });
}
