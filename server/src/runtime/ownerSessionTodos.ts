/**
 * To Do List Pi в сессиях владельца: чтение состояния официального расширения
 * Pi (`@juicesharp/rpiv-todo`) из транскрипта сессии.
 *
 * Что здесь на самом деле лежит. Своего хранилища нет и быть не должно:
 * официальное расширение держит живой список в памяти процесса по номеру
 * сессии (`state/store.ts`), а в транскрипт состояние попадает как `details`
 * результата инструмента `todo` (`TaskDetails`: `tasks` + `nextId`). При
 * восстановлении расширение переигрывает ветку и берёт ПОСЛЕДНИЙ такой
 * результат (`state/replay.ts` → `replayFromBranch`). Здесь тот же разбор:
 * ветка сессии на входе, готовый список на выходе. Ничего не пишется.
 *
 * Зачем это нужно серверу, а не клиенту: правило владельца «тонкий клиент без
 * нагрева» (13.11.2026) — разбор ответов и любой перебор истории делает
 * сервер, телефон только рисует. Поэтому список собирается здесь и уходит
 * клиенту готовым.
 *
 * Изоляция — по сессии: на вход идёт ветка ровно одной сессии, состояние
 * другой сессии или другого хода в неё не попадает. Родительская ветка при
 * ответвлении тоже часть своей истории — в официальном расширении так же.
 *
 * Соглашение с расширением: имя инструмента `todo` и форма `details`
 * (`tasks` + `nextId`) закреплены в самом пакете («DO NOT rename», см.
 * `tool/types.ts`, `state/replay.ts`) — это ключи, а не наша выдумка.
 */

/** Статусы задач официального расширения (4-состояние, `deleted` — надгробие). */
export type OwnerSessionTodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export const OWNER_SESSION_TODO_TOOL = "todo";

export interface OwnerSessionTodoTask {
  id: number;
  subject: string;
  status: OwnerSessionTodoStatus;
  description?: string;
  activeForm?: string;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** Счётчики — по живым задачам: надгробия в интерфейс не идут. */
export interface OwnerSessionTodoCounts {
  pending: number;
  in_progress: number;
  completed: number;
}

export interface OwnerSessionTodos {
  sessionId: string;
  /** В ветке есть запись `todo`: список не пустой по факту, а не по ошибке. */
  available: boolean;
  /** Запись, из которой взят список (её `id` и время), — чтобы клиенту было
   *  к чему привязать живую замену и не рисовать старый список поверх нового. */
  entryId: string | null;
  updatedAt: string | null;
  nextId: number;
  /** Живые задачи в порядке создания; `deleted` не отдаются. */
  tasks: OwnerSessionTodoTask[];
  counts: OwnerSessionTodoCounts;
}

const EMPTY_COUNTS: OwnerSessionTodoCounts = { pending: 0, in_progress: 0, completed: 0 };

export function emptySessionTodos(sessionId: string): OwnerSessionTodos {
  return {
    sessionId,
    available: false,
    entryId: null,
    updatedAt: null,
    nextId: 1,
    tasks: [],
    counts: { ...EMPTY_COUNTS },
  };
}

function isStatus(value: unknown): value is OwnerSessionTodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted";
}

/**
 * Форма `details` результата `todo` (совпадает с `isTaskDetails` расширения).
 * Записи другой формы — старые или чужие — пропускаются молча.
 */
export function isOwnerSessionTodoDetails(value: unknown): value is { tasks: any[]; nextId: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

function normalizeTask(raw: any): OwnerSessionTodoTask | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : null;
  if (id === null) return null;
  const subject = typeof raw.subject === "string" ? raw.subject : "";
  const status = isStatus(raw.status) ? raw.status : "pending";
  const task: OwnerSessionTodoTask = { id, subject, status };
  if (typeof raw.description === "string" && raw.description.trim()) task.description = raw.description;
  if (typeof raw.activeForm === "string" && raw.activeForm.trim()) task.activeForm = raw.activeForm;
  if (Array.isArray(raw.blockedBy)) {
    const blockedBy = raw.blockedBy.filter((value: unknown) => typeof value === "number" && Number.isFinite(value));
    if (blockedBy.length) task.blockedBy = blockedBy as number[];
  }
  if (typeof raw.owner === "string" && raw.owner.trim()) task.owner = raw.owner;
  if (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) {
    task.metadata = raw.metadata as Record<string, unknown>;
  }
  return task;
}

/**
 * Состояние списка из ветки сессии: последняя запись с результатом `todo`
 * побеждает (так же, как в восстановлении официального расширения).
 * Чистая функция: одна и та же ветка — один и тот же ответ.
 */
export function sessionTodosFromEntries(sessionId: string, entries: Iterable<unknown>): OwnerSessionTodos {
  let last: { details: unknown; entryId: string | null; updatedAt: string | null } | null = null;
  for (const entry of entries) {
    const e = entry as { type?: string; id?: string; timestamp?: string; message?: any } | null;
    if (!e || e.type !== "message") continue;
    const message = e.message;
    if (!message || message.role !== "toolResult" || message.toolName !== OWNER_SESSION_TODO_TOOL) continue;
    if (!isOwnerSessionTodoDetails(message.details)) continue;
    last = {
      details: message.details,
      entryId: typeof e.id === "string" ? e.id : null,
      updatedAt: typeof e.timestamp === "string" ? e.timestamp : null,
    };
  }
  if (!last) return emptySessionTodos(sessionId);

  const details = last.details as { tasks: any[]; nextId: number };
  const counts: OwnerSessionTodoCounts = { ...EMPTY_COUNTS };
  const tasks: OwnerSessionTodoTask[] = [];
  for (const raw of details.tasks) {
    const task = normalizeTask(raw);
    if (!task || task.status === "deleted") continue;
    tasks.push(task);
    if (task.status === "in_progress") counts.in_progress += 1;
    else if (task.status === "completed") counts.completed += 1;
    else counts.pending += 1;
  }
  tasks.sort((a, b) => a.id - b.id);
  return {
    sessionId,
    available: true,
    entryId: last.entryId,
    updatedAt: last.updatedAt,
    nextId: typeof details.nextId === "number" ? details.nextId : 1,
    tasks,
    counts,
  };
}
