import { useParams, useNavigate } from "react-router-dom";
import { useAppStore } from "../store";
import { Icon, Avatar } from "../components/UI";

export function TaskDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const task = useAppStore((s) => s.tasks.find((t) => t.id === id));
  const users = useAppStore((s) => s.users);
  const updateTask = useAppStore((s) => s.updateTask);

  if (!task) {
    return (
      <div className="px-4 py-8 text-center text-sub">
        Задача не найдена
      </div>
    );
  }

  const assignee = users.find((u) => u.id === task.assigneeId);
  const PRIORITY_COLORS: Record<number, string> = { 1: "#E44332", 2: "#FF9A14", 3: "#4A9FD8", 4: "#A6A6A6" };

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
          <button className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center">
            <Icon name="edit" size={16} className="text-sub" />
          </button>
          <button className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center">
            <Icon name="trash" size={16} className="text-coral" />
          </button>
        </div>
      </div>

      {/* Priority + Title */}
      <div className="flex items-start gap-3 mb-4">
        <button
          onClick={() => {
            const newStatus = task.status === "active" ? "completed" : "active";
            updateTask(task.id, { status: newStatus });
          }}
          className="mt-1 w-[22px] h-[22px] rounded-full border-2 shrink-0 flex items-center justify-center"
          style={{ borderColor: PRIORITY_COLORS[task.priority] }}
        >
          {task.status === "completed" && <Icon name="check" size={14} className="text-white" />}
        </button>
        <h1 className={`text-[20px] font-semibold leading-snug ${task.status === "completed" ? "line-through text-sub" : ""}`}>
          {task.title}
        </h1>
      </div>

      {/* Description */}
      {task.description && (
        <p className="text-[14px] text-sub leading-relaxed mb-4 pl-[34px]">
          {task.description}
        </p>
      )}

      {/* Metadata */}
      <div className="space-y-[2px] mb-4">
        {task.dueDate && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Icon name="calendarSmall" size={18} className="text-red" />
            <span className="text-[14px] text-red">{task.dueDate}</span>
          </div>
        )}
        {assignee && (
          <div className="flex items-center gap-3 py-3 px-4 bg-card rounded-xl">
            <Avatar initials={assignee.initials} color={assignee.avatarColor} size={24} />
            <span className="text-[14px] text-text">{assignee.name}</span>
            <span className="text-[12px] text-sub ml-auto bg-card2 px-2 py-0.5 rounded">
              {assignee.role === "owner" ? "Владелец" : "Агент"}
            </span>
          </div>
        )}
      </div>

      {/* Labels */}
      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {task.labels.map((l) => (
            <span key={l} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] bg-pink/15 text-pink">
              <Icon name="tag" size={11} /> {l}
            </span>
          ))}
        </div>
      )}

      {/* Subtasks */}
      {task.subtasks.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">Подзадачи</h3>
          <div className="bg-card rounded-2xl overflow-hidden">
            {task.subtasks.map((st, i) => (
              <button
                key={st.id}
                onClick={() => {
                  const newSubs = task.subtasks.map((s) =>
                    s.id === st.id ? { ...s, done: !s.done } : s,
                  );
                  updateTask(task.id, { subtasks: newSubs });
                }}
                className="w-full flex items-center gap-3 py-3 px-4 text-left"
              >
                <div
                  className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 ${
                    st.done ? "bg-red border-red" : "border-dim"
                  }`}
                >
                  {st.done && <Icon name="check" size={12} className="text-white" />}
                </div>
                <span className={`text-[14px] ${st.done ? "line-through text-sub" : "text-text"}`}>
                  {st.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      <div>
        <h3 className="text-[13px] text-sub font-semibold mb-2 px-1">Комментарии</h3>
        {task.comments.length === 0 ? (
          <div className="bg-card rounded-2xl p-4 text-center text-[13px] text-dim">
            Нет комментариев
          </div>
        ) : (
          <div className="space-y-2">
            {task.comments.map((c) => {
              const author = users.find((u) => u.id === c.userId);
              return (
                <div key={c.id} className="bg-card rounded-2xl p-3">
                  <div className="flex items-center gap-2 mb-1">
                    {author && <Avatar initials={author.initials} color={author.avatarColor} size={20} />}
                    <span className="text-[13px] font-medium">{author?.name}</span>
                    <span className="text-[11px] text-dim ml-auto">{c.createdAt}</span>
                  </div>
                  <p className="text-[14px] text-sub">{c.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
