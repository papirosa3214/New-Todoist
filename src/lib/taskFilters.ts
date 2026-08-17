// ═══════════ TASK FILTERS (Inbox / Today / Upcoming) ═══════════
// Shared filter shape + pure helpers for the three "live" task screens.
// Deliberately just project/label/assignee — no "period" facet like
// ActivityScreen's Filters: that screen's driver is "completed tasks over
// a time window", these screens' driver is "what's on my plate right now"
// and already have their own date dimension (Today's overdue/today split,
// Upcoming's calendar) that a period filter would only fight with.
//
// Kept framework-agnostic (no React) on purpose — each screen builds its
// own useMemo around these, same as ActivityScreen already does inline for
// its own filtering. That keeps this file a plain, testable-in-principle
// data layer rather than another hook to learn.
import type { ApiTask } from "../api/types";

export interface TaskFilters {
  projectId: string | null; // null = все проекты
  labelId: string | null; // null = все метки
  assigneeKey: string | null; // null = все, "__none" = без исполнителя, иначе user id
  // Показывать ли выполненные (просьба Максима 15.08.2026). По умолчанию
  // выключено: списки — про то, что делать, а не про то, что сделано.
  // Считается ВКЛЮЧЁННЫМ фильтром, когда true, — иначе счётчик на кнопке
  // не объяснял бы, почему в списке вдруг появились закрытые задачи.
  showCompleted: boolean;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  projectId: null,
  labelId: null,
  assigneeKey: null,
  showCompleted: false,
};

export function taskMatchesFilters(
  task: ApiTask,
  filters: TaskFilters,
): boolean {
  if (filters.projectId && task.project_id !== filters.projectId) {
    return false;
  }
  if (filters.labelId && !task.labels.some((l) => l.id === filters.labelId)) {
    return false;
  }
  if (filters.assigneeKey === "__none") {
    if (task.assignee_id) return false;
  } else if (filters.assigneeKey && task.assignee_id !== filters.assigneeKey) {
    return false;
  }
  // Выполненные скрыты, пока их не попросили показать. Экраны, которые
  // выполненные и так не запрашивают, от этого не меняются — там таких
  // задач в наборе просто нет.
  if (!filters.showCompleted && task.status === "completed") {
    return false;
  }
  return true;
}

export function filterTasks(tasks: ApiTask[], filters: TaskFilters): ApiTask[] {
  return tasks.filter((t) => taskMatchesFilters(t, filters));
}

export function countActiveTaskFilters(filters: TaskFilters): number {
  return (
    (filters.projectId ? 1 : 0) +
    (filters.labelId ? 1 : 0) +
    (filters.assigneeKey ? 1 : 0) +
    (filters.showCompleted ? 1 : 0)
  );
}

export interface TaskFilterOption {
  id: string;
  label: string;
  color: string;
}

export interface TaskAssigneeOptions {
  list: {
    id: string;
    name: string;
    color: string;
    initials: string;
    avatar_url?: string | null;
  }[];
  hasUnassigned: boolean;
}

// Option lists are built from the screen's own pre-filter task universe
// (not the already-filtered set) — same rule ActivityScreen follows: every
// option shown is guaranteed to match at least one task somewhere on this
// screen, even if combining it with another active filter currently yields
// zero results.
export function buildProjectOptions(tasks: ApiTask[]): TaskFilterOption[] {
  const map = new Map<string, TaskFilterOption>();
  for (const t of tasks) {
    if (t.project_id && t.project_name && !map.has(t.project_id)) {
      map.set(t.project_id, {
        id: t.project_id,
        label: t.project_name,
        color: t.project_color || "#A6A6A6",
      });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

export function buildLabelOptions(tasks: ApiTask[]): TaskFilterOption[] {
  const map = new Map<string, TaskFilterOption>();
  for (const t of tasks) {
    for (const l of t.labels) {
      if (!map.has(l.id)) {
        map.set(l.id, { id: l.id, label: l.name, color: l.color });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

export function buildAssigneeOptions(tasks: ApiTask[]): TaskAssigneeOptions {
  const map = new Map<
    string,
    {
      id: string;
      name: string;
      color: string;
      initials: string;
      avatar_url?: string | null;
    }
  >();
  let hasUnassigned = false;
  for (const t of tasks) {
    if (t.assignee_id) {
      if (!map.has(t.assignee_id)) {
        map.set(t.assignee_id, {
          id: t.assignee_id,
          name: t.assignee_name || "Без имени",
          color: t.assignee_color || "#A6A6A6",
          initials: t.assignee_initials || "?",
          avatar_url: t.assignee_avatar_url,
        });
      }
    } else {
      hasUnassigned = true;
    }
  }
  return {
    list: [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    hasUnassigned,
  };
}
