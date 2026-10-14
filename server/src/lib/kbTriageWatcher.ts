import db from "../db.js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * Сторож порога разбора заметок (шаг 3 схемы базы знаний, cfa5cdcd).
 *
 * Разбор запускается не по календарю, а по счётчику: работа не должна
 * гоняться впустую. Набралось порог заметок с временной меткой — заводится
 * задача на разбор.
 *
 * Кто разбирает: Помощник владельца. Он раскладывает заметки по постоянным
 * категориям, снимает временную метку, а похожее на мусор — ПОМЕЧАЕТ и
 * ничего не удаляет. Окончательное решение принимается по факту
 * обращений ролей (noteAccessWatcher), поэтому помеченное обязано остаться
 * видимым.
 *
 * Задача идёт в основной проект, а НЕ в «Серверные уведомления»: разбор —
 * рутина, а не поломка. В уведомления летят только сбои приборов.
 */

const OWNER_ID = "u1";
const TRIAGE_PROJECT_NAME = "TaskFlow - NewTodoist";
const PRIORITY = 2;
const INTERVAL_MS = 30 * 60 * 1000;
/** Порог: столько заметок с временной меткой — пора разбирать. */
const TRIAGE_THRESHOLD = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

let pollHandle: NodeJS.Timeout | null = null;

/**
 * Отметка сторожа на ДИСКЕ, а не только в памяти — по образцу планировщика
 * (`~/.local/state/taskflow-scheduler/last-run.json`).
 *
 * Зачем: «не чаще раза в сутки» держалось в переменной `lastRaisedAt`. При
 * перезапуске сервера она обнулялась, и сторож заводил задачу заново. На
 * живых данных 12.10.2026 это дало семь одинаковых карточек «Разобрать
 * накопившиеся заметки» с 18:25 до 19:23 — семь перезапусков подряд.
 *
 * Плюс эта же отметка нужна экрану «Состояние системы»: клиент показывает
 * лампу сторожа и последнюю проверку, как у «Расписания».
 */
const STATE_DIR = join(homedir(), ".local/state/taskflow-kb-triage");
const STATE_FILE = join(STATE_DIR, "state.json");
/** Интервал проверки — столько же, сколько у таймера ниже. */
const INTERVAL_MS_STATE = INTERVAL_MS;

type TriageState = {
  checked_at_epoch?: number;
  raised_at_epoch?: number;
  raised_task_id?: string;
  pending?: number;
};

function readState(): TriageState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as TriageState;
  } catch {
    return {};
  }
}

function writeState(patch: TriageState): void {
  // Слияние, а не перезапись: проверка обновляет свои поля, поднятие — свои,
  // и они не должны затирать друг друга.
  const next = { ...readState(), ...patch };
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(next), "utf8");
  } catch (error) {
    // Отметка не критична для самой задачи: хуже молча потерять состояние,
    // чем уронить сторож на записи файла.
    console.error(`[kb-triage-watch] не удалось записать состояние: ${String(error)}`);
  }
}

// Восстанавливаем суточный интервал с диска, а не начинаем с нуля:
// перезапуск сервера больше не означает «пора заводить ещё одну».
let lastRaisedAt = readState().raised_at_epoch ?? 0;

/** Состояние сторожа для экрана «Состояние системы» (образец — планировщик).
 *  `active` — сторож не молчит: проверка была не позже двух интервалов назад. */
export function kbTriageState(): {
  active: boolean;
  last_check_at: string | null;
  last_raised_at: string | null;
  pending: number;
  threshold: number;
} {
  const state = readState();
  const checked = state.checked_at_epoch;
  const raised = state.raised_at_epoch;
  return {
    active: typeof checked === "number" && Date.now() - checked < INTERVAL_MS_STATE * 2,
    last_check_at: typeof checked === "number" ? new Date(checked).toISOString() : null,
    last_raised_at: typeof raised === "number" ? new Date(raised).toISOString() : null,
    pending: pendingCount(),
    threshold: TRIAGE_THRESHOLD,
  };
}

function pendingCount(): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM user_notes WHERE kb_temp_category IS NOT NULL AND kb_category IS NULL",
    )
    .get() as { n: number };
  return row.n;
}

/** Проект для задач разбора. Находим по имени: жёсткий id уехал бы
    вслед за тестовой базой, а страница разбора всё равно одна. */
function triageProjectId(): string | null {
  const row = db
    .prepare("SELECT id FROM projects WHERE name = ? AND archived_at IS NULL LIMIT 1")
    .get(TRIAGE_PROJECT_NAME) as { id: string } | undefined;
  return row?.id ?? null;
}

function raise(count: number) {
  // Отметку «проверяли» пишем ВСЕГДА, ещё до порога: экрану «Состояние
  // системы» нужно знать, что сторож жив, даже когда разбирать нечего.
  writeState({ checked_at_epoch: Date.now(), pending: count });
  // Порог проверяется ЗДЕСЬ, а не в вызывающем коде: иначе любой путь,
  // минуя таймер, мог бы завести задачу на пять заметок.
  if (count < TRIAGE_THRESHOLD) return;
  const projectId = triageProjectId();
  if (!projectId) {
    console.error("[kb-triage-watch] нет проекта для разбора — молчу, чтобы не плодить задачи в хабе");
    return;
  }
  const now = Date.now();
  // Не чаще раза в сутки: иначе каждая следующая проверка заведёт новую
  // задачу и проект забьётся одинаковыми карточками. Отметка — с диска,
  // поэтому перезапуск сервера это правило больше не обнуляет.
  if (now - lastRaisedAt < DAY_MS) return;
  lastRaisedAt = now;

  const title = `Разобрать накопившиеся заметки: ${count} ждут разбора`;
  const id = `kb-triage-${Date.now().toString(36)}`;
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, priority, creator_id, status, agent_state,
        project_id, owner_selected_role, ready_for_pickup, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, 'secretary', 0, datetime('now'), datetime('now'))`,
    ).run(
      id,
      title,
      [
        "## Что сделать",
        `Разобрать ${count} заметок с временной меткой в базе знаний.`,
        "",
        "## Как",
        "- Прочитать заметку целиком (taskflow_doc_read) и решить: переиспользуемая или одноразовая.",
        "- Переиспользуемой проставить постоянную категорию: PATCH /api/notes/:id с kb_category.",
        "- Категории: **Workflows** — как принято делать; **Norms** — правила и ограничения; **Roles** — кто что умеет; **Knowledge Base** — как устроено и где грабли; **Исследования** — как это делают снаружи.",
        "- Одноразовую **не удалять**: поставить kb_temp_category = \"мусор\" и снять прежнюю временную метку. Окончательное решение принимается по факту обращений ролей.",
        "- Метку `kb_temp_category` снимать во всех случаях — иначе заметка попадёт в следующий разбор снова.",
        "",
        "## Границы",
        "- Удаление заметок — не твоё дело. Ни одной.",
        "- Личную память ролей не трогать.",
        "- Новую категорию без согласования с владельцем не заводить.",
      ].join("\n"),
      PRIORITY,
      OWNER_ID,
      projectId,
    );
  });
  txn();
  // Отметка о поднятии — на диск, чтобы суточный интервал пережил перезапуск
  // и чтобы экран показал, когда задача заводилась в последний раз.
  writeState({ raised_at_epoch: now, raised_task_id: id, pending: count });
  console.error(`[kb-triage-watch] набралось ${count} заметок, заведена задача на разбор`);
}

export function startKbTriageWatcher() {
  raise(pendingCount());
  pollHandle = setInterval(() => raise(pendingCount()), INTERVAL_MS);
  pollHandle.unref?.();
}

export function stopKbTriageWatcher() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

/** Для тестов и ручной проверки: сколько заметок ждёт разбора. */
export function kbPendingCount(): number {
  return pendingCount();
}
export function __raiseKbTriage() {
  raise(pendingCount());
}
export function __resetKbTriageState() {
  lastRaisedAt = 0;
}