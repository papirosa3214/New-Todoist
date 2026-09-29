// Screen for a single label's task list — the destination for /labels/:id.
// Modeled directly on ProjectTasksScreen (same row shape, same
// priority-color bullets, same loading/not-found/empty treatment) so it
// reads as part of the same app, just scoped to one label's tasks instead
// of one project's. No dedicated server endpoint: GET /api/tasks already
// returns each task's labels array (see ApiTask.labels), so filtering
// client-side — exactly like ProjectTasksScreen filters by project_id —
// is cheaper than a new route and doesn't touch any existing contract.
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTasks, useUpdateTask } from "../api/tasks";
import { useLabels } from "../api/labels";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  Loading,
} from "../components/UI";
import { MONTHS_SHORT } from "../lib/date";
import { PRIORITY_COLORS } from "../lib/priority";

function formatDue(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

export function LabelTasksScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: labels = [],
    isLoading: labelsLoading,
    isError: labelsError,
    error: labelsErrorObj,
  } = useLabels();
  const {
    data: allTasks = [],
    isLoading: tasksLoading,
    isError: tasksError,
    error: tasksErrorObj,
  } = useTasks();
  const updateTask = useUpdateTask();

  const label = useMemo(() => labels.find((l) => l.id === id), [labels, id]);

  const tasks = useMemo(
    () =>
      allTasks.filter(
        (t) => t.status === "active" && t.labels.some((l) => l.id === id),
      ),
    [allTasks, id],
  );

  const isLoading = labelsLoading || tasksLoading;
  // Only "not found" once the labels list has actually loaded without
  // error — otherwise a still-loading or failed labels query would look
  // exactly like a deleted/unknown label id.
  const notFound = !labelsLoading && !labelsError && !label;

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title={
          label ? (
            <span className="inline-flex max-w-[62vw] items-center gap-2">
              <Icon
                name="tag"
                size={14}
                style={{ color: label.color }}
                className="shrink-0"
              />
              <span className="truncate">{label.name}</span>
            </span>
          ) : (
            "Метка"
          )
        }
      />

      <ErrorBanner
        error={labelsErrorObj}
        fallback="Не удалось загрузить метку"
        variant="inline"
        className="mb-2"
      />
      <ErrorBanner
        error={tasksErrorObj}
        fallback="Не удалось загрузить задачи"
        variant="inline"
        className="mb-2"
      />

      {isLoading && <Loading />}

      {notFound && (
        <div className="px-1 py-8 text-center">
          <p className="text-[14px] text-sub mb-4">
            Метка не найдена — возможно, она удалена.
          </p>
          <button
            onClick={() => navigate("/labels")}
            className="h-11 px-5 rounded-xl bg-card text-[13px] text-text font-semibold"
          >
            К списку меток
          </button>
        </div>
      )}

      {!isLoading &&
        !labelsError &&
        !tasksError &&
        label &&
        tasks.length === 0 && (
          <p className="px-1 text-[13px] text-dim">
            Этой меткой пока не помечена ни одна задача
          </p>
        )}

      <div className="space-y-[2px]">
        {/* Owner 2026-08-13: same dot-toggles-status split as TaskRow.tsx
            (its own comment has the full rationale). This screen already
            filters to status:"active" tasks above, so a toggle here just
            makes the row disappear from the list on the next refetch —
            same as ticking off a task anywhere else in the app. */}
        {tasks.map((task) => {
          const hasSubtasks = task.subtasks.length > 0;
          const doneSub = task.subtasks.filter((s) => s.done).length;
          const isDone = task.status === "completed";
          return (
            <div
              key={task.id}
              className="tap-row w-full flex items-start gap-3 py-3 px-1 border-b border-stroke/50"
            >
              <button
                onClick={() =>
                  updateTask.mutate({
                    id: task.id,
                    status: isDone ? "active" : "completed",
                  })
                }
                aria-label={
                  isDone ? "Вернуть в работу" : "Отметить выполненной"
                }
                className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0 flex items-center justify-center"
                style={{
                  borderColor: PRIORITY_COLORS[task.priority] || "#4A9FD8",
                }}
              >
                {isDone && (
                  <Icon name="check" size={12} className="text-white" />
                )}
              </button>
              <button
                onClick={() => navigate(`/task/${task.id}`)}
                className="flex-1 min-w-0 flex items-start gap-3 text-left"
              >
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-[15px] leading-snug mb-1 truncate ${isDone ? "line-through text-sub" : "text-text"}`}
                  >
                    <MarkdownInline source={task.title} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-sub">
                    {task.description && (
                      <span className="truncate max-w-[200px]">
                        {task.description.substring(0, 50)}…
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {task.labels.map((l) => (
                      <span
                        key={l.id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                        style={{
                          backgroundColor: l.color + "26",
                          color: l.color,
                        }}
                      >
                        <Icon name="tag" size={10} /> {l.name}
                      </span>
                    ))}
                    {task.due_date && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                        <Icon name="calendarSmall" size={10} />{" "}
                        {formatDue(task.due_date)}
                      </span>
                    )}
                    {hasSubtasks && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] bg-card text-sub">
                        {doneSub}/{task.subtasks.length}
                      </span>
                    )}
                  </div>
                </div>
                {task.assignee_id && task.assignee_initials && (
                  <Avatar
                    initials={task.assignee_initials}
                    color={task.assignee_color || "#A6A6A6"}
                    avatar_url={task.assignee_avatar_url}
                    size={24}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
