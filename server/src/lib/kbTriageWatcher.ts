import db from "../db.js";

/**
 * Сторож порога разбора заметок (шаг 3 схемы базы знаний, cfa5cdcd).
 *
 * Разбор запускается не по календарю, а по счётчику: работа не должна
 * гоняться впустую. Набралось порог заметок с временной меткой — заводится
 * задача на разбор.
 *
 * Кто разбирает: Секретарь. Он раскладывает заметки по постоянным
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
let lastRaisedAt = 0;

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
  // задачу и проект забьётся одинаковыми карточками.
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