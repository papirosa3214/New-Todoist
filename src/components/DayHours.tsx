import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { ApiTask } from "../api/types";
import { PRIORITIES } from "../lib/priority";
import {
  hapticCross,
  hapticDrop,
  hapticGrab,
  hapticNotch,
} from "../lib/haptics";
import { useTapGuard } from "../lib/useTapGuard";
import { Icon, findScrollContainer } from "./UI";

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
// Подписи есть только у суток, и последняя из них — «24:00»: это потолок
// шкалы, дальше поставить уже нечего (Максим 19.08.2026: «крайний час
// должен быть 24:00, это прям потолок, туда я уже ничего поставить не
// могу, а остальное просто фон идёт»). Добавочные секции ниже подписей не
// получают вовсе.
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
/** Подпись часа с зацикливанием суток: −1 → «23:00», 25 → «01:00». Ровно
 *  24 остаётся «24:00» — это замыкающая строка самих суток, а не час
 *  следующих. Нужно продолжению шкалы за пределы дня. */
const cycleLabel = (h: number) =>
  hourLabel(h === 24 ? 24 : ((h % 24) + 24) % 24);
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
// Сколько часовых секций дорисовано ПОСЛЕ суток — просто картинка,
// продолжение сетки часами следующего дня (00:00, 01:00 …). Владелец
// 19.08.2026: «просто пять секций добавить». Задачу туда не поставить —
// timeFromOffset по-прежнему зажимает время сутками.
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

/** Подписи дней для 3-дневного вида — отдельным компонентом, потому что
 *  рендерятся не внутри сетки, а внутри шапки экрана (ScreenHeader.below,
 *  см. TodayScreen). Геометрия обязана совпадать с сеткой: пустая ячейка
 *  шириной GUTTER_W под колонку с часами, дальше равные доли — те же, по
 *  которым фон рисует вертикали. `-mx-4` компенсирует поля шапки: сетка
 *  идёт от края до края экрана, значит и подписи над ней тоже. */
export function DayColumnsHeader({ days }: { days: DayColumnData[] }) {
  return (
    // bg-bg — сплошной, а не стекло: шапка выше затухает и сквозь неё
    // контент виден намеренно, но на самой строке дат просвечивающие
    // цифры часов читались как грязь рядом с «Ср 19». Плотная подложка
    // здесь и делает то, о чём просил Максим: контент уходит ПОД даты, и
    // затухание начинается от их кромки.
    <div className="-mx-4 flex items-center bg-bg pb-2 pt-1">
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
  );
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
      // z-10, НЕ z-20: у ScreenHeader (UI.tsx) ровно z-20, и при равном
      // числе выигрывает тот, кто позже в DOM — то есть эта линия
      // рисовалась поверх шапки. Пока шапка была непрозрачной плашкой,
      // это выглядело просто странно; со стеклянной (19.08.2026) красная
      // черта с подписью откровенно поехала поверх заголовка экрана.
      // -translate-y-1/2 — по той же причине, что у подсказки времени при
      // перетаскивании: без него на отметке времени стоял ВЕРХ строки, а
      // не её середина, и линия «сейчас» вместе с подписью сидела на 8.5px
      // ниже своего времени (замер 19.08.2026: 19:39 показывалась на
      // 820.7px от верха сетки при расчётных 812.2). Подписи часов слева
      // центрируются именно так, поэтому и красное должно.
      className="pointer-events-none absolute left-0 right-0 z-10 flex -translate-y-1/2 items-center"
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

/** Плашка задачи без времени — её и тащат на шкалу, на любую из отображённых
 *  колонок дня (1 или 3 — см. комментарий у DayHours.onSchedule, 20.08.2026).
 *
 *  Отдельная карточка, а не строка общего списка: заголовок пула и его
 *  подложка убраны (19.08.2026), и плашки теперь просто плавают над
 *  сеткой. Раз подписи «Без времени» больше нет, вся ориентировка — на
 *  самой плашке, поэтому здесь появились проект и приоритет: владелец в
 *  той же реплике — «совсем грустно, когда нет никакой информации, я не
 *  понимаю, к чему она вообще относится; хотя бы символы добавь». */
function UntimedRow({
  task,
  first,
  onClick,
}: {
  task: ApiTask;
  /** Первой строке разделитель сверху не нужен. */
  first: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  const priority = PRIORITIES.find((p) => p.key === task.priority);
  // Низкий приоритет (P4) — значение по умолчанию, флажок для него не
  // рисуем: он был бы у большинства задач и перестал бы что-либо значить.
  // Тот же порядок, что в карточке задачи.
  const showFlag = !!task.priority && task.priority <= 3;
  const subtasks = task.subtasks ?? [];
  const doneSubtasks = subtasks.filter((s) => s.done).length;
  // Клик — только настоящий тап: после завершённого drag браузер шлёт
  // синтетический click, и без гарда каждое перетаскивание заканчивалось
  // бы открытием задачи (тот же приём, что у карточек доски).
  const tap = useTapGuard(onClick);
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      {...tap}
      className={`flex w-full select-none items-center gap-2 pl-3 text-left active:bg-white/[0.04] ${
        first ? "" : "border-t border-stroke"
      } ${isDragging ? "opacity-30" : ""}`}
      style={{
        // Выделение текста при удержании — прямая жалоба владельца
        // 19.08.2026 («если я зажимаю это событие, чтобы у меня не
        // выделялся текст»): длинное нажатие на телефоне выделяет слово и
        // поднимает лупу с меню «Копировать», и перетаскивание начинается
        // уже поверх этого. select-none в классе гасит выделение,
        // WebkitTouchCallout — само меню (у Tailwind свойства для него
        // нет).
        //
        // Ручка-грип убрана (Максим 26.08.2026: «зажал и подтащил», точки
        // убрать везде) — слушатели drag теперь на всей строке. Скролл
        // пула это не ломает: сенсор общий на весь экран (см. sensors),
        // палец с движением сразу — прокрутка, удержание 200мс — захват.
        // touchAction: manipulation, не none — иначе строка перестала бы
        // пролистываться вовсе.
        touchAction: "manipulation",
        WebkitTouchCallout: "none",
      }}
    >
      {/* Порядок задан владельцем 19.08.2026: сначала флажок, потом
          счётчик шагов, потом название — и всё в ОДНУ узкую строку. Ни
          подписи приоритета рядом с флажком («флажок, а потом ещё и P1 —
          зачем дублировать»), ни имени проекта: «не надо всю информацию
          запихивать во все представления, здесь коротенькая заметочка —
          глянул, понял; надо подробнее — провалился в задачу». */}
      {showFlag && (
        <Icon
          name="flag"
          size={12}
          className="shrink-0"
          style={{ color: priority?.color }}
          aria-label={`Приоритет: ${priority?.name ?? ""}`}
        />
      )}
      {subtasks.length > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-dim">
          {doneSubtasks}/{subtasks.length}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 truncate py-1.5 pr-3 text-[13px] ${
          task.status === "completed" ? "text-sub line-through" : "text-text"
        }`}
      >
        {task.title}
      </span>
      {/* Ручка-грип убрана (26.08.2026) — тащат всю строку удержанием,
          см. комментарий у style выше. pr-3 на названии возвращает правый
          отступ, который раньше давал px-4 ручки. */}
    </div>
  );
}

// Текст на цветной плашке — ТЁМНЫЙ, не белый (19.08.2026, аудит WCAG).
// Замер контраста белого на палитре проектов: sage 2.07, teal 2.06, pink
// 2.10, orange 2.12, purple 2.86, blue 2.90 — норма 4.5 не бралась нигде,
// проходил только красный (4.08, и то впритык). Тот же текст тёмным даёт
// 6.35–8.93. Прежнее обоснование в DESIGN.md §9 («перцептивная яркость
// заливки 113–173 из 255») считало не ту величину: WCAG смотрит на
// относительную яркость и отношение, а не на абсолютную светлоту.
const CHIP_INK = "#141414";

/** Плашка задачи внутри сетки — сплошная заливка цветом проекта, полый
 *  кружок-маркер и белый текст, как на присланном скрине Apple Reminders.
 *  Белый текст читается на всех 7 цветах палитры проектов (замер
 *  перцептивной яркости заливки — от 113 до 173 из 255, весь диапазон
 *  темнее белого текста с запасом) — отдельная логика «светлый/тёмный
 *  текст по цвету» не понадобилась. Перетаскивается (draggable=true) в
 *  обоих видах — 1-дневном и 3-дневном (20.08.2026, было только в первом). */
function TimedBlock({
  task,
  color,
  top,
  height,
  left,
  width,
  durKnown,
  draggable,
  hidden,
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
  /** Задачу тащат прямо сейчас, и вместо неё по сетке едет DragGhost —
   *  саму плашку на её старом месте не рисуем совсем. Флаг приходит
   *  снаружи, а не берётся из isDragging: пока палец занесён выше сетки
   *  (задачу возвращают в пул) призрака нет, и в этот момент плашка обязана
   *  остаться видимой, иначе она просто пропадает без следа. */
  hidden: boolean;
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
      className="absolute flex select-none flex-col items-stretch justify-start gap-y-0 overflow-hidden rounded-[6px] px-2 py-1 text-left"
      style={{
        top,
        height,
        left,
        width,
        backgroundColor: color,
        // manipulation, а не none — см. комментарий у sensors: палец
        // прокручивает день прямо с плашки, а тащит её по удержанию.
        touchAction: draggable ? "manipulation" : undefined,
        WebkitTouchCallout: draggable ? "none" : undefined,
        // Раньше здесь был opacity:hidden?0:isDragging?0.35:done?0.5:1 —
        // от него задача «моргала тык-тык» (Максим 26.08.2026):
        // полупрозрачная плашка рисовалась НА СТАРОМ МЕСТЕ каждый кадр,
        // пока сверху ехал свой DragGhost. Два слоя перерисовывались
        // на каждый mousemove, и при смене веток условий (hidden ↔
        // isDragging) плашка дёргалась в прозрачности. С DragOverlay
        // от dnd-kit (см. <DragOverlay> ниже) плашка-источник не нужна
        // совсем: прячем её visibility:hidden, а над сеткой едет ОДИН
        // нативный overlay-элемент из body, через CSS-translate3d, без
        // React-рендера на каждом пикселе.
        visibility: hidden || isDragging ? "hidden" : "visible",
        opacity: done ? 0.5 : 1,
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
      {/* Кружок-маркер убран (Максим 26.08.2026): неактивный декор, ничего
          не делает, а место в узкой плашке отнимает. */}
      <span
        style={{
          color: CHIP_INK,
          // Сколько строк влезет в плашку: высота минус вертикальные
          // паддинги (py-1 = 4+4=8), делим на высоту строки 16px.
          // Получаем 1 строку для 24px (минимальная плашка), 2 для 40px,
          // 3 для 56px и т.д. — текст заполняет плашку переносами, а не
          // висит одной строкой по центру. Огромные описания всё равно
          // обрезаются, чтобы не вылезать за пределы (Максим
          // 26.08.2026: «почему нельзя эту задачу, текст в эту плашку
          // прям с переносами всю запихать»).
          WebkitLineClamp: Math.max(1, Math.floor((height - 8) / 16)),
        }}
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-[16px] font-medium [display:-webkit-box] [-webkit-box-orient:vertical] overflow-hidden ${
          done ? "line-through opacity-70" : ""
        }`}
      >
        {task.title}
      </span>
    </div>
  );
}

/** Плашка, которая едет по сетке, пока задачу тащат, — и есть весь отклик
 *  на перетаскивание. До 19.08.2026 его не было вовсе: источник бледнел на
 *  своём месте, а под пальцем двигалась одна красная черта (владелец: «как
 *  это кустарно смотрится»). Замер того захода: ни одного элемента с
 *  transform во время перетаскивания.
 *
 *  Едет она НЕ за сырой позицией пальца, а по уже привязанному к четверти
 *  часа времени (preview) — то есть ступеньками, ровно туда, где задача и
 *  окажется после отпускания. Обещание совпадает с результатом, отдельная
 *  «линия намерения» и «блок» не разъезжаются на пол-шага.
 *
 *  Отдельным слоем поверх сетки (pointer-events: none), а не подменой
 *  самой плашки: задачу тащат и из пула, где плашки в сетке ещё нет вовсе,
 *  и обе дороги должны выглядеть одинаково. */
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
  onPrevDay,
  onNextDay,
}: {
  days: DayColumnData[];
  /** Цвет блока в сетке берётся от ПРОЕКТА задачи, не из отдельной
   *  палитры: одна и та же задача в списке и в сетке не должна быть
   *  разного цвета. */
  projectColor: (task: ApiTask) => string;
  onTaskClick: (id: string) => void;
  /** Задачу перетащили на шкалу (или на другую колонку дня в 3-дневном
   *  виде) — назначить ей эту дату и время. 20.08.2026: раньше работало
   *  только в 1-дневном виде («в 3-дневном непонятно, в какую из трёх
   *  колонок кидать») — Максим прямо попросил снять это ограничение:
   *  «точно так же, как в одном дне, только между днями тоже должны
   *  ездить». Дата всегда та колонка, куда отпустили, даже если у задачи
   *  уже была другая (человек явно переносит её на другой день). */
  onSchedule?: (id: string, date: string, time: string) => void;
  onPrevDay?: () => void;
  onNextDay?: () => void;
}) {
  const interactive = !!onSchedule;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const isHorizontalSwipeRef = useRef<boolean | null>(null);
  const isSwipeDraggingRef = useRef(false);
  const swipeStartXRef = useRef(0);
  const swipeStartYRef = useRef(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    swipeStartXRef.current = e.clientX;
    swipeStartYRef.current = e.clientY;
    isHorizontalSwipeRef.current = null;
    isSwipeDraggingRef.current = true;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isSwipeDraggingRef.current) return;
    const dx = e.clientX - swipeStartXRef.current;
    const dy = e.clientY - swipeStartYRef.current;
    if (isHorizontalSwipeRef.current === null) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        isHorizontalSwipeRef.current = Math.abs(dx) > Math.abs(dy) * 1.3;
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isSwipeDraggingRef.current) return;
    isSwipeDraggingRef.current = false;
    if (!isHorizontalSwipeRef.current) return;
    const dx = e.clientX - swipeStartXRef.current;
    if (Math.abs(dx) >= 45) {
      hapticNotch();
      if (dx < 0 && onNextDay) onNextDay();
      else if (dx > 0 && onPrevDay) onPrevDay();
    }
  };
  // Хвоста сетки под кнопку здесь больше нет (был до 19.08.2026: сетке
  // добавлялась высота нижнего отступа страницы, погашенная отрицательным
  // margin, чтобы линии-элементы доходили под кнопку-веер). Его работу
  // целиком делает фон контейнера прокрутки — и делает лучше: полосы не
  // кончаются вообще нигде. Заодно ушла неверная строка «прокрутку не
  // удлиняет»: замером 19.08.2026 показано, что торчащий вниз слой в
  // прокручиваемую область как раз попадает.

  // Полная высота сетки вместе с хвостом под кнопкой — и подписи часов по
  // ней же, а не по одним суткам (Максим 19.08.2026: «время тоже до конца
  // проставь, там буквально два числа внизу, чтобы всё было технично»).
  // Последняя подпись рисуется, только если помещается целиком: центр
  // строки не ближе 6px к краю, иначе цифра оказалась бы располовиненной.
  // Ровно сутки: последняя строка «24:00» приходится на нижнюю кромку —
  // это потолок шкалы и конец прокрутки. Продолжение сетки ниже — ФОН, оно
  // живёт отдельным слоем и в раскладке не участвует, поэтому прокрутку не
  // удлиняет (владелец 19.08.2026, после трёх моих неудачных попыток
  // лечить это отрицательными отступами: «почему ты не можешь сделать
  // полоски слоем вот этого фона? не таблицу, а фон — визуально будет
  // казаться, что это продолжение таблицы»).
  const totalH = HOURS.length * HOUR_H;
  // Сутки 0…24 плюс продолжение в обе стороны: выше 00:00 идут 23:00,
  // 22:00 — часы предыдущих суток, ниже 24:00 — 01:00, 02:00 следующих.
  // Сколько именно — замеряет эффект с фоном (overscan): вверх по запасу
  // на оттяжку, вниз строго по свободному месту под сеткой, чтобы не
  // удлинить прокрутку.
  const [overscan, setOverscan] = useState({ up: 0, down: 0 });
  const labelHours = useMemo(() => {
    const from = -overscan.up;
    const to = HOURS.length + overscan.down;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }, [overscan]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // После отпускания плашка-источник должна оставаться скрытой, пока
  // React не отрендерит сетку с новыми days (оптимистичный апдейт
  // сделал таск на новом месте). Без этого на одну отрисовку она
  // видна на СТАРОМ месте и на долю секунды «моргает». Сам dragging
  // к этому моменту уже null — React-плашка-источник видна потому,
  // что hidden={b.task.id === dragging || b.task.id === justDropped}. Держим id скрытой плашки в
  // отдельном state, который сбрасывается через 200мс setTimeout.
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const justDroppedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Какая из колонок дня сейчас под пальцем — только у 3-дневного вида
  // это не всегда 0. Отдельный стейт, а не часть preview: preview — это
  // только время (Y), колонка — это X, они меняются по разным осям и
  // разной частоте (короткий вертикальный доводок внутри своего дня не
  // должен пересчитывать горизонталь).

  // Мышь и палец — РАЗНЫМИ сенсорами, и это осознанное отступление от
  // рецепта соседнего файла (TaskBoard: «PointerSensor одного хватает»).
  // Там у карточки есть выделенная ручка перетаскивания, на которой тап и
  // так ничего не значил, — поэтому порога в 4px достаточно. Здесь ручки
  // нет: тащат саму плашку задачи, и она же открывается тапом, и она же
  // лежит на поверхности, которую нужно уметь прокручивать пальцем. Один
  // PointerSensor с порогом по расстоянию заставил бы выбрать одно из двух
  // — либо `touch-action: none` (и тогда палец, начавший движение с
  // плашки, не прокручивает день вообще), либо потерю перетаскивания.
  //
  //   мышь  — порог 4px, как на доске: курсор точный, задержка была бы
  //           только раздражением;
  //   палец — задержка 200мс с допуском 8px: короткий тап открывает
  //           задачу, движение сразу — прокручивает сетку, а удержание
  //           берёт плашку. Ровно тот жест, который владелец и описал
  //           («если я зажимаю это событие… потом мог перетаскивать») и
  //           который стоит в календаре самого телефона.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  // 20.08.2026: раньше только days[0] (единственная колонка 1-дневного
  // вида) — теперь объединение untimed-задач ВСЕХ отображаемых дней сразу
  // (Map по id гасит теоретическое пересечение, каждая задача — свой
  // due_date, дублей быть не должно, но дедуп на всякий случай дёшев).
  // Один общий приклеенный пул, из которого можно кинуть на любую из
  // колонок — та же плитка, что в 1-дневном виде, просто целей для
  // перетаскивания теперь несколько.
  const untimed = useMemo(
    () =>
      interactive
        ? Array.from(
            new Map(
              days
                .flatMap((d) => d.tasks)
                .filter((t) => hoursFromTime(t.start_time) === null)
                .map((t) => [t.id, t] as const),
            ).values(),
          )
        : [],
    [interactive, days],
  );

  const columns = useMemo(
    () => days.map((d) => ({ day: d, blocks: layoutDay(d.tasks) })),
    [days],
  );
  const anyTimed = columns.some((c) => c.blocks.length > 0);
  const showNowLine = days.some((d) => d.isToday);

  // Что именно едет по сетке прямо сейчас. Высота призрака — по
  // длительности задачи, а у той, что ещё лежит в пуле, длительности нет:
  // берём те же 15 минут, которые проставит onSchedule при отпускании
  // (TodayScreen), чтобы призрак был ровно размером с будущую плашку.
  // Snapshot тащимой задачи в REF, а не в state. Ref обновляется
  // СИНХРОННО в onDragStart, до того как dnd-kit смонтирует overlay —
  // первый кадр overlay сразу получает актуальные данные задачи и не
  // «моргает» предыдущим значением (Максим 26.08.2026: «сначала там
  // моргнёт, потом там появится»). В state `dragging` держим только id —
  // нужно для ре-рендера сетки (плашка-источник должна спрятаться).
  const ghostRef = useRef<{
    task: ApiTask;
    height: number;
    width: number;
    colIndex: number;
  } | null>(null);

  // Прокрутка к текущему часу при открытии — иначе экран открывается на
  // полночь, а человек смотрит день в середине дня. 120px запаса сверху,
  // чтобы было видно, что было прямо перед «сейчас».
  //
  // Крутим ИМЕННО найденный контейнер (findScrollContainer), а не
  // scrollIntoView на якоре, как было до 19.08.2026. Причина — живой баг,
  // который поймал Максим: scrollIntoView прокручивает ВСЮ цепочку
  // предков, а прокручивается здесь общий контейнер контента из
  // Layout.tsx — он один на всё приложение и при смене маршрута НЕ
  // размонтируется. Поэтому оставленная сеткой прокрутка переезжала на
  // соседние экраны: замер до фикса — «Входящие» 0 → «Сегодня» 258 →
  // назад «Входящие» 258 → «Предстоящие» 258 из 242 возможных (у него
  // это выглядело как «экран подъехал вверх, верхушка обрезана, внизу
  // борода»). Прежний комментарий объяснял выбор scrollIntoView тем, что
  // «не нужно знать заранее, какой именно div крутится» — findScrollContainer
  // в этом файле и так уже используется (замер хвоста ниже), так что
  // причины держать побочный эффект на всё приложение не было.
  //
  // Возврат в 0 при уходе — по той же причине: сетка чинит за собой
  // прокрутку, которую сама сдвинула, и следующий экран открывается
  // сверху. Не «вернуть как было»: до захода в «Сегодня» там лежит
  // прокрутка ПРЕДЫДУЩЕГО экрана, и восстановление утащило бы её уже на
  // третий экран — тот же баг с другого конца.
  useEffect(() => {
    const grid = gridRef.current;
    if (!showNowLine || !grid) return;
    const sc = findScrollContainer(grid);
    const now = new Date();
    const pos = now.getHours() + now.getMinutes() / 60;
    const gridTop =
      grid.getBoundingClientRect().top -
      sc.getBoundingClientRect().top +
      sc.scrollTop;
    sc.scrollTop = Math.max(0, gridTop + pos * HOUR_H - 120);
    return () => {
      sc.scrollTop = 0;
    };
  }, [showNowLine]);

  // ═══ Полосы — фон прокручиваемого слоя, а не элементы ═══
  //
  // Владелец 19.08.2026: «хочу, чтобы таблица не заканчивалась — такая
  // заставочка, я по ней кручу; а когда кручу-кручу вниз и она обрывается
  // на каких-то значениях, очень стрёмно выглядит». Ровно та просьба, что
  // была ещё в предыдущий заход: «сделай полоски слоем фона, не таблицу».
  //
  // Почему фон именно на КОНТЕЙНЕРЕ ПРОКРУТКИ, а не на сетке: у сетки
  // область покраски заканчивается вместе с её содержимым — прошлый заход
  // на этом и сломался («ниже содержимого фон не рисуется»). У контейнера
  // прокрутки область покраски — вся видимая область, и повторяющийся
  // градиент замощает её целиком при любом положении прокрутки. Кончиться
  // полосам негде.
  //
  // Дотянуть вниз сами элементы-линии нельзя: замер 19.08.2026 — торчащий
  // вниз слой попадает в прокручиваемую область, даже погашенный
  // отрицательным margin (прокрутка выросла с 281 до 1190 px), то есть
  // обрыв не исчезал, а лишь отъезжал и оставался достижимым. Заодно
  // выяснилось, что прежний хвост под кнопку тоже всё это время удлинял
  // прокрутку — комментарий «проматывается ровно сутки» был неверен.
  //
  // `local` — фон привязан к содержимому и едет вместе с ним, поэтому
  // полосы не разъезжаются с подписями часов («желе», отвергнутое
  // владельцем в заходе с фоном на боксе). Фаза берётся от верха сетки:
  // gridTop % HOUR_H — тогда фоновая линия ложится ровно туда, где раньше
  // была граница элемента.
  //
  // Тот же эффект замеряет, на сколько часов продолжить ПОДПИСИ за
  // пределы суток (overscan, объявлен выше): подписи — текст, фоном их не
  // нарисовать.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const sc = findScrollContainer(grid);
    const apply = () => {
      const gridTop =
        grid.getBoundingClientRect().top -
        sc.getBoundingClientRect().top +
        sc.scrollTop;
      const phase = ((gridTop % HOUR_H) + HOUR_H) % HOUR_H;
      // Ширина колонки дня — в пикселях, а не в calc: она задаёт ПЕРИОД
      // повторения вертикалей, а период внутри repeating-градиента в
      // процентах не выразить. Пересчитывается по ResizeObserver ниже.
      const colW = Math.max(
        1,
        (sc.clientWidth - GUTTER_W) / Math.max(1, days.length),
      );
      // Два слоя, оба 1px цветом --color-stroke — теми же, какими были
      // элементы: часовые полосы и границы колонок дня.
      sc.style.backgroundImage = [
        "linear-gradient(to bottom, var(--color-stroke) 1px, transparent 1px)",
        `repeating-linear-gradient(to right, var(--color-stroke) 0 1px, transparent 1px ${colW}px)`,
      ].join(", ");
      // Оба слоя начинаются от границы первой колонки дня, а не из-под
      // цифр: у Apple подписи часов стоят «на воздухе», и это уже было
      // выверено, когда линии рисовались элементами.
      sc.style.backgroundSize = [
        `calc(100% - ${GUTTER_W}px) ${HOUR_H}px`,
        // Область вертикалей на пиксель уже: иначе замыкающая линия
        // периода ложится ровно на правую кромку экрана и получается
        // рамка, которой у сетки на элементах не было.
        `calc(100% - ${GUTTER_W + 1}px) 100%`,
      ].join(", ");
      sc.style.backgroundRepeat = ["repeat-y", "repeat-y"].join(", ");
      sc.style.backgroundPosition = [
        `right 0 top ${phase}px`,
        // Слева, а не справа: у этого слоя область на пиксель уже, и
        // прижатие вправо сдвинуло бы первую вертикаль с границы колонки.
        `left ${GUTTER_W}px top 0`,
      ].join(", ");
      sc.style.backgroundAttachment = "local";

      // Сколько часов дорисовать подписями за пределами суток. Владелец
      // 19.08.2026: «раз таблицу можно выносить, почему числа нельзя? вот
      // 00:00 — а почему нельзя выше 23:00, потом 22:00; и то же самое
      // внизу — по всему хвосту сделать ещё и цифры. Неактивные, это
      // логично, зато целостно, а сейчас кусок обрубка».
      //
      // Вверх — по запасу на оттяжку: выше начала содержимого прокрутки
      // нет, эти подписи просто обрезаны краем, пока экран не оттянут
      // вниз, и проявляются ровно тогда, когда открывается пустое место.
      // Вниз — строго по СВОБОДНОМУ месту под сеткой (нижние отступы
      // страницы под кнопку-веер), не больше: за ним подписи попали бы в
      // прокручиваемую область и удлинили её, а прокрутка должна остаться
      // ровно сутками (согласовано с владельцем 19.08.2026).
      let padBelow = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
      for (
        let el: HTMLElement | null = grid.parentElement;
        el && el !== sc;
        el = el.parentElement
      ) {
        padBelow += parseFloat(getComputedStyle(el).paddingBottom) || 0;
      }
      setOverscan((prev) => {
        const next = {
          up: Math.ceil(sc.clientHeight / 2 / HOUR_H),
          down: Math.floor(padBelow / HOUR_H),
        };
        return prev.up === next.up && prev.down === next.down ? prev : next;
      });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(sc);
    return () => {
      ro.disconnect();
      sc.style.backgroundImage = "";
      sc.style.backgroundSize = "";
      sc.style.backgroundRepeat = "";
      sc.style.backgroundPosition = "";
      sc.style.backgroundAttachment = "";
    };
  }, [days.length]);

  // Где именно палец взял плашку — расстояние от её верхнего края до точки
  // захвата. Без него плашка, взятая за середину, прыгала бы верхом под
  // палец в первый же момент перетаскивания (у задачи на 2 часа это
  // подскок на целый час). Из пула так не сделать: там источник — строка
  // списка совсем другой высоты, и переносить с неё захват некуда, поэтому
  // у неё смещение остаётся нулевым и верх плашки встаёт под палец.
  const grabOffsetRef = useRef(0);
  // Момент окончания перетаскивания. Нужен, чтобы отпускание не досылало
  // click и не открывало карточку задачи вдогонку: проверки `!dragging`
  // для этого мало — состояние сбрасывается в handleDragEnd, а click от
  // браузера приходит уже после него.
  const dragEndedAtRef = useRef(0);

  // Ячейка под пальцем на прошлом кадре — «колонка:время». Виброотклик
  // положен на ПЕРЕСЕЧЕНИЕ границы, а не на движение: onDragMove приходит
  // каждый кадр, а шаг сетки — SNAP_MIN, и между двумя соседними кадрами
  // время чаще всего то же самое.
  const lastCellRef = useRef<string | null>(null);

  function cellKeyOf(
    pos: { top: number; colIndex: number } | null,
  ): string | null {
    if (!pos || pos.top < -HOUR_H) return null;
    return `${pos.colIndex}:${timeFromOffset(pos.top)}`;
  }

  /** Ключ ячейки указывает на ровный час — «2:14:00» → да, «2:14:15» → нет. */
  function hourNotch(cell: string): boolean {
    return cell.endsWith(":00");
  }

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    const task = days.flatMap((d) => d.tasks).find((t) => t.id === id);
    if (!task) return; // источника нет — анимации не будет
    const startH = hoursFromTime(task.start_time);
    const dur = task.duration_min ?? SNAP_MIN;
    // Заполняем ghostRef СИНХРОННО, до setDragging — иначе overlay при
    // первом монтировании возьмёт старый snapshot (предыдущая задача или
    // null) и мигнёт чужим цветом/высотой. Это и было «сначала там
    // моргнёт, потом там появится».
    // Ширину overlay берём из РЕАЛЬНОЙ колонки сетки, а не из calc на
    // 100% (родитель overlay — body, у него ширина viewport, и в 3-дневном
    // виде плашка растягивается на всю ширину, в 1-дневном — нормально
    // своя колонка). Это «плоская узкая, потом расширяется» при
    // переключении layout посреди drag (Максим 26.08.2026).
    const gridRect = gridRef.current?.getBoundingClientRect();
    const colCount = Math.max(1, days.length);
    const colW = gridRect
      ? (gridRect.width - GUTTER_W) / colCount - RIGHT_INSET
      : 0;
    ghostRef.current = {
      task,
      height: Math.max(MIN_H, (dur / 60) * HOUR_H - 3),
      width: colW,
      colIndex: 0,
    };
    setDragging(id);
    // Плашка оторвалась от сетки — это и есть момент «взял».
    hapticGrab();
    const zeroDelta = {
      activatorEvent: e.activatorEvent,
      delta: { x: 0, y: 0 },
    };
    const pt = pointerXY(zeroDelta);
    const grid = gridRef.current;
    // Точку захвата считаем от ВРЕМЕНИ задачи, а не от прямоугольника
    // dnd-kit (`active.rect.current.initial`): на onDragStart тот ещё не
    // измерен и приходит пустым, из-за чего смещение молча становилось
    // нулевым — блок прыгал верхом под палец, как и раньше. Замер
    // 19.08.2026 на двухчасовой задаче: взяли за нижний край, сдвинули на
    // 2 часа, получили 14:45 вместо 13:00 — ровно высота блока промаха.
    // Верх плашки и так однозначно считается из start_time, зависеть тут
    // от внутренностей библиотеки незачем. Ищем по ВСЕМ дням (20.08.2026)
    // — задача-источник может лежать в любой из трёх колонок, id уникален.
    const offsetInBlock =
      startH !== null && grid && pt
        ? pt.y - (grid.getBoundingClientRect().top + startH * HOUR_H + 1)
        : 0;
    // Отрицательное или заведомо большое значение — только если геометрия
    // разъехалась (например, задача попала в кластер и сдвинута вбок);
    // тогда безопаснее вести плашку верхом под пальцем, чем прыгнуть.
    grabOffsetRef.current =
      offsetInBlock > 0 && offsetInBlock < HOURS.length * HOUR_H
        ? offsetInBlock
        : 0;
    // Призрак должен появиться сразу, а не после первого движения пальца:
    // иначе плашку прячут (hidden), а рисовать вместо неё ещё нечего, и
    // задача на мгновение исчезает с экрана.
    const pos = positionOf(zeroDelta);
    if (pos) {
      setPreview(pos.top < -HOUR_H ? null : timeFromOffset(pos.top));
      if (ghostRef.current) ghostRef.current.colIndex = pos.colIndex;
    }
    lastCellRef.current = cellKeyOf(pos);
  }

  /** Не пропустить click, если он прилетел сразу после перетаскивания. */
  function clickAfterDrag(): boolean {
    return !!dragging || Date.now() - dragEndedAtRef.current < 300;
  }

  // Координаты пальца/курсора ПРЯМО СЕЙЧАС: activatorEvent — где он был в
  // момент, когда взяли строку, delta — на сколько сдвинулся с тех пор
  // (dnd-kit копит её сам). Считать нужно именно так, а НЕ по верхнему
  // краю перетаскиваемого блока (rect.current.translated, как было
  // раньше) — тот сдвигается на ту же дельту от СВОЕГО исходного угла, и
  // если строку взяли не за самый её край (а палец обычно попадает в
  // середину), результат промахивается ровно на эту разницу: палец
  // наведён на 10:00, а получившийся верх блока — на 09:30. Найдено
  // 19.08.2026 живым тестом (Playwright: цель 10:00 → сохранилось 09:30,
  // разница ровно в половину высоты строки-источника). X добавлен
  // 20.08.2026 тем же приёмом — определяет колонку дня под пальцем.
  function pointerXY(e: {
    activatorEvent: Event;
    delta: { x: number; y: number };
  }): { x: number; y: number } | null {
    const ev = e.activatorEvent as
      PointerEvent | MouseEvent | (Event & { touches?: TouchList });
    const clientX =
      "clientX" in ev
        ? (ev as PointerEvent | MouseEvent).clientX
        : ev.touches?.[0]?.clientX;
    const clientY =
      "clientY" in ev
        ? (ev as PointerEvent | MouseEvent).clientY
        : ev.touches?.[0]?.clientY;
    if (typeof clientX !== "number" || typeof clientY !== "number") return null;
    return { x: clientX + e.delta.x, y: clientY + e.delta.y };
  }

  /** Смещение верха плашки от верха сетки (для времени) + индекс колонки
   *  дня (для даты) по текущему положению пальца, с поправкой на точку
   *  захвата по вертикали. Один расчёт на предпросмотр и на запись — чтобы
   *  задача вставала ровно туда, где её показывал призрак. Колонка не
   *  получает поправку на точку захвата — задача не может «наполовину
   *  висеть» между двумя днями, целится в тот день, где сейчас сам палец. */
  function positionOf(e: {
    activatorEvent: Event;
    delta: { x: number; y: number };
  }): { top: number; colIndex: number } | null {
    const grid = gridRef.current;
    const pt = pointerXY(e);
    if (!grid || !pt) return null;
    const rect = grid.getBoundingClientRect();
    const top = pt.y - grabOffsetRef.current - rect.top;
    const colW = (rect.width - GUTTER_W) / days.length;
    const rawCol = (pt.x - rect.left - GUTTER_W) / colW;
    const colIndex = Math.min(days.length - 1, Math.max(0, Math.floor(rawCol)));
    return { top, colIndex };
  }

  function handleDragEnd(e: DragEndEvent) {
    // Очищаем overlay СИНХРОННО, до setDragging(null) — иначе React
    // успеет отрисовать один кадр, где dragging уже null, а ghost ещё
    // показывается.
    ghostRef.current = null;
    const id = String(e.active.id);
    setJustDropped(id);
    if (justDroppedTimerRef.current) clearTimeout(justDroppedTimerRef.current);
    justDroppedTimerRef.current = setTimeout(() => {
      setJustDropped(null);
      justDroppedTimerRef.current = null;
    }, 250);
    setDragging(null);
    setPreview(null);
    lastCellRef.current = null;
    dragEndedAtRef.current = Date.now();
    if (!onSchedule) return;
    const pos = positionOf(e);
    if (!pos) return;
    // Отпустили выше сетки (например, обратно в список) — не трогаем.
    if (pos.top < -HOUR_H) return;
    const date = days[pos.colIndex]?.date;
    if (!date) return;
    // Отклик только когда задача ДЕЙСТВИТЕЛЬНО переставлена: все выходы
    // выше молча ничего не меняют, и «щелчок» там соврал бы про результат.
    hapticDrop();
    onSchedule(String(e.active.id), date, timeFromOffset(pos.top));
  }

  // Таймер justDropped должен быть отменён при размонтировании, иначе
  // setState после анмаунта и утечка. Других постоянных эффектов тут
  // не нужно — всё остальное либо в useEffect ниже по дереву (фон
  // сетки), либо чисто рефы.
  useEffect(() => {
    return () => {
      if (justDroppedTimerRef.current) {
        clearTimeout(justDroppedTimerRef.current);
        justDroppedTimerRef.current = null;
      }
    };
  }, []);

  function handleDragMove(e: {
    activatorEvent: Event;
    delta: { x: number; y: number };
  }) {
    const pos = positionOf(e);
    if (!pos) return;
    // Раньше setPreview/setDragCol вызывались на КАЖДЫЙ mousemove — на
    // 120 Hz экране это 120 React-рендеров сетки в секунду, и каждый
    // перерисовывал все плашки-кандидаты на скрытие (hidden), потому что
    // hidden зависел от ghost.colIndex, который зависел от dragCol. Отсюда
    // «моргание тык-тык» (Максим 26.08.2026). Теперь состояние поднимаем
    // только при реальной смене ячейки — то же условие, что для хаптика.
    const cell = cellKeyOf(pos);
    if (cell !== lastCellRef.current) {
      setPreview(pos.top < -HOUR_H ? null : timeFromOffset(pos.top));
      // colIndex едет СИНХРОННО — overlay позиционируется через CSS-translate
      // от центра, и на первом кадре после смены колонки ref уже новый.
      if (ghostRef.current) ghostRef.current.colIndex = pos.colIndex;
      const prev = lastCellRef.current;
      lastCellRef.current = cell;
      if (cell) {
        const colChanged =
          prev !== null && prev.split(":")[0] !== cell.split(":")[0];
        if (hourNotch(cell) || colChanged) hapticNotch();
        else hapticCross();
      }
    }
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragging(null);
        ghostRef.current = null;
        lastCellRef.current = null;
      }}
    >
      {/* Нативный DragOverlay от dnd-kit (портал в body): едет за пальцем
          через CSS-translate3d, без React-рендеров на каждом mousemove.
          Это и есть «перейти на нативные вещи» (Максим 26.08.2026) —
          библиотека сама перерисовывает ОДИН overlay-элемент, пока
          приложение ничего не делает. Самописный <DragGhost> внутри
          сетки убран: он вызывал перерисовку ВСЕЙ колонки при смене
          ghost.colIndex, а это уже второй слой перерисовки поверх
          полупрозрачной плашки-источника — отсюда и моргание «тык-тык». */}
      <DragOverlay dropAnimation={null}>
        {dragging && ghostRef.current ? (
          // Overlay едет за пальцем через CSS-translate3d. Чтобы плашка
          // сразу была нужной высоты (а не схлопывалась до высоты текста и
          // потом раздувалась на следующем рендере — «уменьшается до
          // минимума, а потом увеличивается», Максим 26.08.2026),
          // высота и флаг лежат в REF, не в state. На первом же кадре
          // монтирования overlay уже знает свою геометрию.
          <div
            className="pointer-events-none flex select-none flex-col items-stretch justify-start gap-y-0 overflow-hidden rounded-[6px] px-2 py-1"
            style={{
              width: ghostRef.current.width || undefined,
              height: ghostRef.current.height,
              backgroundColor: projectColor(ghostRef.current.task),
              boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
              transform: "scale(1.015)",
              transformOrigin: "left center",
            }}
          >
            <span
              style={{
                color: CHIP_INK,
                // Считаем число строк так же, как у TimedBlock, чтобы
                // призрак не «схлопывался до текста и потом раздувался»
                // (Максим 26.08.2026): на длинной задаче призрак уже
                // нужной высоты и текста хватает.
                WebkitLineClamp: Math.max(
                  1,
                  Math.floor((ghostRef.current.height - 8) / 16),
                ),
              }}
              className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-[16px] font-medium [display:-webkit-box] [-webkit-box-orient:vertical] overflow-hidden"
            >
              <MarkdownInline source={ghostRef.current.task.title} />
            </span>
          </div>
        ) : null}
      </DragOverlay>
      <div className="mt-2 flex flex-col gap-3">
        {/* Задачи со сроком на сегодня, но без времени — ПРИКЛЕЕННЫМ пулом
            наверху, под шапкой (владелец 19.08.2026: «они просто должны
            быть наверху зафиксированы где-то, чтобы я мог их спускать по
            временным значениям»).
            Именно приклеенным, а не просто первым блоком страницы, как
            было: экран открывается прокрученным к текущему часу, и пул в
            обычном потоке остаётся выше края экрана — чтобы положить дело
            на 15:00, пришлось бы сперва крутить вверх за задачей, а потом
            тащить её вслепую через весь день. Приклеенный пул виден
            всегда: сетку крутят до нужного часа, и только потом берут
            задачу.
            top — реальная высота шапки (--screen-header-h, публикуется
            usePublishHeaderHeight на контейнере прокрутки); z-10, чтобы
            уходить ПОД шапку (у неё z-20), но идти над сеткой.
            Своя прокрутка при длинном списке — иначе десяток дел без
            времени закрыл бы собой полдня. Общий пул для всех
            отображённых дней разом (20.08.2026, было только у 1-дневного
            вида) — каждую задачу можно кинуть на любую из колонок. */}
        {untimed.length > 0 && (
          <div
            // Ни заголовка «Без времени — N», ни иконки, ни подсказки
            // «перетащите на шкалу» здесь больше нет (владелец 19.08.2026:
            // «убери название, эти три полосочки и „перетащите на шкалу“ —
            // просто чтобы задачи вот так вот поверх плавали, вся их
            // конструкция без лишнего, а остальное прозрачное»).
            // Поэтому и подложки bg-bg нет: пул именно ПЛАВАЕТ над сеткой,
            // сквозь промежутки видно часы. Шлейф затухания вместе с
            // подложкой тоже ушёл — гасить нечего, плашки и так лежат
            // отдельными карточками, а не сплошным полотном.
            className="sticky z-10 -mx-4 px-4 pb-2"
            style={{ top: "var(--screen-header-h, 0px)" }}
          >
            {/* ОДНА общая плашка со строками, а не отдельная пилюля на
                каждую задачу (владелец 19.08.2026, после первого захода:
                «очистил правильно, но не нужно было их разделять каждую в
                свою пилюлину — мне нравилось, что они соединялись в одну
                общую табличку»). Скругление и тень — у контейнера, строки
                внутри разделены чертой. */}
            <div className="max-h-[132px] overflow-y-auto overscroll-contain rounded-2xl bg-card shadow-dropdown">
              {untimed.map((t, i) => (
                <UntimedRow
                  key={t.id}
                  task={t}
                  first={i === 0}
                  onClick={() => !clickAfterDrag() && onTaskClick(t.id)}
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
        {/* z-0 не декоративный: он делает сетку отдельным слоем, и её
            внутренние z-индексы (линия «сейчас», призрак перетаскивания)
            больше не спорят с приклеенным пулом выше — иначе они
            выигрывали бы у него как более поздние в DOM при равном
            z-index и рисовались бы поверх пула. */}
        <div className="relative z-0 -mx-4">
          <div ref={scrollRef} className="relative">
            <div
              ref={gridRef}
              className="relative flex"
              style={{ height: totalH }}
            >
              {/* Левая колонка — только подписи часов, без линии под
                  ними: у Apple часовая линия начинается ровно на границе
                  первой колонки дня, а не под цифрами. */}
              <div
                className="relative shrink-0 select-none"
                style={{ width: GUTTER_W }}
              >
                {labelHours.map((h) => (
                  <span
                    key={h}
                    // Все подписи центрируются по своей часовой линии
                    // одинаково. Раньше у 00:00 центрирование снималось:
                    // она была самой верхней, её линия шла по кромке сетки
                    // и половина цифры терялась за краем (Максим
                    // 19.08.2026: «на самом верху у тебя не 00:00, а
                    // обрезано»). Теперь выше неё идут 23:00, 22:00 — край
                    // не на ней, и особый случай только ломал бы ровный шаг
                    // между двумя верхними подписями.
                    className="absolute right-1.5 text-[10px] font-medium text-dim tabular-nums -translate-y-1/2"
                    style={{ top: h * HOUR_H }}
                  >
                    {cycleLabel(h)}
                  </span>
                ))}
              </div>

              {/* Область колонок: перехватывает свайп влево/вправо без сдвига сетки часов */}
              <div
                // Горизонтальное листание дней — свой жест, свайп «назад»
                // сюда не лезет (см. useSwipeBack, data-hswipe).
                data-hswipe
                className="relative flex flex-1 min-w-0"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={() => {
                  isSwipeDraggingRef.current = false;
                }}
                style={{ touchAction: "pan-y" }}
              >
                {columns.map(({ day, blocks }) => (
                  <div
                    key={day.date}
                    data-day-col={day.date}
                    className="relative min-w-0 flex-1 pl-px"
                  >
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
                        hidden={
                          b.task.id === dragging || b.task.id === justDropped
                        }
                        onClick={() =>
                          !clickAfterDrag() && onTaskClick(b.task.id)
                        }
                      />
                    ))}

                    {/* Самописный DragGhost убран (26.08.2026) — едет в
                        нативном <DragOverlay> выше; тот живёт в body и
                        не трогает сетку. */}
                  </div>
                ))}
              </div>

              {/* Время, на которое встанет задача, — в жёлобе часов, слева
                  от призрака, а не поверх него. Раньше подпись рисовалась
                  внутри колонки дня, где теперь едет сама плашка: цифры
                  легли бы прямо на её текст. Тонкая черта отбивает верхнюю
                  кромку будущей плашки и заодно связывает её с подписью. */}
              {interactive && preview && (
                <div
                  className="pointer-events-none absolute left-0 right-0 z-30 flex -translate-y-1/2 items-center"
                  style={{
                    top:
                      (Number(preview.split(":")[0]) +
                        Number(preview.split(":")[1]) / 60) *
                      HOUR_H,
                  }}
                >
                  <span
                    className="shrink-0 bg-bg py-px pr-1.5 text-right text-[10px] font-semibold text-red tabular-nums"
                    style={{ width: GUTTER_W }}
                  >
                    {preview}
                  </span>
                  <span className="h-[1.5px] flex-1 rounded bg-red/70" />
                </div>
              )}

              {showNowLine && <NowLine />}
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
