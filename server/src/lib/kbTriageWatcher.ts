import crypto from "crypto";
import db from "../db.js";
import { broadcastToUsers } from "../ws.js";
import { loadChatMessage } from "./chatMessages.js";
import { SECRETARY_CHAT_ID } from "./secretaryReply.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
 *
 * ОДНА карточка, а не по одной на каждый порог (решение владельца
 * 16.10.2026). Раньше каждое достижение порога заводило новую задачу, и в
 * проекте копились тринадцать одинаковых «Разобрать накопившиеся заметки»:
 * у Помощника владельца этот ручной поток не в очереди, поэтому они висели
 * мёртвым грузом. Теперь сторож ведёт ОДНУ живую карточку:
 *
 *   • порог достигнут, живой карточки нет  → заводим карточку;
 *   • порог достигнут, карточка жива       → обновляем её счётчик, дубль
 *                                             не заводим никогда;
 *   • порог достигнут, карточку закрыли     → следующая проверка заводит
 *                                             новую (разбор-то не сделан).
 *
 * И рядом с карточкой — сигнал в личный чат Помощника владельца: сколько
 * заметок ждёт, какая карточка и что делать. Молчаливый счётчик роль не
 * будит, а именно она разбирает. Повтор сигнала по той же карточке — не
 * чаще раза в сутки, иначе чат превращается в спам.
 */

const OWNER_ID = "u1";
const TRIAGE_PROJECT_NAME = "TaskFlow - NewTodoist";
const PRIORITY = 2;
const INTERVAL_MS = 30 * 60 * 1000;
/** Порог: столько заметок с временной меткой — пора разбирать. */
const TRIAGE_THRESHOLD = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Учётка серверных сообщений (миграция 095). */
const SYSTEM_USER_ID = "taskflow_system";

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
 * Теперь на диске лежит не только «когда поднимали», но и КАКОЙ карточкой
 * сторож жив и КОГДА по ней уже сигналил: обе отметки переживают перезапуск,
 * поэтому рестарт не плодит ни карточек, ни сообщений.
 *
 * Плюс эта же отметка нужна экрану «Состояние системы»: клиент показывает
 * лампу сторожа и последнюю проверку, как у «Расписания».
 */
const STATE_DIR =
  process.env.TASKFLOW_KB_TRIAGE_STATE_DIR ??
  join(homedir(), ".local/state/taskflow-kb-triage");
const STATE_FILE = join(STATE_DIR, "state.json");
/** Интервал проверки — столько же, сколько у таймера ниже. */
const INTERVAL_MS_STATE = INTERVAL_MS;

type TriageState = {
  checked_at_epoch?: number;
  /** Когда сторож завёл карточку `raised_task_id` (или подхватил готовую). */
  raised_at_epoch?: number;
  raised_task_id?: string;
  pending?: number;
  /** Карточка, о которой сигнал в чат Помощнику уже уходил, и когда. */
  notified_task_id?: string;
  notified_at_epoch?: number;
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

/** Состояние сторожа для экрана «Состояние системы» (образец — планировщик).
 *  `active` — сторож не молчит: проверка была не позже двух интервалов назад. */
export function kbTriageState(): {
  active: boolean;
  last_check_at: string | null;
  last_raised_at: string | null;
  pending: number;
  threshold: number;
  task_id: string | null;
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
    task_id: liveTriageCard()?.id ?? state.raised_task_id ?? null,
  };
}

function pendingCount(): number {
  // Пометка «мусор» — это решение по заметке, а не работа в очереди: её
  // окончательная судьба решается по счётчику обращений (noteAccessWatcher).
  // Считая её здесь, очередь никогда не доходила до нуля — 30 помеченных
  // держали счётчик выше порога, и сторож заводил следующую карточку
  // (решение владельца 17.10.2026).
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM user_notes WHERE kb_temp_category IS NOT NULL AND kb_category IS NULL AND kb_temp_category <> 'мусор'",
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

type TriageCard = { id: string; title: string; description: string | null };

/**
 * Живая карточка разбора, если она есть.
 *
 * Ищем не по отметке в состоянии, а по базе — отметка может потеряться или
 * устареть, а карточка видна всегда. Порядок: карточка, которой сторож уже
 * владеет (её нельзя бросить ради более новой), иначе самая свежая из живых.
 * Именно этот поиск и убирает тринадцать дублей: после перезапуска сервера
 * сторож подхватывает любую живую карточку вместо новой.
 */
function liveTriageCard(): TriageCard | null {
  const rows = db
    .prepare(
      `SELECT id, title, description FROM tasks
        WHERE id LIKE 'kb-triage-%'
          AND status = 'active'
          AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC`,
    )
    .all() as TriageCard[];
  if (!rows.length) return null;
  const preferred = readState().raised_task_id;
  const own = rows.find((r) => r.id === preferred);
  return own ?? rows[0];
}

function triageTitle(count: number): string {
  return `Разобрать накопившиеся заметки: ${count} ждут разбора`;
}

/** Строка счётчика в описании карточки. Сторож ей владеет и переписывает
 *  только её: правки владельца или Помощника в остальном тексте остаются. */
const COUNT_LINE_RE = /^Ждут разбора: \d+.*$/m;

function withCount(description: string | null, count: number): string {
  const line = `Ждут разбора: ${count} — счётчик обновляет сторож, пока карточка жива.`;
  const rest = (description ?? "").replace(COUNT_LINE_RE, "").replace(/^\n+/, "");
  return rest.trim() ? `${line}\n\n${rest.trim()}` : line;
}

function triageDescription(count: number): string {
  return withCount(
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
    count,
  );
}

/** Завести карточку разбора. Живых карточек к этому моменту нет — иначе мы
 *  не сюда бы пришли. Возвращает id новой карточки. */
function createTriageCard(projectId: string, count: number): string {
  const id = `kb-triage-${Date.now().toString(36)}`;
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, priority, creator_id, status, agent_state,
        project_id, owner_selected_role, ready_for_pickup, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, 'secretary', 0, datetime('now'), datetime('now'))`,
    ).run(
      id,
      triageTitle(count),
      triageDescription(count),
      PRIORITY,
      OWNER_ID,
      projectId,
    );
  });
  txn();
  console.error(`[kb-triage-watch] набралось ${count} заметок, заведена карточка на разбор: ${id}`);
  return id;
}

/** Обновить счётчик живой карточки вместо заведения дубля. */
function refreshTriageCard(card: TriageCard, count: number): void {
  const description = withCount(card.description, count);
  const title = triageTitle(count);
  if (card.title === title && card.description === description) return;
  db.prepare("UPDATE tasks SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?").run(
    title,
    description,
    card.id,
  );
  console.error(
    `[kb-triage-watch] карточка ${card.id} жива — счётчик обновлён на ${count}, дубль не заведён`,
  );
}

/**
 * Сигнал Помощнику владельца — в его личный чат.
 *
 * Пишем тем же приёмом, что и остальные серверные сообщения в личные чаты
 * (`ownerDraft.ts`, `secretaryTaskSummary.ts`): строка в chat_messages от
 * учётки «Система» + рассылка участникам комнаты. task_id у сообщения —
 * клиент по нему рисует карточку-ссылку.
 */
function notifySecretary(count: number, taskId: string): boolean {
  const chat = db.prepare("SELECT id FROM chats WHERE id = ?").get(SECRETARY_CHAT_ID);
  if (!chat) {
    console.error("[kb-triage-watch] нет личного чата Помощника владельца — сигнал не отправлен");
    return false;
  }
  const id = crypto.randomUUID();
  const text = [
    `Порог разбора заметок достигнут: ${count} ждут разбора.`,
    "",
    `Что делать: взять карточку «${triageTitle(count)}» (${taskId}) и разобрать накопившиеся заметки — порядок и границы описаны внутри.`,
    "",
    "Пока карточка жива, новых карточек разбора не будет: сторож обновит счётчик в ней же. Повтор этого сигнала по той же карточке — не чаще раза в сутки.",
  ].join("\n");
  db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, message_type)
       VALUES (?, ?, ?, 'chat', ?, ?, 'system')`,
    ).run(id, SYSTEM_USER_ID, text, SECRETARY_CHAT_ID, taskId);
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(SECRETARY_CHAT_ID);
  })();
  const members = (
    db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(SECRETARY_CHAT_ID) as {
      member_id: string;
    }[]
  ).map((m) => m.member_id);
  broadcastToUsers(members, { type: "chat:new", message: loadChatMessage(id) });
  return true;
}

function raise(count: number) {
  // Отметку «проверяли» пишем ВСЕГДА, ещё до порога: экрану «Состояние
  // системы» нужно знать, что сторож жив, даже когда разбирать нечего.
  const now = Date.now();
  writeState({ checked_at_epoch: now, pending: count });
  // Порог проверяется ЗДЕСЬ, а не в вызывающем коде: иначе любой путь,
  // минуя таймер, мог бы завести задачу на пять заметок.
  if (count < TRIAGE_THRESHOLD) return;
  const projectId = triageProjectId();
  if (!projectId) {
    console.error("[kb-triage-watch] нет проекта для разбора — молчу, чтобы не плодить задачи в хабе");
    return;
  }

  // Одна живая карточка на разбор. Пока она не закрыта — новых не будет.
  const live = liveTriageCard();
  const taskId = live ? live.id : createTriageCard(projectId, count);
  if (live) refreshTriageCard(live, count);

  const state = readState();
  if (state.raised_task_id !== taskId) {
    writeState({ raised_at_epoch: now, raised_task_id: taskId });
  }
  writeState({ pending: count });

  // Сигнал в личный чат Помощника владельца: один на карточку в сутки.
  // Отметка на диске, поэтому перезапуск сервера сигнал не повторяет.
  const already = readState();
  const notified =
    already.notified_task_id === taskId &&
    typeof already.notified_at_epoch === "number" &&
    now - already.notified_at_epoch < DAY_MS;
  if (!notified && notifySecretary(count, taskId)) {
    writeState({ notified_task_id: taskId, notified_at_epoch: now });
    console.error(
      `[kb-triage-watch] сигнал Помощнику владельца отправлен: ${count} заметок, карточка ${taskId}`,
    );
  }
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
/** Сброс отметок сторожа — только для тестов. */
export function __resetKbTriageState() {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch {
    // файла нет — сбрасывать было нечего
  }
}
/** Подложить отметку сторожа — только для тестов (например, «сигнал был
 *  вчера», чтобы проверить суточный интервал без ожидания суток). */
export function __setKbTriageState(patch: TriageState) {
  writeState(patch);
}