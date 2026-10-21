// Сторож Ollama: проверяет, что локальная модель на сервере отвечает.
// Проверка настоящая — один запрос эмбеддинга тем же путём, каким ходит
// прибор (embeddingClient), а не «процесс жив». Пока всё хорошо — молчит;
// сломалось или забилась очередь — задача в «Серверные уведомления», не
// чаще одной в сутки.
//
// Зачем он нужен (владелец 12.10.2026). Ollama — неотъемлемая часть
// контура: от неё зависят эмбеддинги (подбор ролей, фанаут плана,
// смысловой поиск по заметкам) и `local_model`. Когда она отвечает
// «503 server busy, maximum pending requests exceeded», приборы молча
// начинают отдавать 502 — и это выглядит как «сервер сломался», хотя
// сервер жив. Без сторожа владелец узнаёт об этом по пересказу агента
// в чате, а не из «Серверных уведомлений», где такие вещи и ждут.
//
// Отличие от проверки «жив ли процесс»: если Ollama перебита очередью,
// порт слушается и /api/tags отвечает — поэтому проба идёт именно за
// эмбеддингом, тем самым запросом, который реально нужен прибору.
//
// Строгость пробы (21.10.2026). Проба шла с окном 15 с, а приборы — с
// окном 30 с (`embedding_timeout_ms`). Выгруженная модель эмбеддинга
// грузится около минуты: проба сдавалась на 15-й секунде и поднимала
// тревогу «Ollama не ответила за 15000 мс», хотя приборы в это время
// 502 не отдавали — тревога была ложной. Теперь:
//   * окно пробы берётся из того же параметра, что и окно приборов, и
//     плюс запас на холодный старт;
//   * состояние «модель ещё грузится» отличается от «Ollama недоступна»:
//     первое тревоги не поднимает (пока модель не загрузилась несколько
//     проб подряд), второе — поднимает;
//   * «перебита очередью» (503 server busy) по-прежнему тревогу поднимает.
//
// Доработка 21.10.2026 (замечания критика к правке 70170a6f):
//   * жёсткий потолок окна пробы (5 мин) был ниже максимально допустимого
//     окна приборов (10 мин) — при таймауте приборов больше 4 минут проба
//     снова становилась строже прибора, то есть возвращалась та же ложная
//     тревога. Теперь окно пробы следует за прибором: окно приборов плюс
//     запас на холодный старт, без отдельного потолка;
//   * 503 у Ollama бывает двух разных видов: очередь запросов исчерпана
//     («server busy: maximum pending requests exceeded») и не хватает памяти
//     под модель («model requires more system memory…»). Считать все 503
//     «очередью» — значит уводить разбор не туда: теперь эти состояния
//     различаются, и подсказка в карточке тревоги соответствует причине.

import { raiseIncident } from "./incidents.js";
import { getSetting } from "./serverSettings.js";
import {
  OLLAMA_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddingClient.js";

const INTERVAL_MS = 30 * 60 * 1000; // как требует контракт сторожей
const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY = 2;

/** Нижняя граница окна пробы: не меньше окна приборов (30 с по умолчанию). */
const MIN_PROBE_WINDOW_MS = 30_000;

/** Запас на холодный старт: выгруженная модель эмбеддинга грузится около
 *  минуты (21.10.2026 — примерно 60 с). Проба обязана это пережить. */
const COLD_START_MARGIN_MS = 60_000;

/** Потолка окна пробы нет намеренно: жёсткий потолок (5 мин) был ниже
 *  максимально допустимого окна приборов (10 мин) — при таймауте приборов
 *  больше 4 минут проба снова сдавалась раньше прибора, и тревога снова
 *  была ложной. Окно пробы = окно приборов + запас на холодный старт. */

/** Сколько проб подряд модель не грузится, прежде чем это станет поломкой. */
const LOADING_STREAK_ALARM = 3;

/** Окно диагностики (запросы /api/tags и /api/ps после сорванной пробы). */
const DIAG_TIMEOUT_MS = 5_000;

let pollHandle: NodeJS.Timeout | null = null;
let lastRaisedAt = 0;
let loadingStreak = 0;
let probeWindowOverrideMs: number | null = null;

/** Состояние пробы:
 *  ok         — эмбеддинг получен;
 *  loading    — модель выкачана, но ещё не в памяти (холодный старт);
 *  busy       — очередь запросов исчерпана (503 server busy);
 *  memory     — под модель не хватает памяти (Ollama тоже отвечает 503);
 *  slow       — модель в памяти, но эмбеддинг не пришёл в окно;
 *  unavailable— Ollama не отвечает или ответила ошибкой;
 *  invalid    — ответ без массива эмбеддинга. */
export type OllamaProbeState =
  | "ok"
  | "loading"
  | "busy"
  | "memory"
  | "slow"
  | "unavailable"
  | "invalid";

export interface CheckResult {
  ok: boolean;
  state: OllamaProbeState;
  reason: string;
  details?: Record<string, unknown>;
}

/** Окно приборов: тот же параметр, что читает embeddingClient. */
function instrumentTimeoutMs(): number {
  try {
    const value = getSetting("embedding_timeout_ms");
    return Number.isFinite(value) && value > 0 ? value : MIN_PROBE_WINDOW_MS;
  } catch {
    return MIN_PROBE_WINDOW_MS;
  }
}

/**
 * Окно пробы: не меньше окна приборов, плюс запас на холодный старт.
 * Потолка нет — проба никогда не должна быть строже прибора (см. шапку
 * файла): окно берётся из того же параметра, что и таймаут приборов.
 */
export function probeWindowMs(): number {
  if (probeWindowOverrideMs !== null) return probeWindowOverrideMs;
  const window = Math.max(instrumentTimeoutMs(), MIN_PROBE_WINDOW_MS);
  return window + COLD_START_MARGIN_MS;
}

/**
 * Разбор ошибки Ollama. 503 у неё бывает двух разных видов: очередь
 * запросов исчерпана («server busy: maximum pending requests exceeded») и
 * не хватает памяти под модель («model requires more system memory…»).
 * Признак берём из текста ответа, а не из самого кода 503: считать все 503
 * «очередью» — значит уводить разбор не туда.
 */
function classifyError(text: string): OllamaProbeState {
  if (/busy|pending requests|maximum pending/i.test(text)) return "busy";
  if (/memory|oom|out of memory/i.test(text)) return "memory";
  return "unavailable";
}

function normalizeModelName(name: string): string {
  const n = String(name ?? "").trim().toLowerCase();
  return n.endsWith(":latest") ? n.slice(0, -":latest".length) : n;
}

/** Совпадение имён модели: «bge-m3-embed:latest» и «bge-m3-embed» — одно. */
function modelMatches(a: string, b: string): boolean {
  return normalizeModelName(a) === normalizeModelName(b);
}

function modelNames(body: unknown): string[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m: any) => String(m?.name ?? m?.model ?? ""))
    .filter(Boolean);
}

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

interface OllamaState {
  /** Ollama вообще отвечает (хотя бы на /api/tags). */
  reachable: boolean;
  /** Модель выкачана на диске. */
  model_installed: boolean;
  /** Модель сейчас в памяти. */
  model_loaded: boolean;
}

/** Разбор состояния Ollama после сорванной пробы: чем она кончилась —
 *  холодный старт или настоящая поломка. */
async function inspectOllamaState(): Promise<OllamaState> {
  const tags = await fetchJson(`${OLLAMA_BASE_URL}/api/tags`, DIAG_TIMEOUT_MS);
  if (!tags.ok) {
    return { reachable: false, model_installed: false, model_loaded: false };
  }
  const installed = modelNames(tags.body).some((n) =>
    modelMatches(n, DEFAULT_EMBEDDING_MODEL),
  );
  const ps = await fetchJson(`${OLLAMA_BASE_URL}/api/ps`, DIAG_TIMEOUT_MS);
  const loaded =
    ps.ok &&
    modelNames(ps.body).some((n) => modelMatches(n, DEFAULT_EMBEDDING_MODEL));
  return { reachable: true, model_installed: installed, model_loaded: loaded };
}

/** Проба сорвалась по времени: разбираем, что это — холодный старт или
 *  недоступность. «Модель ещё грузится» — не поломка. */
async function diagnoseTimeout(windowMs: number): Promise<CheckResult> {
  const state = await inspectOllamaState();
  const details = {
    base_url: OLLAMA_BASE_URL,
    model: DEFAULT_EMBEDDING_MODEL,
    probe_window_ms: windowMs,
    ...state,
  };
  if (!state.reachable) {
    return {
      ok: false,
      state: "unavailable",
      reason: `Ollama недоступна: не ответила за ${windowMs} мс и на /api/tags не отвечает`,
      details,
    };
  }
  if (!state.model_installed) {
    return {
      ok: false,
      state: "unavailable",
      reason: `Модель ${DEFAULT_EMBEDDING_MODEL} не выкачена в Ollama — приборы не получат эмбеддинг`,
      details,
    };
  }
  if (state.model_loaded) {
    return {
      ok: false,
      state: "slow",
      reason: `Модель ${DEFAULT_EMBEDDING_MODEL} в памяти, но эмбеддинг не пришёл за ${windowMs} мс`,
      details,
    };
  }
  return {
    ok: false,
    state: "loading",
    reason: `Модель ${DEFAULT_EMBEDDING_MODEL} ещё грузится (холодный старт): эмбеддинг не пришёл за ${windowMs} мс, Ollama отвечает, в памяти модели ещё нет`,
    details,
  };
}

/**
 * Одна проба: запрос эмбеддинга тем же путём, каким ходит прибор.
 * Различаем «не отвечает», «перебит очередью» и «модель ещё грузится» —
 * чинить их по-разному, и владельцу это нужно видеть прямо в заголовке
 * карточки, а не догадываться.
 */
export async function checkOllamaHealth(): Promise<CheckResult> {
  const windowMs = probeWindowMs();
  const url = `${OLLAMA_BASE_URL}/api/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_EMBEDDING_MODEL, prompt: "проверка" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const state = classifyError(text);
      const details = {
        status: res.status,
        base_url: OLLAMA_BASE_URL,
        model: DEFAULT_EMBEDDING_MODEL,
        probe_window_ms: windowMs,
        ollama_error: text.slice(0, 200),
      };
      if (state === "busy") {
        return {
          ok: false,
          state,
          reason: `Ollama перебита: ответила ${res.status} «${text.slice(0, 120)}» — очередь запросов исчерпана`,
          details,
        };
      }
      if (state === "memory") {
        return {
          ok: false,
          state,
          reason: `Ollama ответила ${res.status}: не хватает памяти под модель «${text.slice(0, 120)}»`,
          details,
        };
      }
      return {
        ok: false,
        state,
        reason: `Ollama ответила ${res.status}: ${text.slice(0, 120) || "без текста"}`,
        details,
      };
    }
    const data = (await res.json()) as { embedding?: unknown };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      return {
        ok: false,
        state: "invalid",
        reason: "Ollama ответила без массива эмбеддинга — ответ непригоден",
        details: {
          base_url: OLLAMA_BASE_URL,
          model: DEFAULT_EMBEDDING_MODEL,
          probe_window_ms: windowMs,
        },
      };
    }
    return { ok: true, state: "ok", reason: "" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (e?.name === "AbortError") {
      return await diagnoseTimeout(windowMs);
    }
    return {
      ok: false,
      state: "unavailable",
      reason: `Ollama недоступна: ${msg.slice(0, 160)}`,
      details: {
        base_url: OLLAMA_BASE_URL,
        model: DEFAULT_EMBEDDING_MODEL,
        probe_window_ms: windowMs,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function raise(
  reason: string,
  details?: Record<string, unknown>,
  state: OllamaProbeState = "unavailable",
) {
  const now = Date.now();
  if (now - lastRaisedAt < DAY_MS) return;
  lastRaisedAt = now;
  const loading = state === "loading";
  const busy = state === "busy";
  const memory = state === "memory";
  const title = loading
    ? `Локальная модель (Ollama) не грузится: ${reason}`
    : busy
      ? `Локальная модель (Ollama) перебита очередью: ${reason}`
      : memory
        ? `Локальная модель (Ollama) не помещается в память: ${reason}`
        : `Локальная модель (Ollama) недоступна: ${reason}`;
  const whatHappened = loading
    ? "Сторож локальной модели несколько проб подряд не дождался эмбеддинга: модель выкачана, но в память не загружается."
    : busy
      ? "Сторож локальной модели получил от Ollama отказ: её очередь запросов исчерпана, приборы начнут отдавать 502."
      : memory
        ? "Сторож локальной модели получил от Ollama отказ: под модель не хватает памяти, приборы начнут отдавать 502."
        : "Сторож локальной модели не смог получить эмбеддинг от Ollama.";
  const whatToDo = [
    "- `curl -X POST http://127.0.0.1:11434/api/embeddings -H 'Content-Type: application/json' -d '{\"model\":\"bge-m3-embed:latest\",\"prompt\":\"test\"}'` — должен вернуть массив embedding.",
    "- Проверить, что модель `bge-m3-embed:latest` вообще выкачена: `ollama list`.",
    busy
      ? "- Очередь запросов исчерпана: найти, кто держит её открытым запросом, и снять его."
      : "",
    memory
      ? "- Не хватает памяти под модель: `free -h` и `ollama ps` — освободить память (выгрузить лишние модели, уменьшить keep_alive)."
      : "",
    loading
      ? "- Модель выкачана, но не в памяти: `ollama ps` покажет пусто. Проверить свободную память и место на диске — нехватка RAM выбрасывает модель, и она не влезает обратно."
      : "",
    !busy && !memory && !loading
      ? "- Проверить, что сервис Ollama жив: `systemctl status ollama` и `journalctl -u ollama -n 50`."
      : "",
  ].filter(Boolean);
  const description = [
    "## Что случилось",
    whatHappened,
    "",
    "## Причина",
    reason,
    details ? `\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`\n` : "",
    "",
    "## Что сломано",
    "От локальной модели зависят приборы: подбор роли для подзадач и плана,",
    "смысловой поиск по заметкам и базе знаний, отчёты. Они начинают",
    "отдавать 502 — при живом сервере, поэтому по симптомам похоже на",
    "падение TaskFlow, хотя сломалась только Ollama.",
    "",
    "## Что делать",
    ...whatToDo,
  ].join("\n");
  raiseIncident({ key: "ollama-health", title, description, priority: PRIORITY });
}

/**
 * Одна проба сторожа целиком: проверка и решение — тревога или молчание.
 * Отдельно от `checkOllamaHealth`, чтобы решение можно было проверить
 * пробным ходом на живой схеме (тест).
 */
export async function runOllamaHealthCheck(): Promise<{
  result: CheckResult;
  raised: boolean;
}> {
  const result = await checkOllamaHealth();
  if (result.ok) {
    loadingStreak = 0;
    return { result, raised: false };
  }
  if (result.state === "loading") {
    loadingStreak += 1;
    if (loadingStreak < LOADING_STREAK_ALARM) {
      // Холодный старт — не поломка: молчим, пока модель грузится.
      console.warn(`[ollama-watch] ${result.reason}`);
      return { result, raised: false };
    }
    result.reason = `${result.reason} (не грузится ${loadingStreak} проб подряд)`;
  } else {
    loadingStreak = 0;
  }
  raise(result.reason, result.details, result.state);
  return { result, raised: true };
}

export function startOllamaHealthWatcher(): void {
  if (process.env.OLLAMA_HEALTH_WATCHER_DISABLED === "1") return;
  if (pollHandle) return;
  const tick = async () => {
    try {
      await runOllamaHealthCheck();
    } catch (e: any) {
      console.warn("[ollama-watch] проба не отработала:", e);
    }
  };
  void tick();
  pollHandle = setInterval(() => void tick(), INTERVAL_MS);
  pollHandle.unref?.();
}

/** Сброс состояния для тестов: снять защиту от лавины тревог и счётчик
 *  неудачных загрузок. */
export function __resetWatchState(): void {
  lastRaisedAt = 0;
  loadingStreak = 0;
}

/** Окно пробы для тестов (мс). null — вернуть боевое окно. */
export function __setProbeWindow(ms: number | null): void {
  probeWindowOverrideMs = ms;
}
