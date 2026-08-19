import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { ApiTask } from "../api/types";
import { Icon } from "./UI";

// ═══════════ Календарная развёртка по часам — 1 или 3 дня ═══════════
//
// 19.08.2026, второй заход. Первая версия (18.08.2026) была виджетом
// внутри страницы (rounded-2xl bg-card, потолок высоты 58vh) — владелец
// прислал скриншоты Apple Reminders («Сегодня» и «Предстоящее», у второго
// та же сетка на 3 колонки дня) и попросил именно так: полноэкранная
// сетка без рамки-карточки, задача — сплошная цветная плашка, а не серый
// блок с полоской. Числа сняты замером присланных PNG (пипетка +
// сканирование границ, скилл pixel-copy-from-screenshot), экран владельца
// 1260×2736 @3x = 420×912pt:
//
//   левая колонка часов        161px → 53.67pt
//   ширина колонки дня         366px → 122pt   (161+3×366=1259 ≈ ширина экрана)
//   высота часа                 124px → 41.33pt (12 интервалов сверены, ровно)
//   плашка: почти вся колонка (0px слева, ~6px справа до разделителя),
//     скругление ~17px→5.7pt, сплошная заливка цветом проекта, полый
//     кружок-маркер слева (~23px→7.7pt), текст белый в одну строку
//   линия «сейчас»: точка ~27px→9pt, сама линия — через ВСЕ колонки разом
//   часовая линия начинается ровно на границе первой колонки (x=161) —
//     под подписями часов линии нет вообще, поэтому не нужен трюк с
//     bg-card «заплаткой» под текстом, который был в первой версии
//
// Час стал заметно компактнее (было 64px произвольных, стало 41.33px по
// замеру) — но с полным диапазоном 0–23 (не 6–23, ниже) общая высота
// сетки почти не меняется, а 30-минутная задача высотой ~19pt у Apple на
// скриншоте читается нормально.
//
// 24 часа, не 6–23: старый диапазон был произвольным (первая версия
// просто решила, что раньше 6 утра дел не бывает) и прятал баг — задача
// в 3 часа ночи получала top=0 и наезжала на 6-часовую строку. Полный
// диапазон устраняет это заодно.
const HOUR_H = 124 / 3; // дробное значение снято замером — законно, см. выше
const HOURS = Array.from({ length: 24 }, (_, i) => i);
// Строки сетки идут ДАЛЬШЕ 23:00 — часами следующих суток (00:00, 01:00,
// …). Владелец 19.08.2026: «таблица заканчивается на 23:00, а ниже пустое
// место и кнопка — напиши 00:00 и чёрточку, потом час ночи, насколько
// хватает; ну или хотя бы просто таблицу дорисуй, чтобы не было пустого
// места».
//
// Сколько именно — считает gridHours ниже, по высоте окна: на телефоне
// сутки и так выше экрана, там хватает одной замыкающей строки «00:00»
// (без неё у часа 23 не было нижней границы, и последняя строка висела
// открытой над пустотой); на высоком экране добавляется столько, чтобы
// расчерченным был весь низ.
//
// Строки за пределами суток чисто декоративные: задачу туда не поставить
// — timeFromOffset зажимает время сутками, перетаскивание за 23:45 не
// уедет.
//
// Подпись строки: после суток счёт идёт по кругу — 24 → «00:00».
const hourLabel = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
const GUTTER_W = 161 / 3; // левая колонка с подписями часов
// Шаг привязки при перетаскивании. 15 минут — как в форме: попадать
// пальцем в минуту на шкале высотой ~41px/час невозможно, а «ровные»
// четверти часа и так покрывают почти все реальные планы.
const SNAP_MIN = 15;
// Высота, в которую гарантированно влезает одна строка 12px-текста с
// отступами — не хвост от старой шкалы 64px, а низ, ниже которого плашку
// просто нечем будет читать.
const MIN_H = 24;
// Правый отступ плашки от границы колонки и зазор между плашками одного
// часа — оба сняты тем же замером (одиночная плашка 162→521 при колонке
// 161→527, то есть 6px свободных справа).
const RIGHT_INSET = 6;
const COL_GAP = 3;

/** «14:30» → 14.5; неразобранное время → null, блок просто не рисуется. */
function hoursFromTime(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h + m / 60;
}

/** Смещение в пикселях от верха сетки → «ЧЧ:ММ», округлённое до SNAP_MIN. */
function timeFromOffset(px: number): string {
  const raw = (px / HOUR_H) * 60;
  const snapped = Math.round(raw / SNAP_MIN) * SNAP_MIN;
  const clamped = Math.min(Math.max(snapped, 0), HOURS.length * 60 - SNAP_MIN);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

/** «Чт 20» — подпись колонки дня в 3-дневном виде, как в присланном скрине. */
function formatDayColumnLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()}`;
}

/** Линия текущего времени — через ВСЕ колонки разом, не по одной на день.
 *  Отдельным компонентом со своим таймером — иначе она замерла бы на
 *  времени последнего рендера всего экрана. */
function NowLine() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Минуты достаточно: линия двигается на пиксель с небольшим —
    // чаще перерисовывать нечего, а таймер на секундах будил бы экран зря.
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const pos = now.getHours() + now.getMinutes() / 60;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
      style={{ top: pos * HOUR_H }}
    >
      <span
        // bg-bg — не декоративный: когда «сейчас» проходит рядом с
        // часовой отметкой (найдено на первом же тестовом скриншоте,
        // 19.08.2026), обе подписи оказываются почти в одной точке и без
        // непрозрачного фона превращаются в нечитаемую кашу из букв.
        className="shrink-0 bg-bg py-px pr-1.5 text-right text-[10px] font-medium text-red tabular-nums"
        style={{ width: GUTTER_W }}
      >
        {String(now.getHours()).padStart(2, "0")}:
        {String(now.getMinutes()).padStart(2, "0")}
      </span>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-red" />
      <span className="h-[1.5px] flex-1 bg-red" />
    </div>
  );
}

/** Строка задачи без времени — её и тащат на шкалу. Только у 1-дневного
 *  вида: в 3-дневном непонятно, в какой из трёх колонок её кидать. */
function UntimedRow({
  task,
  color,
  onClick,
  first,
}: {
  task: ApiTask;
  color: string;
  onClick: () => void;
  first: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/[0.04] ${
        first ? "" : "border-t border-stroke"
      } ${isDragging ? "opacity-40" : ""}`}
      // touch-action: none обязателен для перетаскивания пальцем — без
      // него браузер считает жест прокруткой и до dnd-kit он не доходит.
      style={{ touchAction: "none" }}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[14px] ${
          task.status === "completed" ? "text-sub line-through" : "text-text"
        }`}
      >
        {task.title}
      </span>
      <Icon name="grip" size={14} className="shrink-0 text-dim" />
    </div>
  );
}

/** Плашка задачи внутри сетки — сплошная заливка цветом проекта, полый
 *  кружок-маркер и белый текст, как на присланном скрине Apple Reminders.
 *  Белый текст читается на всех 7 цветах палитры проектов (замер
 *  перцептивной яркости заливки — от 113 до 173 из 255, весь диапазон
 *  темнее белого текста с запасом) — отдельная логика «светлый/тёмный
 *  текст по цвету» не понадобилась. В 1-дневном виде ещё и перетаскивается
 *  (draggable=true), в 3-дневном — только открывается тапом. */
function TimedBlock({
  task,
  color,
  top,
  height,
  left,
  width,
  durKnown,
  draggable,
  onClick,
}: {
  task: ApiTask;
  color: string;
  top: number;
  height: number;
  left: string;
  width: string;
  durKnown: boolean;
  draggable: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !draggable,
  });
  const done = task.status === "completed";
  return (
    <div
      ref={setNodeRef}
      {...(draggable ? attributes : null)}
      {...(draggable ? listeners : null)}
      onClick={onClick}
      className="absolute flex items-center gap-1.5 overflow-hidden rounded-[6px] px-2 text-left"
      style={{
        top,
        height,
        left,
        width,
        backgroundColor: color,
        touchAction: draggable ? "none" : undefined,
        opacity: isDragging ? 0.4 : done ? 0.5 : 1,
        // Конец не задан — низ плашки размыт, чтобы он не читался как
        // «задача точно кончится здесь».
        ...(durKnown
          ? null
          : {
              maskImage: "linear-gradient(to bottom, #000 60%, transparent)",
              WebkitMaskImage:
                "linear-gradient(to bottom, #000 60%, transparent)",
            }),
      }}
    >
      <Icon name="circle" size={9} className="shrink-0 text-white/85" />
      <span
        className={`min-w-0 flex-1 truncate text-[12px] font-medium text-white ${
          done ? "line-through opacity-70" : ""
        }`}
      >
        {task.title}
      </span>
    </div>
  );
}

/** Один интервал времени задачи — вход для раскладки по колонкам. */
interface TimedItem {
  task: ApiTask;
  start: number;
  end: number;
  durKnown: boolean;
}

interface PlacedBlock {
  task: ApiTask;
  top: number;
  height: number;
  left: string;
  width: string;
  durKnown: boolean;
}

/** Раскладывает задачи одного дня по вертикали и, при коллизиях по
 *  времени, по колонкам side-by-side — как три плашки «З… 1… С…» в
 *  присланном скрине на 06:00–07:00. Пересекающиеся задачи транзитивно
 *  собираются в кластер (A∩B и B∩C делают A,B,C одним кластером, даже
 *  если A и C не пересекаются напрямую), внутри кластера — жадная
 *  раскладка: очередная задача идёт в первую колонку, где предыдущая уже
 *  закончилась к её началу. */
function layoutDay(tasks: ApiTask[]): PlacedBlock[] {
  const items: TimedItem[] = tasks
    .filter((t) => hoursFromTime(t.start_time) !== null)
    .map((t) => {
      const start = hoursFromTime(t.start_time)!;
      const durKnown = t.duration_min != null;
      const dur = t.duration_min ?? 30;
      return { task: t, start, end: start + dur / 60, durKnown };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const placed: PlacedBlock[] = [];
  let cluster: TimedItem[] = [];
  let clusterEnd = -Infinity;

  function flush() {
    if (cluster.length === 0) return;
    const colEnds: number[] = [];
    const colOf: number[] = [];
    cluster.forEach((item) => {
      let col = colEnds.findIndex((end) => end <= item.start);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(item.end);
      } else {
        colEnds[col] = item.end;
      }
      colOf.push(col);
    });
    const cols = colEnds.length;
    const totalGap = (cols - 1) * COL_GAP;
    const widthExpr = `calc((100% - ${RIGHT_INSET}px - ${totalGap}px) / ${cols})`;
    cluster.forEach((item, i) => {
      const col = colOf[i];
      placed.push({
        task: item.task,
        top: Math.max(0, item.start * HOUR_H + 1),
        height: Math.max(MIN_H, (item.end - item.start) * HOUR_H - 3),
        left:
          col === 0
            ? "0px"
            : `calc(${widthExpr} * ${col} + ${col * COL_GAP}px)`,
        width: widthExpr,
        durKnown: item.durKnown,
      });
    });
    cluster = [];
  }

  for (const item of items) {
    if (cluster.length > 0 && item.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return placed;
}

export interface DayColumnData {
  date: string;
  tasks: ApiTask[];
  isToday: boolean;
}

export function DayHours({
  days,
  projectColor,
  onTaskClick,
  onSchedule,
}: {
  days: DayColumnData[];
  /** Цвет блока в сетке берётся от ПРОЕКТА задачи, не из отдельной
   *  палитры: одна и та же задача в списке и в сетке не должна быть
   *  разного цвета. */
  projectColor: (task: ApiTask) => string;
  onTaskClick: (id: string) => void;
  /** Задачу перетащили на шкалу — назначить ей это время. Только у
   *  1-дневного вида, см. комментарий у UntimedRow. */
  onSchedule?: (id: string, time: string) => void;
}) {
  const interactive = days.length === 1 && !!onSchedule;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Высота окна — от неё зависит, сколько часовых строк дорисовать после
  // суток, чтобы низ экрана не оставался пустым (см. gridHours ниже).
  const [viewH, setViewH] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  useEffect(() => {
    const onResize = () => setViewH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Сутки + замыкающая полночь + столько часов следующего дня, сколько
  // нужно, чтобы сетка была не короче экрана. Высота контейнера ниже
  // равна позиции ПОСЛЕДНЕЙ строки — тогда она приходится ровно на нижний
  // край, и пустого фона под таблицей не остаётся вовсе.
  const gridHours = useMemo(() => {
    const extra = Math.max(
      0,
      Math.ceil((viewH - HOURS.length * HOUR_H) / HOUR_H),
    );
    return Array.from({ length: HOURS.length + extra + 1 }, (_, i) => i);
  }, [viewH]);
  const gridSpan = gridHours[gridHours.length - 1];
  const [dragging, setDragging] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Мышь/палец начинают тащить только после 6px — иначе обычный тап по
  // строке превращался бы в микро-перетаскивание и не открывал задачу.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const untimed = useMemo(
    () =>
      interactive
        ? days[0].tasks.filter((t) => hoursFromTime(t.start_time) === null)
        : [],
    [interactive, days],
  );

  const columns = useMemo(
    () => days.map((d) => ({ day: d, blocks: layoutDay(d.tasks) })),
    [days],
  );
  const anyTimed = columns.some((c) => c.blocks.length > 0);
  const showNowLine = days.some((d) => d.isToday);

  // Прокрутка к текущему часу при открытии — иначе экран открывается на
  // полночь, а человек смотрит день в середине дня. 120px запаса сверху,
  // чтобы было видно, что было прямо перед «сейчас».
  //
  // scrollIntoView на невидимом якоре, а не свой scrollTop: своего
  // скролл-контейнера у сетки больше нет (см. комментарий у -mx-4 ниже —
  // «обрывается, не доходит до низа» лечилось именно снятием вложенного
  // overflow-y-auto), сетка теперь часть обычного потока страницы.
  // scrollIntoView сам находит ближайшего скроллящегося предка — не нужно
  // знать заранее, какой именно div сейчас крутится (мобильная и
  // десктопная ветки Layout.tsx устроены по-разному).
  const nowAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showNowLine || !nowAnchorRef.current) return;
    const now = new Date();
    const pos = now.getHours() + now.getMinutes() / 60;
    nowAnchorRef.current.style.top = `${Math.max(0, pos * HOUR_H - 120)}px`;
    nowAnchorRef.current.scrollIntoView({ block: "start" });
  }, [showNowLine]);

  function handleDragStart(e: DragStartEvent) {
    setDragging(String(e.active.id));
  }

  // Y-координата пальца/курсора ПРЯМО СЕЙЧАС: activatorEvent — где он был
  // в момент, когда взяли строку, delta.y — на сколько сдвинулся с тех
  // пор (dnd-kit копит эту дельту сам). Считать нужно именно так, а НЕ по
  // верхнему краю перетаскиваемого блока (rect.current.translated.top,
  // как было раньше) — тот сдвигается на ту же дельту от СВОЕГО исходного
  // верха, и если строку взяли не за самый её верх (а палец обычно
  // попадает в середину), результат промахивается ровно на эту разницу:
  // палец наведён на 10:00, а получившийся верх блока — на 09:30. Найдено
  // 19.08.2026 живым тестом (Playwright: цель 10:00 → сохранилось 09:30,
  // разница ровно в половину высоты строки-источника).
  function pointerY(e: {
    activatorEvent: Event;
    delta: { y: number };
  }): number | null {
    const ev = e.activatorEvent as
      PointerEvent | MouseEvent | (Event & { touches?: TouchList });
    const clientY =
      "clientY" in ev
        ? (ev as PointerEvent | MouseEvent).clientY
        : ev.touches?.[0]?.clientY;
    return typeof clientY === "number" ? clientY + e.delta.y : null;
  }

  function handleDragEnd(e: DragEndEvent) {
    setDragging(null);
    setPreview(null);
    const grid = gridRef.current;
    if (!grid || !onSchedule) return;
    // Колонка здесь всегда одна (interactive===true только при
    // days.length===1), поэтому горизонталь роли не играет — важна
    // только высота.
    const y = pointerY(e);
    if (y == null) return;
    const offset = y - grid.getBoundingClientRect().top;
    // Отпустили выше сетки (например, обратно в список) — не трогаем.
    if (offset < -HOUR_H) return;
    onSchedule(String(e.active.id), timeFromOffset(offset));
  }

  function handleDragMove(e: { activatorEvent: Event; delta: { y: number } }) {
    const grid = gridRef.current;
    const y = pointerY(e);
    if (!grid || y == null) return;
    const offset = y - grid.getBoundingClientRect().top;
    setPreview(offset < -HOUR_H ? null : timeFromOffset(offset));
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragging(null);
        setPreview(null);
      }}
    >
      <div className="mt-2 flex flex-col gap-3">
        {/* Задачи без времени — НАД сеткой: их перетаскивают вниз на
            шкалу, и держать их под ней значило бы тащить через весь
            экран. Только у 1-дневного вида (см. DayHours.interactive). */}
        {untimed.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 px-1">
              <Icon name="list" size={13} className="text-dim" />
              <span className="text-[13px] font-semibold text-sub">
                Без времени — {untimed.length}
              </span>
              <span className="ml-auto text-[11px] text-dim">
                перетащите на шкалу
              </span>
            </div>
            <div className="overflow-hidden rounded-2xl bg-card">
              {untimed.map((t, i) => (
                <UntimedRow
                  key={t.id}
                  task={t}
                  color={projectColor(t)}
                  first={i === 0}
                  onClick={() => !dragging && onTaskClick(t.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* -mx-4 full-bleed: сетка идёт от края до края экрана, как на
            присланном скрине, а не карточкой внутри страничных полей
            (родитель — TodayScreen, px-4). Тот же приём, что у полосы
            свайпа TaskRow и у доски TaskBoard.
            БЕЗ своего max-h/overflow-y-auto (было max-h-[68vh] — владелец
            19.08.2026: «таблица обрывается, не доходит до низа экрана»,
            дальше пустой фон до кнопки-веера). Страница уже сама
            скроллится целиком (Layout.tsx, flex-1 overflow-y-auto) — тут
            нужен был не второй вложенный скролл-регион, а обычный поток
            страницы, как у списка/доски. */}
        <div className="-mx-4">
          <div ref={scrollRef} className="relative">
            {/* Подписи дней — только в 3-дневном виде, и «прилипают»
                к верху при прокрутке: у Apple на «Предстоящем» они видны
                всегда, крутится только сама сетка часов. top:0 здесь БЫЛ
                БАГОМ (живой тест 19.08.2026): свой скролл-контейнер убран
                (см. -mx-4 выше), эта строка стала sticky относительно
                ВСЕЙ страницы — той же containing block, что и ScreenHeader
                (тоже sticky top:0, z-20 выше). Два top:0 подряд НЕ
                складывают отступы сами — при прокрутке эта строка
                садилась ровно НА ScreenHeader и пряталась под ним целиком
                (getBoundingClientRect подтвердил: top=0 у обеих, ниже
                z-index проигрывает). top берётся из --screen-header-h
                (UI.tsx, usePublishHeaderHeight — измеряет реальную
                высоту шапки, а не константа: large/compact разной
                высоты). */}
            {days.length > 1 && (
              <div
                className="sticky z-10 flex items-center bg-bg pb-2"
                style={{ top: "var(--screen-header-h, 0px)" }}
              >
                <span className="shrink-0" style={{ width: GUTTER_W }} />
                {days.map((d) => (
                  <span
                    key={d.date}
                    className={`flex-1 text-center text-[12px] font-semibold ${
                      d.isToday ? "text-red" : "text-sub"
                    }`}
                  >
                    {formatDayColumnLabel(d.date)}
                  </span>
                ))}
              </div>
            )}

            {/* Высота — ровно до последней часовой строки (gridSpan), а не
                «сутки + 8px», как было: тот хвост и был тем пустым местом
                под 23:00, из-за которого таблица выглядела оборванной. */}
            <div
              ref={gridRef}
              className="relative flex"
              style={{ height: gridSpan * HOUR_H }}
            >
              {/* Левая колонка — только подписи часов, без линии под
                  ними: у Apple часовая линия начинается ровно на границе
                  первой колонки дня, а не под цифрами. */}
              <div className="relative shrink-0" style={{ width: GUTTER_W }}>
                {gridHours.map((h) => (
                  <span
                    key={h}
                    className="absolute right-1.5 -translate-y-1/2 text-[10px] font-medium text-dim tabular-nums"
                    style={{ top: h * HOUR_H }}
                  >
                    {hourLabel(h)}
                  </span>
                ))}
              </div>

              {columns.map(({ day, blocks }) => (
                <div
                  key={day.date}
                  className="relative min-w-0 flex-1 border-l border-stroke"
                >
                  {gridHours.map((h) => (
                    <div
                      key={h}
                      className="absolute left-0 right-0 border-t border-stroke"
                      style={{ top: h * HOUR_H }}
                    />
                  ))}

                  {/* Подсказка времени под пальцем — только в
                      1-дневном виде, единственной колонке. */}
                  {interactive && preview && day.isToday && (
                    <div
                      className="pointer-events-none absolute left-0 right-0 z-30 flex items-center gap-2"
                      style={{
                        top:
                          (Number(preview.split(":")[0]) +
                            Number(preview.split(":")[1]) / 60) *
                          HOUR_H,
                      }}
                    >
                      <span className="w-[46px] shrink-0 pr-1.5 text-right text-[10px] font-semibold text-red tabular-nums">
                        {preview}
                      </span>
                      <span className="h-[2px] flex-1 rounded bg-red/70" />
                    </div>
                  )}

                  {blocks.map((b) => (
                    <TimedBlock
                      key={b.task.id}
                      task={b.task}
                      color={projectColor(b.task)}
                      top={b.top}
                      height={b.height}
                      left={b.left}
                      width={b.width}
                      durKnown={b.durKnown}
                      draggable={interactive}
                      onClick={() => !dragging && onTaskClick(b.task.id)}
                    />
                  ))}
                </div>
              ))}

              {showNowLine && (
                <>
                  {/* Невидимый якорь для автопрокрутки — своей top ставит
                      эффект выше (imperatively, до scrollIntoView), а не
                      через рендер: позиция нужна только В МОМЕНТ монтажа,
                      заводить под неё state ради одного эффекта незачем. */}
                  <div
                    ref={nowAnchorRef}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 right-0 h-px"
                  />
                  <NowLine />
                </>
              )}
            </div>
          </div>
        </div>

        {interactive && !anyTimed && (
          <p className="px-1 text-center text-[12px] text-dim">
            На время пока ничего не назначено
          </p>
        )}
      </div>
    </DndContext>
  );
}
