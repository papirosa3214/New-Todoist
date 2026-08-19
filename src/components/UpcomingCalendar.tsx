import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiTask } from "../api/types";
import { Icon, findScrollContainer } from "./UI";
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
// Насколько далеко надо увести палец, чтобы месяц перелистнулся.
const SWIPE_MIN_PX = 70;
const WEEKDAY_LETTERS = ["П", "В", "С", "Ч", "П", "С", "В"];
// Запас под кнопку-веер больше не константа: обе сетки замеряют реальную
// доступную высоту (см. useLayoutEffect в WeekGrid/MonthGrid) — угаданное
// число промахивалось на десятки пикселей.

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
    // Календарь занимает ячейку ЦЕЛИКОМ, а не сидит сплющенным сверху
    // (владелец 19.08.2026: «зачем ты его сплющил и оставил половину
    // квадратика пустым — надо на весь квадратик»). Ряды делят высоту
    // поровну через flex-1, поэтому числа расходятся по всей ячейке, как
    // и в соседних ячейках дней.
    <div className="flex h-full flex-col p-1.5">
      <div className="grid grid-cols-7 pb-0.5">
        {WEEKDAY_LETTERS.map((l, i) => (
          <span key={i} className="text-center text-[9px] text-dim">
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
            className={`grid flex-1 grid-cols-7 items-center rounded ${
              inWeek ? "bg-white/[0.07]" : ""
            }`}
          >
            {rowCells.map((d) => {
              const ds = toDateStr(d);
              const dim = d.getMonth() !== month;
              return (
                <button
                  key={ds}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPickDate(ds);
                  }}
                  className={`text-center text-[10px] tabular-nums ${
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

/** Подпись месяца под заголовком экрана — какой месяц мы вообще смотрим
 *  (владелец 19.08.2026: «нужно месяц вверху указывать, там где
 *  Предстоящее, чуть ниже»). Отдаётся в ScreenHeader через проп `below`:
 *  тогда её накрывает то же затухание, что и заголовок, а высота шапки
 *  (--screen-header-h, по ней считается высота сетки) пересчитывается
 *  сама. Месяц берётся по четвергу недели — по той же причине, что и в
 *  мини-календаре. */
export function WeekMonthLabel({ monday }: { monday: string }) {
  const thursday = new Date(monday + "T00:00:00");
  thursday.setDate(thursday.getDate() + 3);
  return (
    <div className="pb-1.5 pt-0.5 text-[15px] font-semibold text-text">
      {MONTHS_NOM[thursday.getMonth()]} {thursday.getFullYear()}
    </div>
  );
}

const MONTHS_NOM = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

/** Заголовок месяца со стрелками — уезжает в шапку экрана
 *  (ScreenHeader.below), как и подпись недели: владелец 19.08.2026 —
 *  «этот „авг 2026“ можешь в шапку добавить, календарик чуть приподнимется».
 *  Там же он получает общее с заголовком затухание. */
export function MonthHeaderLabel({ month }: { year: number; month: number }) {
  // Ни года, ни стрелок (владелец 19.08.2026: «2026 не надо, убери год;
  // стрелки тоже убери» — месяц листается свайпом, см. MonthGrid).
  return (
    <div className="pb-1.5 pt-0.5 text-[15px] font-semibold text-text">
      {MONTHS_NOM[month]}
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
  // Высота сетки ЗАМЕРЯЕТСЯ, а не считается формулой из 100dvh: расчёт
  // «экран минус шапка минус запас» промахнулся на 25px — в него не
  // входят отступы страницы и нижний padding контейнера прокрутки, и
  // страница всё равно чуть болталась вверх-вниз, чего владелец как раз и
  // просил не допускать («статика, абсолютная статика»). Здесь берётся
  // фактическое расстояние от верха сетки до низа видимой области того же
  // контейнера, что и прокручивает страницу.
  const gridRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const sc = findScrollContainer(grid);
    const measure = () => {
      const top =
        grid.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      // Нижние отступы ВСЕЙ цепочки до контейнера прокрутки, а не только
      // его собственный: место под кнопку-веер создаёт страница, и без
      // этого слагаемого сетка ровно на столько и вылезала за экран
      // (замер: 104px прокрутки). Тот же обход предков, что в сетке дня.
      let padBelow = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
      for (
        let el: HTMLElement | null = grid.parentElement;
        el && el !== sc;
        el = el.parentElement
      ) {
        padBelow += parseFloat(getComputedStyle(el).paddingBottom) || 0;
      }
      const next = Math.max(240, sc.clientHeight - top - padBelow);
      setHeight((prev) => (prev && Math.abs(prev - next) < 1 ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [monday]);

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
    // БЕЗ прокрутки: вся неделя видна разом, крутить нечего (владелец
    // 19.08.2026: «зачем здесь скроллить, вся неделя на экране — статика,
    // абсолютная статика»). Поэтому height, а не minHeight: сетка ровно в
    // оставшийся экран, страница не удлиняется ни на пиксель.
    //
    // Замыкающих линий сверху и снизу нет намеренно — только внутренние
    // разделители. С рамкой по периметру сетка читалась «квадратиком»;
    // без неё края открыты и раскладка выглядит продолжающейся, как и
    // просил владелец («чтобы был такой воздушный, с продолжением»).
    <div
      ref={gridRef}
      className="-mx-4 grid grid-cols-2"
      style={{ height, gridTemplateRows: "repeat(4, minmax(0, 1fr))" }}
    >
      <div className="min-h-0 border-b border-r border-stroke">
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
            className={`flex min-h-0 flex-col items-stretch gap-[3px] overflow-hidden p-1.5 text-left ${
              // Правая граница — только у левой колонки сетки. Первая
              // ячейка (мини-календарь) уже занята, поэтому чётность
              // считается со сдвигом на единицу.
              i % 2 === 0 ? "" : "border-r border-stroke"
            } ${
              // Нижняя черта — у всех, кроме двух последних ячеек: сетка
              // не должна замыкаться линией по низу, см. комментарий выше.
              i < days.length - 2 ? "border-b border-stroke" : ""
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
  openDay,
  onDayClick,
  onTaskClick,
  onPrevMonth,
  onNextMonth,
}: {
  year: number;
  month: number;
  byDate: Map<string, ApiTask[]>;
  /** Раскрытый день — его список вставляется ПОД строкой его недели. */
  openDay: string | null;
  onDayClick: (date: string) => void;
  onTaskClick: (id: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}) {
  // Свайп влево-вправо листает месяцы — стрелки владелец убрал именно под
  // него (19.08.2026: «добавь возможность свайпами менять месяца, вот как
  // надо, поэтому стрелочки и не нужны; свайп прям нормальный, чтобы не в
  // пол пинка он улетал»). Отсюда пороги: жест засчитывается от 70px по
  // горизонтали И только если он заметно горизонтальнее вертикального —
  // случайное движение пальцем месяц не перелистнёт.
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    swipeRef.current = { x: e.clientX, y: e.clientY };
  }
  function onPointerUp(e: React.PointerEvent) {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.6)
      return;
    if (dx < 0) onNextMonth();
    else onPrevMonth();
  }
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
  // Высота — замером, как в WeekGrid: календарь месяца тоже фиксирован,
  // страница не прокручивается (владелец 19.08.2026: «тут скроллить
  // нечего, сам календарик пусть будет фикс, а скроллить буду задачи
  // внутри открывшегося окна»).
  const gridRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const sc = findScrollContainer(grid);
    const measure = () => {
      const top =
        grid.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      let padBelow = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
      for (
        let el: HTMLElement | null = grid.parentElement;
        el && el !== sc;
        el = el.parentElement
      ) {
        padBelow += parseFloat(getComputedStyle(el).paddingBottom) || 0;
      }
      const next = Math.max(320, sc.clientHeight - top - padBelow);
      setHeight((prev) => (prev && Math.abs(prev - next) < 1 ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [year, month]);

  const gridH = height ? height - 26 : undefined;
  const rowH = gridH ? gridH / 6 : undefined;

  return (
    <div
      className="-mx-4 select-none"
      ref={gridRef}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeRef.current = null)}
      style={{ touchAction: "pan-y" }}
    >
      {/* Разделительной черты под днями недели больше нет — вся сетка
          месяца идёт без линий (владелец 19.08.2026: «убери всю сетку
          месяца, чтобы не было вообще этих полосок»). */}
      <div className="grid grid-cols-7 pb-1">
        {WEEKDAYS_SHORT.map((w) => (
          <span key={w} className="text-center text-[10px] text-dim">
            {w}
          </span>
        ))}
      </div>
      {/* Сетка собирается ПОНЕДЕЛЬНО, а не одним гридом на 42 ячейки:
          раскрытый день показывает свои задачи полосой, вставленной между
          его неделей и следующей (владелец 19.08.2026: «не надо, чтобы в
          месяце снизу выезжала формочка — нажимаешь на день, и между этой
          неделей и следующей раскрывается окно, внутри которого задачи»).
          Внутри одного грида такую вставку не сделать, не ломая ряды. */}
      {/* Высота замерена (см. выше), ряды — ФИКСИРОВАННОЙ высоты, не
          доли: при раскрытии дня календарь не должен меняться (владелец
          19.08.2026: «не нужно сжимать все остальные, календарь не должен
          меняться — просто вниз уезжают те недели, что ниже»). Полоса
          вставляется в поток, нижние недели съезжают вниз и обрезаются
          краем, а размер ячеек остаётся прежним. */}
      <div className="flex flex-col overflow-hidden" style={{ height: gridH }}>
        {Array.from({ length: 6 }, (_, w) => {
          const week = cells.slice(w * 7, w * 7 + 7);
          const openHere =
            openDay != null && week.some((d) => toDateStr(d) === openDay);
          return (
            <Fragment key={w}>
              <div
                className="grid min-h-0 shrink-0 grid-cols-7"
                style={{ height: rowH }}
              >
                {week.map((d) => {
                  const ds = toDateStr(d);
                  const tasks = byDate.get(ds) ?? [];
                  const shown = tasks.slice(0, MONTH_CHIP_LIMIT);
                  const rest = tasks.length - shown.length;
                  const otherMonth = d.getMonth() !== month;
                  const isOpen = ds === openDay;
                  return (
                    // div, не button — по той же причине, что и в неделе:
                    // внутри лежат кнопки-плашки.
                    <div
                      key={ds}
                      onClick={() => onDayClick(ds)}
                      // Никаких границ: сетка без линий вовсе. Осталась
                      // только подсветка выбранного дня — она и связывает
                      // его с раскрытой полосой.
                      className={`flex min-h-0 flex-col items-center gap-[2px] overflow-hidden px-0.5 py-1 text-left ${
                        otherMonth ? "opacity-45" : ""
                      } ${isOpen ? "rounded-t-lg bg-card" : ""}`}
                    >
                      {/* Число по ЦЕНТРУ ячейки, а не у левого края:
                          владелец 19.08.2026 — «числа отцентруй по
                          ячейкам, чтобы они шли в рядок с днями недели».
                          Теперь «Пн» в шапке и все его числа стоят на
                          одной вертикали. */}
                      <span
                        className={`mb-0.5 text-[11px] tabular-nums ${
                          ds === today
                            ? "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red font-semibold text-white"
                            : "text-text"
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
                        <span className="px-1 text-[9px] text-dim">
                          +{rest}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {openHere && openDay && (
                <DayStrip
                  date={openDay}
                  tasks={byDate.get(openDay) ?? []}
                  onTaskClick={onTaskClick}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** Раскрытый день ВНУТРИ месячной сетки — полоса между его неделей и
 *  следующей. Не панель снизу: владелец 19.08.2026 попросил именно так,
 *  чтобы день раскрывался на месте, не закрывая собой календарь. */
function DayStrip({
  date,
  tasks,
  onTaskClick,
}: {
  date: string;
  tasks: ApiTask[];
  onTaskClick: (id: string) => void;
}) {
  const d = new Date(date + "T00:00:00");
  return (
    // shrink-0 обязателен: контейнер месяца теперь фиксированной высоты с
    // overflow-hidden, и без запрета сжатия полосу схлопывало в ноль —
    // недели с flex-1 забирали всю высоту себе.
    <div className="shrink-0 bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-text">
          {d.getDate()} {MONTHS_GEN[d.getMonth()]},
        </span>
        {/* Кнопки «Свернуть» здесь нет намеренно (владелец 19.08.2026:
            «убери это слово, оно абсолютно не нужно, я и так знаю, как
            сворачивать») — полоса закрывается повторным тапом по тому же
            дню, см. onDayClick в UpcomingScreen.
            День недели — ПОЛНЫМ словом с большой буквы и тем же
            начертанием, что дата: «20 августа, Четверг» (владелец там же:
            «можешь всё-таки писать обычным шрифтом, как 20 августа,
            Четверг — там всё с большой буквы идёт»). Сокращённое «Чт»
            тонким серым читалось как служебная подпись. */}
        <span className="text-[13px] font-semibold text-text">
          {WEEKDAYS_FULL[(d.getDay() + 6) % 7]}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="py-2 text-[12px] text-dim">Ничего не запланировано</p>
      ) : (
        // Своя прокрутка при длинном дне: полоса не должна выталкивать
        // календарь с экрана — она встроена в него, а не лежит поверх.
        <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto overscroll-contain">
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={(e) => {
                e.stopPropagation();
                onTaskClick(t.id);
              }}
              className="flex items-center gap-2 rounded-lg bg-card2 px-2 py-1.5 text-left"
            >
              <span
                className={`flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[4px] border ${
                  t.status === "completed"
                    ? "border-dim bg-dim/30"
                    : "border-dim"
                }`}
              >
                {t.status === "completed" && (
                  <Icon name="check" size={8} className="text-sub" />
                )}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] ${
                  t.status === "completed"
                    ? "text-sub line-through"
                    : "text-text"
                }`}
              >
                {t.title}
              </span>
              {t.start_time && (
                <span className="shrink-0 text-[11px] tabular-nums text-dim">
                  {formatTimeRange(t.start_time, t.duration_min)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Раскрытый день — панель со списком задач этого дня (скриншот IMG_8356:
 *  там она выезжает поверх сетки). Осталась для НЕДЕЛЬНОГО вида; в
 *  месячном день раскрывается полосой внутри сетки, см. DayStrip. */
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

const WEEKDAYS_FULL = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];

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
