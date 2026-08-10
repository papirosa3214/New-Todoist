import { useState, useMemo } from "react";
import { useAppStore } from "../store";
import { Icon, Avatar } from "../components/UI";

const MONTHS_FULL = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS_SHORT = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const WEEKDAYS = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];

function genCalendar(year: number, month: number) {
  const first = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatDateStr(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function formatFullDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  const isToday = dateStr === "2026-08-10";
  const isTomorrow = dateStr === "2026-08-11";
  const suffix = isToday ? " · сегодня · Понедельник" : isTomorrow ? " · завтра · Вторник" : "";
  const weekday = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"][d.getDay()];
  return `${day} ${MONTHS_SHORT[d.getMonth()]}${suffix || ` · ${weekday}`}`;
}

export function UpcomingScreen() {
  const [calMode, setCalMode] = useState<"month" | "week">("month");
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(7); // August
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const allTasks = useAppStore((s) => s.tasks);
  const users = useAppStore((s) => s.users);
  const labels = useAppStore((s) => s.labels);

  const tasks = useMemo(() => allTasks.filter((t) => t.status === "active"), [allTasks]);

  const cells = useMemo(() => genCalendar(year, month), [year, month]);

  // Tasks with due dates, grouped
  const groupedTasks: Record<string, typeof tasks> = {};
  tasks.forEach((t) => {
    if (t.dueDate) {
      if (!groupedTasks[t.dueDate]) groupedTasks[t.dueDate] = [];
      groupedTasks[t.dueDate].push(t);
    }
  });

  // Tasks for selected date or all
  const visibleDates = useMemo(() => {
    if (selectedDate) {
      return groupedTasks[selectedDate] ? [selectedDate] : [];
    }
    return Object.keys(groupedTasks).sort();
  }, [selectedDate, groupedTasks]);

  // Week view dates
  const weekDates = useMemo(() => {
    const dates: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(year, month, 9 + i); // start from 9th to show week
      dates.push(d.getDate());
    }
    return dates;
  }, [year, month]);

  const today = 10;

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear(year - 1); }
    else setMonth(month - 1);
    setSelectedDate(null);
  };

  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear(year + 1); }
    else setMonth(month + 1);
    setSelectedDate(null);
  };

  return (
    <div className="px-4 pb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[17px] font-semibold">Предстоящее</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setCalMode(calMode === "month" ? "week" : "month")}
            className="w-[36px] h-[36px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform"
          >
            <Icon name={calMode === "month" ? "grid" : "list"} size={16} className="text-text" />
          </button>
          <button className="w-[36px] h-[36px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform">
            <Icon name="dotsH" size={16} className="text-text" />
          </button>
        </div>
      </div>

      {calMode === "month" ? (
        <>
          {/* Month nav */}
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} className="w-[28px] h-[28px] flex items-center justify-center active:scale-95">
              <Icon name="chevronLeft" size={18} className="text-sub" />
            </button>
            <button className="flex items-center gap-1">
              <span className="text-[14px] font-semibold text-red">
                {MONTHS_FULL[month]}. {year} г.
              </span>
              <Icon name="chevronDown" size={12} className="text-red" />
            </button>
            <button onClick={nextMonth} className="w-[28px] h-[28px] flex items-center justify-center active:scale-95">
              <Icon name="chevron" size={18} className="text-sub" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-0 mb-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="text-center text-[11px] text-sub py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-0 mb-4">
            {cells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const dateStr = formatDateStr(year, month, day);
              const hasTasks = groupedTasks[dateStr]?.length > 0;
              const isToday = day === today && month === 7 && year === 2026;
              const isSelected = dateStr === selectedDate;

              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                  className={`h-[42px] flex flex-col items-center justify-center rounded-full transition-all active:scale-90 ${
                    isSelected
                      ? "bg-red text-white font-semibold"
                      : isToday
                        ? "bg-red/20 text-red font-semibold"
                        : hasTasks
                          ? "text-text"
                          : "text-dim"
                  }`}
                >
                  <span className="text-[14px]">{day}</span>
                  {hasTasks && !isSelected && (
                    <div className="w-[4px] h-[4px] rounded-full bg-red mt-[1px]" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        /* Week strip */
        <div className="flex justify-between mb-4 px-1">
          {weekDates.map((d) => {
            const dateStr = formatDateStr(year, month, d);
            const isActive = d === today && month === 7 && year === 2026;
            return (
              <button
                key={d}
                onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                className={`flex flex-col items-center gap-1 transition-all ${isActive ? "text-red" : "text-sub"}`}
              >
                <span className="text-[10px] font-medium uppercase">
                  {["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][new Date(year, month, d).getDay()]}
                </span>
                <span className={`text-[15px] font-medium ${
                  isActive ? "bg-red text-white w-[28px] h-[28px] rounded-full flex items-center justify-center" : ""
                }`}>
                  {d}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Selected date indicator */}
      {selectedDate && (
        <button
          onClick={() => setSelectedDate(null)}
          className="flex items-center gap-2 mb-3 px-3 py-1.5 bg-red/15 rounded-lg text-[13px] text-red"
        >
          <Icon name="calendarSmall" size={14} />
          {formatFullDate(selectedDate)}
          <Icon name="x" size={14} className="ml-auto" />
        </button>
      )}

      {/* Task list */}
      {visibleDates.map((dateStr) => (
        <div key={dateStr} className="mb-3">
          <div className="text-[13px] text-sub mb-2 px-1">{formatFullDate(dateStr)}</div>
          {groupedTasks[dateStr].map((task) => {
            const assignee = users.find((u) => u.id === task.assigneeId);
            const taskLabel = labels.find((l) => task.labels.includes(l.name));
            return (
              <div key={task.id} className="flex items-start gap-3 py-3 px-1 border-b border-stroke/50 active:bg-card/50 transition-colors">
                <div className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 border-red shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-text leading-snug">{task.title}</div>
                  {task.description && (
                    <div className="text-[13px] text-sub mt-0.5 line-clamp-2">{task.description}</div>
                  )}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {taskLabel && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                        style={{ backgroundColor: taskLabel.color + "30", color: taskLabel.color }}>
                        <Icon name="shield" size={10} /> {taskLabel.name}
                      </span>
                    )}
                    {task.subtasks.length > 0 && (
                      <span className="text-[11px] text-sub">
                        {task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}
                      </span>
                    )}
                  </div>
                </div>
                {assignee && <Avatar initials={assignee.initials} color={assignee.avatarColor} size={24} />}
              </div>
            );
          })}
        </div>
      ))}

      {selectedDate && !groupedTasks[selectedDate] && (
        <div className="text-center py-8 text-[14px] text-dim">
          Нет задач на эту дату
        </div>
      )}
    </div>
  );
}
