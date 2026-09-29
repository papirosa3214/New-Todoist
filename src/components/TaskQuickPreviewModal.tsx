import { useEffect } from "react";
import type { ApiTask } from "../api/types";
import { Icon } from "./UI";
import { MarkdownInline } from "./MarkdownInline";
import { PRIORITIES } from "../lib/priority";
import { MONTHS_SHORT } from "../lib/date";

interface TaskQuickPreviewModalProps {
  task: ApiTask | null;
  onClose: () => void;
  onOpenFull: (taskId: string) => void;
}

function formatDateLabel(dateStr: string | null): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dateMonth = MONTHS_SHORT[m - 1] || "";
  return `${d} ${dateMonth}`;
}

function getStatusBadge(task: ApiTask): {
  text: string;
  bg: string;
  fg: string;
} {
  if (task.status === "completed") {
    return {
      text: "Выполнена",
      bg: "bg-emerald-500/15",
      fg: "text-emerald-500",
    };
  }
  if (task.agent_state === "review") {
    return { text: "На проверке", bg: "bg-blue-500/15", fg: "text-blue-500" };
  }
  if (task.agent_state === "blocked") {
    return {
      text: "Заблокирована",
      bg: "bg-amber-500/15",
      fg: "text-amber-500",
    };
  }
  if (task.agent_state === "in_progress") {
    return { text: "В работе", bg: "bg-teal-500/15", fg: "text-teal-500" };
  }
  return { text: "Активна", bg: "bg-sub/15", fg: "text-sub" };
}

export function TaskQuickPreviewModal({
  task,
  onClose,
  onOpenFull,
}: TaskQuickPreviewModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!task) return null;

  const prio = PRIORITIES.find((p) => p.key === task.priority);
  const statusInfo = getStatusBadge(task);
  // Родитель считается по детям, а не по шагам — та же логика, что в
  // TaskRow (10.09.2026, a195895d): разбиение родительской задачи это и
  // есть дочерние карточки. Нет детей — считаем шаги, как раньше.
  const kidsTotal = task.children_total ?? task.children?.length ?? 0;
  const totalSub = kidsTotal > 0 ? kidsTotal : task.subtasks?.length || 0;
  const doneSub =
    kidsTotal > 0
      ? (task.children_done ??
        (task.children ?? []).filter((c) => c.status === "completed").length)
      : task.subtasks?.filter((s) => s.done).length || 0;

  return (
    <>
      {/* Прозрачный оверлей для мгновенного закрытия по клику мимо */}
      <div
        // Свайп «назад» не должен уводить экран из-под шторки
        // (useSwipeBack ищет этот атрибут).
        data-overlay
        className="fixed inset-0 z-40 bg-transparent"
        onClick={onClose}
      />

      {/* Лайтовая плашка-поповер внизу экрана (над навигацией) */}
      <div className="fixed bottom-20 left-3 right-3 sm:left-auto sm:right-6 sm:w-96 z-50 animate-popover pointer-events-auto">
        <div
          onClick={() => onOpenFull(task.id)}
          className="relative bg-card/95 backdrop-blur-md border border-stroke rounded-2xl p-3.5 shadow-2xl hover:border-stroke/80 transition-all cursor-pointer group active:scale-[0.99]"
        >
          {/* Верхняя строка: статус, проект, время, кнопка закрыть */}
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5 flex-wrap overflow-hidden">
              <span
                className={`px-2 py-0.5 text-[10px] font-semibold rounded-full shrink-0 ${statusInfo.bg} ${statusInfo.fg}`}
              >
                {statusInfo.text}
              </span>

              {task.project_name && (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-bg/80 border border-stroke/50 text-[10px] font-medium text-sub rounded-full truncate">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: task.project_color || "#3A82F6" }}
                  />
                  <span className="truncate">{task.project_name}</span>
                </span>
              )}

              {prio && task.priority > 1 && (
                <span
                  className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-bg border border-stroke/50 shrink-0"
                  style={{ color: prio.color }}
                >
                  <Icon name="chevronUp" size={10} />P{task.priority}
                </span>
              )}
            </div>

            {/* Кнопка мгновенного закрытия плашки */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label="Закрыть превью"
              className="w-6 h-6 rounded-full flex items-center justify-center text-sub hover:text-text hover:bg-bg/80 transition-colors shrink-0 -mr-1 -mt-1"
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          {/* Заголовок задачи */}
          <h3 className="text-[15px] font-bold text-text group-hover:text-red transition-colors line-clamp-2 leading-snug mb-2">
            <MarkdownInline source={task.title} />
          </h3>

          {/* Нижняя строка: Время / дата, подзадачи, исполнитель + стрелочка перехода */}
          <div className="flex items-center justify-between gap-2 text-[12px] text-sub border-t border-stroke/40 pt-2 mt-1">
            <div className="flex items-center gap-2 overflow-hidden flex-wrap">
              {/* Время / Дата */}
              {task.due_date && (
                <div className="flex items-center gap-1 font-medium text-text shrink-0">
                  <Icon name="clock" size={12} className="text-red" />
                  <span>
                    {task.start_time
                      ? task.start_time
                      : formatDateLabel(task.due_date)}
                  </span>
                  {task.duration_min ? (
                    <span className="text-sub font-normal">
                      ({task.duration_min}м)
                    </span>
                  ) : null}
                </div>
              )}

              {/* Счётчик подзадач */}
              {totalSub > 0 && (
                <span className="px-1.5 py-0.5 bg-bg/80 rounded text-[11px] font-medium text-sub shrink-0">
                  {doneSub}/{totalSub} шагов
                </span>
              )}

              {/* Исполнитель */}
              {task.assignee_name && (
                <div className="flex items-center gap-1 shrink-0">
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                    style={{
                      backgroundColor: task.assignee_color || "#3A82F6",
                    }}
                  >
                    {task.assignee_initials || task.assignee_name[0]}
                  </span>
                  <span className="text-[11px]">{task.assignee_name}</span>
                </div>
              )}
            </div>

            {/* Шеврон навигации */}
            <div className="flex items-center gap-1 text-red font-semibold text-[12px] shrink-0 group-hover:translate-x-0.5 transition-transform">
              <span>Карточка</span>
              <Icon name="chevron" size={12} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
