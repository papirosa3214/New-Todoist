// ═══════════ Types mirroring the server's actual row/response shapes ═══════════
// Kept snake_case on purpose — this is what the API returns, and screens
// consume it directly. No camelCase mapping layer.

export type Role = "owner" | "agent" | "viewer";
export type UserType = "human" | "ai";

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  type: UserType;
  avatar_color: string;
  initials: string;
  status: string;
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
  user_initials?: string | null;
  /** Приложенные файлы — приходят вместе с задачей (GET /api/tasks/:id). */
  attachments?: ApiAttachment[];
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
  actor_initials?: string | null;
}

export interface ApiTask {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
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
  // Derived, not stored — true once agent_heartbeat_at + 15min has passed
  // while agent_state is still set ("агент пропал"). Computed server-side
  // on every read (server/src/agentState.ts isStale), never trust a stale
  // client-cached value.
  agent_stale?: boolean;
  // Manual sort order within a TaskBoard column (server/src/db.ts's
  // additive migration) — NULL until the card is dragged for the first
  // time, in which case the view's own default order applies (see
  // TaskBoard.tsx). Not scoped to any one column/project — see that file's
  // comment for why cross-column value collisions are harmless.
  position: number | null;
  // Joined in on list/detail — not present on the raw row returned by
  // POST/PATCH.
  assignee_name?: string | null;
  assignee_color?: string | null;
  assignee_initials?: string | null;
  project_name?: string | null;
  project_color?: string | null;
  labels: ApiLabel[];
  subtasks: ApiSubtask[];
  comments?: ApiComment[]; // only on GET /api/tasks/:id
  events?: ApiTaskEvent[]; // only on GET /api/tasks/:id
}

export interface ApiProject {
  id: string;
  name: string;
  color: string;
  owner_id: string;
  task_count: number;
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
  actor_initials?: string | null;
  // LEFT JOIN users ON n.user_id — this is the *recipient*.
  user_name?: string | null;
  user_color?: string | null;
  user_initials?: string | null;
  task_title?: string | null;
}
