import { useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTask, useUpdateTask, useDeleteTask } from "../api/tasks";
import { useUpdateSubtask } from "../api/subtasks";
import { useAddComment } from "../api/comments";
import { Icon, Avatar } from "../components/UI";

const PRIORITY_COLORS: Record<number, string> = {
  1: "#E44332",
  2: "#FF9A14",
  3: "#4A9FD8",
  4: "#A6A6A6",
};

export function TaskDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, isError } = useTask(id);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateSubtask = useUpdateSubtask();
  const addComment = useAddComment(id || "");

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [commentText, setCommentText] = useState("");

  if (isLoading) {
    return <div className="px-4 py-8 text-center text-sub">Загрузка…</div>;
  }

  if (!task || isError) {
    return (
      <div className="px-4 py-8 text-center text-sub">Задача не найдена</div>
    );
  }

  const startEdit = () => {
    setEditTitle(task.title);
    setEditDesc(task.description || "");
    setEditing(true);
  };

  const saveEdit = () => {
    if (!editTitle.trim()) return;
    updateTask.mutate({
      id: task.id,
      title: editTitle.trim(),
      description: editDesc.trim() || undefined,
    });
    setEditing(false);
  };

  const handleDelete = () => {
    if (!confirm("Удалить задачу без возможности отмены?")) return;
    // Only the creator may delete (server enforces this with a 404, same as
    // "not found", so an assignee-only task shows this rather than a 403).
    deleteTask.mutate(task.id, {
      onSuccess: () => navigate(-1),
      onError: () =>
        alert(
          "Не удалось удалить задачу — возможно, вы не создатель этой задачи.",
        ),
    });
  };

  const handleSubmitComment = (e: FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    addComment.mutate(commentText.trim(), {
      onSuccess: () => setCommentText(""),
    });
  };

  return (
    <div className="px-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between h-[48px] mb-2">
        <button
          onClick={() => navigate(-1)}
          className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center"
        >
          <Icon name="chevronLeft" size={18} />
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => (editing ? saveEdit() : startEdit())}
            className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center"
          >
            <Icon
              name={editing ? "check" : "edit"}
              size={16}
              className={editing ? "text-red" : "text-sub"}
            />
          </button>
          <button
            onClick={handleDelete}
            className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center"
          >
            <Icon name="trash" size={16} className="text-coral" />
          </button>
        </div>
      </div>

      {/* Priority + Title */}
      <div className="flex items-start gap-3 mb-4">
        <button
          onClick={() => {
            const newStatus = task.status === "active" ? "completed" : "active";
            updateTask.mutate({ id: task.id, status: newStatus });
          }}
          className="mt-1 w-[22px] h-[22px] rounded-full border-2 shrink-0 flex items-center justify-center"
          style={{ borderColor: PRIORITY_COLORS[task.priority] }}
        >
          {task.status === "completed" && (
            <Icon name="check" size={14} className="text-white" />
          )}
        </button>
        {editing ? (
          <textarea
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="flex-1 bg-card rounded-lg px-2 py-1 text-[20px] font-semibold leading-snug outline-none resize-none"
            rows={2}
            autoFocus
          />
        ) : (
          <h1
            className={`text-[20px] font-semibold leading-snug ${task.status === "completed" ? "line-through text-sub" : ""}`}
          >
            {task.title}
          </h1>
        )}
      </div>

      {/* Description */}
      {editing ? (
        <textarea
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          placeholder="Описание"
          className="w-full bg-card rounded-lg px-2 py-1.5 text-[14px] text-sub leading-relaxed mb-4 outline-none resize-none"
          rows={3}
        />
      ) : (
        task.description && (
          <p className="text-[14px] text-sub leading-relaxed mb-4 pl-[34px] whitespace-pre-wrap">
            {task.description}
          </p>
        )
      )}

      {/* Metadata */}
      <div className="space-y-[2px] mb-4">
        {task.due_date && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Icon name="calendarSmall" size={18} className="text-red" />
            <span className="text-[14px] text-red">{task.due_date}</span>
          </div>
        )}
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

      {/* Subtasks */}
      {task.subtasks.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">
            Подзадачи
          </h3>
          <div className="bg-card rounded-2xl overflow-hidden">
            {task.subtasks.map((st) => (
              <button
                key={st.id}
                onClick={() =>
                  updateSubtask.mutate({ id: st.id, done: !st.done })
                }
                className="w-full flex items-center gap-3 py-3 px-4 text-left"
              >
                <div
                  className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 ${
                    st.done ? "bg-red border-red" : "border-dim"
                  }`}
                >
                  {st.done && (
                    <Icon name="check" size={12} className="text-white" />
                  )}
                </div>
                <span
                  className={`text-[14px] ${st.done ? "line-through text-sub" : "text-text"}`}
                >
                  {st.title}
                </span>
              </button>
            ))}
          </div>
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
                  {c.user_name && (
                    <Avatar
                      initials={c.user_initials || "?"}
                      color={c.user_color || "#A6A6A6"}
                      size={20}
                    />
                  )}
                  <span className="text-[13px] font-medium">{c.user_name}</span>
                  <span className="text-[11px] text-dim ml-auto">
                    {c.created_at}
                  </span>
                </div>
                <p className="text-[14px] text-sub">{c.text}</p>
              </div>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSubmitComment}
          className="flex items-center gap-2"
        >
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Написать комментарий…"
            className="flex-1 bg-card rounded-xl px-3 py-2.5 text-[14px] text-text placeholder:text-dim outline-none"
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
