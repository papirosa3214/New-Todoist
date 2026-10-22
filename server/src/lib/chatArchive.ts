import db from "../db.js";

/**
 * Уборка лишних чатов (карточка 0b7a8b81…, 21.10.2026).
 *
 * Три правила живут здесь, чтобы маршрут и тесты говорили об одном и том же:
 *
 *  1. ПРАВО УБИРАТЬ. Темы задач и комнаты проектов заводятся сервером при
 *     создании задачи (lib/projectTopics.ts: created_by = project.owner_id).
 *     Проверка «убирает только создатель» к ним неприменима: создатель у
 *     всех тем проекта один, участников — много, и по факту никто из них
 *     этим правилом убрать не мог. Поэтому тему задачи убирает любой
 *     участник проекта, а личные и групповые переписки (room_kind: dm,
 *     personal, handoff, wake) — только тот, кто их завёл.
 *
 *  2. УБРАТЬ = АРХИВИРОВАТЬ. Строки не стираются: чат получает closed_at
 *     (уходит из общего списка, новые сообщения не принимаются) и
 *     archived_at (явная отметка уборки — её не снимает возвращение задачи в
 *     работу, в отличие от закрытия темы вместе с задачей). История,
 *     счётчики и статистика по задачам остаются в базе.
 *
 *  3. МАССОВАЯ УБОРКА берёт только пустые темы задач: без сообщений, без
 *     строк в очереди доставки, не тронутые два часа, без живых попыток.
 *     Личные и групповые переписки в кандидаты не попадают никогда.
 */

/** Строка чата в том виде, в каком её видит правило прав. */
export interface ChatRoomRow {
  id: string;
  created_by: string | null;
  task_id: string | null;
  project_id: string | null;
  parent_chat_id: string | null;
  room_kind: string | null;
  closed_at: string | null;
  archived_at?: string | null;
}

export type ArchiveRight =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Системная комната — тема задачи: её заводит сервер, она живёт внутри
 * комнаты проекта. Именно её убирает любой участник проекта.
 */
export function isTaskTopic(chat: {
  task_id?: string | null;
  parent_chat_id?: string | null;
}): boolean {
  return Boolean(chat.task_id) && Boolean(chat.parent_chat_id);
}

/**
 * Кто вправе убрать чат.
 *
 * Проверка членства (участник ли вызывающий этой комнаты) — на маршруте
 * (isMember): сюда приходят с уже проверенным доступом к чату.
 */
export function archiveRight(chat: ChatRoomRow, userId: string): ArchiveRight {
  // Постоянная общая комната — не переписка, её убирать нельзя.
  if (chat.room_kind === "common")
    return { allowed: false, reason: "общую комнату убрать нельзя" };
  // Тема задачи — системная комната: убирает любой участник проекта.
  if (isTaskTopic(chat)) return { allowed: true };
  // Личные и групповые переписки — только создатель.
  if (chat.created_by !== userId)
    return { allowed: false, reason: "убрать чат может только его создатель" };
  return { allowed: true };
}

/**
 * Архивировать чат: пометить закрытым и убранным. Строки не трогаем —
 * сообщения, счётчики и статистика остаются в базе.
 */
export function archiveChat(chatId: string): void {
  db.prepare(
    `UPDATE chats
        SET closed_at = COALESCE(closed_at, datetime('now')),
            archived_at = COALESCE(archived_at, datetime('now'))
      WHERE id = ?`,
  ).run(chatId);
}

/** Убран ли чат человеком (в отличие от темы, закрытой вместе с задачей). */
export function isArchived(chat: { archived_at?: string | null }): boolean {
  return Boolean(chat.archived_at);
}

/** Строка чата в том виде, в каком её видит правило прав. */
export function chatRoomRow(chatId: string): ChatRoomRow | undefined {
  return db
    .prepare(
      `SELECT id, created_by, task_id, project_id, parent_chat_id, room_kind,
              closed_at, archived_at
         FROM chats WHERE id = ?`,
    )
    .get(chatId) as ChatRoomRow | undefined;
}

/**
 * Карточка сейчас в работе.
 *
 * «В работе» — это не только живая попытка: попытка кончается ходом, а
 * карточка между ходами остаётся работой роли. Признаки:
 *   • своё agent_state in_progress / review / blocked;
 *   • незакрытый шаг плана in_progress / blocked (роль ходит по слоту).
 * Тему такой карточки из уборки исключаем: её чат — рабочее место роли,
 * убирать его, пока карточка не отдана, нельзя.
 */
export function taskIsInWork(taskId: string | null): boolean {
  return Boolean(
    taskId &&
      (db
        .prepare(
          `SELECT 1 FROM tasks
            WHERE id = ? AND agent_state IN ('in_progress','review','blocked')`,
        )
        .get(taskId) ||
        db
          .prepare(
            `SELECT 1 FROM subtasks
              WHERE task_id = ? AND done = 0
                AND agent_state IN ('in_progress','blocked')`,
          )
          .get(taskId)),
  );
}

/** Кандидат на уборку — пустая тема задачи. */
export interface CleanupCandidate {
  id: string;
  title: string | null;
  task_id: string | null;
  task_title: string | null;
  project_id: string | null;
  updated_at: string;
  messages: number;
  queue: number;
}

/** Сколько часов тема должна лежать нетронутой, чтобы попасть в уборку. */
export const CLEANUP_MIN_IDLE_HOURS = 2;

/**
 * Кандидаты на массовую уборку — пустые темы задач.
 *
 * Условия (все должны выполняться):
 *   • это тема задачи (родитель — комната проекта), не личная переписка;
 *   • ни одного сообщения и ни одной строки в очереди доставки;
 *   • тема не тронута последние CLEANUP_MIN_IDLE_HOURS часов;
 *   • у задачи нет живой попытки (ended_at IS NULL) — ход не идёт;
 *   • карточка не в работе (taskIsInWork): свой agent_state или
 *     незакрытый шаг роли — убирать рабочее место роли нельзя;
 *   • тема ещё не убрана и не закрыта.
 *
 * Порядок — от самой старой: так уборка съедает именно залежавшееся.
 */
export function cleanupCandidates(limit = 500): CleanupCandidate[] {
  return db
    .prepare(
      `SELECT c.id, c.title, c.task_id, c.project_id, c.updated_at,
              (SELECT t.title FROM tasks t WHERE t.id = c.task_id) AS task_title,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS messages,
              (SELECT COUNT(*) FROM chat_message_queue q WHERE q.chat_id = c.id) AS queue
         FROM chats c
        WHERE c.parent_chat_id IS NOT NULL
          AND c.task_id IS NOT NULL
          AND c.room_kind IS NULL
          AND c.closed_at IS NULL
          AND COALESCE(c.archived_at, '') = ''
          AND c.updated_at <= datetime('now', ?)
          AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM chat_message_queue q WHERE q.chat_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM attempts a
                           WHERE a.task_id = c.task_id AND a.ended_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM tasks wt
                           WHERE wt.id = c.task_id
                             AND wt.agent_state IN
                                 ('in_progress','review','blocked'))
          AND NOT EXISTS (SELECT 1 FROM subtasks ws
                           WHERE ws.task_id = c.task_id AND ws.done = 0
                             AND ws.agent_state IN ('in_progress','blocked'))
        ORDER BY c.updated_at ASC, c.id ASC
        LIMIT ?`,
    )
    .all(`-${CLEANUP_MIN_IDLE_HOURS} hours`, limit) as CleanupCandidate[];
}

/**
 * Убрать кандидатов: архивировать каждого. Возвращает id убранных чатов.
 * Отбор кандидатов делается ЗДЕСЬ, в момент уборки, а не берётся из тела
 * запроса: список мог устареть между предпросмотром и подтверждением, а
 * правило «не трогать живое» должно соблюдаться на самом моменте архивирования.
 */
export function runCleanup(limit = 500): string[] {
  const candidates = cleanupCandidates(limit);
  const archived: string[] = [];
  const txn = db.transaction(() => {
    for (const candidate of candidates) {
      // Повторная проверка в момент уборки: между предпросмотром и
      // подтверждением карточка могла начать работать.
      // Ищем именно КАРТОЧКУ кандидата (candidate.task_id): по номеру чата
      // (candidate.id) проверка всегда была ложной, и страховка молча не
      // срабатывала (дефект D2).
      if (taskIsInWork(candidate.task_id)) continue;
      archiveChat(candidate.id);
      archived.push(candidate.id);
    }
  });
  txn();
  return archived;
}

/**
 * Одиночная уборка темы задачи (POST /api/chats/:id/archive): тема карточки,
 * которая сейчас в работе, не убирается — рабочее место роли.
 */
export function canArchiveTaskTopic(taskId: string | null): boolean {
  return taskId ? !taskIsInWork(taskId) : true;
}
