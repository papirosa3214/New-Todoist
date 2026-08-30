// ═══════════ Types mirroring the server's actual row/response shapes ═══════════
// Kept snake_case on purpose — this is what the API returns, and screens
// consume it directly. No camelCase mapping layer.

export type Role = "owner" | "agent" | "viewer" | "orchestrator";
export type UserType = "human" | "ai";

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  type: UserType;
  avatar_color: string;
  avatar_url?: string | null;
  // «Живая» аватарка (27.08.2026) — необязательные варианты и вычисленное
  // сервером текущее состояние (GET /api/agents). Приходят только там,
  // остальные ответы (задачи, комментарии) их не отдают — там достаточно
  // дефолтной avatar_url.
  avatar_url_working?: string | null;
  avatar_url_blocked?: string | null;
  activity?: "working" | "blocked" | null;
  initials: string;
  status: string;
  // Признаки жизни агента. Сервер считает по запросам к authOrApiToken
  // и кладёт в users.last_seen_at / в память (activeAgent.ts). online —
  // «запрос был в последнюю минуту», last_action — что именно делает,
  // last_action_title — название задачи, к которой обращение (для подписи
  // в UI). limits — лимиты агента, если есть. Отдаются только в
  // GET /api/agents, остальные ответы их не включают.
  online?: boolean;
  last_seen_at?: string | null;
  last_action?: string;
  last_action_title?: string;
  limits?: { remaining?: number | string } | null;
}

export interface ApiLabel {
  id: string;
  name: string;
  color: string;
  owner_id?: string;
}

export interface ApiSubtask {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  position: number;
  // Аренда агента над этой конкретной подзадачей (withSubtaskState,
  // server/src/routes/tasks.ts) — вычисляются при КАЖДОЙ отдаче, не
  // хранятся как есть. Опциональны не потому, что сервер может их не
  // прислать (шлёт всегда), а чтобы TS не ломался там, где подзадача
  // собирается вручную (TaskFormScreen.tsx create-mode, localSubtasks) без
  // этих полей вовсе. См. SubtaskFeed.tsx — тот же набор состояний, что
  // здесь, называется SubtaskState.
  state?: "done" | "running" | "pending" | "blocked";
  result?: string | null;
  agent_id?: string | null;
  agent_heartbeat_at?: string | null;
  agent_stale?: boolean;
}

// Вложение комментария. Байтов здесь нет — только описание файла; сам файл
// забирается отдельным запросом (GET /api/attachments/:id), иначе карточка
// тащила бы за собой все приложенные скриншоты разом.
export interface ApiAttachment {
  id: string;
  comment_id: string | null;
  file_name: string;
  mime: string;
  size: number;
  created_at: string;
}

export interface ApiComment {
  id: string;
  task_id: string;
  user_id: string;
  text: string;
  created_at: string;
  user_name?: string | null;
  user_color?: string | null;
  user_avatar_url?: string | null;
  user_initials?: string | null;
  /** Приложенные файлы — приходят вместе с задачей (GET /api/tasks/:id). */
  attachments?: ApiAttachment[];
}

// Чат агентов (server/src/routes/chat.ts): общий канал, to_user_id — адресный
// намёк (кого будить), не приватное ЛС — остальные видят сообщение тоже.
/** Канал сообщения (28.08.2026): «owner» — разговор владельца с
    оркестратором, «agents» — рабочая переписка исполнителей. Проставляет
    сервер по ролям отправителя и адресата, клиент его не выбирает. */
export type ChatChannel = "owner" | "agents";

export interface ApiChatMessage {
  id: string;
  channel: ChatChannel;
  from_user_id: string;
  to_user_id: string | null;
  task_id: string | null;
  kind: "совещание" | "делегирование" | "находка" | null;
  text: string;
  created_at: string;
  from_user_name?: string | null;
  from_user_color?: string | null;
  from_user_avatar_url?: string | null;
  from_user_initials?: string | null;
  /** Имя адресата. Пусто при to_user_id = null — это сообщение всей ленте
      («всем»), с 28.08.2026 такой же ЯВНЫЙ выбор, как и любой другой. */
  to_user_name?: string | null;
  to_user_color?: string | null;
  task_title?: string | null;
  /** Приложенные файлы. Приезжают вместе с сообщением — и в истории, и в
      живой рассылке по сокету, чтобы пузырь не дорисовывал скрепку позже. */
  attachments?: ApiChatAttachment[];
}

/** Сводка «кто кого озадачивает» (28.08.2026). Ключи русские — как у
    остальных счётчиков сервера (ср. «непрочитано»). */
export interface ApiChatStats {
  всего: number;
  кому: Array<{ id: string | null; имя: string; сообщений: number }>;
  от_кого: Array<{ id: string; имя: string; сообщений: number }>;
  пары: Array<{
    от_id: string;
    от: string;
    кому_id: string | null;
    кому: string;
    сообщений: number;
  }>;
}

/** Вложение сообщения чата — только то, что нужно пузырю. Полный
    ApiAttachment сюда не тянем: comment_id и created_at здесь бессмысленны. */
export interface ApiChatAttachment {
  id: string;
  file_name: string;
  mime: string;
  size: number;
}

export interface ApiChatParticipant {
  id: string;
  name: string;
  type: string;
  /** Роль нужна экрану, чтобы найти оркестратора: в канале владельца он
      единственный собеседник, и адресат там не выбирается, а показывается. */
  role?: Role;
  avatar_color?: string | null;
  avatar_url?: string | null;
  initials?: string | null;
}

// tasks.agent_state / tasks.agent_heartbeat_at — see AGENT-PROTOCOL.md and
// server/src/agentState.ts. NULL means "никто не взял"; the three named
// states are set exclusively through POST /api/tasks/:id/{claim,state}.
export type AgentState = "in_progress" | "blocked" | "review";

// A row from task_events — the immutable, server-written journal of what
// happened to a task (see AGENT-PROTOCOL.md, "Журнал задачи"). Only ever
// INSERTed/SELECTed by the server; there is no API to edit or delete one.
export interface ApiTaskEvent {
  id: string;
  task_id: string;
  actor_id: string | null; // NULL = system-authored entry, no human/agent actor
  kind: string; // e.g. "claimed" | "state_changed" | ...
  field: string | null;
  from_value: string | null;
  to_value: string | null;
  created_at: string;
  actor_name?: string | null;
  actor_color?: string | null;
  actor_avatar_url?: string | null;
  actor_initials?: string | null;
}

export interface ApiTask {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  // Час начала «ЧЧ:ММ» местного времени и длительность в минутах — под
  // календарную развёртку раздела «День» (миграция 005_task_time_of_day).
  // Оба необязательные: задача без них — обычная задача списка.
  start_time?: string | null;
  duration_min?: number | null;
  project_id: string | null;
  priority: 1 | 2 | 3 | 4;
  assignee_id: string | null;
  creator_id: string;
  status: "active" | "completed";
  created_at: string;
  updated_at: string;
  // The moment status flipped active→completed — see server/src/db.ts's
  // additive migration for the full contract: set only on that exact
  // transition, cleared back to NULL on completed→active, untouched by
  // any other PATCH (so editing a finished task never re-stamps it).
  // Tasks completed before this column existed were backfilled from
  // updated_at, so this is effectively never null for status:"completed" —
  // ActivityScreen still falls back to updated_at defensively.
  completed_at: string | null;
  // Agent-work protocol (AGENT-PROTOCOL.md) — orthogonal to `status`: a task
  // stays status:"active" the entire time an agent works on it, so none of
  // the status==="active" filters across the frontend need to change.
  agent_state?: AgentState | null;
  agent_heartbeat_at?: string | null;
  // Чья сессия ведёт задачу (X-Agent-Session, agent-state.ts claim/state) —
  // нужен только для одного: показать владельцу команду `claude --resume`,
  // чтобы зайти в терминал того же двойника (TaskJournal.tsx AgentStatusRow).
  agent_session_id?: string | null;
  // Derived, not stored — true once agent_heartbeat_at + 15min has passed
  // while agent_state is still set ("агент пропал"). Computed server-side
  // on every read (server/src/agentState.ts isStale), never trust a stale
  // client-cached value.
  agent_stale?: boolean;
  // Момент последнего взятия задачи агентом — вычисляется из журнала на каждой
  // отдаче (hydrateTask). Нужен островку: он крутит время работы от этой точки,
  // иначе счётчик обнулялся бы каждый раз, когда приложение открывают заново.
  agent_started_at?: string | null;
  // Manual sort order within a TaskBoard column (server/src/db.ts's
  // additive migration) — NULL until the card is dragged for the first
  // time, in which case the view's own default order applies (see
  // TaskBoard.tsx). Not scoped to any one column/project — see that file's
  // comment for why cross-column value collisions are harmless.
  position: number | null;
  // Закреплена наверх списка внутри проекта (server/src/db.ts's additive
  // migration, 20.08.2026) — независимо от position, см. ProjectTasksScreen.
  pinned?: boolean | number;
  // Joined in on list/detail — not present on the raw row returned by
  // POST/PATCH.
  assignee_name?: string | null;
  assignee_color?: string | null;
  assignee_avatar_url?: string | null;
  assignee_initials?: string | null;
  project_name?: string | null;
  project_color?: string | null;
  labels: ApiLabel[];
  subtasks: ApiSubtask[];
  // id родительской задачи (null = корневая). Добавлено 30.08.2026 под origin'овский
  // taskOwner.ts, где Pick<ApiTask, "status"|"agent_state"|"creator_id"|"parent_id">
  // требует поле обязательно.
  parent_id: string | null;
  // Дочерние задачи (parent_task_id = this.id). Сервер отдаёт в GET /api/tasks/:id
  // рядом с subtasks. TaskDetailScreen переключает таб по наличию.
  // Добавлено 30.08.2026 — старый код ссылался на .children, которого не было в типе.
  children?: ApiTask[];
  comments?: ApiComment[]; // only on GET /api/tasks/:id
  events?: ApiTaskEvent[]; // only on GET /api/tasks/:id
  // Файлы, приложенные к самой задаче (kind='task' на сервере), а не к
  // комментарию в ленте — то, что прикладывается в форме под «Заметкой».
  // Тоже только на GET /api/tasks/:id.
  attachments?: ApiAttachment[];
}

export interface ApiProject {
  id: string;
  name: string;
  color: string;
  owner_id: string;
  task_count: number;
  // Ручной порядок и закрепление в блоке «Мои проекты» (OverviewScreen,
  // 20.08.2026) — тот же смысл, что у ApiTask.position/pinned выше.
  position?: number | null;
  pinned?: boolean | number;
  /** Папка заметок проекта — ссылка на папку Дневника (journal_folders).
   *  Своей иерархии у проекта нет: папка живёт в общем дереве заметок,
   *  проект лишь указывает на неё (26.08.2026). */
  notes_folder_id?: number | null;
}

export interface ApiNotification {
  id: string;
  user_id: string;
  type:
    | "assigned"
    | "completed"
    | "commented"
    | "subtask_created"
    | "new_task"
    | string;
  task_id: string | null;
  text: string;
  read: 0 | 1;
  created_at: string;
  // actor_id and actor_name — the user who triggered the notification.
  // For old notifications created before this was added, they may be null/empty.
  actor_id?: string | null;
  actor_name?: string | null;
  actor_color?: string | null;
  actor_avatar_url?: string | null;
  actor_initials?: string | null;
  // LEFT JOIN users ON n.user_id — this is the *recipient*.
  user_name?: string | null;
  user_color?: string | null;
  user_initials?: string | null;
  task_title?: string | null;
}
