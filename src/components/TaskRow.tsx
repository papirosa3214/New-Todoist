// ═══════════ TASK ROW ═══════════
// One list-row rendering of a task (priority dot + title + description +
// labels/due/subtasks/agent-state badges + assignee avatar) — used by the
// list layouts of InboxScreen, ProjectTasksScreen, UpcomingScreen and
// TodayScreen. Built from TodayScreen's former local `TaskRow` (its
// button shape, its priority dot, its title/description stack) and
// extended with the badge types InboxScreen/ProjectTasksScreen/
// UpcomingScreen's near-identical local copies also needed — those three
// screens are gone now, replaced by this one file.
//
// Not a board card: TaskBoard.tsx's BoardCard is a different, denser
// component for the "доска" layout (260px columns) and stays separate —
// this component is only for the "список" layout's full-width rows.
//
// Description now renders as its own line with `line-clamp-2` (CSS
// two-line ellipsis, no manual substring cut) rather than the three
// different treatments the four screens used to have (Today: substring(0,
// 60) + truncate; Upcoming: line-clamp-2, no cut; Inbox/Project: substring
// (0,50) crammed into the badge row) — this is also what mockup-reference/
// index.html's own `.t-title`/`.t-sub`/`.t-meta` split does (title line,
// description line, then a separate badge row), so unifying on it is a
// mockup-fidelity fix, not just deduplication. Press feedback is `tap-row`
// (index.css's own canonical answer for "a row inside a list" — Inbox/
// Project's `active:bg-card/50 transition-colors` was exactly the kind of
// ad-hoc drift that block's own comment calls out), and the label pill
// always uses the "tag" icon (Upcoming's single label pill used "shield" —
// the odd one out against Inbox/Project/LabelsScreen's "tag" convention).
//
// Props below are only for genuine per-screen product differences (what a
// row is allowed to show at all), never for restyling the same badge two
// ways — see each prop's comment for which screen needs it and why.
import { Icon, Avatar, AgentStateTag } from "./UI";
import { getPriorityColor } from "../lib/priority";
import { formatDueLabel, MONTHS_SHORT } from "../lib/date";
import type { ApiTask } from "../api/types";

// Plain "8 авг" — no relative "Сегодня/Завтра" prefix, no trailing dot.
// Distinct from lib/date.ts's `formatDueLabel` (used just below for the
// overdue-specific red pill, which DOES want that relative prefix) — this
// is the ordinary due-date badge's format, matching what Inbox/Project's
// former local `formatDue` produced. Kept private/unexported: a plain
// function export from a component file trips oxlint's
// react/only-export-components (see lib/priority.ts's own comment on why
// PRIORITY_COLORS/getPriorityColor live outside UI.tsx for the same rule).
function formatDue(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

export interface TaskRowProps {
  task: ApiTask;
  onClick: () => void;
  // TodayScreen only: this row is overdue — swaps the ordinary due badge
  // for a red "Просрочено, …" pill (relative label from formatDueLabel).
  overdue?: boolean;
  // TodayScreen only: show the agent-state pill (AGENT-PROTOCOL.md — "в
  // работе"/"на проверке"/"заблокировано"/"агент пропал"). Inbox/Project/
  // Upcoming's plain list rows never showed this.
  showAgentState?: boolean;
  // How many label pills to render. Inbox/Project show every label
  // (Infinity, the default); Upcoming only ever showed the first one
  // (pass 1); Today shows none at all (pass 0) — its row stays a focused
  // "what and why" line without the extra badges the other three carry.
  maxLabels?: number;
  // Ordinary (non-overdue) due-date badge. Default on for Inbox/Project.
  // Off for Upcoming (the date is already that row's group header, a
  // second copy on the row itself would be redundant) and for Today
  // (which only ever shows the overdue-specific red pill, never a plain
  // one for a same-day date).
  showDueBadge?: boolean;
  // Subtasks-done badge ("2/5"). Default on for Inbox/Project/Upcoming,
  // off for Today (same "keep the row focused" reasoning as maxLabels).
  showSubtasksBadge?: boolean;
  // Assignee avatar. Default on for Inbox/Project/Upcoming, off for
  // Today — its row never carried one and nothing in this task asks to
  // add it there.
  showAvatar?: boolean;
}

export function TaskRow({
  task,
  onClick,
  overdue = false,
  showAgentState = false,
  maxLabels = Infinity,
  showDueBadge = true,
  showSubtasksBadge = true,
  showAvatar = true,
}: TaskRowProps) {
  const doneSub = task.subtasks.filter((s) => s.done).length;
  const visibleLabels = maxLabels > 0 ? task.labels.slice(0, maxLabels) : [];

  const hasOverduePill = overdue && !!task.due_date;
  const hasAgentTag = showAgentState && !!task.agent_state;
  const hasDueBadge = showDueBadge && !overdue && !!task.due_date;
  const hasSubtasksBadge = showSubtasksBadge && task.subtasks.length > 0;
  const hasLabels = visibleLabels.length > 0;
  const hasMeta =
    hasOverduePill ||
    hasAgentTag ||
    hasDueBadge ||
    hasSubtasksBadge ||
    hasLabels;

  return (
    <button
      onClick={onClick}
      className="tap-row w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50"
    >
      <div
        className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0"
        style={{ borderColor: getPriorityColor(task.priority) }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] text-text leading-snug truncate">
          {task.title}
        </div>
        {task.description && (
          <div className="text-[13px] text-sub mt-0.5 line-clamp-2">
            {task.description}
          </div>
        )}
        {hasMeta && (
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            {hasOverduePill && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-red/15 text-red">
                <Icon name="calendarSmall" size={10} /> Просрочено,{" "}
                {formatDueLabel(task.due_date!)}
              </span>
            )}
            {hasAgentTag && <AgentStateTag task={task} />}
            {visibleLabels.map((l) => (
              <span
                key={l.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                style={{ backgroundColor: l.color + "26", color: l.color }}
              >
                <Icon name="tag" size={10} /> {l.name}
              </span>
            ))}
            {hasDueBadge && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                <Icon name="calendarSmall" size={10} />{" "}
                {formatDue(task.due_date!)}
              </span>
            )}
            {hasSubtasksBadge && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                <Icon name="check" size={10} /> {doneSub}/{task.subtasks.length}
              </span>
            )}
          </div>
        )}
      </div>
      {showAvatar && task.assignee_id && task.assignee_initials && (
        <Avatar
          initials={task.assignee_initials}
          color={task.assignee_color || "#A6A6A6"}
          size={24}
        />
      )}
    </button>
  );
}
