// ═══════════ TASK BOARD ═══════════
// Shared "список ↔ доска" board layout for Inbox and Today. Deliberately
// dumb/presentational: it only knows how to lay out whatever columns it's
// handed, not where those columns come from — the two screens build very
// different column sets (Inbox: one column per project; Today: exactly
// "Просрочено" / "Сегодня", never by project — direct product decision)
// with different header furniture (Inbox: a plain trailing count; Today's
// "Просрочено" folds its count into the title text itself and adds a
// "Перенести" button). Both screens now give every column a footer
// "Добавить задачу" pill (Today's "Сегодня" column; every Inbox project
// column, including "Без проекта") — a single generic component keeps that
// difference in the screens, not duplicated here.
//
// Columns scroll horizontally as a group (the screen itself never scrolls
// sideways — see overflow-x-auto below, scoped to this strip only). Column
// width is fixed so the next column's edge peeks in on a 390px phone,
// hinting there's more to the right; a board reduced to a single column
// (e.g. Today with no overdue tasks) instead goes full-width — a lone
// 260px column floating in the middle of the screen would look broken.
import type { ReactNode } from "react";
import { Icon } from "./UI";
import { getPriorityColor } from "../lib/priority";
import type { ApiTask } from "../api/types";

const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

function formatCompactDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

export interface BoardColumn {
  id: string;
  // Exact header text — callers compose it fully themselves (e.g. Inbox
  // passes a bare project name; Today's overdue column passes "Просрочено
  // 8" as one string, per the product screenshot showing the count folded
  // into the label rather than a separate pill).
  title: string;
  // Leading dot before the title, in the column's own real color (a
  // project's `color` from the API). Status columns (Просрочено/Сегодня)
  // have no such color and omit this — they signal meaning through
  // titleClassName instead, mirroring exactly how the list layout already
  // styles those two labels (TodayScreen.tsx: red for overdue, sub for
  // today's date).
  dotColor?: string;
  titleClassName?: string;
  // Separate trailing count pill, right-aligned — Inbox's project columns
  // only. Today's columns fold their count into `title` (Просрочено) or
  // show none at all (Сегодня), so this stays unset there.
  trailingCount?: number;
  tasks: ApiTask[];
  // Whether every card's due-date badge should use the list's existing
  // "overdue" red style (bg-red/15 text-red) or the neutral one. A
  // column-level flag, not per-card, because both current uses are
  // column-uniform: every card in "Просрочено" is overdue, none in
  // "Сегодня" or in an Inbox project column is.
  dueBadgeVariant?: "default" | "overdue";
  // Show each card's own project chip. Off for Inbox (the column already
  // *is* the project — repeating it on every card would be noise); on for
  // Today (its columns cut across projects, so the chip is the only place
  // that context still shows).
  showProjectBadge?: boolean;
  // Extra control in the header's right slot, e.g. Today's red "Перенести"
  // button on the overdue column.
  headerAction?: ReactNode;
  // Rendered below the column's cards (or its empty-state box), e.g.
  // Today's "Добавить задачу" pill under "Сегодня".
  footer?: ReactNode;
}

function BoardCard({
  task,
  overdue,
  showProjectBadge,
  onClick,
}: {
  task: ApiTask;
  overdue: boolean;
  showProjectBadge: boolean;
  onClick: () => void;
}) {
  const doneSub = task.subtasks.filter((s) => s.done).length;
  const label = task.labels[0];
  const hasFooter =
    !!task.due_date ||
    task.subtasks.length > 0 ||
    !!label ||
    (showProjectBadge && !!task.project_name);

  return (
    <button
      onClick={onClick}
      className="tap-row w-full text-left bg-card rounded-xl p-3 flex flex-col gap-1"
    >
      <div className="flex items-start gap-2">
        <div
          className="mt-0.5 w-[12px] h-[12px] rounded-full border-2 shrink-0"
          style={{ borderColor: getPriorityColor(task.priority) }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-text leading-snug line-clamp-2">
            {task.title}
          </div>
          {task.description && (
            <div className="text-[11px] text-sub truncate mt-0.5">
              {task.description}
            </div>
          )}
        </div>
      </div>
      {hasFooter && (
        <div className="flex items-center gap-1.5 flex-wrap pl-[18px]">
          {task.due_date && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                overdue ? "bg-red/15 text-red" : "bg-card2 text-sub"
              }`}
            >
              <Icon name="calendarSmall" size={9} />
              {formatCompactDate(task.due_date)}
            </span>
          )}
          {task.subtasks.length > 0 && (
            <span className="text-[10px] text-sub shrink-0">
              {doneSub}/{task.subtasks.length}
            </span>
          )}
          {label && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0"
              style={{
                backgroundColor: label.color + "26",
                color: label.color,
              }}
            >
              <Icon name="tag" size={9} />
              {label.name}
            </span>
          )}
          {showProjectBadge && task.project_name && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0 min-w-0"
              style={{
                backgroundColor: (task.project_color || "#A6A6A6") + "26",
                color: task.project_color || "#A6A6A6",
              }}
            >
              <Icon name="hash" size={9} />
              <span className="truncate max-w-[90px]">{task.project_name}</span>
            </span>
          )}
        </div>
      )}
    </button>
  );
}

export function TaskBoard({
  columns,
  onTaskClick,
  isLoading,
  emptyMessage = "Пока нечего показать",
}: {
  columns: BoardColumn[];
  onTaskClick: (taskId: string) => void;
  isLoading?: boolean;
  emptyMessage?: string;
}) {
  // The parent screen already renders its own "Загрузка…" line above the
  // list/board switch — nothing to add here, just don't flash an "empty"
  // message while the real data is still in flight.
  if (isLoading) return null;

  if (columns.length === 0) {
    return (
      <div className="py-10 text-center text-[13px] text-dim">
        {emptyMessage}
      </div>
    );
  }

  const single = columns.length === 1;

  return (
    <div
      data-board-strip
      className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2"
    >
      {columns.map((col) => (
        <div
          key={col.id}
          className={`shrink-0 snap-start ${single ? "w-full" : "w-[260px]"}`}
        >
          {/* min-h-11 on both column headers on purpose — the overdue
              column's "Перенести" button is a 44px tap target, so without
              matching that floor here the two headers would sit at
              different heights and the first card in each column would
              start at a different Y (exactly the misaligned-board-columns
              failure mode). */}
          <div className="flex items-center gap-2 px-1 mb-2 min-h-11">
            {col.dotColor && (
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: col.dotColor }}
              />
            )}
            <span
              className={`text-[13px] font-semibold truncate ${
                col.titleClassName ?? "text-text"
              }`}
            >
              {col.title}
            </span>
            {(col.trailingCount !== undefined || col.headerAction) && (
              <div className="ml-auto shrink-0 flex items-center gap-1">
                {col.trailingCount !== undefined && (
                  <span className="text-[11px] text-sub">
                    {col.trailingCount}
                  </span>
                )}
                {col.headerAction}
              </div>
            )}
          </div>

          {col.tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stroke py-6 text-center text-[12px] text-dim">
              Нет задач
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {col.tasks.map((task) => (
                <BoardCard
                  key={task.id}
                  task={task}
                  overdue={col.dueBadgeVariant === "overdue"}
                  showProjectBadge={!!col.showProjectBadge}
                  onClick={() => onTaskClick(task.id)}
                />
              ))}
            </div>
          )}

          {/* mt-4, а не mt-2: на mt-2 кнопка «Добавить задачу» вплотную
              липла к последней карточке и читалась как ещё одна строка
              списка, а не как действие (замечание владельца 11.08.2026). */}
          {col.footer && <div className="mt-4">{col.footer}</div>}
        </div>
      ))}
    </div>
  );
}
