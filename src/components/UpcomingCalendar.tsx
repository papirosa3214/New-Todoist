import { useMemo } from "react";
import type { ApiTask } from "../api/types";
import { Icon } from "./UI";
import { formatTimeRange, todayStr } from "../lib/date";

// ═══════════ Календарные виды раздела «Предстоящее» ═══════════
//
// 19.08.2026, по четырём присланным скриншотам (IMG_8353/8354 — неделя,
// IMG_8357 — месяц, IMG_8356 — раскрытый день поверх месяца). Владелец:
// «как у нас в Сегодня появились помимо списка календарные вещи — один
// день и три дня, так же сделай неделю и месяц в предстоящем».
//
// Что взято со скриншотов — СТРУКТУРА, а не палитра: там светлая тема
// чужого приложения, у нас своя тёмная дизайн-система, и переносить
// сиреневые плашки на #1C1C1E значило бы завести вторую палитру рядом с
// существующей.
//
//   неделя — сетка 2×4: первая ячейка занята мини-календарём месяца,
//            остальные семь — дни недели со списком задач внутри;
//   месяц  — сетка 7×6, в ячейке число и мини-плашки задач, а не
//            влезающие сворачиваются в «+N»;
//   день   — по тапу раскрывается списком (в обоих видах).
//
// Неделя начинается с ПОНЕДЕЛЬНИКА, а не с воскресенья, как на скриншотах:
// весь остальной календарь этого приложения (лента недель в этом же
// экране, мини-календарь в форме задачи) уже built с понедельника, и одна
// раскладка, живущая по другому правилу, читалась бы как ошибка.

const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAY_LETTERS = ["П", "В", "С", "Ч", "П", "С", "В"];
// Сколько высоты оставить под кнопку-веер внизу экрана, чтобы последний
// ряд сетки не уходил под неё.
const GRID_BOTTOM_RESERVE = 96;

/** Понедельник недели, в которую попадает дата. */
export function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  // getDay(): 0 = воскресенье. Сдвиг до понедельника: у воскресенья это
  // −6 дней, у остальных — −(day−1).
  const shift = d.getDay() === 0 ? -6 : -(d.getDay() - 1);
  d.setDate(d.getDate() + shift);
  return toDateStr(d);
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Задачи по датам — один проход вместо фильтра на каждую ячейку: в
 *  месячной сетке ячеек 42, и фильтровать весь список для каждой значило
 *  бы 42 прохода по всем задачам на каждый рендер. */
export function groupByDate(tasks: ApiTask[]): Map<string, ApiTask[]> {
  const map = new Map<string, ApiTask[]>();
  for (const t of tasks) {
    if (!t.due_date) continue;
    const list = map.get(t.due_date);
    if (list) list.push(t);
    else map.set(t.due_date, [t]);
  }
  // Внутри дня — по времени начала: задачи без времени идут первыми, как
  // и в сетке дня («Сегодня»), где они лежат отдельным пулом сверху.
  for (const list of map.values()) {
    list.sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
  }
  return map;
}

/** Плашка задачи внутри ячейки дня. Одна строка: отметка, название и
 *  время справа — ровно как на скриншоте. Время печатается интервалом,
 *  тем же форматом, что в карточке задачи. */
function TaskChip({
  task,
  onClick,
  compact,
}: {
  task: ApiTask;
  onClick: () => void;
  /** Месячная сетка: там ячейка узкая, времени в плашке нет вовсе. */
  compact?: boolean;
}) {
  const done = task.status === "completed";
  return (
    <button
      onClick={(e) => {
        // Не отдавать клик ячейке дня: тап по плашке — это «открыть эту
        // задачу», а не «раскрыть день».
        e.stopPropagation();
        onClick();
      }}
      className={`flex w-full items-center gap-1 overflow-hidden rounded bg-card2 px-1 text-left ${
        compact ? "h-[15px]" : "h-[19px] gap-1.5 px-1.5"
      } ${done ? "opacity-45" : ""}`}
    >
      {/* Отметка — квадрат рамкой, как в строке списка и в шапке карточки
          задачи (решение владельца 15.08.2026: круг остался за
          подзадачами). Готовой иконки квадрата в наборе нет, и заводить её
          ради 10px незачем. */}
      {!compact && (
        <span
          className={`flex h-[10px] w-[10px] shrink-0 items-center justify-center rounded-[3px] border ${
            done ? "border-dim bg-dim/30" : "border-dim"
          }`}
        >
          {done && <Icon name="check" size={7} className="text-sub" />}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 truncate ${
          compact ? "text-[9px]" : "text-[11px]"
        } ${done ? "text-sub line-through" : "text-text"}`}
      >
        {task.title}
      </span>
      {!compact && task.start_time && (
        <span className="shrink-0 text-[10px] tabular-nums text-dim">
          {task.start_time}
        </span>
      )}
    </button>
  );
}

/** Мини-календарь месяца — первая ячейка недельной сетки. Показывает весь
 *  месяц и подсвечивает показанную неделю полосой, чтобы было видно, где
 *  ты находишься. Тап по числу уводит на его неделю. */
function MiniMonth({
  monday,
  onPickDate,
}: {
  monday: string;
  onPickDate: (date: string) => void;
}) {
  const today = todayStr();
  const anchor = new Date(monday + "T00:00:00");
  // Месяц берётся по ЧЕТВЕРГУ недели, а не по понедельнику: неделя на
  // стыке месяцев принадлежит тому месяцу, где лежит её большая часть, и
  // иначе последняя неделя августа подписывалась бы июлем.
  const thursday = new Date(anchor);
  thursday.setDate(thursday.getDate() + 3);
  const year = thursday.getFullYear();
  const month = thursday.getMonth();

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const lead = first.getDay() === 0 ? 6 : first.getDay() - 1;
    const start = new Date(year, month, 1 - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [year, month]);

  const weekEnd = addDays(monday, 6);

  return (
    <div className="flex flex-col gap-[3px] p-1.5">
      <div className="grid grid-cols-7">
        {WEEKDAY_LETTERS.map((l, i) => (
          <span key={i} className="text-center text-[8px] text-dim">
            {l}
          </span>
        ))}
      </div>
      {Array.from({ length: 6 }, (_, row) => {
        const rowCells = cells.slice(row * 7, row * 7 + 7);
        const rowStr = rowCells.map(toDateStr);
        // Полоса под показанной неделей — одна на строку, а не рамка у
        // каждого числа: на скриншоте выделена именно строка целиком.
        const inWeek = rowStr[0] >= monday && rowStr[0] <= weekEnd;
        return (
          <div
            key={row}
            className={`grid grid-cols-7 rounded ${inWeek ? "bg-white/[0.07]" : ""}`}
          >
            {rowCells.map((d) => {
              const ds = toDateStr(d);
              const dim = d.getMonth() !== month;
              return (
                <button
                  key={ds}
                  onClick={() => onPickDate(ds)}
                  className={`text-center text-[9px] leading-[13px] tabular-nums ${
                    ds === today
                      ? "font-semibold text-red"
                      : dim
                        ? "text-dim/60"
                        : "text-sub"
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Неделя: мини-календарь и семь дней в сетке 2×4. */
export function WeekGrid({
  monday,
  byDate,
  onTaskClick,
  onDayClick,
  onPickDate,
}: {
  monday: string;
  byDate: Map<string, ApiTask[]>;
  onTaskClick: (id: string) => void;
  onDayClick: (date: string) => void;
  onPickDate: (date: string) => void;
}) {
  const today = todayStr();
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return (
    // Сетка идёт от края до края экрана (-mx-4 компенсирует поля страницы)
    // и делится линиями, а не отступами — как на скриншоте: ячейки там
    // смыкаются, разделённые одной чертой.
    //
    // Высота — ровно оставшийся экран, поделённый на четыре ряда: на
    // скриншоте сетка занимает его целиком, а не кончается на середине с
    // пустотой внизу. Отсчёт от --screen-header-h (реальная высота шапки,
    // публикуется ScreenHeader) плюс запас под кнопку-веер, чтобы нижний
    // ряд не уезжал под неё.
    <div
      className="-mx-4 grid grid-cols-2 border-t border-stroke"
      style={{
        minHeight: `calc(100dvh - var(--screen-header-h, 60px) - ${GRID_BOTTOM_RESERVE}px)`,
        gridTemplateRows: "repeat(4, minmax(0, 1fr))",
      }}
    >
      <div className="border-b border-r border-stroke">
        <MiniMonth monday={monday} onPickDate={onPickDate} />
      </div>
      {days.map((ds, i) => {
        const tasks = byDate.get(ds) ?? [];
        const d = new Date(ds + "T00:00:00");
        const isToday = ds === today;
        return (
          // Ячейка — div, а НЕ button: внутри лежат кнопки-плашки задач, а
          // кнопка внутри кнопки — невалидная разметка, React ругается
          // прямо в консоль («cannot be a descendant of button»). Тап по
          // свободному месту ячейки раскрывает день, тап по плашке
          // открывает задачу и всплытие останавливает.
          <div
            key={ds}
            onClick={() => onDayClick(ds)}
            className={`flex min-h-0 flex-col items-stretch overflow-hidden gap-[3px] border-b border-stroke p-1.5 text-left ${
              // Правая граница — только у левой колонки сетки. Первая
              // ячейка (мини-календарь) уже занята, поэтому чётность
              // считается со сдвигом на единицу.
              i % 2 === 0 ? "" : "border-r"
            }`}
          >
            <div className="mb-0.5 flex items-baseline gap-1 px-0.5">
              <span
                className={`text-[11px] font-semibold ${
                  isToday ? "text-red" : "text-sub"
                }`}
              >
                {WEEKDAYS_SHORT[i]}
              </span>
              <span
                className={`text-[12px] tabular-nums ${
                  isToday
                    ? "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red px-1 text-[11px] font-semibold text-white"
                    : "text-text"
                }`}
              >
                {d.getDate()}
              </span>
            </div>
            {tasks.map((t) => (
              <TaskChip key={t.id} task={t} onClick={() => onTaskClick(t.id)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Месяц: 7×6, в ячейке число и мини-плашки. Не влезающие сворачиваются в
 *  «+N» — сколько именно поместится, решает высота ячейки, поэтому лимит
 *  задан числом, а не измерением: на 128px ячейки помещается ровно
 *  четыре плашки по 15px с отступами. */
const MONTH_CHIP_LIMIT = 4;

export function MonthGrid({
  year,
  month,
  byDate,
  onDayClick,
}: {
  year: number;
  month: number;
  byDate: Map<string, ApiTask[]>;
  onDayClick: (date: string) => void;
}) {
  const today = todayStr();
  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const lead = first.getDay() === 0 ? 6 : first.getDay() - 1;
    const start = new Date(year, month, 1 - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [year, month]);

  return (
    <div className="-mx-4">
      <div className="grid grid-cols-7 border-b border-stroke pb-1">
        {WEEKDAYS_SHORT.map((w) => (
          <span key={w} className="text-center text-[10px] text-dim">
            {w}
          </span>
        ))}
      </div>
      {/* Шесть рядов на весь оставшийся экран — см. тот же приём в
          WeekGrid: сетка месяца не должна обрываться на середине. */}
      <div
        className="grid grid-cols-7"
        style={{
          minHeight: `calc(100dvh - var(--screen-header-h, 60px) - ${GRID_BOTTOM_RESERVE + 44}px)`,
          gridTemplateRows: "repeat(6, minmax(0, 1fr))",
        }}
      >
        {cells.map((d) => {
          const ds = toDateStr(d);
          const tasks = byDate.get(ds) ?? [];
          const shown = tasks.slice(0, MONTH_CHIP_LIMIT);
          const rest = tasks.length - shown.length;
          const otherMonth = d.getMonth() !== month;
          return (
            // div, не button — по той же причине, что и в неделе: внутри
            // лежат кнопки-плашки.
            <div
              key={ds}
              onClick={() => onDayClick(ds)}
              className={`flex min-h-0 flex-col gap-[2px] overflow-hidden border-b border-r border-stroke p-1 text-left ${
                otherMonth ? "opacity-45" : ""
              }`}
            >
              <span
                className={`mb-0.5 self-start text-[11px] tabular-nums ${
                  ds === today
                    ? "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red px-1 font-semibold text-white"
                    : "px-1 text-text"
                }`}
              >
                {d.getDate()}
              </span>
              {shown.map((t) => (
                <TaskChip
                  key={t.id}
                  task={t}
                  compact
                  onClick={() => onDayClick(ds)}
                />
              ))}
              {rest > 0 && (
                <span className="px-1 text-[9px] text-dim">+{rest}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Раскрытый день — панель со списком задач этого дня (скриншот IMG_8356:
 *  там она выезжает поверх сетки). Здесь она открывается снизу, как и
 *  прочие панели приложения. */
export function DaySheet({
  date,
  tasks,
  onTaskClick,
  onClose,
}: {
  date: string;
  tasks: ApiTask[];
  onTaskClick: (id: string) => void;
  onClose: () => void;
}) {
  const d = new Date(date + "T00:00:00");
  return (
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] w-full overflow-y-auto rounded-t-2xl bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[17px] font-semibold text-text">
            {d.getDate()} {MONTHS_GEN[d.getMonth()]}
          </span>
          <span className="text-[13px] text-sub">
            {WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-[14px] text-red"
            aria-label="Закрыть"
          >
            Готово
          </button>
        </div>
        {tasks.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-dim">
            На этот день ничего не запланировано
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => onTaskClick(t.id)}
                className="flex items-center gap-2 rounded-xl bg-card2 px-3 py-2.5 text-left"
              >
                <span
                  className={`flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[5px] border-2 ${
                    t.status === "completed"
                      ? "border-dim bg-dim/30"
                      : "border-dim"
                  }`}
                >
                  {t.status === "completed" && (
                    <Icon name="check" size={10} className="text-sub" />
                  )}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate text-[14px] ${
                    t.status === "completed"
                      ? "text-sub line-through"
                      : "text-text"
                  }`}
                >
                  {t.title}
                </span>
                {t.start_time && (
                  <span className="shrink-0 text-[12px] tabular-nums text-dim">
                    {formatTimeRange(t.start_time, t.duration_min)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const MONTHS_GEN = [
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
