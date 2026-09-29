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
// Запас под кнопку-веер больше не константа для WeekGrid: она замеряет
// реальную доступную высоту (см. useLayoutEffect в WeekGrid). MonthGrid
// после 20.08.2026 меряет по-другому — см. её собственный блок ниже.

// ═══ Месяц — континуальный скролл (20.08.2026) ═══
// Максим, увидев дискретное «страница-месяц целиком» с горизонтальным
// свайпом: «нужно, чтобы бесконечный скролл был вниз-вверх, тоже месяца
// менялись... прям непрерывно и полотном... с числом числом, ну одни
// цифры... без каких-либо заминок». Настоящий infinite-scroll (Google
// Calendar-стиль), не страницы — уточнено явно через превью вариантов.
//
// MONTH_ROW_H — ФИКСИРОВАННАЯ высота строки-недели, а не замер «весь
// экран / 6 рядов» (тот способ был для другой задачи — «месяц занимает
// ровно экран, без остатка»; теперь общий смысл обратный, сама фича —
// это то, что список скроллится). 128px — то самое число, что уже было
// подтверждено в проекте комментарием у MONTH_CHIP_LIMIT ниже («на 128px
// ячейки помещается ровно четыре плашки по 15px с отступами») — не
// придумано заново, взято уже проверенное.
const MONTH_ROW_H = 128;
// Сколько недель заранее подгружено при первом открытии — до и после
// начальной точки. Начальная точка теперь — ПЕРВАЯ НЕДЕЛЯ ТЕКУЩЕГО МЕСЯЦА,
// а не «8 недель до сегодня» (владелец 22.08.2026: «слишком много пустого
// места до начала августа — подтянуть вверх»). При этом 8 недель ПРОШЛЫХ
// остаются в списке намеренно: верхний sentinel имеет rootMargin 800px, и
// если запас был бы меньше этой зоны (например 2 недели = 256px), он
// срабатывал бы уже в первый кадр и дорисовывал сотни недель, уезжая от
// начала месяца. 8 недель = 1024px > 800px — sentinel не виден на старте.
const WEEKS_INITIAL_PAST = 8;
const WEEKS_INITIAL_FUTURE = 16;
const WEEKS_CHUNK = 12;

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
      // tap-menu, а не tap-row: плашка сама лежит на приподнятой
      // поверхности (bg-card2 = #2b2b2b), а значения откликов сняты с
      // макета, где более светлая заливка .06 как раз и предназначена для
      // строк на приподнятой панели — на #2b2b2b заливка .04 не читается
      // (см. описание системы в index.css).
      //
      // ::before добирает зону нажатия на просвет между плашками (week:
      // gap-[3px], month: gap-[2px]) — по половине зазора в каждую сторону,
      // так что зоны соседних плашек НЕ накладываются. Смысл не в трёх
      // пикселях высоты, а в том, что промах в зазор раньше доставался
      // ячейке дня и открывал ДРУГОЙ экран (лист дня) вместо задачи.
      // inset-x-0 обязателен: у абсолютного псевдоэлемента с пустым
      // content ширина иначе схлопывается в ноль, и зона не растёт (первый
      // заход именно так и промолчал — замер показал прежние 19pt).
      // overflow-hidden с кнопки снят: он обрезал бы псевдоэлемент. Текст
      // клипается сам (`truncate` на своём span), сверка скриншотов
      // до/после: 52 субпикселя разницы с максимумом 4/255 — сглаживание
      // скруглений у квадратика отметки, глазом не видно.
      //
      // Норма HIG 44pt по высоте здесь недостижима в принципе: в ячейку дня
      // недельной сетки (замер — 155pt чистой высоты) при 44pt влезло бы
      // три задачи вместо семи. Это перекройка вида, а не расширение зоны.
      className={`relative flex w-full items-center gap-1 rounded bg-card2 px-1 text-left tap-menu before:absolute before:inset-x-0 before:content-[''] ${
        compact
          ? "h-[15px] before:-inset-y-[1px]"
          : "h-[19px] gap-1.5 px-1.5 before:-inset-y-[1.5px]"
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
        <MarkdownInline source={task.title} />
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
            // items-center убран намеренно: при нём кнопка числа сжималась
            // до высоты текста (замер: 28.1×15pt при собственной высоте
            // строки 23.1pt), и 8pt строки оставались мёртвой зоной между
            // числами. Теперь кнопка растягивается на всю строку и центрует
            // цифру уже внутри себя — вид тот же, зона нажатия больше в
            // полтора раза.
            className={`grid flex-1 grid-cols-7 rounded ${
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
                  // 44×44 в мини-календаре недостижимо арифметически: 42
                  // ячейки живут в плитке 210×167pt, на ячейку приходится
                  // 28.1×23.1 — больше можно взять только внахлёст с
                  // соседним числом, что хуже промаха. Берём максимум без
                  // наложения (h-full w-full) и добавляем отклик: tap-row,
                  // потому что ячейка лежит на тёмном фоне плитки, где
                  // заливки .04 достаточно (см. index.css).
                  className={`flex h-full w-full items-center justify-center rounded text-center text-[10px] tabular-nums tap-row ${
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
  onPrevWeek,
  onNextWeek,
}: {
  monday: string;
  byDate: Map<string, ApiTask[]>;
  onTaskClick: (id: string) => void;
  onDayClick: (date: string) => void;
  onPickDate: (date: string) => void;
  /** Свайп влево-вправо переключает неделю — Максим 20.08.2026: «нужно
   *  реализовать это влево-вправо, чтобы недели перескакивали», тот же
   *  жест и те же пороги, что уже листают месяц (см. MonthGrid ниже). */
  onPrevWeek: () => void;
  onNextWeek: () => void;
}) {
  const today = todayStr();
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isHorizontalRef = useRef<boolean | null>(null);

  const triggerHaptic = () => {
    if (typeof window !== "undefined" && (window as any).Capacitor) {
      import("@capacitor/haptics").then(({ Haptics, ImpactStyle }) => {
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      });
    }
  };

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    isHorizontalRef.current = null;
    isDraggingRef.current = true;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    if (isHorizontalRef.current === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        isHorizontalRef.current = Math.abs(dx) > Math.abs(dy) * 1.3;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    if (!isHorizontalRef.current) return;

    const dx = e.clientX - startXRef.current;
    if (Math.abs(dx) >= SWIPE_MIN_PX) {
      triggerHaptic();
      if (dx < 0) onNextWeek();
      else onPrevWeek();
    }
  }
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
      // Нижняя граница — обход padding-bottom всей цепочки предков до sc,
      // ТОТ ЖЕ метод, что и раньше (пробовали заменить его прямым замером
      // плавающей кнопки-веера — оказалось неверно: у кнопки нет
      // отношения к padding-bottom, который реально стоит в потоке ПОСЛЕ
      // содержимого страницы (FAN_MENU_CONTENT_PADDING на обёртке вокруг
      // Outlet, Layout.tsx) — без его учёта e2e-тест поймал живой скролл
      // 16px, хотя нижний край сетки формально не заходил под кнопку).
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
      const next = Math.max(240, sc.clientHeight - top - padBelow);
      setHeight((prev) => (prev && Math.abs(prev - next) < 1 ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    // Раскладка стабилизируется НЕ за один проход. 20.08.2026, живой замер
    // вместе с владельцем: gridTop гулял 48.5 → 139.5 → 108px за один и
    // тот же цикл загрузки — сначала «доедала» себя шапка (меняет
    // --screen-header-h, style-атрибут на sc — это ResizeObserver(sc) не
    // видит, значение публикуется вручную через setProperty, не через
    // изменение размера sc), потом что-то ещё в поддереве над сеткой
    // (подпись месяца, судя по моменту) сдвигало саму сетку ещё на
    // 31.5px — тоже не изменение размера/style самого sc. Widen —
    // единственный надёжный вариант без гадания точным источником:
    // MutationObserver на всё поддерево sc (там же живёт и подпись
    // месяца, и сама сетка) ловит правки класса/текста/детей, а не
    // только style — проверено живым замером до точного совпадения с
    // независимым измерением после полного оседания страницы.
    const mo = new MutationObserver(measure);
    mo.observe(sc, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [monday]);

  // Высота ряда УЖЕ на максимуме без скролла — сетка и так занимает весь
  // оставшийся экран целиком (height ниже — фактическая доступная высота,
  // 4 равные доли). Растянуть выше физически некуда, не заведя прокрутку;
  // Максим 20.08.2026 явно отказался и от сужения ширины («мне не нужны
  // квадратики... ширину-то не надо было сужать»), и раньше — от скролла
  // («статика, абсолютная статика»). Значит ячейка остаётся тем
  // прямоугольником, что и была: ширина колонки на всю ширину экрана,
  // высота — вся доступная без остатка. Свайп ниже — отдельная, принятая
  // часть просьбы, ширины эта правка не касается.
  return (
    // Внешняя full-bleed обёртка — только под свайп-жест (палец должен
    // ловиться по всей ширине экрана). touchAction: pan-y — тот же приём,
    // что у MonthGrid: горизонтальный жест не даёт странице увести
    // вертикальный скролл вместе с ним.
    <div
      // Листание недель — свой горизонтальный жест (useSwipeBack исключает
      // помеченные узлы).
      data-hswipe
      className="-mx-4 select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (isDraggingRef.current = false)}
      style={{ touchAction: "pan-y" }}
    >
      <div
        ref={gridRef}
        data-week-grid
        className="grid grid-cols-2"
        style={{
          height,
          gridTemplateRows: "repeat(4, minmax(0, 1fr))",
        }}
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
              data-week-day={ds}
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
                <TaskChip
                  key={t.id}
                  task={t}
                  onClick={() => onTaskClick(t.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Месяц: 7×6, в ячейке число и мини-плашки. Не влезающие сворачиваются в
 *  «+N» — сколько именно поместится, решает высота ячейки, поэтому лимит
 *  задан числом, а не измерением: на 128px ячейки помещается ровно
 *  четыре плашки по 15px с отступами. */
const MONTH_CHIP_LIMIT = 4;

/** «Доминирующий» месяц недели — по четвергу, тем же правилом, что уже
 *  использует WeekMonthLabel/MiniMonth в этом файле: на стыке двух
 *  месяцев неделя «принадлежит» тому, где лежит её большая часть. */
function weekMonth(monday: string): { year: number; month: number } {
  const thu = new Date(monday + "T00:00:00");
  thu.setDate(thu.getDate() + 3);
  return { year: thu.getFullYear(), month: thu.getMonth() };
}

export function MonthGrid({
  initialMonday,
  byDate,
  openDay,
  onDayClick,
  onTaskClick,
  onVisibleMonthChange,
}: {
  /** Понедельник недели, вокруг которой строится начальный диапазон —
   *  обычно неделя сегодняшнего дня. Дальше список живёт сам, родитель им
   *  не управляет (см. «Почему» ниже). */
  initialMonday: string;
  byDate: Map<string, ApiTask[]>;
  /** Раскрытый день — его список вставляется ПОД строкой его недели. */
  openDay: string | null;
  onDayClick: (date: string) => void;
  onTaskClick: (id: string) => void;
  /** Какой месяц сейчас основной на экране — только для заголовка в
   *  шапке (MonthHeaderLabel в UpcomingScreen). Не управляет сеткой:
   *  список недель — внутреннее состояние этого компонента. */
  onVisibleMonthChange: (year: number, month: number) => void;
}) {
  const today = todayStr();
  const containerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  // Список недель начинается С ПЕРВОЙ НЕДЕЛИ ТЕКУЩЕГО МЕСЯЦА (с запасом
  // 2 недели наверх, чтобы верхний сентинел не дорисовывал сотни строк в
  // первый кадр). Владелец 22.08.2026: «слишком много пустого места от
  // предстоящего до начала августа — подтянуть вверх»; раньше список шёл
  // от 8 недель ДО понедельника текущей недели, и при открытии месячного
  // вида верх экрана занимала половина прошлого месяца.
  const [weeks, setWeeks] = useState<string[]>(() => {
    // Понедельник недели, содержащей 1-е число месяца от initialMonday.
    const anchor = new Date(initialMonday + "T00:00:00");
    const firstOf = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const dw = firstOf.getDay(); // 0 = вс
    const firstWeekMonday = new Date(firstOf);
    firstWeekMonday.setDate(firstOf.getDate() - (dw === 0 ? 6 : dw - 1));
    const start = addDays(
      firstWeekMonday.toISOString().slice(0, 10),
      -WEEKS_INITIAL_PAST * 7,
    );
    return Array.from(
      { length: WEEKS_INITIAL_PAST + WEEKS_INITIAL_FUTURE + 1 },
      (_, i) => addDays(start, i * 7),
    );
  });
  // Список НАЧИНАЕТСЯ на WEEKS_INITIAL_PAST недель раньше сегодняшней —
  // без явной прокрутки первым кадром был бы виден самый край списка
  // (прошлый месяц), а не «сейчас», как ждёт владелец при открытии
  // «Предстоящего». useLayoutEffect — до первой отрисовки на экране,
  // никакого мелькания прошлого месяца не будет. Единожды, при монтировании
  // (initialMonday в остальной жизни компонента не меняется).
  useLayoutEffect(() => {
    const grid = containerRef.current;
    if (!grid) return;
    const sc = findScrollContainer(grid);
    const gridTop =
      grid.getBoundingClientRect().top -
      sc.getBoundingClientRect().top +
      sc.scrollTop;
    // Показываем ПЕРВУЮ НЕДЕЛЮ МЕСЯЦА: она на индексе WEEKS_INITIAL_PAST
    // в списке (список начинается с WEEKS_INITIAL_PAST недель до неё).
    // Владелец 22.08.2026: «подтянуть вверх, много пустого места до
    // начала августа».
    sc.scrollTop = gridTop + WEEKS_INITIAL_PAST * MONTH_ROW_H;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Сколько недель добавили СВЕРХУ последним разом — растущий список внизу
  // не двигает уже видимый контент (браузер сам сохраняет scrollTop), а
  // добавление сверху отодвигает всё, что уже на экране, ровно на
  // добавленную высоту. Без коррекции ниже видимая часть «прыгает» вниз в
  // момент подгрузки — ровно то дёрганье, которого continuous-scroll не
  // должен показывать («без каких-либо заминок»).
  const prependedRef = useRef(0);
  useLayoutEffect(() => {
    if (prependedRef.current === 0) return;
    const sc = findScrollContainer(containerRef.current!);
    sc.scrollTop += prependedRef.current * MONTH_ROW_H;
    prependedRef.current = 0;
  }, [weeks]);

  // Подгрузка чанками через сентинелы сверху/снизу списка — не настоящая
  // виртуализация (дальние недели из DOM не убираются): для домашнего
  // трекера, где никто не станет листать тысячи недель за раз, это
  // достаточно и на порядок проще/безопаснее самодельной виртуализации.
  // rootMargin даёт запас — чанк подгружается ДО того, как сентинел
  // реально войдёт в кадр, иначе на быстром скролле мелькнёт пустота.
  useLayoutEffect(() => {
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    const grid = containerRef.current;
    if (!top || !bottom || !grid) return;
    const sc = findScrollContainer(grid);
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === top) {
            setWeeks((prev) => {
              const added = Array.from({ length: WEEKS_CHUNK }, (_, i) =>
                addDays(prev[0], (i - WEEKS_CHUNK) * 7),
              );
              prependedRef.current = WEEKS_CHUNK;
              return [...added, ...prev];
            });
          } else if (entry.target === bottom) {
            setWeeks((prev) => [
              ...prev,
              ...Array.from({ length: WEEKS_CHUNK }, (_, i) =>
                addDays(prev[prev.length - 1], (i + 1) * 7),
              ),
            ]);
          }
        }
      },
      { root: sc, rootMargin: "800px 0px 800px 0px" },
    );
    io.observe(top);
    io.observe(bottom);
    return () => io.disconnect();
  }, []);

  // Какой месяц сейчас основной на экране — по неделе, чья позиция
  // приходится на точку чуть НИЖЕ верхней кромки видимой области (не
  // ровно на кромке: там как раз чаще всего стоит переходная неделя, и
  // заголовок дёргался бы туда-обратно на каждый мелкий скролл). Индекс
  // считается арифметикой по MONTH_ROW_H, не перебором всех строк через
  // getBoundingClientRect — тот перебор дорог при не-виртуализированном
  // списке в сотни недель, а тут одно вычитание координат.
  useLayoutEffect(() => {
    const grid = containerRef.current;
    if (!grid) return;
    const sc = findScrollContainer(grid);
    let raf = 0;
    let lastKey = "";
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const scRect = sc.getBoundingClientRect();
        const gridTop = grid.getBoundingClientRect().top;
        const anchorY = scRect.top + 120;
        const idx = Math.max(
          0,
          Math.min(
            weeks.length - 1,
            Math.floor((anchorY - gridTop) / MONTH_ROW_H),
          ),
        );
        const { year, month } = weekMonth(weeks[idx]);
        const key = `${year}-${month}`;
        if (key !== lastKey) {
          lastKey = key;
          onVisibleMonthChange(year, month);
        }
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks.length]);

  // Свайп влево-вправо — теперь не смена state, а программный прыжок:
  // найти первую неделю, чей четверг попадает в следующий/предыдущий
  // месяц относительно того, что сейчас видно, и подскроллить к ней.
  // Если нужной недели ещё нет в уже построенном диапазоне (редко —
  // только у самых краёв), диапазон сперва достраивается синхронно,
  // чтобы прыжок не промахнулся в пустоту.
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  function jumpMonths(delta: 1 | -1) {
    const grid = containerRef.current;
    if (!grid) return;
    const sc = findScrollContainer(grid);
    const scRect = sc.getBoundingClientRect();
    const gridTop = grid.getBoundingClientRect().top;
    const curIdx = Math.max(
      0,
      Math.min(
        weeks.length - 1,
        Math.floor((scRect.top + 120 - gridTop) / MONTH_ROW_H),
      ),
    );
    const curMonth = weekMonth(weeks[curIdx]).month;
    // Поиск и, если нужно, достройка диапазона считаются здесь, ОДИН раз
    // на closure-снимке weeks — не внутри updater-функции setWeeds. React
    // StrictMode в dev нарочно вызывает такие updater'ы дважды, ловя
    // нечистые побочные эффекты: scrollTo внутри неё срабатывал оба раза,
    // причём второй раз поверх уже сдвинутого scrollTop — свайп улетал на
    // двойное расстояние (поймано 20.08.2026 на тесте свайпа назад).
    let list = weeks;
    let idx = curIdx;
    while (
      (delta === 1 ? idx < list.length - 1 : idx > 0) &&
      weekMonth(list[idx]).month === curMonth
    ) {
      idx += delta;
    }
    if (weekMonth(list[idx]).month === curMonth) {
      // Край уже построенного диапазона, месяц так и не сменился —
      // достроить чанк и повторить поиск один раз.
      const extra = Array.from({ length: WEEKS_CHUNK }, (_, i) =>
        delta === 1
          ? addDays(list[list.length - 1], (i + 1) * 7)
          : addDays(list[0], (i - WEEKS_CHUNK) * 7),
      );
      if (delta === 1) {
        list = [...list, ...extra];
      } else {
        prependedRef.current += WEEKS_CHUNK;
        list = [...extra, ...list];
        idx += WEEKS_CHUNK;
      }
      while (
        (delta === 1 ? idx < list.length - 1 : idx > 0) &&
        weekMonth(list[idx]).month === curMonth
      ) {
        idx += delta;
      }
      // Функциональная форма, не setWeeks(list) напрямую: list построен на
      // closure-снимке weeks, и если между рендером и этим вызовом
      // сентинел уже успел что-то дописать (узкое окно, но не нулевое),
      // плоская запись стёрла бы его — здесь достаточно применить свежий
      // prev, если он успел уйти вперёд снимка.
      setWeeks((prev) => (prev === weeks ? list : prev));
    }
    requestAnimationFrame(() => {
      sc.scrollTo({ top: sc.scrollTop + (idx - curIdx) * MONTH_ROW_H });
    });
  }
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
    jumpMonths(dx < 0 ? 1 : -1);
  }

  return (
    <div
      data-month-grid
      // Листание месяцев — свой горизонтальный жест.
      data-hswipe
      className="-mx-4 select-none"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeRef.current = null)}
      // pan-y: жест остаётся настоящим вертикальным скроллом системы (это
      // и есть вся фича), горизонтальная составляющая перехватывается
      // логикой выше только чтобы отличить «смахнул вбок» от «повёл
      // пальцем чуть криво во время скролла» — сам скролл она не блокирует.
      style={{ touchAction: "pan-y" }}
    >
      {/* Разделительной черты под днями недели больше нет — вся сетка
          месяца идёт без линий (владелец 19.08.2026: «убери всю сетку
          месяца, чтобы не было вообще этих полосок»).
          sticky, а не обычный поток (20.08.2026, найдено при переходе на
          continuous-scroll): страница теперь реально скроллится, и без
          этого подпись «Пн Вт Ср…» уезжала вверх вместе с уже пройденными
          неделями — после автоскролла к сегодня её не было видно вовсе.
          top: var(--screen-header-h), НЕ top-0 — тот же приём, что у
          подписей дней в 3-дневном виде DayHours.tsx: второй sticky-элемент
          с тем же top:0, что и ScreenHeader, просто прячется под ней. */}
      <div
        // Без своего -mx-4/px-4: родитель [data-month-grid] уже full-bleed
        // (-mx-4), эта строка просто наследует его ширину как обычный
        // block-потомок — свой -mx-4 здесь удвоил бы отступ.
        className="sticky z-10 grid grid-cols-7 bg-bg pb-1 pt-1"
        style={{ top: "var(--screen-header-h, 0px)" }}
      >
        {WEEKDAYS_SHORT.map((w) => (
          <span key={w} className="text-center text-[10px] text-dim">
            {w}
          </span>
        ))}
      </div>
      {/* Сентинел сверху — рождает подгрузку недель НАЗАД, когда владелец
          скроллит вверх и приближается к текущему началу списка. */}
      <div ref={topSentinelRef} aria-hidden className="h-px" />
      {/* Сетка собирается ПОНЕДЕЛЬНО, а не одним гридом: раскрытый день
          показывает свои задачи полосой, вставленной между его неделей и
          следующей (владелец 19.08.2026: «не надо, чтобы в месяце снизу
          выезжала формочка — между этой неделей и следующей раскрывается
          окно»). Список ПРОСТО скроллится вместе со страницей — общий
          scroll-контейнер, свой вложенный скролл не заводим (страница
          длинная, это и есть вся суть continuous-scroll, 20.08.2026). */}
      <div ref={containerRef} className="flex flex-col">
        {weeks.map((monday, i) => {
          const week = Array.from(
            { length: 7 },
            (_, d) => new Date(addDays(monday, d) + "T00:00:00"),
          );
          const openHere =
            openDay != null && week.some((d) => toDateStr(d) === openDay);
          // Переходная неделя — дни принадлежат двум разным месяцам.
          // Тонкая линия только здесь: Максим 20.08.2026, глядя на
          // Google Calendar-стиль — «небольшая полосочка только
          // появляется, когда месяцы смежные... переходный... чтобы не
          // путаться, тут так она потом исчезает». otherMonth-приглушение
          // (было раньше) больше не имеет смысла: при continuous-scroll
          // нет «одного текущего месяца», к которому дни принадлежат.
          const isTransitionWeek =
            new Set(week.map((d) => d.getMonth())).size > 1;
          return (
            <Fragment key={monday}>
              <div
                className={`grid shrink-0 grid-cols-7 ${
                  isTransitionWeek && i > 0 ? "border-t border-stroke" : ""
                }`}
                style={{ height: MONTH_ROW_H }}
              >
                {week.map((d) => {
                  const ds = toDateStr(d);
                  const tasks = byDate.get(ds) ?? [];
                  const shown = tasks.slice(0, MONTH_CHIP_LIMIT);
                  const rest = tasks.length - shown.length;
                  const isOpen = ds === openDay;
                  return (
                    // div, не button — по той же причине, что и в неделе:
                    // внутри лежат кнопки-плашки.
                    <div
                      key={ds}
                      onClick={() => onDayClick(ds)}
                      className={`flex min-h-0 flex-col items-center gap-[2px] overflow-hidden px-0.5 py-1 text-left ${
                        isOpen ? "rounded-t-lg bg-card" : ""
                      }`}
                    >
                      {/* Число по ЦЕНТРУ ячейки, а не у левого края:
                          владелец 19.08.2026 — «числа отцентруй по
                          ячейкам, чтобы они шли в рядок с днями недели».
                          «Пн» в шапке и все его числа стоят на одной
                          вертикали. */}
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
      <div ref={bottomSentinelRef} aria-hidden className="h-px" />
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
              className="tap-menu flex items-center gap-2 rounded-lg bg-card2 px-2 py-1.5 text-left"
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
  onPrevDay,
  onNextDay,
}: {
  date: string;
  tasks: ApiTask[];
  onTaskClick: (id: string) => void;
  onClose: () => void;
  onPrevDay?: () => void;
  onNextDay?: () => void;
}) {
  const d = new Date(date + "T00:00:00");
  const contentRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const currentXRef = useRef(0);
  const isHorizontalRef = useRef<boolean | null>(null);

  const setOffset = (x: number, animated = false) => {
    currentXRef.current = x;
    if (contentRef.current) {
      contentRef.current.style.transition = animated
        ? "transform 0.28s cubic-bezier(0.2, 0.9, 0.28, 1)"
        : "none";
      contentRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    currentXRef.current = 0;
    isHorizontalRef.current = null;
    isDraggingRef.current = true;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    if (isHorizontalRef.current === null) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        isHorizontalRef.current = Math.abs(dx) > Math.abs(dy);
      }
    }
    if (!isHorizontalRef.current) return;
    let nextX = dx;
    if (Math.abs(nextX) > 80) {
      const over = Math.abs(nextX) - 80;
      nextX = Math.sign(nextX) * (80 + over * 0.35);
    }
    setOffset(nextX, false);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    const target = e.currentTarget as HTMLElement;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {}
    if (!isHorizontalRef.current) {
      setOffset(0, true);
      return;
    }
    const dx = currentXRef.current;
    if (Math.abs(dx) >= 60 && (onPrevDay || onNextDay)) {
      if (typeof window !== "undefined" && (window as any).Capacitor) {
        import("@capacitor/haptics").then(({ Haptics, ImpactStyle }) => {
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
        });
      }
      const dir = dx < 0 ? -1 : 1;
      const targetW = target.clientWidth || 360;
      setOffset(dir * targetW * 0.35, true);
      setTimeout(() => {
        if (dx < 0 && onNextDay) onNextDay();
        else if (dx > 0 && onPrevDay) onPrevDay();
        setOffset(0, false);
      }, 120);
    } else {
      setOffset(0, true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] w-full overflow-hidden rounded-t-2xl bg-card p-4 select-none"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ touchAction: "pan-y" }}
      >
        <div ref={contentRef} style={{ willChange: "transform" }}>
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
            <div className="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto">
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
