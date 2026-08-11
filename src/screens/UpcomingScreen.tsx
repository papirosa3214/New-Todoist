import { useState, useMemo, useRef, useEffect, type TouchEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import { todayStr } from "../lib/date";
import { getPriorityColor } from "../lib/priority";
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

// Свайп по ручке-засечке короче этого порога (px по Y) считается тапом —
// его обрабатывает обычный onClick, а не сам touch-хэндлер.
const SWIPE_THRESHOLD = 24;

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
  const navigate = useNavigate();

  const tasks = useMemo(
    () => allTasks.filter((t) => t.status === "active"),
    [allTasks],
  );

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

  // Единая точка входа для месяц↔неделя — дёргают и кнопка в шапке, и
  // ручка-засечка (клик/свайп), поэтому оба управления не могут разойтись:
  // это один и тот же вызов над одним и тем же состоянием. Меряет ТЕКУЩУЮ
  // (ещё старую) высоту ВНЕШНЕГО блока ДО смены calMode и фиксирует её как
  // явный height — это стартовая точка анимации, см. useEffect ниже.
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
      changeMode("week");
    } else if (dy >= SWIPE_THRESHOLD && calMode !== "month") {
      e.preventDefault();
      changeMode("month");
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
      <div
        ref={stickyRef}
        /* -mx-4 px-4: этот блок несёт собственный фон и живёт внутри
           родительского px-4, поэтому без компенсации его фон обрывался в
           16px от краёв экрана и прокручивающиеся карточки проглядывали в
           щелях (замер 11.08.2026: ширина 358 при экране 390, на остальных
           вкладках ScreenHeader растягивается сам). Отрицательное поле
           тянет фон до краёв, внутренний padding возвращает содержимому
           прежние отступы — заголовок и кнопки не сдвигаются. */
        className="sticky top-0 z-20 -mx-4 px-4 bg-bg border-b border-stroke shadow-[0_10px_16px_-12px_rgba(0,0,0,.55)]"
      >
        <ScreenHeader
          title="Предстоящее"
          actions={
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
          }
        />

        {/* Единственный смонтированный вид (лента недель ИЛИ одна неделя,
            по ternary — как и было изначально). Высота анимируется через
            явный height, зафиксированный в calAnimHeight (см.
            changeMode/useEffect выше); обычные ре-рендеры (навигация по
            месяцам через попап) height не трогают — он остаётся
            undefined/auto, так что строка с переходом месяца всегда
            показывает точную высоту без анимации, как раньше. */}
        <div
          ref={calOuterRef}
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
                            className={`text-[9px] leading-none ${
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
                                : hasTasks
                                  ? "text-text"
                                  : "text-dim"
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
              className="absolute z-40 flex items-center gap-1 bg-card border border-stroke rounded-lg shadow-lg p-1"
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
