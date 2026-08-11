// Просмотр задачи: заголовок/описание/срок/приоритет/метки/исполнитель —
// только чтение, подзадачи — можно отмечать выполненными прямо здесь
// (как и было). Полное редактирование полей (включая CRUD подзадач)
// живёт в TaskFormScreen — карандаш в шапке ведёт туда (owner 2026-08-10:
// «точно такой же интерфейс должен открываться при редактировании» —
// переиспользуем форму создания вместо отдельного подменю).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTask, useUpdateTask, useDeleteTask } from "../api/tasks";
import { useCurrentUser } from "../api/auth";
import { useUpdateSubtask } from "../api/subtasks";
import { useAddComment } from "../api/comments";
import { ApiError } from "../api/client";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  BackButton,
} from "../components/UI";
import { PRIORITIES, PriorityPill } from "../components/TaskFields";
import {
  AgentStatusRow,
  AgentOwnerActions,
  TaskFeed,
} from "../components/TaskJournal";
import { ActionsMenu } from "../components/ActionsMenu";
import { formatDueLabel } from "../lib/date";
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
  const { data: currentUser } = useCurrentUser();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateSubtask = useUpdateSubtask();
  const addComment = useAddComment(id || "");
  const { confirm, alert, dialog } = useDialog();
  const queryClient = useQueryClient();

  const [commentText, setCommentText] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsAnchorRef = useRef<HTMLButtonElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  // "Аренда истекла" (agent_stale) is computed server-side on every read —
  // nothing pushes it to an open tab (heartbeat deliberately fires no WS
  // event, see server/src/routes/agent-state.ts). Without this, a card left
  // open through a 15-minute silent lease would keep showing "Агент
  // работает" forever — exactly the "молчание неотличимо от работы"
  // failure the whole protocol exists to prevent (AGENT-PROTOCOL.md). Only
  // polls while an agent actually holds the task, and at a cadence well
  // under the 15-minute lease so the header can catch the in_progress →
  // "агент пропал" flip (and keep "N мин назад" honest) without a reload.
  useEffect(() => {
    if (!id || !task?.agent_state) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["tasks", id] });
    }, 30_000);
    return () => clearInterval(timer);
  }, [id, task?.agent_state, queryClient]);

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
    // pb-4 (16px) — исходный отступ снизу для «десктопной» рамки/Android,
    // где 100dvh сам ужимается под клавиатуру (см. index.html:38,
    // interactive-widget=resizes-content). На WebKit (Safari, режим «с
    // домашнего экрана») этого не происходит — 16px тонет под клавиатурой
    // высотой 280-340px, поэтому здесь добавлен --kb-inset
    // (useVisualViewportInset.ts): пока клавиатура закрыта, переменная
    // 0px и calc() равен ровно pb-4, как и было; открыта — отступ растёт
    // на её высоту.
    <div className="px-4 pb-[calc(1rem+var(--kb-inset,0px))]">
      {dialog}
      <ScreenHeader
        variant="compact"
        leading={<BackButton onClick={() => navigate(-1)} />}
        title=""
        actions={
          <>
            <button
              ref={actionsAnchorRef}
              onClick={() => setActionsOpen((v) => !v)}
              className="tap-scale w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center"
              aria-label="Действия с задачей"
            >
              <Icon name="dots" size={18} />
            </button>
            <ActionsMenu
              open={actionsOpen}
              onClose={() => setActionsOpen(false)}
              anchorRef={actionsAnchorRef}
              items={[
                {
                  icon: "edit",
                  label: "Изменить",
                  onClick: () => navigate(`/task/${task.id}/edit`),
                },
                {
                  icon: "trash",
                  label: "Удалить",
                  destructive: true,
                  onClick: handleDelete,
                },
              ]}
            />
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
        <AgentStatusRow task={task} />
      </div>

      {/* Owner actions — agent-work protocol (AGENT-PROTOCOL.md): visible
          only to the task's creator, only while an agent_state makes them
          relevant. Renders nothing otherwise. */}
      <AgentOwnerActions
        task={task}
        isOwner={!!currentUser && currentUser.id === task.creator_id}
      />

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

      {/* Лента — комментарии и журнал задачи в одном хронологическом
          потоке (AGENT-PROTOCOL.md, "Журнал задачи"): комментарии
          полноценными карточками, системные записи — приглушённой
          компактной строкой, чтобы живой текст не тонул среди служебных
          отметок. См. src/components/TaskJournal.tsx. */}
      <div>
        <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">Лента</h3>
        <TaskFeed task={task} />
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
            ref={commentInputRef}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            // Родное поведение WebKit «сам подскроллит фокусный инпут над
            // клавиатурой» на iPhone ненадёжно (аудит 2026-08-11: токен
            // interactive-widget=resizes-content, на который это
            // поведение обычно опирается, в WebKit не реализован — см.
            // useVisualViewportInset.ts) — не полагаемся только на него,
            // добиваем явным скроллом. block:"end" — это поле последнее
            // в ленте, его естественное место при открытой клавиатуре —
            // у самого низа видимой области. На десктопе (клавиатуры нет)
            // это не более чем обычный скролл контейнера к уже почти
            // видимому полю — если оно и так внизу, scrollIntoView
            // фактически не двигает содержимое (проверено скриншотами,
            // см. отчёт).
            onFocus={() =>
              commentInputRef.current?.scrollIntoView({ block: "end" })
            }
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
