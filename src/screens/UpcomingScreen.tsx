import { useState, useMemo, useRef, type TouchEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import { todayStr } from "../lib/date";
import { getPriorityColor } from "../lib/priority";
import type { ApiTask } from "../api/types";

const MONTHS_FULL = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
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
const WEEKDAYS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];

// Высоты-«потолки» для CSS-transition на max-height при сворачивании
// месяц↔неделя. Не измеряются через ref — оба состояния имеют известный,
// ограниченный набор строк (месяц: заголовок+сетка до 6 недель, неделя:
// одна строка), так что фиксированный запас с надёжным зазором проще и
// устойчивее, чем ResizeObserver, и даёт тот же плавный переход.
const CAL_MAX_HEIGHT_MONTH = 420;
const CAL_MAX_HEIGHT_WEEK = 110;

// Свайп по ручке-засечке короче этого порога (px по Y) считается тапом —
// его обрабатывает обычный onClick, а не сам touch-хэндлер.
const SWIPE_THRESHOLD = 24;

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

export function UpcomingScreen() {
  const [calMode, setCalMode] = useState<"month" | "week">("month");
  const today = todayStr();
  const todayDate = new Date(today + "T00:00:00");

  const [year, setYear] = useState(todayDate.getFullYear());
  const [month, setMonth] = useState(todayDate.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const { data: allTasks = [], isLoading, error } = useTasks();
  const navigate = useNavigate();

  const tasks = useMemo(
    () => allTasks.filter((t) => t.status === "active"),
    [allTasks],
  );

  const cells = useMemo(() => genCalendar(year, month), [year, month]);

  // Единая точка входа для месяц↔неделя — дёргают и кнопка в шапке, и
  // ручка-засечка (клик/свайп), поэтому оба управления не могут разойтись:
  // это один и тот же вызов setCalMode над одним и тем же состоянием.
  function toggleCalMode() {
    setCalMode((m) => (m === "month" ? "week" : "month"));
  }

  function formatFullDate(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getDate();
    const isToday = dateStr === today;
    const weekday = [
      "Воскресенье",
      "Понедельник",
      "Вторник",
      "Среда",
      "Четверг",
      "Пятница",
      "Суббота",
    ][d.getDay()];
    const suffix = isToday ? ` · сегодня · ${weekday}` : ` · ${weekday}`;
    return `${day} ${MONTHS_SHORT[d.getMonth()]}${suffix}`;
  }

  // Tasks with due dates, grouped
  const groupedTasks = useMemo(() => {
    const g: Record<string, ApiTask[]> = {};
    tasks.forEach((t) => {
      if (t.due_date) {
        if (!g[t.due_date]) g[t.due_date] = [];
        g[t.due_date].push(t);
      }
    });
    return g;
  }, [tasks]);

  // Tasks for selected date or all
  const visibleDates = useMemo(() => {
    if (selectedDate) {
      return groupedTasks[selectedDate] ? [selectedDate] : [];
    }
    return Object.keys(groupedTasks).sort();
  }, [selectedDate, groupedTasks]);

  // Week view dates (Mon-based week containing the selected date, falling
  // back to `today` when nothing is selected) — so the collapsed view
  // always shows the week the user actually cares about, not always "this
  // week" regardless of what they picked in month view.
  const weekDates = useMemo(() => {
    const base = new Date((selectedDate || today) + "T00:00:00");
    const dow = base.getDay(); // 0 = Sunday
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(base);
    monday.setDate(base.getDate() + mondayOffset);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [today, selectedDate]);

  const prevMonth = () => {
    if (month === 0) {
      setMonth(11);
      setYear(year - 1);
    } else setMonth(month - 1);
    setSelectedDate(null);
  };

  const nextMonth = () => {
    if (month === 11) {
      setMonth(0);
      setYear(year + 1);
    } else setMonth(month + 1);
    setSelectedDate(null);
  };

  // ── Свайп по ручке-засечке ──
  // touchstart/touchmove в React 17+ регистрируются пассивно на корне, так
  // что preventDefault там не остановит скролл/системные жесты — поэтому
  // жест «глушится» через CSS touch-action:none на самой ручке (класс
  // touch-none ниже), а не через preventDefault в этих хэндлерах. Порог по
  // Y решает, был ли это свайп (сработает тут) или короткий тап (сработает
  // обычный onClick на этом же элементе).
  const touchStartY = useRef<number | null>(null);

  function handleTouchStart(e: TouchEvent) {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  }

  function handleTouchEnd(e: TouchEvent) {
    const startY = touchStartY.current;
    touchStartY.current = null;
    if (startY === null) return;
    const endY = e.changedTouches[0]?.clientY ?? startY;
    const dy = endY - startY;
    if (dy <= -SWIPE_THRESHOLD && calMode !== "week") {
      // touchend (в отличие от touchstart/touchmove) не форсится пассивным,
      // preventDefault здесь реально гасит «призрачный» click после свайпа
      // — иначе он вызвал бы toggleCalMode ещё раз и откатил переключение.
      e.preventDefault();
      setCalMode("week");
    } else if (dy >= SWIPE_THRESHOLD && calMode !== "month") {
      e.preventDefault();
      setCalMode("month");
    }
    // Иначе — сдвиг меньше порога, это тап: пусть его обработает обычный
    // onClick на этой же ручке (единая точка входа toggleCalMode).
  }

  return (
    <div className="px-4 pb-4">
      {/* Закреплённый «хром»: шапка экрана + календарь + ручка-засечка —
          всё в одном sticky-блоке. ScreenHeader сам уже sticky top-0
          (см. UI.tsx), но вложенный в уже прилипший родитель, эта
          собственная стики-логика становится no-op: как только внешний
          блок прилип к верху скролл-контейнера, всё что внутри нём (шапка,
          календарь) больше никогда не проезжает мимо top:0, так что
          дублирование не конфликтует — оно просто не участвует. Работает
          одинаково что на мобильном (скроллится document), что на
          десктопе (скроллится .flex-1.overflow-y-auto рамки телефона в
          Layout.tsx) — sticky в обоих случаях считается от ближайшего
          реального скролл-контейнера, а не от структуры вложенности. */}
      <div className="sticky top-0 z-20 bg-bg border-b border-stroke shadow-[0_10px_16px_-12px_rgba(0,0,0,.55)]">
        <ScreenHeader
          title="Предстоящее"
          actions={
            <button
              onClick={toggleCalMode}
              className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform"
              aria-label={
                calMode === "month"
                  ? "Свернуть календарь в неделю"
                  : "Развернуть календарь в месяц"
              }
            >
              <Icon
                name={calMode === "month" ? "grid" : "list"}
                size={16}
                className="text-text"
              />
            </button>
          }
        />

        <div
          className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={{
            maxHeight:
              calMode === "month" ? CAL_MAX_HEIGHT_MONTH : CAL_MAX_HEIGHT_WEEK,
          }}
        >
          {calMode === "month" ? (
            <>
              {/* Month nav */}
              <div className="flex items-center justify-between mb-2 pt-1">
                <button
                  onClick={prevMonth}
                  aria-label="Предыдущий месяц"
                  className="w-[44px] h-[44px] -ml-2 flex items-center justify-center active:scale-95"
                >
                  <Icon name="chevronLeft" size={18} className="text-sub" />
                </button>
                {/* Подпись месяца/года — в эталоне (mockup-reference) это
                    статичная метка, не кнопка: переключение вида
                    месяц/неделя живёт в тоггле выше (иконка grid/list) и в
                    ручке-засечке снизу, а не здесь. */}
                <span className="flex items-center gap-1">
                  <span className="text-[14px] font-semibold text-red">
                    {MONTHS_FULL[month]}. {year} г.
                  </span>
                  <Icon name="chevronDown" size={12} className="text-red" />
                </span>
                <button
                  onClick={nextMonth}
                  aria-label="Следующий месяц"
                  className="w-[44px] h-[44px] -mr-2 flex items-center justify-center active:scale-95"
                >
                  <Icon name="chevron" size={18} className="text-sub" />
                </button>
              </div>

              {/* Weekday headers */}
              <div className="grid grid-cols-7 gap-0 mb-1">
                {WEEKDAYS.map((d) => (
                  <div
                    key={d}
                    className="text-center text-[11px] text-sub py-1"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-0 pb-2">
                {cells.map((day, i) => {
                  if (day === null) return <div key={i} />;
                  const dateStr = formatDateStr(year, month, day);
                  const hasTasks = groupedTasks[dateStr]?.length > 0;
                  const isToday = dateStr === today;
                  const isSelected = dateStr === selectedDate;

                  return (
                    <button
                      key={i}
                      onClick={() =>
                        setSelectedDate(isSelected ? null : dateStr)
                      }
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
            <div className="flex justify-between pt-2 pb-3 px-1">
              {weekDates.map((d) => {
                const dateStr = formatDateStr(
                  d.getFullYear(),
                  d.getMonth(),
                  d.getDate(),
                );
                const isActive = dateStr === today;
                const isSelected = dateStr === selectedDate;
                return (
                  <button
                    key={dateStr}
                    onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                    className={`flex flex-col items-center gap-1 transition-all ${isActive ? "text-red" : isSelected ? "text-text" : "text-sub"}`}
                  >
                    <span className="text-[10px] font-medium uppercase">
                      {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()]}
                    </span>
                    <span
                      className={`text-[15px] font-medium ${
                        isActive
                          ? "bg-red text-white w-[28px] h-[28px] rounded-full flex items-center justify-center"
                          : isSelected
                            ? "border-2 border-red w-[28px] h-[28px] rounded-full flex items-center justify-center"
                            : ""
                      }`}
                    >
                      {d.getDate()}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Ручка-засечка: свайп вверх — свернуть в неделю, свайп вниз —
            развернуть в месяц; на устройствах без touch (мышь) короткий
            клик делает то же самое через toggleCalMode. Видимая полоска —
            4px, но интерактивная область — полные 44px по высоте
            (тап-таргет). */}
        <div
          role="button"
          tabIndex={0}
          aria-label={
            calMode === "month"
              ? "Свернуть календарь в неделю"
              : "Развернуть календарь в месяц"
          }
          onClick={toggleCalMode}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleCalMode();
            }
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="flex items-center justify-center h-[36px] touch-none select-none cursor-pointer"
        >
          <span className="w-[36px] h-[4px] rounded-full bg-dim/70" />
        </div>
      </div>

      {/* Selected date indicator */}
      {selectedDate && (
        <button
          onClick={() => setSelectedDate(null)}
          className="flex items-center gap-2 mt-3 mb-3 px-3 py-1.5 bg-red/15 rounded-lg text-[13px] text-red"
        >
          <Icon name="calendarSmall" size={14} />
          {formatFullDate(selectedDate)}
          <Icon name="x" size={14} className="ml-auto" />
        </button>
      )}

      {isLoading && <p className="mt-3 px-1 text-[13px] text-dim">Загрузка…</p>}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить задачи"
        className="mt-3 mb-2"
      />

      {/* Task list */}
      <div className={selectedDate || isLoading || error ? "" : "mt-3"}>
        {visibleDates.map((dateStr) => (
          <div key={dateStr} className="mb-3">
            <div className="text-[13px] text-sub mb-2 px-1">
              {formatFullDate(dateStr)}
            </div>
            {groupedTasks[dateStr].map((task) => (
              <button
                key={task.id}
                onClick={() => navigate(`/task/${task.id}`)}
                className="w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50 active:bg-card/50 transition-colors"
              >
                <div
                  className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0"
                  style={{ borderColor: getPriorityColor(task.priority) }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-text leading-snug">
                    {task.title}
                  </div>
                  {task.description && (
                    <div className="text-[13px] text-sub mt-0.5 line-clamp-2">
                      {task.description}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {task.labels[0] && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                        style={{
                          backgroundColor: task.labels[0].color + "30",
                          color: task.labels[0].color,
                        }}
                      >
                        <Icon name="shield" size={10} /> {task.labels[0].name}
                      </span>
                    )}
                    {task.subtasks.length > 0 && (
                      <span className="text-[11px] text-sub">
                        {task.subtasks.filter((s) => s.done).length}/
                        {task.subtasks.length}
                      </span>
                    )}
                  </div>
                </div>
                {task.assignee_id && task.assignee_initials && (
                  <Avatar
                    initials={task.assignee_initials}
                    color={task.assignee_color || "#A6A6A6"}
                    size={24}
                  />
                )}
              </button>
            ))}
          </div>
        ))}

        {selectedDate && !groupedTasks[selectedDate] && (
          <div className="text-center py-8 text-[14px] text-dim">
            Нет задач на эту дату
          </div>
        )}
      </div>
    </div>
  );
}
