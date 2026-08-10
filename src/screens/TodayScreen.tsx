import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { todayStr, formatDueLabel, partitionOverdueToday } from "../lib/date";
import { getPriorityColor } from "../lib/priority";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";
import { RescheduleSheet } from "../components/RescheduleSheet";
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
const WEEKDAYS_FULL = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];

// "10 авг. · Понедельник" — matches the "Сегодня" board column's header,
// which stands in for a project-color dot with a date instead (this
// column isn't a project, so a date is the thing that actually identifies
// it).
function formatColumnDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}. · ${WEEKDAYS_FULL[d.getDay()]}`;
}

// Одна строка задачи — используется и для просроченных, и для сегодняшних,
// разница только в `overdue` (красная пометка «Просрочено, …» под текстом).
function TaskRow({
  task,
  overdue,
  onClick,
}: {
  task: ApiTask;
  overdue: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50 active:bg-card/50 transition-colors"
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
          <div className="text-[13px] text-sub mt-0.5 truncate">
            {task.description.substring(0, 60)}…
          </div>
        )}
        {overdue && task.due_date && (
          <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded text-[11px] bg-red/15 text-red">
            <Icon name="calendarSmall" size={10} /> Просрочено,{" "}
            {formatDueLabel(task.due_date)}
          </span>
        )}
      </div>
    </button>
  );
}

export function TodayScreen() {
  const { data: allTasks = [], isLoading, isError, error } = useTasks();
  const navigate = useNavigate();
  const today = todayStr();
  const layout = useAppStore((s) => s.taskLayout.today);
  const setTaskLayout = useAppStore((s) => s.setTaskLayout);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);

  // Single source for "просрочено vs. сегодня" — shared by both layouts
  // (see lib/date.ts) so the list and the board can never quietly disagree
  // about which task belongs where.
  const { overdue: overdueTasks, todayTasks } = useMemo(
    () => partitionOverdueToday(allTasks, today),
    [allTasks, today],
  );

  const isEmpty =
    !isLoading &&
    !isError &&
    overdueTasks.length === 0 &&
    todayTasks.length === 0;

  // Доска «Сегодня» — НЕ по проектам (прямое решение владельца): ровно две
  // колонки, «Просрочено» и «Сегодня», тот же состав и порядок, что и в
  // списке выше. «Просрочено» колонка целиком отсутствует, когда
  // просроченных нет — половина экрана под пустую колонку выглядела бы как
  // поломка, а список рядом уже прячет свой заголовок «Просрочено» точно
  // так же в этом случае, так что оба layout'а ведут себя одинаково.
  // «Сегодня» колонка, наоборот, всегда на доске (даже пустая, с кнопкой
  // «Добавить задачу») — это тот самый экран, ради которого сюда пришли.
  const boardColumns: BoardColumn[] = useMemo(() => {
    const cols: BoardColumn[] = [];
    if (overdueTasks.length > 0) {
      cols.push({
        id: "overdue",
        title: `Просрочено ${overdueTasks.length}`,
        titleClassName: "text-red",
        tasks: overdueTasks,
        dueBadgeVariant: "overdue",
        showProjectBadge: true,
        headerAction: (
          <button
            onClick={() => setRescheduleOpen(true)}
            className="tap-fade shrink-0 min-h-11 px-2.5 flex items-center justify-center rounded-lg text-[12px] font-semibold text-red"
          >
            Перенести
          </button>
        ),
      });
    }
    cols.push({
      id: "today",
      title: formatColumnDateLabel(today),
      tasks: todayTasks,
      showProjectBadge: true,
      footer: (
        <button
          onClick={() => navigate("/task/new")}
          className="tap-row w-full flex items-center justify-center gap-2 h-11 rounded-full bg-card text-[13px] font-semibold text-text"
        >
          <span className="w-5 h-5 rounded-full bg-card2 flex items-center justify-center">
            <Icon name="plus" size={12} />
          </span>
          Добавить задачу
        </button>
      ),
    });
    return cols;
  }, [overdueTasks, todayTasks, today, navigate]);

  const header = (
    <ScreenHeader
      className={isEmpty ? "w-full" : ""}
      leading={
        <div className="bg-card/60 rounded-full p-2">
          <Icon name="calendarSmall" size={22} className="text-text" />
        </div>
      }
      title="Сегодня"
      actions={
        <>
          <button
            onClick={() =>
              setTaskLayout("today", layout === "list" ? "board" : "list")
            }
            className="tap-scale w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center"
            aria-label={
              layout === "list"
                ? "Переключить на вид доски"
                : "Переключить на вид списка"
            }
          >
            <Icon
              name={layout === "list" ? "list" : "grid"}
              size={18}
              className="text-text"
            />
          </button>
          <button className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform">
            <Icon name="dots" size={18} />
          </button>
          <button
            onClick={() => navigate("/search")}
            className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform"
          >
            <Icon name="search" size={18} />
          </button>
        </>
      }
    />
  );

  if (isEmpty) {
    return (
      <div className="px-4 pb-4 flex flex-col items-center">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center mt-8">
          <svg width="200" height="180" viewBox="0 0 200 180" className="mb-6">
            <circle cx="100" cy="80" r="48" fill="#2B2B2B" />
            <circle cx="85" cy="72" r="4" fill="white" />
            <circle cx="115" cy="72" r="4" fill="white" />
            <path
              d="M88 90 Q100 100 112 90"
              stroke="white"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <ellipse
              cx="68"
              cy="55"
              rx="6"
              ry="3"
              fill="#35B8A3"
              transform="rotate(-20 68 55)"
            />
            <ellipse
              cx="132"
              cy="55"
              rx="6"
              ry="3"
              fill="#35B8A3"
              transform="rotate(20 132 55)"
            />
            <circle
              cx="50"
              cy="130"
              r="18"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="2"
            />
            <circle
              cx="150"
              cy="120"
              r="14"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="2"
            />
            <circle
              cx="80"
              cy="150"
              r="10"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="1.5"
            />
          </svg>
          <h3 className="text-[17px] font-semibold mb-2">
            Чёткое видение грядущего дня
          </h3>
          <p className="text-[14px] text-sub text-center px-8 leading-relaxed">
            Задачи на сегодня появятся здесь, когда вы назначите дедлайн.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-4">
      {header}
      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить задачи"
        className="mt-2"
      />
      {layout === "board" ? (
        <div className="mt-2">
          <TaskBoard
            columns={boardColumns}
            onTaskClick={(id) => navigate(`/task/${id}`)}
            isLoading={isLoading}
          />
        </div>
      ) : (
        <div className="space-y-[2px]">
          {overdueTasks.length > 0 && (
            <div className="flex items-center gap-1.5 px-1 pt-2 pb-1">
              <span className="text-[13px] font-semibold text-red">
                Просрочено
              </span>
            </div>
          )}
          {overdueTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              overdue
              onClick={() => navigate(`/task/${t.id}`)}
            />
          ))}
          {overdueTasks.length > 0 && todayTasks.length > 0 && (
            <div className="text-[13px] font-semibold text-sub px-1 pt-3 pb-1">
              Сегодня
            </div>
          )}
          {todayTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              overdue={false}
              onClick={() => navigate(`/task/${t.id}`)}
            />
          ))}
        </div>
      )}

      <RescheduleSheet
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        taskIds={overdueTasks.map((t) => t.id)}
      />
    </div>
  );
}
