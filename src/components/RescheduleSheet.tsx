// ═══════════ RESCHEDULE SHEET ═══════════
// Bulk «перенести все просроченные» sheet, opened from the overdue
// column's header button on Today's board. Same bottom-sheet visual
// language as Dialog.tsx's confirm/alert (scrim + bg-card rounded-sheet-top
// panel sliding up from the bottom).
//
// Scope, per direct product decision: quick-pick rows (Сегодня/Завтра/На
// выходных/Следующая неделя/Без срока) + a month calendar for picking any
// other day. NOT implemented on purpose: the free-text «Введите срок»
// input, «Время», «Повтор» — there is no time-of-day or recurrence concept
// anywhere in this app's data model or server, so a row for either would
// be a dead control with nothing behind it. Owner's own rule: either build
// it for real or don't show it — this doesn't show it, rather than fake it
// with a disabled row.
//
// There is no bulk-PATCH endpoint on the server (confirmed — tasks.ts only
// has PATCH /api/tasks/:id, one row at a time), so «reschedule everything»
// here really is N sequential network calls fired in parallel via
// Promise.all. That's inherent to the current API, not a shortcut taken
// here — see the report for why a real bulk endpoint would be worth adding
// server-side.
import { useEffect, useState } from "react";
import { Icon, ErrorBanner, SheetHandle } from "./UI";
import { useUpdateTask } from "../api/tasks";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { addDays, todayStr } from "../lib/date";
import { useBottomSheet } from "../lib/useBottomSheet";

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
const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function genCalendar(year: number, month: number) {
  // Неделя начинается с понедельника: 0 = Пн, ..., 6 = Вс
  const first = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return cells;
}

function formatDateStr(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface QuickOption {
  label: string;
  date: string | null; // null = "без срока"
  hint: string; // weekday shown on the right, or "" for "без срока"
  iconClassName: string; // color-codes the row — the icon set has no
  // distinct day/weekend/repeat glyphs, so rows are told apart by color
  // (all from the theme palette) rather than shape.
}

export function RescheduleSheet({
  open,
  onClose,
  taskIds,
}: {
  open: boolean;
  onClose: () => void;
  taskIds: string[];
}) {
  const updateTask = useUpdateTask();
  const today = todayStr();

  const [stagedDate, setStagedDate] = useState<string | null>(null);
  const [viewYear, setViewYear] = useState(0);
  const [viewMonth, setViewMonth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [failCount, setFailCount] = useState(0);
  // Snapshot at the moment a reschedule starts — `taskIds` comes from the
  // parent's `overdueTasks`, which shrinks live as each PATCH succeeds and
  // react-query refetches. Without this snapshot the "из N" in the error
  // line below would silently change denominator mid-flight.
  const [totalAtStart, setTotalAtStart] = useState(0);

  useEffect(() => {
    if (open) {
      setStagedDate(null);
      setFailCount(0);
      setProgress(null);
      const d = new Date(today + "T00:00:00");
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [open, today]);

  const applyDate = useGuardedCallback(async (dateStr: string | null) => {
    if (taskIds.length === 0) return;
    const ids = taskIds;
    setBusy(true);
    setFailCount(0);
    setTotalAtStart(ids.length);
    setProgress({ done: 0, total: ids.length });
    let done = 0;
    let fails = 0;
    await Promise.all(
      ids.map(async (id) => {
        try {
          await updateTask.mutateAsync({ id, due_date: dateStr });
        } catch {
          fails += 1;
        } finally {
          done += 1;
          setProgress({ done, total: ids.length });
        }
      }),
    );
    setBusy(false);
    setFailCount(fails);
    if (fails === 0) onClose();
  });

  // §3 Interruptibility, §5 Velocity handoff, §7 Spatial consistency
  const sheet = useBottomSheet({ open, onClose });

  if (!sheet.mounted) return null;

  const tomorrow = addDays(today, 1);
  const dow = new Date(today + "T00:00:00").getDay();
  const satOffset = (6 - dow + 7) % 7 || 7; // today itself being Saturday jumps to the *next* one
  const weekend = addDays(today, satOffset);
  const mondayOffset = (1 - dow + 7) % 7 || 7; // ditto for Monday
  const nextWeek = addDays(today, mondayOffset);
  const weekdayOf = (d: string) => {
    const day = new Date(d + "T00:00:00").getDay();
    return WEEKDAYS_SHORT[(day + 6) % 7];
  };

  const quickOptions: QuickOption[] = [
    {
      label: "Сегодня",
      date: today,
      hint: weekdayOf(today),
      iconClassName: "text-red",
    },
    {
      label: "Завтра",
      date: tomorrow,
      hint: weekdayOf(tomorrow),
      iconClassName: "text-orange",
    },
    {
      label: "На выходных",
      date: weekend,
      hint: weekdayOf(weekend),
      iconClassName: "text-teal",
    },
    {
      label: "Следующая неделя",
      date: nextWeek,
      hint: weekdayOf(nextWeek),
      iconClassName: "text-purple",
    },
    { label: "Без срока", date: null, hint: "", iconClassName: "text-dim" },
  ];

  const cells = genCalendar(viewYear, viewMonth);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else setViewMonth((m) => m + 1);
  };

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      {/* Scrim: opacity animated by useBottomSheet spring */}
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle: drag target for dismiss gesture */}
        <SheetHandle dragProps={sheet.dragProps} />

        {/* Header: X закрывает без изменений слева, круглая галочка справа
            подтверждает выбранный в календаре день (быстрые варианты ниже
            применяются сразу по тапу, без промежуточного подтверждения —
            календарь же требует явного "готово", потому что просто листать
            месяцы не должно ничего применять). */}
        <div className="flex items-center justify-between pb-2">
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          {/* Заголовок шторки — 17px, как заголовок вторичного экрана
              (ScreenHeader variant="compact"): шторка это тот же уровень
              навигации. 16px здесь был сиротой вне шкалы — в проекте 16px
              значит «поле ввода, защита от автозума iOS», см. index.css. */}
          <h3 className="text-[17px] font-semibold text-text">Срок</h3>
          <button
            onClick={() => stagedDate && applyDate(stagedDate)}
            disabled={!stagedDate || busy}
            aria-label="Подтвердить выбранную дату"
            className="tap-scale w-11 h-11 -mr-2 rounded-full bg-red flex items-center justify-center disabled:opacity-40"
          >
            <Icon name="check" size={18} className="text-white" />
          </button>
        </div>

        <div className="flex flex-col">
          {quickOptions.map((opt) => (
            <button
              key={opt.label}
              onClick={() => applyDate(opt.date)}
              disabled={busy}
              className="tap-row w-full flex items-center gap-3 py-2.5 px-1 text-left disabled:opacity-50"
            >
              <div
                className={`w-8 h-8 rounded-full bg-card2 flex items-center justify-center shrink-0 ${opt.iconClassName}`}
              >
                <Icon
                  name={opt.date === null ? "x" : "calendarSmall"}
                  size={15}
                />
              </div>
              <span className="flex-1 text-[14px] text-text">{opt.label}</span>
              {opt.hint && (
                <span className="text-[12px] text-sub">{opt.hint}</span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-1 pt-3 border-t border-stroke">
          <div className="flex items-center justify-between mb-2 px-1">
            <button
              onClick={prevMonth}
              disabled={busy}
              aria-label="Предыдущий месяц"
              className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
            >
              <Icon name="chevronLeft" size={16} className="text-sub" />
            </button>
            <span className="text-[13px] font-semibold text-text">
              {MONTHS_FULL[viewMonth]} {viewYear}
            </span>
            <button
              onClick={nextMonth}
              disabled={busy}
              aria-label="Следующий месяц"
              className="tap-scale w-11 h-11 -mr-2 flex items-center justify-center"
            >
              <Icon name="chevron" size={16} className="text-sub" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0 mb-1">
            {WEEKDAYS_SHORT.map((d, i) => (
              <div
                key={`${d}-${i}`}
                className="text-center text-[11px] text-sub py-1"
              >
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0 pb-3">
            {cells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const dateStr = formatDateStr(viewYear, viewMonth, day);
              const isToday = dateStr === today;
              const isStaged = dateStr === stagedDate;
              return (
                <button
                  key={i}
                  onClick={() => setStagedDate(isStaged ? null : dateStr)}
                  disabled={busy}
                  className={`h-[38px] flex items-center justify-center rounded-full transition-all active:scale-90 text-[13px] disabled:opacity-50 ${
                    isStaged
                      ? "bg-red text-white font-semibold"
                      : isToday
                        ? "text-red font-semibold"
                        : "text-text"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>

        {busy && progress && (
          <p className="text-[12px] text-sub text-center py-2">
            Переносим {progress.done} из {progress.total}…
          </p>
        )}
        <ErrorBanner
          error={failCount > 0}
          fallback={`Не удалось перенести ${failCount} из ${totalAtStart} задач. Остальные уже перенесены — попробуйте ещё раз.`}
          variant="block"
          className="mt-1 mb-2"
        />
      </div>
    </div>
  );
}
