import fs from "node:fs";
import path from "node:path";
import db, { DB_PATH } from "../db.js";
import { cancelQuestionsForChat } from "./chatQuestions.js";

/**
 * Уборка лишних чатов (карточка 0b7a8b81…, 21.10.2026).
 *
 * Три правила живут здесь, чтобы маршрут и тесты говорили об одном и том же:
 *
 *  1. ПРАВО УБИРАТЬ. Комнаты задач заводятся сервером при
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
 * Системная комната — комната задачи: её заводит сервер при работе по
 * карточке. Именно её убирает любой участник задачи, а не только автор.
 */
export function isTaskRoom(chat: {
  task_id?: string | null;
  room_kind?: string | null;
}): boolean {
  return Boolean(chat.task_id) && chat.room_kind === "task";
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
  if (isTaskRoom(chat)) return { allowed: true };
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
  // Убранный чат ответить уже не даст: его открытые вопросы снимаем, иначе
  // они навсегда висят в «Нужен ответ» (31.10.2026).
  cancelQuestionsForChat(chatId);
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
 *   • это комната задачи (room_kind='task'), не личная переписка;
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
        WHERE c.room_kind = 'task'
          AND c.task_id IS NOT NULL
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

/**
 * Удалить чат насовсем (владелец 08.11.2026: «есть архив, есть просто удалить…
 * если удалил, уже возвращать нечего»).
 *
 * Правила:
 *  • сначала архив: удалять можно только убранный чат (archived_at) или
 *    закрытый (closed_at) — «сначала в архив, захочу удалить, тогда удалю»;
 *  • общая комната и личные комнаты ролей не удаляются: на них держится
 *    структура комнат;
 *  • комнату задачи удаляет только владелец трекера, остальные чаты — владелец
 *    или тот, кто их завёл.
 */
export function purgeRight(
  chat: ChatRoomRow,
  userId: string,
  trackerOwner: boolean,
): ArchiveRight {
  if (chat.room_kind === "common")
    return { allowed: false, reason: "общую комнату удалить нельзя" };
  if (chat.room_kind === "personal")
    return { allowed: false, reason: "личная комната роли не удаляется" };
  if (!chat.archived_at && !chat.closed_at)
    return { allowed: false, reason: "сначала убери чат в архив" };
  if (isTaskRoom(chat))
    return trackerOwner
      ? { allowed: true }
      : { allowed: false, reason: "комнату задачи удаляет владелец" };
  if (trackerOwner || chat.created_by === userId) return { allowed: true };
  return { allowed: false, reason: "удалить чат может только его создатель" };
}

/** Каталог вложений — тот же, что у routes/attachments.ts, без лишней связи. */
function uploadsDir(): string {
  return process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), "uploads");
}

export interface PurgeCounts {
  messages: number;
  attachments: number;
  queue: number;
  questions: number;
}

/**
 * Окончательное удаление: сообщения, вложения (и их файлы), участники, сессии,
 * очередь доставки, открытые вопросы и сам чат. Откат невозможен — в этом и
 * смысл действия; перед вызовом ходы чата должны быть остановлены.
 */
export function purgeChat(chatId: string): PurgeCounts {
  const count = (sql: string) => (db.prepare(sql).get(chatId) as { n: number }).n;
  const counts: PurgeCounts = {
    messages: count("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?"),
    attachments: count(
      `SELECT COUNT(*) AS n FROM attachments a JOIN chat_messages m ON m.id = a.chat_message_id
        WHERE m.chat_id = ?`,
    ),
    queue: count("SELECT COUNT(*) AS n FROM chat_message_queue WHERE chat_id = ?"),
    questions: count("SELECT COUNT(*) AS n FROM chat_questions WHERE chat_id = ?"),
  };
  const files = db
    .prepare(
      `SELECT a.stored_name FROM attachments a JOIN chat_messages m ON m.id = a.chat_message_id
        WHERE m.chat_id = ?`,
    )
    .all(chatId) as Array<{ stored_name: string }>;
  const dir = uploadsDir();
  const txn = db.transaction(() => {
    // Вопросы роли держат chat_id без FK — снимаем сами.
    db.prepare("DELETE FROM chat_questions WHERE chat_id = ?").run(chatId);
    // Закреплённое сообщение — ссылка на сообщение, мешает каскаду.
    db.prepare("UPDATE chats SET pinned_message_id = NULL WHERE id = ?").run(chatId);
    // Остальное (сообщения, вложения, участники, сессии, очередь, топики,
    // обсуждения, выжимки, настройки) уходит каскадом по FK.
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
  });
  txn();
  for (const file of files) {
    try {
      fs.rmSync(path.join(dir, file.stored_name), { force: true });
    } catch {
      /* файл уже удалён или недоступен — строка из базы уже ушла */
    }
  }
  return counts;
}
