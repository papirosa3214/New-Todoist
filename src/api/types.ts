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

export interface ApiComment {
  id: string;
  task_id: string;
  user_id: string;
  text: string;
  created_at: string;
  user_name?: string | null;
  user_color?: string | null;
  user_initials?: string | null;
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
