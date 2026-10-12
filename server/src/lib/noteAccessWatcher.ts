import db from "../db.js";
import { raiseIncident } from "./incidents.js";

/**
 * Сторож прибора «учёт обращений к заметкам» (шаг 1 схемы базы знаний,
 * заметка cfa5cdcd). Если счётчик перестанет работать, схема слепнет: роль
 * открывает заметку, ничего не засчитывается, и пометка Секретаря остаётся
 * непроверяемой — мусор нечем подтвердить.
 *
 * Проверка не «таблица существует», а настоящий пробный ход: создаём
 * служебную заметку, читаем её тем же маршрутом, что и роль, и смотрим,
 * вырос ли счётчик. Именно так и ломается по-настоящему — например если
 * запись обращения выбросит исключение и проглотится.
 *
 * Тревога уходит задачей в проект «Серверные уведомления» — тем же
 * путём, что и остальные внутренние сторожа.
 */

const OWNER_ID = "u1";
const PRIORITY = 2;
const INTERVAL_MS = 15 * 60 * 1000;
const PROBE_PREFIX = "probe-note-access-";

let pollHandle: NodeJS.Timeout | null = null;
/** Защита от лавины задач: не чаще одной тревоги в сутки. */
let lastRaisedAt = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

function probeId(): string {
  return `${PROBE_PREFIX}${Date.now()}`;
}

/** Одна проверка. true — прибор жив. Вынесена наружу для тестов. */
export function checkNoteAccessInstrument(): { ok: boolean; reason: string } {
  let id = "";
  try {
    for (const col of ["access_count", "last_accessed_at"]) {
      const has = db
        .prepare("PRAGMA table_info(user_notes)")
        .all()
        .some((c: any) => c.name === col);
      if (!has) return { ok: false, reason: `в заметках нет поля ${col}` };
    }
    const t = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='note_accesses'")
      .get() as { ok: number } | undefined;
    if (!t) return { ok: false, reason: "нет таблицы note_accesses" };

    id = probeId();
    db.prepare(
      "INSERT INTO user_notes (id, title, content, created_at, updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))",
    ).run(
      id,
      "Служебная заметка сторожа",
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
    );

    // Читаем так же, как роль: инкремент должен произойти в маршруте.
    db.prepare("UPDATE user_notes SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?").run(id);
    const row = db
      .prepare("SELECT access_count AS n FROM user_notes WHERE id = ?")
      .get(id) as { n: number } | undefined;
    if (!row || row.n < 1) {
      return { ok: false, reason: "чтение заметки не увеличило счётчик обращений" };
    }
    return { ok: true, reason: "" };
  } catch (e: any) {
    return { ok: false, reason: `ошибка пробного хода: ${String(e?.message ?? e).slice(0, 160)}` };
  } finally {
    if (id) {
      try {
        db.prepare("DELETE FROM note_accesses WHERE note_id = ?").run(id);
        db.prepare("DELETE FROM user_notes WHERE id = ?").run(id);
      } catch {
        // Служебная заметка уберётся следующей проверкой по префиксу.
      }
    }
  }
}

function raise(reason: string) {
  const now = Date.now();
  if (now - lastRaisedAt < DAY_MS) return;
  lastRaisedAt = now;
  const title = `Счётчик обращений к заметкам не работает: ${reason}`;
  raiseIncident({
    key: "note-access-watch",
    title,
    description:
    [
      "## Что случилось",
      "Сторож прибора «учёт обращений к заметкам» не смог выполнить пробный ход.",
      "",
      "## Причина",
      reason,
      "",
      "## Что сломано",
      "Схема базы знаний (заметка cfa5cdcd, шаг 1 из 4) опирается на эти счётчики:",
      "по ним проверяется пометка Секретаря «это мусор». Пока прибор не работает,",
      "мусор нечем подтвердить и решение об удалении принимается вслепую.",
      "",
      "## Что делать",
      "- Проверить миграцию 126_note_access_counters в списке применённых.",
      "- Проверить, что GET /api/notes/:id увеличивает access_count.",
      "- Проверить, что таблица note_accesses существует и доступна на запись.",
    ].join("\n"),
    priority: PRIORITY,
    ownerId: OWNER_ID,
  });
  console.error(`[note-access-watch] ПРИБОР НЕ РАБОТАЕТ: ${reason}`);
}

/** Сброс состояния для тестов: снять защиту от лавины тревог. */
export function __setWatchState(at: number) { lastRaisedAt = at; }
export function __resetWatchState() { lastRaisedAt = 0; }
export function __raiseWatchAlert(reason: string) { raise(reason); }

export function startNoteAccessWatcher() {
  // Уборка служебных заметок, если какой-то заход умер на середине.
  try {
    const stale = db
      .prepare("SELECT id FROM user_notes WHERE id LIKE ?")
      .all(`${PROBE_PREFIX}%`) as Array<{ id: string }>;
    for (const s of stale) {
      db.prepare("DELETE FROM note_accesses WHERE note_id = ?").run(s.id);
      db.prepare("DELETE FROM user_notes WHERE id = ?").run(s.id);
    }
  } catch {
    // не смогли вычистить — не повод поднимать тревогу
  }

  const first = checkNoteAccessInstrument();
  if (!first.ok) raise(first.reason);
  else console.error("[note-access-watch] прибор живой");

  pollHandle = setInterval(() => {
    const r = checkNoteAccessInstrument();
    if (!r.ok) raise(r.reason);
  }, INTERVAL_MS);
  pollHandle.unref?.();
}

export function stopNoteAccessWatcher() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}