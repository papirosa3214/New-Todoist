// Просмотр задачи: заголовок/описание/срок/приоритет/метки/исполнитель —
// только чтение, подзадачи — можно отмечать выполненными прямо здесь
// (как и было). Полное редактирование полей (включая CRUD подзадач)
// живёт в TaskFormScreen — карандаш в шапке ведёт туда (owner 2026-08-10:
// «точно такой же интерфейс должен открываться при редактировании» —
// переиспользуем форму создания вместо отдельного подменю).
import { useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTask, useUpdateTask, useDeleteTask } from "../api/tasks";
import { useUpdateSubtask } from "../api/subtasks";
import { useAddComment } from "../api/comments";
import { ApiError } from "../api/client";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import { PRIORITIES, PriorityPill } from "../components/TaskFields";
import { formatDueLabel, formatRelativeTime } from "../lib/date";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";

// ═══════════ SUBTASK ROW ═══════════
// Its own component (not inlined in the .map() below) so each row gets its
// own useGuardedCallback instance — one hook call per row instance, per
// useGuardedCallback's own rule. A single guard hoisted out of the loop and
// shared across rows would make tapping row 2 a silent no-op while row 1's
// toggle is still in flight.
function SubtaskToggleRow({
  title,
  done,
  onToggle,
}: {
  title: string;
  done: boolean;
  onToggle: () => Promise<unknown>;
}) {
  const guardedToggle = useGuardedCallback(onToggle);
  return (
    <button
      onClick={guardedToggle}
      className="w-full flex items-center gap-3 py-3 px-4 text-left"
    >
      <div
        className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 ${
          done ? "bg-red border-red" : "border-dim"
        }`}
      >
        {done && <Icon name="check" size={12} className="text-white" />}
      </div>
      <span
        className={`text-[14px] ${done ? "line-through text-sub" : "text-text"}`}
      >
        {title}
      </span>
    </button>
  );
}

export function TaskDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, isError, error } = useTask(id);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateSubtask = useUpdateSubtask();
  const addComment = useAddComment(id || "");
  const { confirm, alert, dialog } = useDialog();

  const [commentText, setCommentText] = useState("");

  // These guarded handlers close over `task`, which is only defined once
  // the query resolves — but the hooks themselves must run unconditionally,
  // above the isLoading/isError/!task early returns below. Calling a hook
  // only in the "task loaded" branch would change the hook count between
  // renders the moment the task resolves (React: "Rendered more hooks than
  // during the previous render"). Each body starts with `if (!task) return`
  // so there's nothing to actually do before the task exists — the guard
  // just can't be skipped structurally.
  const handleDelete = useGuardedCallback(async () => {
    if (!task) return;
    const ok = await confirm({
      title: "Удалить задачу без возможности отмены?",
      confirmLabel: "Удалить",
      cancelLabel: "Отмена",
      danger: true,
    });
    if (!ok) return;
    try {
      // Only the creator may delete (server enforces this with a 404, same
      // as "not found", so an assignee-only task shows this rather than a
      // 403).
      await deleteTask.mutateAsync(task.id);
      navigate(-1);
    } catch {
      await alert(
        "Не удалось удалить задачу — возможно, вы не создатель этой задачи.",
      );
    }
  });

  const handleToggleStatus = useGuardedCallback(async () => {
    if (!task) return;
    const newStatus = task.status === "active" ? "completed" : "active";
    await updateTask.mutateAsync({ id: task.id, status: newStatus });
  });

  const handleSubmitComment = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = commentText.trim();
    if (!trimmed) return;
    await addComment.mutateAsync(trimmed);
    setCommentText("");
  });

  if (isLoading) {
    return <div className="px-4 py-8 text-center text-sub">Загрузка…</div>;
  }

  if (isError) {
    // A 404 (deleted task, stale link, someone else's task) is the common
    // case here and isn't a connectivity problem — showing "проверьте
    // соединение" for it would be misleading. useTask has retry: false, so
    // any non-404 failure (offline, 5xx) falls through to the ErrorBanner
    // below, which turns a raw ApiError/TypeError into real Russian copy.
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
      );
    }
    return (
      <div className="px-4 py-8">
        <ErrorBanner
          error={error}
          fallback="Не удалось загрузить задачу — проверьте соединение"
          variant="block"
        />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
    );
  }

  const priorityColor =
    PRIORITIES.find((p) => p.key === task.priority)?.color ?? "#A6A6A6";

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader
        variant="compact"
        leading={
          <button
            onClick={() => navigate(-1)}
            className="w-[44px] h-[44px] rounded-full bg-card2 flex items-center justify-center"
          >
            <Icon name="chevronLeft" size={18} />
          </button>
        }
        title=""
        actions={
          <>
            <button
              onClick={() => navigate(`/task/${task.id}/edit`)}
              className="w-[44px] h-[44px] rounded-full bg-card2 flex items-center justify-center"
            >
              <Icon name="edit" size={16} className="text-sub" />
            </button>
            <button
              onClick={handleDelete}
              className="w-[44px] h-[44px] rounded-full bg-card2 flex items-center justify-center"
            >
              <Icon name="trash" size={16} className="text-coral" />
            </button>
          </>
        }
      />

      {/* Priority ring + Title */}
      <div className="flex items-start gap-3 mb-4">
        <button
          onClick={handleToggleStatus}
          className="mt-1 w-[22px] h-[22px] rounded-full border-2 shrink-0 flex items-center justify-center"
          style={{ borderColor: priorityColor }}
        >
          {task.status === "completed" && (
            <Icon name="check" size={14} className="text-white" />
          )}
        </button>
        <h1
          className={`text-[20px] font-semibold leading-snug ${task.status === "completed" ? "line-through text-sub" : ""}`}
        >
          {task.title}
        </h1>
      </div>

      <ErrorBanner
        error={updateTask.error}
        fallback="Не удалось обновить задачу"
        variant="block"
        className="mb-4"
      />

      {/* Description */}
      {task.description && (
        <p className="text-[14px] text-sub leading-relaxed mb-4 pl-[34px] whitespace-pre-wrap">
          {task.description}
        </p>
      )}

      {/* Metadata */}
      <div className="space-y-[2px] mb-4">
        {task.due_date && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Icon name="calendarSmall" size={18} className="text-red" />
            <span className="text-[14px] text-red">
              {formatDueLabel(task.due_date)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
          <Icon name="flag" size={18} className="text-sub" />
          <span className="text-[14px] text-sub flex-1">Приоритет</span>
          <PriorityPill priority={task.priority} />
        </div>
        {task.assignee_id && task.assignee_name && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Avatar
              initials={task.assignee_initials || "?"}
              color={task.assignee_color || "#A6A6A6"}
              size={24}
            />
            <span className="text-[14px] text-text">{task.assignee_name}</span>
          </div>
        )}
      </div>

      {/* Labels */}
      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px]"
              style={{ backgroundColor: l.color + "26", color: l.color }}
            >
              <Icon name="tag" size={11} /> {l.name}
            </span>
          ))}
        </div>
      )}

      {/* Subtasks — quick toggle only; add/rename/delete happens in the
          edit form (see header pencil button). */}
      {task.subtasks.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">
            Подзадачи
          </h3>
          <div className="bg-card rounded-2xl overflow-hidden">
            {task.subtasks.map((st) => (
              <SubtaskToggleRow
                key={st.id}
                title={st.title}
                done={st.done}
                onToggle={() =>
                  updateSubtask.mutateAsync({ id: st.id, done: !st.done })
                }
              />
            ))}
          </div>
          <ErrorBanner
            error={updateSubtask.error}
            fallback="Не удалось обновить подзадачу"
            variant="block"
            className="mt-2"
          />
        </div>
      )}

      {/* Comments */}
      <div>
        <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">
          Комментарии
        </h3>
        {!task.comments || task.comments.length === 0 ? (
          <div className="bg-card rounded-2xl p-4 text-center text-[13px] text-dim mb-2">
            Нет комментариев
          </div>
        ) : (
          <div className="space-y-2 mb-2">
            {task.comments.map((c) => (
              <div key={c.id} className="bg-card rounded-2xl p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Avatar
                    initials={c.user_initials || "?"}
                    color={c.user_color || "#A6A6A6"}
                    size={20}
                  />
                  <span className="text-[13px] font-medium">
                    {c.user_name || "Неизвестный"}
                  </span>
                  <span className="text-[11px] text-dim ml-auto">
                    {formatRelativeTime(c.created_at)}
                  </span>
                </div>
                <p className="text-[14px] text-sub">{c.text}</p>
              </div>
            ))}
          </div>
        )}
        <ErrorBanner
          error={addComment.error}
          fallback="Не удалось отправить комментарий"
          variant="block"
          className="mb-2"
        />
        <form
          onSubmit={handleSubmitComment}
          className="flex items-center gap-2"
        >
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Написать комментарий…"
            className="flex-1 bg-card rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none"
          />
          <button
            type="submit"
            disabled={!commentText.trim() || addComment.isPending}
            className="w-[40px] h-[40px] rounded-xl bg-red flex items-center justify-center shrink-0 disabled:opacity-50"
          >
            <Icon name="chevron" size={16} className="text-white -rotate-90" />
          </button>
        </form>
      </div>
    </div>
  );
}
