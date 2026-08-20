import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useAgents } from "../api/agents";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { ActionsMenu } from "../components/ActionsMenu";
import { useAppStore } from "../store";
import {
  WeekGrid,
  MonthGrid,
  DaySheet,
  groupByDate,
  WeekMonthLabel,
  MonthHeaderLabel,
  // В этом файле уже есть своя mondayOf — она работает с Date и обслуживает
  // ленту-выборщик; эта работает со строками «ГГГГ-ММ-ДД» и обслуживает
  // календарные виды. Разные типы, разные потребители, поэтому алиас, а не
  // попытка свести их в одну.
  mondayOf as weekStartOf,
} from "../components/UpcomingCalendar";
import { todayStr, MONTHS_SHORT, addDays } from "../lib/date";
import { isAgentAssignedTask } from "../lib/taskOwner";
import { TaskRow } from "../components/TaskRow";
import {
  TaskFilterButton,
  TaskFilterSheet,
} from "../components/TaskFilterSheet";
import {
  DEFAULT_TASK_FILTERS,
  filterTasks,
  countActiveTaskFilters,
  buildProjectOptions,
  buildLabelOptions,
  buildAssigneeOptions,
  type TaskFilters,
} from "../lib/taskFilters";
import type { ApiTask } from "../api/types";

// Сокращённые названия месяцев (именительный падеж, с точкой там, где
// усечено по стандарту рус. типографики) — используются в ДВУХ местах: в
// заголовке ленты («Авг. 2026 г.») и внутри ячейки первого числа месяца
// («Сент.» над «1»). Родительный падеж («11 августа») в этом файле не
// нужен — здесь нет мест, где месяц ставится после числа; такой массив
// (MONTHS_FULL) есть отдельно в RescheduleSheet.tsx и ActivityScreen.tsx,
// этот файл их не использует.
const MONTHS_ABBR_DOT = [
  "Янв.",
  "Февр.",
  "Март",
  "Апр.",
  "Май",
  "Июнь",
  "Июль",
  "Авг.",
  "Сент.",
  "Окт.",
  "Нояб.",
  "Дек.",
];
// Порядок недели с понедельника (не индексируется через getDay() —
// рендерится напрямую по .map(), поэтому порядок в массиве и есть порядок
// колонок в сетке). Массивы, индексируемые через d.getDay() (0 = ВС),
// такие как в formatFullDate и в week-strip ниже, трогать нельзя — там
// переставлять нельзя.
const WEEKDAYS = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];

// Переход месяц↔неделя: длительность и направленная кривая (ease-out на
// разворот — по ощущениям владельца; ease-in на сворачивание — зеркальная
// пара, ускоряется к исчезновению, а не тормозит как разворот). Длительность
// 280мс — литерал duration-[280ms] прямо в className ниже (Tailwind не
// увидит её через интерполяцию JS-строки, см. комментарий там же).
//
// Три варианта рассматривались, два отброшены по конкретным причинам:
//
// 1) max-height с угаданными потолками (было раньше) — отброшен: потолки
//    420/110px разошлись с реальной высотой (живой замер Playwright дал
//    442.5/165px). Месяц оказался ВЫШЕ потолка — при сворачивании контент
//    в момент смены calMode уже короче нового потолка недели, так что
//    max-height все 300мс не был сдерживающим фактором (рывок). При
//    разворачивании — обратная асимметрия, потолок реально сдерживал рост
//    (визуально «более-менее»). Асимметрия была ровно та, на которую
//    пожаловался владелец.
//
// 2) grid-template-rows 0fr↔1fr на паре всегда смонтированных треков —
//    ПОПРОБОВАН и тоже отброшен, уже эмпирически: в этом Chromium
//    (headless, playwright-core) transition на grid-template-rows с fr-
//    единицами НЕ интерполируется плавно, когда оба трека держат реальный
//    контент одновременно — вместо непрерывной анимации браузер держит
//    старое значение и переключается на новое ОДНИМ дискретным скачком
//    примерно на середине длительности (это стандартный CSS-фоллбэк для
//    неинтерполируемого свойства: «держать/переключить на 50%», а не
//    линейная анимация). Замер high-frequency сэмплами подтвердил: плато на
//    старой высоте, скачок к новой около t≈140мс из 280мс. Известный трюк
//    «0fr/1fr» рассчитан на ОДИН трек (показать/спрятать целиком), а не на
//    одновременный ресайз двух треков с реальным контентом в обоих — не тот
//    случай использования, для которого это в браузерах хорошо тестировано.
//
// 3) ВЫБРАНО — измерение реальной высоты через ref + двойная синхронизация
//    с кадром отрисовки:
//    - `changeMode()` СНАЧАЛА мерит текущую (ещё старую) высоту контента
//      через getBoundingClientRect() и фиксирует её в state как явный
//      height, ПОТОМ переключает calMode — оба обновления в одном рендере,
//      так что браузер коммитит и красит кадр «новый контент, но зажат под
//      старую высоту» (это и есть отправная точка анимации).
//    - useEffect(..., [calMode]) — обычный useEffect, а НЕ useLayoutEffect:
//      он в React гарантированно срабатывает ПОСЛЕ покраски кадра, то есть
//      после того как браузер уже показал «стартовый» кадр выше. Внутри —
//      requestAnimationFrame (двойная страховка от таймингов конкретной
//      версии React) меряет scrollHeight НОВОГО контента (реальный, не
//      подставленный) и ставит его как height — вот тут CSS-transition
//      реально стартует между двумя видимыми, покрашенными кадрами.
//    - onTransitionEnd отпускает height обратно в auto (undefined) — иначе
//      после анимации высота осталась бы зажатой в px и не следила бы за
//      сменой числа строк ленты недель (сейчас фиксированное число, но
//      строка с переходом месяца выше остальных — см. WEEKS_COUNT) при
//      обычной навигации по месяцам через попап, которая calMode не трогает.
//    - prefers-reduced-motion: reduce — changeMode() и useEffect оба вообще
//      не трогают явную высоту (остаётся auto), переход мгновенный — иначе
//      он бы «залип» без transitionend, который при выключенных переходах
//      не срабатывает.
//    Результат — реальная intrinsic-высота контента в обе стороны, без
//    угаданных чисел, переживает переменную высоту строки перехода месяца.

// Сколько недель показывать в ленте. На образце — пять строк подряд.
const WEEKS_COUNT = 5;

// Понедельник недели, которой принадлежит `d` (getDay() отдаёт 0 =
// воскресенье). Единая точка правды для «начала недели» — everywhere else
// (weekDates ниже) считает то же самое, но inline, под свою специфику
// (база — selectedDate/today, а не произвольная дата).
function mondayOf(d: Date): Date {
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + offset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Непрерывная лента недель начиная с `startMonday` — БЕЗ пустых ячеек и
// без разрыва на границе месяца (в отличие от прежней genCalendar, которая
// строила сетку одного месяца с пустой добивкой по краям).
function genWeekStrip(startMonday: Date, weeks: number): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(startMonday);
    d.setDate(startMonday.getDate() + i);
    days.push(d);
  }
  return days;
}

function formatDateStr(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function UpcomingScreen() {
  const [calMode, setCalMode] = useState<"month" | "week">("month");
  // Вид экрана: привычный список с календарём-лентой или календарные
  // раскладки. Живёт в сторе (persist), как и вид «Сегодня»: выбранная
  // раскладка должна переживать перезапуск приложения.
  const view = useAppStore((s) => s.upcomingLayout);
  const setView = useAppStore((s) => s.setUpcomingLayout);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  // Какая неделя и какой месяц показаны в календарных видах, и какой день
  // раскрыт панелью. Своё состояние, не связанное с лентой-выборщиком
  // списка: она листается своей логикой (ribbonAnchor ниже).
  const [gridMonday, setGridMonday] = useState(() => weekStartOf(todayStr()));
  const [gridMonth, setGridMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [openDay, setOpenDay] = useState<string | null>(null);
  const today = todayStr();
  const todayDate = new Date(today + "T00:00:00");

  // pickerYear/pickerMonth — то, что показывает заголовок ленты («Авг.
  // 2026 г.») и что листает попап-выбор месяца. Отдельно от того, откуда
  // реально начинается лента (ribbonAnchor): по умолчанию (ribbonAnchor ===
  // null) лента стартует с понедельника ТЕКУЩЕЙ недели, что при обычном
  // ходе месяца совпадает с pickerMonth, но не обязано совпасть в
  // граничных случаях (текущая неделя может зацепить конец предыдущего
  // месяца) — заголовок в таких случаях всё равно должен называть именно
  // «текущий» месяц, а не месяц первой ячейки ленты, поэтому это два
  // независимых state, не один выведенный из другого.
  const [pickerYear, setPickerYear] = useState(todayDate.getFullYear());
  const [pickerMonth, setPickerMonth] = useState(todayDate.getMonth());
  // null = лента начинается с понедельника текущей недели (обычный режим).
  // Ставится в конкретный понедельник, когда владелец выбрал другой месяц
  // через попап — тогда лента стартует с ПЕРВОЙ недели этого месяца (та,
  // что содержит его 1-е число), как договорено в ТЗ.
  const [ribbonAnchor, setRibbonAnchor] = useState<Date | null>(null);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const { data: allTasks = [], isLoading, error } = useTasks();
  const { data: agents = [] } = useAgents();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Агентские задачи сюда не попадают вовсе (19.08.2026, владелец: «кроме
  // как во входящих в конкретном проекте, нигде маячить не должна» —
  // Предстоящее не исключение). См. isAgentAssignedTask.
  const activeTasks = useMemo(
    () =>
      allTasks.filter(
        (t) => t.status === "active" && !isAgentAssignedTask(t, agents),
      ),
    [allTasks, agents],
  );

  // This screen only ever renders tasks that have a due_date (groupedTasks
  // below drops everything else) — so the filter's task universe has to be
  // `datedTasks`, not every active task, or the sheet would offer a
  // project/label/assignee that exists only on undated tasks. Picking such
  // an option would leave `tasks` matching real (undated) tasks while the
  // calendar/list shows nothing and no "ничего не подошло" message fires,
  // since that check also needs to compare against the dated universe.
  const datedTasks = useMemo(
    () => activeTasks.filter((t) => t.due_date),
    [activeTasks],
  );

  // Filter options from the full dated set (pre-filter), same rule as
  // Inbox/Today/ActivityScreen.
  const projectFilterOptions = useMemo(
    () => buildProjectOptions(datedTasks),
    [datedTasks],
  );
  const labelFilterOptions = useMemo(
    () => buildLabelOptions(datedTasks),
    [datedTasks],
  );
  const assigneeFilterOptions = useMemo(
    () => buildAssigneeOptions(datedTasks),
    [datedTasks],
  );
  const activeFilterCount = countActiveTaskFilters(filters);

  const tasks = useMemo(
    () => filterTasks(datedTasks, filters),
    [datedTasks, filters],
  );
  // Раскладка по дням для календарных видов — один проход по списку
  // вместо фильтра на каждую из 42 ячеек месяца.
  const byDate = useMemo(() => groupByDate(tasks), [tasks]);

  const ribbonStart = useMemo(
    () => ribbonAnchor ?? mondayOf(todayDate),
    [ribbonAnchor, todayDate],
  );
  const ribbonDays = useMemo(
    () => genWeekStrip(ribbonStart, WEEKS_COUNT),
    [ribbonStart],
  );

  // Два рефа, не один — это была первая, ошибочная попытка с одним рефом:
  // измерять `scrollHeight` того же элемента, на который наложен явный
  // style.height, чтобы узнать «сколько нужно новому контенту». Но
  // scrollHeight у overflow-hidden элемента с явной height НЕ возвращает
  // натуральную высоту контента — он возвращает max(contentHeight,
  // заданный height), то есть пока explicit height ещё держит старое
  // (большее) значение, scrollHeight тоже отдавал старое значение — итог:
  // высота никогда не доезжала до цели, календарь визуально не сворачивался
  // вообще (поймано живым Playwright-прогоном: aria-label менялся, высота —
  // нет). Поэтому: calOuterRef — на нём explicit height/overflow-hidden/
  // transition; calInnerRef — БЕЗ каких-либо ограничений по высоте вообще,
  // всегда показывает истинный intrinsic-размер текущего контента.
  const calOuterRef = useRef<HTMLDivElement>(null);
  const calInnerRef = useRef<HTMLDivElement>(null);
  // stickyRef — контейнер, относительно которого позиционируется попап
  // выбора месяца (position:sticky — уже позиционирующий элемент, свой
  // containing block для absolute-потомков, доп. class="relative" не
  // нужен). Попап рендерится СНАРУЖИ calOuterRef (соседом, не потомком) —
  // иначе overflow-hidden/явная height на calOuterRef обрежут его: у
  // абсолютно спозиционированного потомка контент не участвует в auto-
  // высоте предка, а overflow-hidden всё равно клипует по границе
  // предка, так что попап был бы невидим.
  const stickyRef = useRef<HTMLDivElement>(null);
  const monthBtnRef = useRef<HTMLButtonElement>(null);
  const [calAnimHeight, setCalAnimHeight] = useState<number | undefined>(
    undefined,
  );
  const calIsFirstRender = useRef(true);

  function prefersReducedMotion() {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  // Единая точка входа для месяц↔неделя — дёргает кнопка в шапке (owner
  // 2026-08-13: ручку-засечку под календарём убрали целиком вместе со
  // свайпом — она дублировала эту же кнопку и оставляла пустую полосу
  // между сеткой дней и списком задач). Меряет ТЕКУЩУЮ (ещё старую) высоту
  // ВНЕШНЕГО блока ДО смены calMode и фиксирует её как явный height — это
  // стартовая точка анимации, см. useEffect ниже.
  function changeMode(next: "month" | "week") {
    if (next === calMode) return;
    if (!prefersReducedMotion()) {
      const el = calOuterRef.current;
      if (el) setCalAnimHeight(el.getBoundingClientRect().height);
    }
    setCalMode(next);
  }

  function toggleCalMode() {
    changeMode(calMode === "month" ? "week" : "month");
  }

  // Срабатывает ПОСЛЕ покраски кадра, в котором calMode уже сменился, но
  // высота ещё зажата под старое значение (см. changeMode выше) — то есть
  // ровно тот граничный кадр, что нужен CSS-transition для старта. rAF —
  // дополнительная страховка кадровой границы поверх гарантии useEffect.
  // Меряет calInnerRef (без ограничений) — НЕ calOuterRef.
  useEffect(() => {
    if (calIsFirstRender.current) {
      calIsFirstRender.current = false;
      return;
    }
    if (prefersReducedMotion()) return; // высота остаётся auto, без рывка
    const raf = requestAnimationFrame(() => {
      const el = calInnerRef.current;
      if (el) setCalAnimHeight(el.getBoundingClientRect().height);
    });
    return () => cancelAnimationFrame(raf);
  }, [calMode]);

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
  // week" regardless of what they picked in the ribbon.
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

  // Попап выбора месяца — рендерится вне calOuterRef (см. комментарий у
  // stickyRef), поэтому позиционируется вручную по живым координатам
  // кнопки-триггера относительно sticky-контейнера, а не CSS-якорем.
  function openMonthPicker() {
    const btn = monthBtnRef.current;
    const sticky = stickyRef.current;
    if (btn && sticky) {
      const b = btn.getBoundingClientRect();
      const s = sticky.getBoundingClientRect();
      setPopoverPos({ top: b.bottom - s.top + 4, left: b.left - s.left });
    }
    setMonthPickerOpen(true);
  }

  function closeMonthPicker() {
    setMonthPickerOpen(false);
  }

  function goPrevMonth() {
    let y = pickerYear;
    let m = pickerMonth - 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    setPickerYear(y);
    setPickerMonth(m);
    setRibbonAnchor(mondayOf(new Date(y, m, 1)));
    setSelectedDate(null);
  }

  function goNextMonth() {
    let y = pickerYear;
    let m = pickerMonth + 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    setPickerYear(y);
    setPickerMonth(m);
    setRibbonAnchor(mondayOf(new Date(y, m, 1)));
    setSelectedDate(null);
  }

  function goToday() {
    setPickerYear(todayDate.getFullYear());
    setPickerMonth(todayDate.getMonth());
    setRibbonAnchor(null);
    setSelectedDate(null);
    setMonthPickerOpen(false);
  }

  return (
    <div className="px-4 pb-4">
      {/* Закреплённый «хром»: шапка экрана + календарь — всё в одном
          sticky-блоке (owner 2026-08-13: ручку-засечку под сеткой дней
          убрали — свайп ею дублировал кнопку toggleCalMode в шапке, а
          пустая 36px-полоса под ней отделяла список задач от чисел
          календаря без необходимости; граница/тень блока теперь сразу
          под сеткой дней). ScreenHeader сам уже sticky top-0
          (см. UI.tsx), но вложенный в уже прилипший родитель, эта
          собственная стики-логика становится no-op: как только внешний
          блок прилип к верху скролл-контейнера, всё что внутри нём (шапка,
          календарь) больше никогда не проезжает мимо top:0, так что
          дублирование не конфликтует — оно просто не участвует. Работает
          одинаково что на мобильном (скроллится document), что на
          десктопе (скроллится .flex-1.overflow-y-auto рамки телефона в
          Layout.tsx) — sticky в обоих случаях считается от ближайшего
          реального скролл-контейнера, а не от структуры вложенности. */}
      <div
        ref={stickyRef}
        /* -mx-4 px-4: этот блок несёт собственный фон и живёт внутри
           родительского px-4, поэтому без компенсации его фон обрывался в
           16px от краёв экрана и прокручивающиеся карточки проглядывали в
           щелях (замер 11.08.2026: ширина 358 при экране 390, на остальных
           вкладках ScreenHeader растягивается сам). Отрицательное поле
           тянет фон до краёв, внутренний padding возвращает содержимому
           прежние отступы — заголовок и кнопки не сдвигаются. */
        className="sticky top-0 z-20 -mx-4 px-4 bg-bg border-b border-stroke shadow-sticky"
      >
        <ScreenHeader
          title="Предстоящее"
          // Какой месяц смотрим — строкой под заголовком, внутри шапки:
          // так её накрывает общее затухание, и высота шапки, от которой
          // считается высота сетки, пересчитывается автоматически.
          below={
            view === "week" ? (
              <WeekMonthLabel monday={gridMonday} />
            ) : view === "month" ? (
              <MonthHeaderLabel year={gridMonth.year} month={gridMonth.month} />
            ) : undefined
          }
          actions={
            <>
              <TaskFilterButton
                onClick={() => setFilterSheetOpen(true)}
                active={activeFilterCount > 0}
              />
              {/* Свернуть/развернуть календарь-ленту — только в виде
                  «список»: в календарных видах ленты нет вовсе, и кнопка
                  управляла бы тем, чего на экране не видно. */}
              {view === "list" && (
                <button
                  onClick={toggleCalMode}
                  className="w-[44px] h-[44px] flex items-center justify-center active:scale-95 transition-transform"
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
              )}
              {/* Виды экрана — под тремя точками, ровно как в «Сегодня»
                  (19.08.2026: «под троеточие спрячь список, доска, один
                  день, три дня»). Здесь набор свой: список, неделя,
                  месяц. */}
              <button
                ref={menuAnchorRef}
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Ещё"
                className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
              >
                <Icon name="dots" size={18} />
              </button>
              <ActionsMenu
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                anchorRef={menuAnchorRef}
                items={(
                  [
                    ["list", "Список", "list"],
                    ["week", "Неделя", "calendarSmall"],
                    ["month", "Месяц", "grid"],
                  ] as const
                ).map(([key, label, icon]) => ({
                  icon,
                  label: (
                    <span
                      className={view === key ? "font-semibold text-red" : ""}
                    >
                      {label}
                    </span>
                  ),
                  onClick: () => setView(key),
                }))}
              />
            </>
          }
        />

        {/* Единственный смонтированный вид (лента недель ИЛИ одна неделя,
            по ternary — как и было изначально). Высота анимируется через
            явный height, зафиксированный в calAnimHeight (см.
            changeMode/useEffect выше); обычные ре-рендеры (навигация по
            месяцам через попап) height не трогают — он остаётся
            undefined/auto, так что строка с переходом месяца всегда
            показывает точную высоту без анимации, как раньше. */}
        {/* Лента-выборщик даты — принадлежность вида «список»: в неделе и
            месяце календарь и есть сам экран, вторая его копия сверху
            только отняла бы высоту у сетки. */}
        <div
          ref={calOuterRef}
          hidden={view !== "list"}
          onTransitionEnd={(e) => {
            // Только СВОЙ переход по height — иначе всплывший transitionend
            // от дочерних transition-all (дни календаря, .active:scale-90)
            // сбросил бы height обратно в auto посреди анимации.
            if (e.target === e.currentTarget && e.propertyName === "height") {
              setCalAnimHeight(undefined);
            }
          }}
          style={{ height: calAnimHeight }}
          // Tailwind's scanner needs a complete, literal class token in the
          // source text — an interpolated `duration-[${N}ms]` would never
          // match and the utility would silently not be generated
          // (transition falling back to 0s, instant). duration-[280ms] is
          // written out literally here — the single source of truth for
          // that number, see the "ВЫБРАНО" note above.
          className={`overflow-hidden transition-[height] duration-[280ms] motion-reduce:transition-none ${
            calMode === "month" ? "ease-out" : "ease-in"
          }`}
        >
          {/* calInnerRef — БЕЗ каких-либо height-ограничений, всегда
              измеримо в свой истинный intrinsic-размер (см. useEffect
              выше и комментарий про два рефа). */}
          <div ref={calInnerRef}>
            {calMode === "month" ? (
              <>
                {/* Заголовок ленты — компактный, слева, без стрелок по
                    бокам (в эталоне они исчезают целиком). Шеврон вниз —
                    признак того, что по нажатию открывается выбор месяца
                    (попап с «‹ Сегодня ›» ниже), а не сама навигация. */}
                <div className="flex items-center mb-1">
                  <button
                    ref={monthBtnRef}
                    onClick={() =>
                      monthPickerOpen ? closeMonthPicker() : openMonthPicker()
                    }
                    aria-haspopup="true"
                    aria-expanded={monthPickerOpen}
                    aria-label="Выбрать месяц"
                    className="flex items-center gap-1 h-[40px] -ml-2 px-2 active:scale-95"
                  >
                    <span className="text-[14px] font-semibold text-red">
                      {MONTHS_ABBR_DOT[pickerMonth]} {pickerYear} г.
                    </span>
                    <Icon
                      name="chevronDown"
                      size={12}
                      className={`text-red transition-transform ${monthPickerOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                </div>

                {/* Weekday headers — py-0/mb-0 (было py-1/mb-1): уплотнение
                    календаря, эту строку не тапают, минимальная площадь
                    касания на неё не распространяется. */}
                <div className="grid grid-cols-7 gap-0 mb-0">
                  {WEEKDAYS.map((d) => (
                    <div
                      key={d}
                      className="text-center text-[11px] text-sub py-0"
                    >
                      {d}
                    </div>
                  ))}
                </div>

                {/* Лента недель — непрерывная, без пустых ячеек и без
                    разрыва на границе месяца: начинается с понедельника
                    текущей недели (или с первой недели выбранного через
                    попап месяца) и идёт только вперёд. pb-1 (уплотнение,
                    шкала 16/12/8/4). Числовые ячейки — не уже 40×40 (сама
                    кнопка), внутренний кружок заливки — 26×26. */}
                <div className="grid grid-cols-7 gap-0 pb-1">
                  {ribbonDays.map((d) => {
                    const dateStr = formatDateStr(
                      d.getFullYear(),
                      d.getMonth(),
                      d.getDate(),
                    );
                    const hasTasks = groupedTasks[dateStr]?.length > 0;
                    const isToday = dateStr === today;
                    const isSelected = dateStr === selectedDate;
                    const isPast = dateStr < today;
                    const isFirstOfMonth = d.getDate() === 1;
                    const isFilled = isSelected || isToday;

                    return (
                      <button
                        key={dateStr}
                        data-date={dateStr}
                        onClick={() =>
                          setSelectedDate(isSelected ? null : dateStr)
                        }
                        className="min-h-[40px] w-full flex flex-col items-center justify-center gap-[1px] py-1 transition-all active:scale-90"
                      >
                        {isFirstOfMonth && (
                          <span
                            data-cal-month-label
                            /* 9px → 10px (20.08.2026): 9px не входил в
                               шкалу проекта и, главное, выпадал из таблицы
                               оптического трекинга в index.css — она
                               начинается с 10px. То есть самая мелкая
                               подпись в приложении оставалась БЕЗ разрядки
                               именно там, где она нужнее всего: на 10px
                               таблица открывает буквы на +0.025em, иначе
                               «Сент.» читается пятном. */
                            className={`text-[10px] leading-none ${
                              isFilled ? "text-red" : "text-sub"
                            }`}
                          >
                            {MONTHS_ABBR_DOT[d.getMonth()]}
                          </span>
                        )}
                        <span
                          data-cal-daynum
                          className={`text-[14px] leading-none w-[26px] h-[26px] rounded-full flex items-center justify-center ${
                            isFilled
                              ? "bg-red text-white font-semibold"
                              : isPast
                                ? "text-dim"
                                : "text-text"
                          }`}
                        >
                          {d.getDate()}
                        </span>
                        {hasTasks && !isFilled && (
                          <div className="w-[4px] h-[4px] rounded-full bg-red" />
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
                      onClick={() =>
                        setSelectedDate(isSelected ? null : dateStr)
                      }
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
        </div>

        {/* Попап выбора месяца — соседний с calOuterRef элемент (НЕ
            потомок), чтобы overflow-hidden/анимируемая height на
            calOuterRef его не обрезали (см. комментарий у stickyRef).
            Оверлей — div, не button/Link: check-dead-controls проверяет
            только button/Link/NavLink, а этот div и не должен туда
            попадать — это просто клик-заглушка для закрытия по тапу мимо. */}
        {monthPickerOpen && popoverPos && (
          <>
            <div className="fixed inset-0 z-30" onClick={closeMonthPicker} />
            <div
              className="absolute z-40 flex items-center gap-1 bg-card border border-stroke rounded-lg shadow-pop p-1"
              style={{ top: popoverPos.top, left: popoverPos.left }}
            >
              <button
                onClick={goPrevMonth}
                aria-label="Предыдущий месяц"
                className="w-[36px] h-[36px] flex items-center justify-center active:scale-95"
              >
                <Icon name="chevronLeft" size={16} className="text-sub" />
              </button>
              <button
                onClick={goToday}
                className="px-2 h-[36px] text-[12px] text-sub whitespace-nowrap active:scale-95"
              >
                Сегодня
              </button>
              <button
                onClick={goNextMonth}
                aria-label="Следующий месяц"
                className="w-[36px] h-[36px] flex items-center justify-center active:scale-95"
              >
                <Icon name="chevron" size={16} className="text-sub" />
              </button>
            </div>
          </>
        )}
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

      {isLoading && <Loading className="mt-3" />}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить задачи"
        className="mt-3 mb-2"
      />

      {/* selectedDate уже показывает своё «Нет задач на эту дату» ниже,
          когда фильтр вычистил всё на выбранный день — эта строка только
          для общего вида ленты (без выбранной даты), где раньше в этом
          случае не было вообще никакого сообщения. */}
      {!selectedDate &&
        !isLoading &&
        !error &&
        datedTasks.length > 0 &&
        tasks.length === 0 && (
          <div className="px-1 pt-1 pb-2 flex items-center gap-2 flex-wrap text-[13px] text-dim">
            Под выбранные фильтры ничего не подошло
            <button
              onClick={() => setFilters(DEFAULT_TASK_FILTERS)}
              className="text-red font-medium"
            >
              Сбросить фильтры
            </button>
          </div>
        )}

      {/* Календарные виды — вместо списка. Данные те же, что у списка
          (tasks — уже с применёнными фильтрами), просто разложены по
          дням. */}
      {view === "week" && (
        <WeekGrid
          monday={gridMonday}
          byDate={byDate}
          onTaskClick={(id) => navigate(`/task/${id}`)}
          onDayClick={(d) => setOpenDay(d)}
          onPickDate={(d) => setGridMonday(weekStartOf(d))}
          onPrevWeek={() => setGridMonday((m) => addDays(m, -7))}
          onNextWeek={() => setGridMonday((m) => addDays(m, 7))}
        />
      )}
      {/* Заголовок месяца со стрелками живёт в ШАПКЕ (below выше), а не
          здесь: владелец 19.08.2026 — «этот „авг 2026“ можешь в шапку
          добавить, календарик чуть приподнимется». */}
      {view === "month" && (
        <MonthGrid
          year={gridMonth.year}
          month={gridMonth.month}
          byDate={byDate}
          openDay={openDay}
          // Повторный тап по тому же дню сворачивает полосу.
          onDayClick={(d) => setOpenDay((prev) => (prev === d ? null : d))}
          onTaskClick={(id) => navigate(`/task/${id}`)}
          onPrevMonth={() =>
            setGridMonth(({ year, month }) =>
              month === 0
                ? { year: year - 1, month: 11 }
                : { year, month: month - 1 },
            )
          }
          onNextMonth={() =>
            setGridMonth(({ year, month }) =>
              month === 11
                ? { year: year + 1, month: 0 }
                : { year, month: month + 1 },
            )
          }
        />
      )}
      {openDay && view === "week" && (
        <DaySheet
          date={openDay}
          tasks={byDate.get(openDay) ?? []}
          onTaskClick={(id) => {
            setOpenDay(null);
            navigate(`/task/${id}`);
          }}
          onClose={() => setOpenDay(null)}
        />
      )}

      {/* Task list */}
      <div
        hidden={view !== "list"}
        className={selectedDate || isLoading || error ? "" : "mt-3"}
      >
        {visibleDates.map((dateStr) => (
          <div key={dateStr} className="mb-3">
            <div className="text-[13px] text-sub mb-2 px-1">
              {formatFullDate(dateStr)}
            </div>
            {groupedTasks[dateStr].map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                maxLabels={1}
                showDueBadge={false}
                onClick={() => navigate(`/task/${task.id}`)}
              />
            ))}
          </div>
        ))}

        {selectedDate && !groupedTasks[selectedDate] && (
          <div className="text-center py-8 text-[14px] text-dim">
            Нет задач на эту дату
          </div>
        )}
      </div>

      <TaskFilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filters={filters}
        setFilters={setFilters}
        projectOptions={projectFilterOptions}
        labelOptions={labelFilterOptions}
        assigneeOptions={assigneeFilterOptions}
      />
    </div>
  );
}
