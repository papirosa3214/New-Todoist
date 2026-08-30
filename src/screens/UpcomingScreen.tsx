import { useState, useMemo, useRef, useEffect } from "react";
import { useOpenTask } from "../lib/useOpenTask";
import { useTasks, useUpdateTask } from "../api/tasks";
import { useProjects } from "../api/projects";
import { useAgents } from "../api/agents";
import {
  Icon,
  ScreenHeader,
  ErrorBanner,
  Loading,
  findScrollContainer,
} from "../components/UI";
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
import {
  DayHours,
  DayColumnsHeader,
  type DayColumnData,
} from "../components/DayHours";
import { todayStr, MONTHS_SHORT, addDays } from "../lib/date";
import { isAgentAssignedTask } from "../lib/taskOwner";
import { TaskRow } from "../components/TaskRow";
import { AppleCalendarEvents } from "../components/AppleCalendarEvents";
import {
  TaskFilterButton,
  TaskFilterSheet,
} from "../components/TaskFilterSheet";
import { PlannerProjectChips } from "../components/PlannerProjectChips";
import {
  DEFAULT_TASK_FILTERS,
  filterTasks,
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

// Свайп-раскрытие/сворачивание календаря в виде «список» («за краюшек»,
// владелец 22.08.2026: кнопка остаётся, но должен работать и жест — тянем
// нижнюю кромку: месяц-раскрытый — вверх на сворачивание, неделя-свернутая —
// вниз на разворачивание). Порог засчитывания переключения и нижний предел
// высоты при перетаскивании (неделя + ручка-кромка).
const CAL_DRAG_THRESHOLD = 48;
const CAL_DRAG_MIN_H = 36;

// Понедельник недели, которой принадлежит `d` (getDay() отдаёт 0 =
// воскресенье). Осталось для weekDates ниже — база selectedDate/today.
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
  // Стартовая точка для месяца — читается ОДИН раз (initial state), сам
  // список недель дальше живёт своей жизнью внутри MonthGrid (континуальный
  // скролл, 20.08.2026: «нужно, чтобы бесконечный скролл был вниз-вверх,
  // тоже месяца менялись»). gridMonth ниже теперь не источник данных для
  // сетки, а только зеркало «что сейчас видно» — MonthGrid сообщает об
  // этом сам через onVisibleMonthChange, для заголовка в шапке.
  const [monthGridInitialMonday] = useState(() => weekStartOf(todayStr()));
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
  // Ранее здесь был ribbonAnchor (старт ленты недель) — лента заменена
  // полноширинной месячной сеткой (22.08.2026), якорь больше не нужен.
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // Активная дата при скролле списка — та, чей sticky-заголовок сейчас
  // под шапкой; по ней в свёрнутой полосе бежит красное свечение и полоса
  // сама прокручивается к этому числу (владелец 22.08.2026: «листаю от
  // 22 до 24 — свечение бежит по числам полосы»).
  const [activeDate, setActiveDate] = useState<string | null>(null);

  const { data: allTasks = [], isLoading, error } = useTasks();
  const { data: agents = [] } = useAgents();
  // Цвет блока в сетке часов и назначение времени перетаскиванием — вид
  // «Три дня» ниже, перенесённый со «Сегодня» (20.08.2026).
  const { data: projects = [] } = useProjects();
  const updateTask = useUpdateTask();
  const openTask = useOpenTask();
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Агентские задачи сюда не попадают вовсе (19.08.2026, владелец: «кроме
  // как во входящих в конкретном проекте, нигде маячить не должна» —
  // Предстоящее не исключение). См. isAgentAssignedTask.
  // This screen only ever renders tasks that have a due_date >= today
  // (просроченные задачи отображаются на экране «Сегодня», в «Предстоящих»
  // отображаются только сегодняшние и будущие задачи).
  // Шаг 2 (feature/projects-decouple-planner-merge): симметрично с
  // TodayScreen.plannerTasks — по умолчанию только задачи без проекта
  // (т.е. «Входящие»), проектные задачи попадают, только если их
  // проект есть в plannerVisibleProjects.
  const visibleProjectIds = useAppStore((s) => s.plannerVisibleProjects);
  const togglePlannerVisibleProject = useAppStore(
    (s) => s.togglePlannerVisibleProject,
  );
  const datedTasks = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          !isAgentAssignedTask(t, agents) &&
          t.due_date &&
          t.due_date >= today &&
          (!t.project_id || !!visibleProjectIds[t.project_id]),
      ),
    [allTasks, agents, today, visibleProjectIds],
  );

  // Шаг 2 фикс (blocker 2, @local-macbook): раньше *FilterOptions здесь
  // строились от datedTasks, который после Шага 1/2 отражает ТОЛЬКО то,
  // что сейчас показано (входящие + видимые проекты с будущей датой).
  // Фильтр «Проект» в шторке не предлагал проекты, которые юзер ещё НЕ
  // добавил в раздел — picker их показывает, фильтр нет. Здесь берём
  // полный allTasks, отфильтрованный только по тем же «разделам
  // экрана», что и datedTasks: агентские задачи и просроченные
  // исключаем (их в «Предстоящем» не было и не будет — фильтровать по
  // ним бессмысленно). Проект-фильтр НЕ применяем, чтобы фильтр
  // «Проект» отражал «что МОЖНО сузить», а не «что сужено сейчас».
  const optionDatedTasks = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          !isAgentAssignedTask(t, agents) && t.due_date && t.due_date >= today,
      ),
    [allTasks, agents, today],
  );
  const projectFilterOptions = useMemo(
    () => buildProjectOptions(optionDatedTasks),
    [optionDatedTasks],
  );
  const labelFilterOptions = useMemo(
    () => buildLabelOptions(optionDatedTasks),
    [optionDatedTasks],
  );
  const assigneeFilterOptions = useMemo(
    () => buildAssigneeOptions(optionDatedTasks),
    [optionDatedTasks],
  );

  const tasks = useMemo(
    () => filterTasks(datedTasks, filters),
    [datedTasks, filters],
  );
  // Раскладка по дням для календарных видов — один проход по списку
  // вместо фильтра на каждую из 42 ячеек месяца.
  const byDate = useMemo(() => groupByDate(tasks), [tasks]);

  // Данные для DayHours (вид «Три дня») — три колонки от сегодня, без
  // своей навигации, ровно как было на «Сегодня» до переезда 20.08.2026
  // (владелец: «перенос кода без каких-либо изменений»). В отличие от
  // «Сегодня» здесь НЕТ понятий «просрочено»/«ждут вас» — это семантика
  // того экрана, сюда её тащить не нужно: все три дня, включая
  // сегодняшний, берут задачи одинаково, просто по due_date (byDate уже
  // отфильтрован и уже без агентских задач — см. activeTasks выше).
  const hourDays: DayColumnData[] = useMemo(
    () =>
      [0, 1, 2].map((i) => {
        const date = addDays(today, i);
        return { date, tasks: byDate.get(date) ?? [], isToday: date === today };
      }),
    [today, byDate],
  );

  // Полноширинная месячная сетка (22.08.2026): 42 ячейки (6 недель)
  // от понедельника недели, содержащей 1-е число ВЫБРАННОГО месяца
  // (pickerMonth/pickerYear — тот же источник, что у ленты и заголовка).
  const { bigMonthDays, bigMonthYear, bigMonthMonth } = useMemo(() => {
    const y = pickerYear;
    const m = pickerMonth;
    const first = new Date(y, m, 1);
    const dow = first.getDay(); // 0 = вс
    const lead = dow === 0 ? 6 : dow - 1; // понедельник — первый день
    const start = new Date(y, m, 1 - lead);
    const days = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
    return { bigMonthDays: days, bigMonthYear: y, bigMonthMonth: m };
  }, [pickerYear, pickerMonth]);

  // Полоса недели в свёрнутом виде — 7 дней НЕДЕЛИ АКТИВНОЙ ДАТЫ (как в
  // Todoist/CRM): при скролле списка активный день едет по полосе, и
  // неделя полосы перестраивается за ним. База — activeDate (или сегодня).
  const activeWeekDays = useMemo(() => {
    const baseDate = activeDate
      ? new Date(activeDate + "T00:00:00")
      : todayDate;
    const dow = baseDate.getDay(); // 0 = вс
    const monday = new Date(baseDate);
    monday.setDate(baseDate.getDate() - (dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [activeDate]);

  // Название месяца над полосой недели — по четвергу активной недели
  // (месяц, которому принадлежит большая часть недели).
  function formatMonthOfWeek(days: Date[]): string {
    if (!days.length) return "";
    const thu = days[3] ?? days[0];
    return `${MONTHS_ABBR_DOT[thu.getMonth()]} ${thu.getFullYear()}`;
  }

  // ═══ Отслеживание активной даты при скролле списка (22.08.2026) ═══
  const activeScrollRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const sc =
      (calInnerRef.current ? findScrollContainer(calInnerRef.current) : null) ||
      (document.querySelector(".overflow-y-auto") as HTMLElement | null);
    if (!sc) return;
    activeScrollRef.current = sc;

    const onScroll = () => {
      const headers = Array.from(
        sc.querySelectorAll("[data-date-header]"),
      ) as HTMLElement[];
      if (!headers.length) return;

      const calBottom = calOuterRef.current
        ? calOuterRef.current.getBoundingClientRect().bottom
        : 140;

      let currentHeader: HTMLElement | null = null;
      for (const el of headers) {
        const top = el.getBoundingClientRect().top;
        if (top <= calBottom + 30) {
          currentHeader = el;
        }
      }
      if (!currentHeader && headers.length > 0) {
        currentHeader = headers[0];
      }
      const d = currentHeader?.getAttribute("data-date-header");
      if (d) {
        setActiveDate((prev) => (prev === d ? prev : d));
      }
    };

    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, [tasks, view]);

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
  // Горизонтальная лента дней месяца в свёрнутом виде — для автопрокрутки
  // к активной дате при скролле списка (22.08.2026).
  const weekStripRef = useRef<HTMLDivElement>(null);
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

  // ═══ Свайп-раскрытие календаря («за краюшек», 22.08.2026) ═══
  // Палец цепляется за нижнюю ручку-кромку и тянет её:
  //  • тянем вниз — контент сразу становится МЕСЯЦЕМ, высота растёт за пальцем;
  //  • тянем вверх — контент сразу становится НЕДЕЛЕЙ, высота падает за пальцем.
  // В конце (отпускании) высота плавно добирается до целевой через CSS-
  // transition. Владельцу важно: и сворачивание, и разворачивание должны быть
  // плавными («зажав и плавно тянуть»), и при свернутом — название месяца
  // остаётся видимым сверху (см. WeekMonthLabel ниже).
  const [dragging, setDragging] = useState(false);
  const [dragStartH, setDragStartH] = useState<number | null>(null);
  const dragAnchorY = useRef(0);
  const fullHRef = useRef(0);
  // Синхронный флаг для обработчиков: setState батчится (движения мыши
  // приходят до ре-рендера), поэтому проверка `dragging` из state в
  // calDragMove/calDragEnd видела бы СТАРОЕ значение — жест бы не начался.
  // Реф виден синхронно; state нужен только для отключения transition.
  const draggingRef = useRef(false);

  function calDragStart(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    const el = calOuterRef.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragAnchorY.current = e.clientY;
    // Потолок высоты — с запасом: при старте с НЕДЕЛИ (88px) нельзя
    // ограничиваться её высотой, иначе развернуть в месяц не удалось бы
    // (лимит = высота недели). Берём величину с запасом, а окончательную
    // высоту решает calDragEnd (плавный добор до месяца/недели).
    fullHRef.current = Math.max(el.getBoundingClientRect().height, 700);
    setDragStartH(el.getBoundingClientRect().height);
    draggingRef.current = true;
    setDragging(true);
  }

  function calDragMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || dragStartH == null) return;
    const dy = e.clientY - dragAnchorY.current;
    // Контент НЕ переключается посреди жеста — тянется текущий вид
    // (месяц сжимается / неделя растягивается). Переключение на неделю/
    // месяц происходит ТОЛЬКО в calDragEnd по превышению порога — иначе
    // при первых же 8px палец «терял» месяц и тащил пустоту (замечание
    // владельца 22.08.2026: «сразу недельное представление, а я потом
    // пустоту задвигаю»).
    // Высота ВСЕГДА следует за пальцем от СТАРТОВОЙ точки, без прыжков.
    const next = Math.min(
      fullHRef.current,
      Math.max(CAL_DRAG_MIN_H, dragStartH + dy),
    );
    setCalAnimHeight(next);
  }

  function triggerHaptic() {
    if (typeof window !== "undefined" && (window as any).Capacitor) {
      import("@capacitor/haptics").then(({ Haptics, ImpactStyle }) => {
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      });
    }
  }

  // ═══ Горизонтальный свайп полосы недели: статичный, переключает недели с тактильным откликом ═══
  const stripDraggingRef = useRef(false);
  const stripStartXRef = useRef(0);
  const stripStartYRef = useRef(0);
  const stripIsHorizontalRef = useRef<boolean | null>(null);

  function onStripPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    stripStartXRef.current = e.clientX;
    stripStartYRef.current = e.clientY;
    stripIsHorizontalRef.current = null;
    stripDraggingRef.current = true;
  }

  function onStripPointerMove(e: React.PointerEvent) {
    if (!stripDraggingRef.current) return;
    const dx = e.clientX - stripStartXRef.current;
    const dy = e.clientY - stripStartYRef.current;
    if (stripIsHorizontalRef.current === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        stripIsHorizontalRef.current = Math.abs(dx) > Math.abs(dy) * 1.3;
      }
    }
  }

  function onStripPointerUp(e: React.PointerEvent) {
    if (!stripDraggingRef.current) return;
    stripDraggingRef.current = false;
    if (!stripIsHorizontalRef.current) return;

    const dx = e.clientX - stripStartXRef.current;
    if (Math.abs(dx) >= 45) {
      triggerHaptic();
      const curBase = activeDate
        ? new Date(activeDate + "T00:00:00")
        : todayDate;
      const shiftDays = dx < 0 ? 7 : -7;
      const newDate = new Date(curBase);
      newDate.setDate(curBase.getDate() + shiftDays);
      const newDateStr = formatDateStr(
        newDate.getFullYear(),
        newDate.getMonth(),
        newDate.getDate(),
      );
      setActiveDate(newDateStr);
      // Не блокируем список одной датой, чтобы весь список оставался открытым и скроллился
      setSelectedDate(null);
      // Подскролливаем список задач к началу новой недели
      requestAnimationFrame(() => {
        const sc = activeScrollRef.current;
        if (!sc) return;
        const target = sc.querySelector<HTMLElement>(
          `[data-date-header="${newDateStr}"]`,
        );
        if (target) {
          const hh =
            parseFloat(
              getComputedStyle(sc).getPropertyValue("--screen-header-h"),
            ) || 0;
          const top =
            target.getBoundingClientRect().top -
            sc.getBoundingClientRect().top +
            sc.scrollTop -
            hh -
            4;
          sc.scrollTo({ top, behavior: "smooth" });
        }
      });
    }
  }

  function calDragEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const dy = e.clientY - dragAnchorY.current;
    draggingRef.current = false;
    setDragging(false); // снова включаем CSS-transition — плавный добор
    const exceeded = Math.abs(dy) > CAL_DRAG_THRESHOLD;
    const goMonth = calMode === "week" && dy > 0;
    const goWeek = calMode === "month" && dy < 0;
    if (exceeded && (goMonth || goWeek)) {
      triggerHaptic();
      // Доезжаем до целевой высоты — анимация через calAnimHeight:
      // changeMode сам замерит старую высоту и анимирует переход.
      if (goWeek) changeMode("week");
      else changeMode("month");
    } else {
      // Откат: плавно вернуть к intrinsic высоте ТЕКУЩЕГО контента.
      requestAnimationFrame(() => {
        const inner = calInnerRef.current;
        if (inner) setCalAnimHeight(inner.getBoundingClientRect().height);
      });
    }
  }

  // Срабатывает ПОСЛЕ покраски кадра, в котором calMode уже сменился, но
  // высота ещё зажата под старое значение (см. changeMode выше) — то есть
  // ровно тот граничный кадр, что нужен CSS-transition для старта. rAF —
  // дополнительная страховка кадровой границы поверх гарантии useEffect.
  // Меряет calInnerRef (без ограничений) — НЕ calOuterRef.
  // Во время drag (draggingRef) НЕ срабатывает: высоту ведёт сам жест.
  useEffect(() => {
    if (calIsFirstRender.current) {
      calIsFirstRender.current = false;
      return;
    }
    if (draggingRef.current) return; // высотой управляет drag-жест
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

  // Последовательные даты вперёд на год (365 дней) + даты с задачами
  const visibleDates = useMemo(() => {
    if (selectedDate) {
      return [selectedDate];
    }
    const datesSet = new Set<string>();

    // Просроченные даты с задачами
    Object.keys(groupedTasks).forEach((d) => {
      if (d < today) datesSet.add(d);
    });

    // Непрерывная лента дней от сегодня на 365 дней вперёд
    const base = new Date(today + "T00:00:00");
    for (let i = 0; i < 365; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      datesSet.add(formatDateStr(d.getFullYear(), d.getMonth(), d.getDate()));
    }

    // Задачи дальше 365 дней (если есть)
    Object.keys(groupedTasks).forEach((d) => datesSet.add(d));

    return Array.from(datesSet).sort();
  }, [selectedDate, groupedTasks, today]);

  // Week view dates (Mon-based week containing the selected date, falling
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
    setSelectedDate(null);
  }

  function goToday() {
    setPickerYear(todayDate.getFullYear());
    setPickerMonth(todayDate.getMonth());
    setSelectedDate(null);
    setMonthPickerOpen(false);
  }

  // Общие кнопки шапки — используются и лёгкой шапкой «три дня», и полным
  // календарным хромом ниже, чтобы не держать одну и ту же разметку в двух
  // местах (см. оба места использования).
  const headerActions = (
    <>
      <TaskFilterButton onClick={() => setFilterSheetOpen(true)} />
      {/* Кнопка сворачивания/разворачивания календаря-ленты убрана
          (27.08.2026, владелец: «зачем она, у меня для этого жест уже
          есть») — вертикальный свайп по ленте (calDragStart, см. ниже)
          вызывает changeMode() напрямую и делает то же самое; отдельная
          toggleCalMode() была только у этой кнопки — удалена вместе с ней. */}
      {/* Виды экрана — под тремя точками, ровно как в «Сегодня»
          (19.08.2026: «под троеточие спрячь список, доска, один
          день, три дня»). Список, неделя, месяц — плюс «Три дня»
          (calendarSmall уже занята «Неделей», поэтому clock —
          сетка часов), переехавшая сюда со «Сегодня» 20.08.2026. */}
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
            ["hours", "Три дня", "clock"],
          ] as const
        ).map(([key, label, icon]) => ({
          icon,
          label: (
            <span className={view === key ? "font-semibold text-red" : ""}>
              {label}
            </span>
          ),
          onClick: () => setView(key),
        }))}
      />
    </>
  );

  return (
    <div className="px-4 pb-4">
      {/* «Три дня» — своя, не обёрнутая в sticky-хром шапка, ТОЧНО как у
          «Сегодня» (владелец 20.08.2026: «шапка должна быть статичной, а
          не растягиваться вместе с таблицей, и затухание — на краю
          шапки»). Раньше этот вид шёл через тот же sticky-блок, что
          список/неделя/месяц, ниже — а ScreenHeader сам по себе `position:
          fixed`, не sticky (см. UI.tsx): вложенный в sticky-родителя, он
          измерял свои left/width от родителя, который ещё «не прилип» на
          старте скролла — отсюда и «растягивание». У списка/недели/месяца
          так и оставлено: там в этом же блоке ещё лента календаря
          (calOuterRef) и попап месяца, обёртка им нужна взаправду. */}
      {view === "hours" ? (
        <ScreenHeader
          title="Планирование"
          below={<DayColumnsHeader days={hourDays} />}
          actions={headerActions}
        />
      ) : (
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
            title="Планирование"
            // !mb-0: у ScreenHeader встроено mb-4 (16px) — общий отступ под
            // всеми шапками. На этом экране календарь-лента живёт внутри
            // того же sticky-блока и обязан начинаться СРАЗУ под шапкой,
            // иначе образуется «много пустого места между Предстоящее и
            // Августом» (владелец 22.08.2026). В Tailwind v4 важность —
            // суффикс «!».
            className="!mb-0"
            // Какой месяц смотрим — строкой под заголовком, внутри шапки:
            // так её накрывает общее затухание, и высота шапки, от которой
            // считается высота сетки, пересчитывается автоматически.
            below={
              view === "week" ? (
                <WeekMonthLabel monday={gridMonday} />
              ) : view === "month" ? (
                <MonthHeaderLabel
                  year={gridMonth.year}
                  month={gridMonth.month}
                />
              ) : undefined
            }
            actions={headerActions}
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
            style={{
              height: calAnimHeight,
              // Пока тянем — отключаем CSS-transition (иначе высота
              // «догоняла» бы палец с лагом 280мс → рваные движения).
              transition: dragging ? "none" : undefined,
            }}
            // Tailwind's scanner needs a complete, literal class token in the
            // source text — an interpolated `duration-[${N}ms]` would never
            // match and the utility would silently not be generated
            // (transition falling back to 0s, instant). duration-[280ms] is
            // written out literally here — the single source of truth for
            // that number, see the "ВЫБРАНО" note above.
            className={`relative overflow-hidden transition-[height] duration-[280ms] motion-reduce:transition-none ${
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

                  {/* Месяц — ПРОСТО ЧИСЛА на всю ширину экрана, как недельная полоса
                                      (владелец 22.08.2026: «месячный был уже и меньший шрифт,
                                      сделай одинаковыми — просто числа, не надо ячеек»).
                                      Крупный шрифт как в неделе, 7 колонок = вся ширина. */}
                  <div className="grid grid-cols-7 gap-0 py-1">
                    {bigMonthDays.map((d) => {
                      const dateStr = formatDateStr(
                        d.getFullYear(),
                        d.getMonth(),
                        d.getDate(),
                      );
                      const firstOfMonth = d.getDate() === 1;
                      const isToday = dateStr === today;
                      const isSel = dateStr === selectedDate;
                      const hasTasks = (groupedTasks[dateStr]?.length ?? 0) > 0;
                      const isFilled = isSel || isToday;
                      // Дни не текущего месяца — приглушены
                      const dim =
                        d.getFullYear() !== bigMonthYear ||
                        d.getMonth() !== bigMonthMonth;
                      return (
                        <button
                          key={dateStr}
                          data-date={dateStr}
                          onClick={() =>
                            setSelectedDate(isSel ? null : dateStr)
                          }
                          className="min-h-[44px] w-full flex flex-col items-center justify-center gap-[2px] py-1 transition-all active:scale-90"
                        >
                          {firstOfMonth && (
                            <span
                              className={`text-[10px] leading-none ${
                                isFilled ? "text-red" : "text-sub"
                              }`}
                            >
                              {MONTHS_ABBR_DOT[d.getMonth()]}
                            </span>
                          )}
                          <span
                            className={`text-[16px] leading-none w-[30px] h-[30px] rounded-full flex items-center justify-center ${
                              isFilled
                                ? "bg-red text-white font-semibold"
                                : dim
                                  ? "text-dim/50"
                                  : hasTasks
                                    ? "text-text"
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
                /* Свёрнутый вид — ПОЛОСА НЕДЕЛИ (7 дней), как в Todoist/CRM
                               (владелец 22.08.2026): лента идёт по дням,
                               при скролле списка активный день едет по
                               полосе — неделя полосы следует за ним.
                               Сверху — название месяца активной недели. */
                <>
                  <div className="relative flex items-center justify-between pt-1 pb-0.5 px-1">
                    <span className="text-[13px] font-semibold text-red">
                      {formatMonthOfWeek(activeWeekDays)}
                    </span>
                  </div>
                  <div
                    ref={weekStripRef}
                    onPointerDown={onStripPointerDown}
                    onPointerMove={onStripPointerMove}
                    onPointerUp={onStripPointerUp}
                    onPointerCancel={onStripPointerUp}
                    className="flex justify-between px-1 pb-2 pt-1 gap-1 select-none"
                    style={{ touchAction: "pan-y" }}
                  >
                    {activeWeekDays.map((d) => {
                      const date = formatDateStr(
                        d.getFullYear(),
                        d.getMonth(),
                        d.getDate(),
                      );
                      const dow = d.getDay(); // 0 = вс
                      const short = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][
                        dow
                      ];
                      const isActive =
                        activeDate === date ||
                        (activeDate == null && date === today);
                      const isToday = date === today;
                      const hasTasks = (groupedTasks[date]?.length ?? 0) > 0;
                      return (
                        <button
                          key={date}
                          data-strip-day={date}
                          onClick={() =>
                            setSelectedDate(date === selectedDate ? null : date)
                          }
                          className={`relative flex h-[46px] w-[44px] shrink-0 flex-col items-center justify-center rounded-2xl transition-all ${
                            isActive && !isToday
                              ? "bg-red/15 ring-1 ring-red/30"
                              : ""
                          }`}
                        >
                          {/* Красное свечение позади активного числа —
                                              «размытое пятнышко», бегущее по числам.
                                              Не рисуем под кружком «сегодня». */}
                          {isActive && !isToday && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-0 rounded-full"
                              style={{
                                background:
                                  "radial-gradient(circle, rgba(255,59,48,0.28) 0%, transparent 70%)",
                              }}
                            />
                          )}
                          <span
                            className={`relative text-[10px] font-medium uppercase ${
                              isActive || isToday ? "text-red" : "text-sub"
                            }`}
                          >
                            {short}
                          </span>
                          <span
                            className={`relative text-[15px] font-medium ${
                              // Сегодня — ВСЕГДА красный кружок (как
                              // было изначально); свечение — только у
                              // активной даты скролла, если это не
                              // сегодня (иначе кружок с ней конфликтует).
                              isToday
                                ? "flex h-[28px] w-[28px] items-center justify-center rounded-full bg-red text-white"
                                : isActive
                                  ? "text-red font-semibold"
                                  : date === selectedDate
                                    ? "text-text font-semibold"
                                    : "text-text"
                            }`}
                          >
                            {d.getDate()}
                          </span>
                          {hasTasks && !isActive && (
                            <span className="relative h-[4px] w-[4px] rounded-full bg-red" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Ручка-кромка — ТОЛЬКО в виде «Список» (владелец 22.08.2026:
                      «мы правим только список, а не неделю и месяц — отдельные
                      виды, а ты ручку поставил везде»). В неделе и месяце это
                      полноценные отдельные вкладки, им свайп-кромка не нужна. */}
          {view === "list" && (
            <div
              onPointerDown={calDragStart}
              onPointerMove={calDragMove}
              onPointerUp={calDragEnd}
              onPointerCancel={calDragEnd}
              style={{
                touchAction: "none", // не отдавать вертикальный жест скроллу
                cursor: "row-resize",
              }}
              data-cal-handle
              className="group -mx-4 flex h-5 items-center justify-center"
            >
              {/* Сама полоска-«защёлка» — узкая, в цвет фона календаря,
                          с лёгким откликом при нажатии. */}
              <div className="h-[4px] w-9 rounded-full bg-stroke transition-opacity group-active:opacity-70" />
            </div>
          )}

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
      )}

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
          onTaskClick={openTask}
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
          initialMonday={monthGridInitialMonday}
          byDate={byDate}
          openDay={openDay}
          // Повторный тап по тому же дню сворачивает полосу.
          onDayClick={(d) => setOpenDay((prev) => (prev === d ? null : d))}
          onTaskClick={openTask}
          // Список недель — внутреннее дело MonthGrid (continuous-scroll,
          // 20.08.2026); он лишь сообщает, что сейчас основное на экране,
          // для заголовка «Август» в шапке ниже.
          onVisibleMonthChange={(year, month) => setGridMonth({ year, month })}
        />
      )}
      {/* «Три дня» — почасовая сетка, перенесённая со «Сегодня» 20.08.2026
          (владелец: «перенос кода без каких-либо изменений... всё
          абсолютно там настроено, просто нужно сменить локацию»).
          DayHours — тот же компонент, что рисовал 1-дневную сетку на
          «Сегодня», просто теперь получает три колонки вместо одной. */}
      {view === "hours" && (
        <DayHours
          days={hourDays}
          projectColor={(t) =>
            projects.find((p) => p.id === t.project_id)?.color || "#717171"
          }
          onTaskClick={openTask}
          // Перетащили задачу на шкалу — назначаем и время, и дату колонки,
          // куда отпустили; длительность 15 минут (SNAP_MIN), если её
          // раньше не было — та же логика, что была на «Сегодня», см.
          // комментарий у одноимённого onSchedule в TodayScreen.tsx.
          onSchedule={(id, date, time) => {
            const task = allTasks.find((t) => t.id === id);
            updateTask.mutate({
              id,
              start_time: time,
              due_date: date,
              ...(task?.duration_min == null ? { duration_min: 15 } : null),
            });
          }}
        />
      )}
      {openDay && view === "week" && (
        <DaySheet
          date={openDay}
          tasks={byDate.get(openDay) ?? []}
          onTaskClick={(id) => {
            setOpenDay(null);
            openTask(id);
          }}
          onClose={() => setOpenDay(null)}
          onPrevDay={() => {
            const d = new Date(openDay + "T00:00:00");
            d.setDate(d.getDate() - 1);
            setOpenDay(
              formatDateStr(d.getFullYear(), d.getMonth(), d.getDate()),
            );
          }}
          onNextDay={() => {
            const d = new Date(openDay + "T00:00:00");
            d.setDate(d.getDate() + 1);
            setOpenDay(
              formatDateStr(d.getFullYear(), d.getMonth(), d.getDate()),
            );
          }}
        />
      )}

      {/* Task list */}
      <div
        hidden={view !== "list"}
        className={selectedDate || isLoading || error ? "" : "mt-3"}
      >
        {visibleDates.map((dateStr) => (
          <div key={dateStr} className="mb-3">
            {/* Sticky-заголовок даты: липнет под шапкой при скролле списка
                задач, активная (текущая) дата — с красным свечением-пятном
                (владелец 22.08.2026: «дата перемещается... текущая дата
                осталась, а красненькое размытое пятнышко шло за той
                датой, на которой я остановился»). top учитывает высоту
                шапки (--screen-header-h), чтобы не прятаться под неё.
                Скрыт при выбранной дате (27.08.2026, владелец: «тыкаю на
                календаре — та же подпись дублируется») — «Selected date
                indicator» (красная плашка выше) уже показывает то же
                самое, а список в этом режиме и так ровно из одной группы,
                sticky-слежению за скроллом тут нечего делать. */}
            {!selectedDate && (
              <div
                data-date-header={dateStr}
                className={`sticky z-10 -mx-4 mb-2 flex items-center gap-2 px-4 py-1 ${
                  dateStr === today ? "text-red" : "text-sub"
                }`}
                style={{
                  top: "var(--screen-header-h, 0px)",
                  // Свечение позади активной даты: мягкое красное пятно,
                  // размытое, как и просил владелец.
                  ...(dateStr === today
                    ? {
                        background:
                          "radial-gradient(120px 28px at 50% 50%, rgba(255,59,48,0.18), transparent 70%)",
                      }
                    : {}),
                  backdropFilter: dateStr === today ? "blur(2px)" : undefined,
                  WebkitBackdropFilter:
                    dateStr === today ? "blur(2px)" : undefined,
                }}
              >
                <span className="text-[13px] font-semibold">
                  {formatFullDate(dateStr)}
                </span>
              </div>
            )}
            <AppleCalendarEvents dateStr={dateStr} className="mb-2" />
            {(groupedTasks[dateStr] ?? []).map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                maxLabels={1}
                showDueBadge={false}
                onClick={() => openTask(task.id)}
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

      <PlannerProjectChips
        projects={projects}
        visibleProjectIds={visibleProjectIds}
        onAdd={() => setFilterSheetOpen(true)}
      />

      <TaskFilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filters={filters}
        setFilters={setFilters}
        projectOptions={projectFilterOptions}
        labelOptions={labelFilterOptions}
        assigneeOptions={assigneeFilterOptions}
        plannerProjects={{
          projects,
          visibleProjectIds,
          onToggle: togglePlannerVisibleProject,
          defaultOpenSection: "planner",
        }}
      />
    </div>
  );
}
