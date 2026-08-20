// Shared task-editing field primitives used by TaskFormScreen (create AND
// edit — the same form component, see that file) and, for read-only
// display, by TaskDetailScreen. Built to match the "Новая задача" screen in
// mockup-reference/index.html (id="s-newtask", lines 1112–1201): a `.card`
// of `.row`s for Срок/Проект/Приоритет, a horizontally-tagged `.card` for
// Метки, and a `.card` add-row for Подзадачи. The mockup has no dedicated
// task-detail screen and no date/priority/label picker sheet, so the
// expand-in-place picker panels below (calendar, priority list, label
// create-row) follow the interaction pattern already accepted for the task
// form rather than inventing a modal.
import {
  useState,
  useRef,
  useEffect,
  useMemo,
  Children,
  type ReactNode,
  type CSSProperties,
} from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { Icon } from "./UI";
import {
  formatDueLabel,
  formatTimeRange,
  todayStr,
  tomorrowStr,
} from "../lib/date";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { PRIORITIES } from "../lib/priority";
import type { ApiLabel } from "../api/types";

// Re-exported so existing `import { PRIORITIES } from "../components/TaskFields"`
// call sites (TaskDetailScreen) keep working. ../lib/priority.ts is the
// canonical source now — see PRIORITY_COLORS/getPriorityColor there for
// the flat color-only form (for screens that just need a dot's color, not
// the full label/name/color metadata).
export { PRIORITIES };

// ═══════════ CARD (mockup .card — 14px radius, edge-to-edge dividers) ═══════════

export function Card({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="w-full bg-card rounded-2xl overflow-hidden">
      {items.map((child, i) => (
        <div key={i} className={i > 0 ? "border-t border-stroke" : ""}>
          {child}
        </div>
      ))}
    </div>
  );
}

// ═══════════ FIELD ROW (mockup .row — r-ic / r-tx / r-val / r-chev) ═══════════

export function FieldRow({
  icon,
  iconClassName = "text-sub",
  // Цвет иконки значением, а не классом — нужен там, где он берётся из
  // данных (цвет приоритета), а не из палитры Tailwind.
  iconStyle,
  label,
  value,
  valueClassName = "text-sub",
  trailing,
  chevron = true,
  chevronOpen = false,
  onClick,
  minHeight = 48,
}: {
  icon?: string;
  iconClassName?: string;
  iconStyle?: CSSProperties;
  label: string;
  value?: ReactNode;
  valueClassName?: string;
  trailing?: ReactNode;
  chevron?: boolean;
  chevronOpen?: boolean;
  onClick?: () => void;
  minHeight?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 text-left active:bg-white/[0.04] transition-colors"
      style={{ minHeight }}
    >
      {icon && (
        <Icon
          name={icon}
          size={18}
          className={`shrink-0 ${iconClassName}`}
          style={iconStyle}
        />
      )}
      <span className="text-[15px] font-medium text-text flex-1 min-w-0 truncate">
        {label}
      </span>
      {value !== undefined && (
        <span
          className={`text-[14px] shrink-0 ${typeof value === "string" ? valueClassName : ""}`}
        >
          {value}
        </span>
      )}
      {trailing}
      {chevron && (
        <Icon
          name={chevronOpen ? "chevronDown" : "chevron"}
          size={14}
          className="text-dim shrink-0"
        />
      )}
    </button>
  );
}

// ═══════════ PRIORITY ═══════════
// (PRIORITIES itself now lives in ../lib/priority.ts — imported + re-exported above.)

// Восстановлена 18.08.2026 — была удалена как «мёртвый код» после того, как
// TaskDetailScreen.tsx перестал её использовать в своей read-only карточке
// (Максим попросил там флажок+слово цветом вместо пилюли), но PriorityField
// ниже её всё ещё использует — свёрнутое состояние пикера в форме
// редактирования. grep по проекту тогда проверил только импорты СНАРУЖИ
// файла, не вызовы внутри него самого — вызвало ReferenceError и белый
// экран при открытии формы («Изменить», тухнет, серый фон»). Живой урок:
// «нигде не импортируется» и «нигде не используется» — разные проверки.
export function PriorityPill({ priority }: { priority: number }) {
  const p = PRIORITIES.find((x) => x.key === priority) ?? PRIORITIES[3];
  return (
    <span
      className="inline-flex items-center justify-center text-[11px] font-bold text-white rounded-[10px] px-2 h-[20px] min-w-[26px] shrink-0"
      style={{ backgroundColor: p.color }}
    >
      {p.label}
    </span>
  );
}

// mockup .p1-pill
export function PriorityField({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PRIORITIES.find((x) => x.key === value) ?? PRIORITIES[3];
  return (
    <>
      {/* Свёрнутый вид — как в детальной карточке: флажок и название
          приоритета его цветом, без пилюли (владелец 19.08.2026: «у нас
          же уже была правка, что пилюлю убираем, красится флаг и слово»).
          Раньше пилюля жила только здесь, и одно и то же значение
          выглядело в форме и в карточке по-разному. Сама PriorityPill
          осталась для развёрнутого списка ниже — там кружок с «P1»
          работает как маркер варианта, а не как способ показать текущее. */}
      <FieldRow
        icon="flag"
        iconStyle={{ color: current.color }}
        label="Приоритет"
        value={
          <span style={{ color: current.color }} className="font-medium">
            {current.name}
          </span>
        }
        chevronOpen={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="border-t border-stroke">
          {PRIORITIES.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                onChange(p.key);
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 py-3 px-4 text-left active:bg-white/[0.04] transition-colors"
            >
              <span
                className="w-[24px] h-[24px] rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                style={{ backgroundColor: p.color }}
              >
                {p.label}
              </span>
              <span className="text-[14px] text-text flex-1">{p.name}</span>
              {p.key === value && (
                <Icon name="check" size={16} className="text-red shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ═══════════ DUE DATE ═══════════

function miniCal(year: number, month: number) {
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return cells;
}

const CAL_MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

// ═══════════ ВРЕМЯ НАЧАЛА И ДЛИТЕЛЬНОСТЬ ═══════════
//
// 18.08.2026, под календарную развёртку раздела «День». Живёт ВНУТРИ
// «Срока» (см. DueDateField): владелец 19.08.2026 — «логично как-то это
// совместить, а то мне надо сначала выбрать срок, потом только
// открывается время». Время без даты сервер не примет, поэтому барабаны
// заблокированы, пока день не выбран.
//
// Ввод — БАРАБАНОМ, как в будильнике iPhone (просьба владельца
// 19.08.2026), а не рядами кнопок: первый заход кнопками занимал три
// ряда на экране и всё равно давал только шаг в 15 минут. Барабанов
// было два (часы и минуты) — с 19.08.2026 остался один, крутящий сразу
// время начала с шагом 15 минут, см. TimeWheel.
// Ровно шесть значений и одной строкой (владелец 19.08.2026): 90 минут и
// 4 часа убраны — с ними ряд переносился на вторую строку, а «полтора
// часа» на телефоне выбирают заметно реже остальных.
const DURATIONS = [15, 30, 45, 60, 120, 180];

/** Компактная подпись для кнопки в один ряд: «45м», «2ч». Полная форма
 *  («1 ч 30 мин») остаётся в строке поля, где места хватает. */
function shortDuration(min: number): string {
  return min < 60 ? `${min}м` : `${min / 60}ч`;
}

/** «90» → «1 ч 30 мин»; часы без остатка — просто «2 ч». */
export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

// ═══════════ Барабан времени: замеры с присланного скриншота ═══════════
//
// Владелец 19.08.2026 прислал IMG_8362.jpg («воспроизведи точно такую же
// вещь, прям анимации постараться»): барабан там НЕ плоский — строки
// лежат на цилиндре, к краям сжимаются и гаснут, а в центре стоит пилюля
// с ИНТЕРВАЛОМ «12:15—12:45», а не с одним временем.
//
// Все числа сняты с файла пипеткой и сканированием (скилл
// pixel-copy-from-screenshot), экран 1260×2736 @3x = 420×912pt, значит
// физические пиксели делятся на 3:
//
//   карточка барабана    1140×550px → 380×183.33pt, радиус 72px → 24pt
//   шаг центров строк      95px → 31.67pt в середине
//   шаг ЧЕРЕЗ ОДНУ         76px → 25.33pt  ← сжатие к краям, вот и «сфера»
//   пилюля               518×122px → 172.67×40.67pt, капсула
//   высота цифр            30px → 10pt (кегль ≈14pt)
//
// Сжатие шага 95→76 и есть доказательство цилиндра: у плоского списка шаг
// постоянный. Из двух шагов однозначно считается геометрия колеса —
// sin(2Δ)/sin(Δ) = 2cos(Δ) = 171/94.75 даёт Δ = 25.5°, а радиус
// R = 94.75/sin(25.5°) = 220px = 73.33pt. По этой же модели сходится и
// высота цифр в соседних строках: 28px против 30px в центре — это
// cos(25.5°) = 0.90, а через одну 18/30 = 0.6 против cos(51°) = 0.63.
const WHEEL_ANGLE = 25.5; // градусов между соседними строками
const WHEEL_R = 220 / 3; // радиус цилиндра, pt
const WHEEL_STEP = 95 / 3; // шаг центров в середине = R·sin(WHEEL_ANGLE)
const WHEEL_CARD_H = 550 / 3;
const WHEEL_PILL_W = 518 / 3;
const WHEEL_PILL_H = 122 / 3;
const WHEEL_CARD_R = 24;
// Прозрачность строк по удалению от центра — тоже замер, а не на глаз:
// самый светлый пиксель строки давал #A0A0A2 / #646466 / #3F3F41 на фоне
// карточки #2C2C2E. Обратный пересчёт через фон даёт ровно 1 / 0.48 /
// 0.16 (проверка: 44 + 0.48×(160−44) = 99.7 при замеренных 100).
const WHEEL_FADE = [1, 1, 0.48, 0.16, 0];
// Шаг барабана. 15 минут — как на скриншоте (11:45, 12:00, 12:15) и как
// у привязки при перетаскивании в сетке дня (DayHours, SNAP_MIN): одно и
// то же время не должно ходить разным шагом в двух местах приложения.
const TIME_STEP_MIN = 15;
// Лента продолжительности, замеры оттуда же: 1140×147px и капсула
// 164×115px при том же делении на 3.
const STRIP_H = 147 / 3;
const STRIP_CAP_W = 164 / 3;
const STRIP_CAP_H = 115 / 3;
// «Пройденная» заливка слева: тот же рост, что у капсулы (113px → 37.67pt),
// отступ от левого края ленты 24px → 8pt, и обрывается она за 10px → 3.33pt
// до капсулы, а не под ней — иначе вокруг капсулы читается ореол.
const STRIP_FILL_H = 113 / 3;
const STRIP_FILL_INSET = 8;
// Шлейф тает к началу ленты: у капсулы плотный, к левому краю сходит в
// ноль. Хвост, а не вторая пилюля — см. комментарий в разметке.
const STRIP_FILL_FADE =
  "linear-gradient(to right, transparent 0%, rgba(0,0,0,0.35) 18%, #000 55%, #000 100%)";

/** Прозрачность строки на расстоянии k шагов от центра (k дробное, пока
 *  барабан крутится) — линейная интерполяция замеренных узлов. */
function wheelOpacity(k: number): number {
  const a = Math.abs(k);
  const i = Math.floor(a);
  if (i >= WHEEL_FADE.length - 1) return 0;
  return WHEEL_FADE[i] + (WHEEL_FADE[i + 1] - WHEEL_FADE[i]) * (a - i);
}

/** Барабан времени начала с шагом 15 минут. В центральной пилюле стоит
 *  ИНТЕРВАЛ — «12:15—12:45», конец считается из выбранной длительности,
 *  поэтому крутить нужно один барабан, а не два (владелец 19.08.2026:
 *  «изначально выбираешь интервал, а потом мотаешь один барабан, он уже
 *  сразу с учётом этого»).
 *
 *  Прокрутка и отрисовка РАЗДЕЛЕНЫ: невидимый слой сверху даёт нативную
 *  инерцию и залипание (scroll-snap), а видимые строки рисует абсолютный
 *  слой по формуле цилиндра. Так сделано намеренно — если вместо этого
 *  крутить сами строки в потоке и накладывать на них rotateX, поток и
 *  трансформация складываются, и шаг перестаёт совпадать с замеренным.
 *  Здесь же положение каждой строки считается ровно как y = R·sin(kΔ), а
 *  сжатие по высоте — cos(kΔ), то есть числа со скриншота воспроизводятся
 *  буквально. */
function TimeWheel({
  minutes,
  duration,
  onChange,
  disabled,
}: {
  /** Время начала в минутах от полуночи, кратное шагу барабана. */
  minutes: number;
  /** Длительность для подписи интервала; null — показываем одно время. */
  duration: number | null;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0); // дробный индекс под центром
  const items = useMemo(
    () =>
      Array.from(
        { length: (24 * 60) / TIME_STEP_MIN },
        (_, i) => i * TIME_STEP_MIN,
      ),
    [],
  );
  const idx = Math.max(0, Math.round(minutes / TIME_STEP_MIN));

  // Встать на выбранное значение без анимации: барабан должен ОКАЗАТЬСЯ на
  // месте при открытии поля, а не ехать туда на глазах.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = idx * WHEEL_STEP;
    if (Math.abs(el.scrollTop - target) > 1) {
      el.scrollTop = target;
      setOffset(idx);
    }
  }, [idx]);

  // Кадр прокрутки: положение читаем через rAF, иначе на каждый пиксель
  // прокрутки шла бы перерисовка состояния формы.
  const frame = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleScroll() {
    if (disabled) return;
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const el = scrollRef.current;
        if (el) setOffset(el.scrollTop / WHEEL_STEP);
      });
    }
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      const next = items[Math.round(el.scrollTop / WHEEL_STEP)];
      if (next !== undefined && next !== minutes) onChange(next);
    }, 90);
  }
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const pad = (WHEEL_CARD_H - WHEEL_STEP) / 2;
  const center = Math.round(offset);
  // Рисуем только то, что попадает на видимую часть цилиндра: дальше
  // строки всё равно погашены до нуля (WHEEL_FADE).
  const span = WHEEL_FADE.length - 1;

  return (
    <div
      className="relative overflow-hidden"
      style={{
        height: WHEEL_CARD_H,
        borderRadius: WHEEL_CARD_R,
        background: "var(--color-card2)",
        // Перспектива не декоративная: без неё дальние строки сжимались бы
        // ровно по cos, но не «уходили» вглубь, и колесо читалось бы как
        // гармошка. Значение — из радиуса цилиндра, чтобы искажение
        // соответствовало его размеру.
        perspective: `${WHEEL_R * 8}px`,
      }}
    >
      {/* Пилюля выбранного интервала — под строками, они пишутся поверх. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 bg-red"
        style={{
          width: WHEEL_PILL_W,
          height: WHEEL_PILL_H,
          borderRadius: WHEEL_PILL_H / 2,
          transform: "translate(-50%, -50%)",
        }}
      />

      <div className="pointer-events-none absolute inset-0">
        {Array.from({ length: span * 2 + 1 }, (_, n) => center - span + n)
          .filter((i) => i >= 0 && i < items.length)
          .map((i) => {
            const k = i - offset;
            const rad = (k * WHEEL_ANGLE * Math.PI) / 180;
            const op = wheelOpacity(k);
            if (op <= 0.01) return null;
            const near = Math.abs(k) < 0.5; // строка в пилюле
            const end = items[i] + (duration ?? 0);
            return (
              <div
                key={i}
                className={`absolute inset-x-0 flex items-center justify-center text-[14px] tabular-nums ${
                  near ? "font-semibold text-white" : "text-sub"
                }`}
                style={{
                  top: WHEEL_CARD_H / 2 + WHEEL_R * Math.sin(rad),
                  // translateY(-50%) центрирует строку на своей отметке, а
                  // scaleY(cos) даёт то самое сжатие к краям: замеренные
                  // 28px и 18px высоты цифр против 30px в центре.
                  transform: `translateY(-50%) scaleY(${Math.cos(rad).toFixed(4)})`,
                  opacity: op,
                }}
              >
                {near && duration
                  ? `${formatMinutes(items[i])}—${formatMinutes(end % (24 * 60))}`
                  : formatMinutes(items[i])}
              </div>
            );
          })}
      </div>

      {/* Невидимый слой прокрутки поверх всего: он и ловит палец. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        aria-label="Время начала"
        className={`absolute inset-0 overflow-y-auto ${
          disabled ? "pointer-events-none opacity-40" : ""
        }`}
        style={{
          scrollSnapType: "y mandatory",
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div style={{ height: pad }} />
        {items.map((m) => (
          <div
            key={m}
            onClick={() => onChange(m)}
            style={{ height: WHEEL_STEP, scrollSnapAlign: "center" }}
          />
        ))}
        <div style={{ height: pad }} />
      </div>
    </div>
  );
}

/** «735» → «12:15». Барабан и пилюля печатают время только так. */
function formatMinutes(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Продолжительность — одной лентой-капсулой, как на присланном скрине:
 *  все значения видны разом, активное сидит в капсуле, а всё, что левее
 *  него, залито «пройденным» фоном. Замеры: лента 1140×147px →
 *  380×49pt, капсула 164×115px → 54.67×38.33pt, заливка слева #524040 при
 *  фоне ленты #2C2C2E. */
function DurationStrip({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const activeIdx = value == null ? -1 : DURATIONS.indexOf(value);
  return (
    <div
      className={`relative flex overflow-hidden ${
        disabled ? "pointer-events-none opacity-40" : ""
      }`}
      style={{
        height: STRIP_H,
        borderRadius: STRIP_H / 2,
        background: "var(--color-card2)",
      }}
    >
      {/* Шлейф «пройденного» — ХВОСТ, выходящий из капсулы, а не второй
          самостоятельный элемент. Владелец 19.08.2026 по первому заходу:
          «не две пилюли разные, а как-то как шлейф идти должен» — там
          заливка обрывалась перед капсулой скруглённым правым краем и
          читалась как отдельная пилюля.
          Поэтому: правый край ПРЯМОЙ и уходит под капсулу (до центра
          активной зоны), скругление только слева, а к началу ленты шлейф
          сходит на нет маской — как и положено хвосту. */}
      {activeIdx >= 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-0"
          style={{
            top: (STRIP_H - STRIP_FILL_H) / 2,
            height: STRIP_FILL_H,
            marginLeft: STRIP_FILL_INSET,
            width: `calc(${((activeIdx + 0.5) / DURATIONS.length) * 100}% - ${
              STRIP_FILL_INSET
            }px)`,
            background:
              "color-mix(in srgb, var(--color-red) 22%, var(--color-card2))",
            borderRadius: `${STRIP_FILL_H / 2}px 0 0 ${STRIP_FILL_H / 2}px`,
            maskImage: STRIP_FILL_FADE,
            WebkitMaskImage: STRIP_FILL_FADE,
          }}
        />
      )}
      {DURATIONS.map((d, i) => (
        <button
          key={d}
          type="button"
          // Повторный тап снимает длительность — так её можно не только
          // поставить, но и передумать, не убирая время целиком.
          onClick={() => onChange(value === d ? null : d)}
          className="relative flex-1 text-[13px] font-medium tabular-nums"
        >
          {i === activeIdx && (
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 bg-red"
              style={{
                width: STRIP_CAP_W,
                height: STRIP_CAP_H,
                borderRadius: STRIP_CAP_H / 2,
                transform: "translate(-50%, -50%)",
              }}
            />
          )}
          {/* Три состояния подписи, и все три — замер эталона, а не вкус:
              активная белая; попавшая НА заливку светлее обычной
              (#8B7B7C на #524040 = белый с прозрачностью 0.32); все
              остальные — ровный #6E6E70, то есть наш --color-dim.
              Затухания крайних значений в эталоне НЕТ — я его сначала
              добавил «для мягкости», и на первом же скриншоте владельца
              «15м» оказалось нечитаемым: к нему сложились и затемнение
              крайнего, и тёмный фон заливки. */}
          <span
            className={`relative ${
              i === activeIdx ? "text-white" : i < activeIdx ? "" : "text-dim"
            }`}
            style={
              i < activeIdx ? { color: "rgba(255,255,255,0.32)" } : undefined
            }
          >
            {shortDuration(d)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function DueDateField({
  value,
  onChange,
  // Время живёт ЗДЕСЬ же, внутри «Срока», а не отдельной строкой ниже
  // (владелец 19.08.2026: «логично как-то это совместить, а то мне надо
  // сначала выбрать срок, потом только открывается время»). Первый заход
  // был отдельной строкой «Время», которая появлялась лишь после того,
  // как задан срок, — владелец её просто не нашёл при создании задачи.
  // Пропсы необязательные: без них поле ведёт себя как раньше, только с
  // датой (так его зовут экраны, где время ни к чему).
  time,
  duration,
  onTimeChange,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  time?: string | null;
  duration?: number | null;
  onTimeChange?: (time: string | null, duration: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const base = value
    ? new Date(value + "T00:00:00")
    : new Date(todayStr() + "T00:00:00");
  const [calYear, setCalYear] = useState(base.getFullYear());
  const [calMonth, setCalMonth] = useState(base.getMonth());

  const cells = miniCal(calYear, calMonth);
  const today = todayStr();
  const tomorrow = tomorrowStr();
  const hasValue = !!value;
  const withTime = !!onTimeChange;

  // «Сегодня, 18 авг. · 14:30 · 1 ч 30 мин» — дата и время одной строкой,
  // чтобы состояние читалось не открывая поле.
  // Интервалом, а не «начало + длительность» отдельно: см. formatTimeRange
  // — владельцу нужно видеть, во сколько он освободится, без сложения в
  // уме. Длительность в строке больше не дублируется: «13:45—14:30» её и
  // так задаёт.
  const rowValue = !hasValue
    ? "Не установлен"
    : time
      ? `${formatDueLabel(value!)} · ${formatTimeRange(time, duration)}`
      : formatDueLabel(value!);

  return (
    <>
      <FieldRow
        icon="calendarSmall"
        iconClassName={hasValue ? "text-red" : "text-sub"}
        label={withTime ? "Срок и время" : "Срок"}
        value={rowValue}
        valueClassName={hasValue ? "text-red" : "text-sub"}
        chevronOpen={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="border-t border-stroke px-3 py-3">
          {/* Быстрые опции */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => {
                onChange(today);
                // Панель остаётся открытой, когда в ней есть барабаны
                // времени: закрыть её сразу после выбора дня — значит
                // спрятать время, ради которого поле и объединили.
                if (!withTime) setOpen(false);
              }}
              className={`flex-1 h-[40px] rounded-xl text-[13px] font-medium transition-colors ${
                value === today
                  ? "bg-red text-white"
                  : "bg-card2 text-text active:bg-white/10"
              }`}
            >
              Сегодня
            </button>
            <button
              onClick={() => {
                onChange(tomorrow);
                if (!withTime) setOpen(false);
              }}
              className={`flex-1 h-[40px] rounded-xl text-[13px] font-medium transition-colors ${
                value === tomorrow
                  ? "bg-red text-white"
                  : "bg-card2 text-text active:bg-white/10"
              }`}
            >
              Завтра
            </button>
          </div>

          {/* Календарь для произвольной даты */}
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() =>
                calMonth === 0
                  ? (setCalMonth(11), setCalYear(calYear - 1))
                  : setCalMonth(calMonth - 1)
              }
              className="p-1.5 -m-1.5"
            >
              <Icon name="chevronLeft" size={16} className="text-sub" />
            </button>
            <span className="text-[13px] font-semibold">
              {CAL_MONTHS[calMonth]} {calYear}
            </span>
            <button
              onClick={() =>
                calMonth === 11
                  ? (setCalMonth(0), setCalYear(calYear + 1))
                  : setCalMonth(calMonth + 1)
              }
              className="p-1.5 -m-1.5"
            >
              <Icon name="chevron" size={16} className="text-sub" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0">
            {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((d) => (
              <div key={d} className="text-center text-[10px] text-dim py-1">
                {d}
              </div>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const ds = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const selected = ds === value;
              return (
                <button
                  key={i}
                  onClick={() => {
                    onChange(ds);
                    if (!withTime) setOpen(false);
                  }}
                  className={`h-[32px] text-[13px] rounded-full transition-all ${
                    selected
                      ? "bg-red text-white font-semibold"
                      : "text-text active:bg-card2"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {withTime && (
            <div className="mt-3 border-t border-stroke pt-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[12px] text-sub">Во сколько</span>
                {!hasValue && (
                  <span className="text-[11px] text-dim">
                    сначала выберите день
                  </span>
                )}
              </div>
              {/* Один барабан вместо двух: время начала крутится с шагом
                  15 минут, а конец берётся из длительности и пишется тут
                  же, в пилюле («12:15—12:45»). Отдельного барабана минут
                  больше нет — он и был причиной того, что на выбор
                  получаса уходили два жеста. */}
              <TimeWheel
                minutes={
                  time
                    ? Number(time.split(":")[0]) * 60 +
                      Number(time.split(":")[1])
                    : 9 * 60
                }
                duration={duration ?? null}
                disabled={!hasValue}
                onChange={(m) =>
                  onTimeChange!(
                    formatMinutes(m),
                    // Длительность НЕ подставляем: «сколько займёт»
                    // владелец может не знать (19.08.2026 — «если я не
                    // знаю, сколько займёт, просто указал время»). Поле
                    // необязательное и в базе, и в API.
                    duration ?? null,
                  )
                }
              />

              {/* Продолжительность показывается сразу, как выбран день, а
                  не только после касания барабана: барабан и так стоит на
                  09:00, и пустое место под ним читалось как «время уже
                  задано, а длительности почему-то нет». Тап по значению
                  заодно фиксирует время, которое барабан показывает. */}
              {hasValue && (
                <>
                  <div className="mt-3 mb-2 text-[12px] text-sub">
                    Продолжительность
                  </div>
                  <DurationStrip
                    value={duration ?? null}
                    onChange={(d) => onTimeChange!(time ?? "09:00", d)}
                  />
                </>
              )}
            </div>
          )}

          {hasValue && (
            <button
              onClick={() => {
                onChange(null);
                // Дата ушла — время осиротело: сервер не примет время без
                // срока, поэтому снимаем оба разом.
                onTimeChange?.(null, null);
                setOpen(false);
              }}
              className="mt-1 w-full py-2 text-center text-[13px] text-sub"
            >
              {time ? "Убрать дату и время" : "Убрать дату"}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ═══════════ LABELS (mockup .tags-row / .tag-pill-2) ═══════════

export function LabelsField({
  labels,
  selectedIds,
  onToggle,
  onCreate,
}: {
  labels: ApiLabel[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onCreate: (name: string) => void | Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  // `saving` here is display-only (spinner/disabled styling) — the actual
  // re-entrancy guard against a double tap creating the label twice is
  // useGuardedCallback's synchronous ref below, not this state.
  const [saving, setSaving] = useState(false);

  const submit = useGuardedCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    setSaving(true);
    try {
      await onCreate(trimmed);
      setName("");
      setCreating(false);
    } finally {
      setSaving(false);
    }
  });

  return (
    <div className="w-full bg-card rounded-2xl overflow-hidden">
      <div className="flex flex-wrap gap-2 px-4 py-3">
        {labels.map((l) => {
          const active = selectedIds.includes(l.id);
          return (
            <button
              key={l.id}
              onClick={() => onToggle(l.id)}
              className="inline-flex items-center gap-1 text-[12px] font-semibold rounded-[10px] px-3 py-2 transition-colors"
              style={{
                backgroundColor: active
                  ? l.color + "26"
                  : "rgba(255,255,255,.08)",
                color: active ? l.color : "#A6A6A6",
              }}
            >
              {active && <Icon name="check" size={11} />}
              {l.name}
            </button>
          );
        })}
        {/* Кнопка «+ новая» убрана 19.08.2026 по решению владельца: метки
            заводятся в настройках («Метки»), и второй вход сюда же плодил
            дубли — «я в настройках себе выставляю, а оно двоится». Здесь
            остаётся только ВЫБОР из уже заведённых. Механизм создания
            (creating/onCreate ниже) не удалён: им пользуется экран меток,
            а удалять рабочий код ради одной скрытой кнопки — лишний риск,
            уже наступали (см. историю PriorityPill выше в этом файле). */}
      </div>
      {creating && (
        <div className="border-t border-stroke flex items-center gap-2 px-4 py-2.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                setCreating(false);
                setName("");
              }
            }}
            placeholder="Название метки"
            className="flex-1 min-w-0 bg-transparent text-[16px] text-text placeholder:text-dim outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red/40"
          />
          <button
            onClick={submit}
            disabled={!name.trim() || saving}
            className="p-2 -m-1 shrink-0 disabled:opacity-40"
          >
            <Icon name="check" size={18} className="text-red" />
          </button>
          <button
            onClick={() => {
              setCreating(false);
              setName("");
            }}
            className="p-2 -m-1 shrink-0"
          >
            <Icon name="x" size={16} className="text-dim" />
          </button>
        </div>
      )}
      {labels.length === 0 && !creating && (
        <div className="px-4 pb-3 -mt-1 text-[12px] text-dim">
          Меток пока нет
        </div>
      )}
    </div>
  );
}

// ═══════════ SUBTASKS (mockup .card add-row) ═══════════

// Строка подзадачи в форме «Изменить»: переименовать и удалить.
// Отмечать выполненной здесь НЕЛЬЗЯ (решение Максима 15.08.2026) — для
// этого есть лента подзадач в самой карточке; в форме переключатель только
// загромождал строку. Признак готовности остаётся видимым: галочка слева.
export function SubtaskRow({
  title,
  done,
  onRename,
  onDelete,
  dragHandleListeners,
  dragHandleAttributes,
  setDragHandleRef,
  isDragging,
}: {
  title: string;
  done: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
  // Перетаскивание — см. SortableSubtaskRow в TaskFormScreen.tsx. Опционально:
  // без dnd-kit-обёртки (create-mode ещё без id, или будущий вызов без
  // переупорядочивания) строка просто не получает ручку и ведёт себя как
  // раньше.
  dragHandleListeners?: DraggableSyntheticListeners;
  dragHandleAttributes?: DraggableAttributes;
  setDragHandleRef?: (el: HTMLElement | null) => void;
  isDragging?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  const commit = () => {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) onRename(trimmed);
    else setValue(title);
  };

  return (
    // Owner 2026-08-13 (седьмой заход): px-4 убран — тот же рассинхрон, что
    // и у AddSubtaskRow ниже (его комментарий разбирает причину подробно):
    // здесь этот отступ был нужен, пока строка стояла внутри Card-рамки
    // (убрана пятым заходом), сейчас это просто лишний сдвиг вправо
    // относительно title/desc textarea и остальных лейблов формы.
    <div
      className={`relative flex items-center gap-3 py-3 ${isDragging ? "opacity-40" : ""}`}
    >
      {dragHandleListeners && (
        // Тот же приём, что у BoardCard на доске (TaskBoard.tsx): ручка —
        // отдельный элемент, перетаскивание стартует только с неё, тап по
        // остальной строке (переименование, `input`) не задет. touch-none —
        // чтобы палец не начинал скролл раньше, чем dnd-kit распознает драг.
        //
        // absolute, НЕ в потоке: строка (её родитель наследует px-4 формы,
        // своего отступа не имеет — см. комментарий выше) не может отдать
        // ручке место в потоке, не сдвинув текст вправо относительно
        // AddSubtaskRow и textarea названия — ровно та рассинхронизация,
        // которую семь заходов правок этого файла как раз убирали. Ручка
        // вместо этого встаёт в сам px-4 gutter слева от строки: left:-16px
        // (=-px-4) до 0 — ровно ширина этого отступа, ни пикселем в текст.
        // Хуже 44×44 канона (TaskFilterButton и т.п.), но шире отступа
        // взять некуда, не сдвинув текст всей формы — цена этого выбора.
        <div
          ref={setDragHandleRef}
          {...dragHandleAttributes}
          {...dragHandleListeners}
          className="absolute left-[-16px] top-0 bottom-0 w-4 flex items-center justify-center touch-none text-dim active:text-sub"
          aria-label="Перетащить подзадачу"
        >
          <Icon name="grip" size={12} />
        </div>
      )}
      {/* Кружка-переключателя здесь нет (решение Максима 15.08.2026): это
          раздел «Изменить», в нём подзадачи правят и удаляют, а отмечают
          выполненными в самой карточке. Лишний элемент только загружал
          строку. Галочка у уже выполненной остаётся — она несёт смысл,
          показывая, что шаг закрыт. */}
      {done && <Icon name="check" size={14} className="text-green shrink-0" />}
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setValue(title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-[16px] text-text outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red/40"
        />
      ) : (
        <button
          onClick={() => {
            setValue(title);
            setEditing(true);
          }}
          className="flex-1 min-w-0 text-left"
        >
          <span
            className={`text-[14px] ${done ? "line-through text-sub" : "text-text"}`}
          >
            {title}
          </span>
        </button>
      )}
      <button onClick={onDelete} className="p-2 -m-1 shrink-0">
        <Icon name="x" size={14} className="text-dim" />
      </button>
    </div>
  );
}

// New-subtask input row — mockup's "Добавить подзадачу..." row (48px).
// Owner 2026-08-13 (шестой заход, типографика): decorative gray-bordered
// circle placeholder removed on request — this row is a plain text input,
// not a checkable subtask (those already have their own real circle, see
// SubtaskRow above). Text size dropped 16px to 13px, the "мелкий" (content)
// size the whole form's typography now converges on — see the comment on
// TaskFormScreen's title textarea for the full two-size rationale.
// Седьмой заход: px-4 тоже убран — этот отступ был правильным, пока строка
// стояла ВНУТРИ Card-рамки (bg-card/rounded, убрана пятым заходом): там он
// был внутренним отступом от края плашки. Без рамки он стал просто лишним
// сдвигом вправо относительно title/desc textarea (владелец это и заметил
// — «подзадача начинается в одном месте, описание в другом»). Теперь этот
// ряд наследует общий px-4 родителя формы, как и всё остальное.
//
// value/onChange опциональны и подняты в TaskFormScreen (owner 2026-08-13:
// кнопка диктовки должна писать и сюда, не только в title/desc) — когда
// они переданы, поле становится controlled и родитель может вставлять в
// него надиктованный текст; без них компонент ведёт себя как раньше
// (собственный локальный state), поэтому существующие вызовы не ломаются.
// onFocus/onBlur наружу — тем же способом, каким title/desc уже сообщают
// MicKeyboardBar, в каком поле сейчас курсор.
export function AddSubtaskRow({
  onAdd,
  value: controlledValue,
  onChange: controlledOnChange,
  onFocus,
  onBlur,
}: {
  onAdd: (title: string) => void;
  value?: string;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [localValue, setLocalValue] = useState("");
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : localValue;
  const setValue = isControlled ? controlledOnChange! : setLocalValue;
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue("");
  };
  return (
    // Owner 2026-08-13 (девятый заход, замер, полная переверка по прямому
    // требованию владельца — «всё посчитать»): было minHeight:48 с
    // items-center — тач-таргет 48px, унаследованный от времён, когда
    // строка стояла внутри Card (там центрирование в фикс-высоте было
    // уместно). Три итерации живого замера (getBoundingClientRect) после
    // переезда в общий поток:
    //   1) items-center+minHeight:48 → «Подзадачи»→поле = 22px, не
    //      совпадало с «Заметка»→«Описание» = 12px (эталон был сам неточным,
    //      см. ниже);
    //   2) py-3 (тот же ритм что у SubtaskRow) → 20px, верхний padding
    //      добавлял то, чего нет у textarea (та начинается от верха поля
    //      без своего отступа);
    //   3) pb-3 (только нижний) → 8px сверху (корректно, целиком из mb-2
    //      лейбла) — но 28px СНИЗУ до «Заметка», потому что pb-3 (12px)
    //      складывался с mb-4 родительского wrapper блока подзадач (16px),
    //      двойной источник отступа, тогда как «Название»→mb-4 и
    //      «Описание»→mb-4 дают ровно 16px без дублирования.
    // Итог: mb-4 вместо pb-3 — margin, не padding, тот же приём, что у
    // textarea названия/описания (весь нижний отступ — margin последнего
    // элемента, родительский div больше своего mb не добавляет, см. правку
    // рядом в TaskFormScreen.tsx). Заодно эталон «Заметка»→«Описание» был
    // сам занижен на 4px лишним <span> в разметке лейбла (line-box давал
    // div.bottom ниже текста) — после его удаления оба зазора честно
    // совпадают на 8px.
    <div className="flex items-center gap-3 mb-4">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="Добавить подзадачу..."
        className="flex-1 min-w-0 bg-transparent text-[13px] text-sub placeholder:text-sub outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red/40"
      />
      {value.trim() && (
        <button onClick={submit} className="p-2 -m-1 shrink-0">
          <Icon name="check" size={16} className="text-red" />
        </button>
      )}
    </div>
  );
}
