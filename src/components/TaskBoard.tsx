// ═══════════ TASK BOARD ═══════════
// Shared "список ↔ доска" board layout for Inbox and Today. Deliberately
// dumb/presentational: it only knows how to lay out whatever columns it's
// handed, not where those columns come from — the two screens build very
// different column sets (Inbox: one column per project; Today: exactly
// "Просрочено" / "Сегодня", never by project — direct product decision)
// with different header furniture (Inbox: a plain trailing count; Today's
// "Просрочено" folds its count into the title text itself and adds a
// "Перенести" button). Both screens now give every column a footer
// "Добавить задачу" pill (Today's "Сегодня" column; every Inbox project
// column, including "Без проекта") — a single generic component keeps that
// difference in the screens, not duplicated here.
//
// Columns scroll horizontally as a group (the screen itself never scrolls
// sideways — see overflow-x-auto below, scoped to this strip only). Column
// width is fixed so the next column's edge peeks in on a 390px phone,
// hinting there's more to the right; a board reduced to a single column
// (e.g. Today with no overdue tasks) instead goes full-width — a lone
// 260px column floating in the middle of the screen would look broken.
//
// ─── Drag-and-drop (added — reorder + cross-column move) ───
// One deliberate crack in "dumb/presentational" above: InboxScreen.tsx and
// TodayScreen.tsx are off-limits to this change (parallel agents own them),
// so there is no caller-supplied callback this component could delegate
// persistence to — TaskBoard talks to the API directly (api.patch + a
// single queryClient.invalidateQueries(["tasks"]) once a drop settles).
// That is the one place this file stops being "dumb"; every other decision
// below still only reads props/data it's already handed, nothing about
// "Inbox" or "Today" by name.
//
// What a drop does, decided from data already on BoardColumn/ApiTask:
//  - Reordering inside one column always works — it only ever touches this
//    task's own `position` (server/src/db.ts's additive migration; NULL
//    until the first drag, see sortByPosition below).
//  - Moving a card to a DIFFERENT column additionally writes project_id —
//    but only when the whole board is "project-shaped". The signal for
//    that is `dotColor`: Inbox sets it on every column (a project's real
//    color, or the dim placeholder for "Без проекта" — see InboxScreen.tsx);
//    Today's status columns never set it (see the BoardColumn.dotColor
//    doc below). So: `columns.every(c => c.dotColor !== undefined)` is the
//    single flag that turns cross-column drops into a project_id write.
//    Today fails that check (no column sets dotColor) — a card dragged
//    toward another Today column just snaps back into place, same as
//    dropping it in its own column at an unchanged index: no lie, because
//    nothing about a status column is a stored field a drag could rewrite
//    ("Ждут вас" is derived from agent_state + creator_id, which this app
//    never rewrites by hand — see AGENT-PROTOCOL.md; "Просрочено"/"Сегодня"
//    already have a dedicated control for that, the "Перенести" button).
//  - The one Inbox-specific literal this file knows: `"__none"` is the
//    sentinel InboxScreen.tsx uses for its "Без проекта" column id (grepped
//    the repo — it's the only synthetic BoardColumn id there is). Dropping
//    onto that column writes project_id: null instead of the string
//    "__none". If a future board ever reuses dotColor for something else,
//    this mapping would need a real per-column hook instead — flagged here
//    on purpose so it isn't missed.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, Avatar, AgentStateTag, PriorityArrows, ReadyFlag } from "./UI";
import { MarkdownInline } from "./MarkdownInline";
import { MONTHS_SHORT } from "../lib/date";
import { useTapGuard } from "../lib/useTapGuard";
import { hapticCross, hapticDrop, hapticGrab } from "../lib/haptics";
import { api } from "../api/client";
import type { ApiTask } from "../api/types";

function formatCompactDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// Sentinel InboxScreen.tsx uses for its "no project" column — see the
// file-header note above. Kept as one named constant instead of a bare
// string sprinkled through the drag handlers below.
const NO_PROJECT_COLUMN_ID = "__none";

// A column's cards, ordered for display: manual `position` wins when set
// (ascending — lower drags above higher), ties/NULLs fall back to
// whatever order the column already arrived in (each screen's own default:
// Inbox groups tasks in fetch order, Today's "Просрочено" is pre-sorted by
// due_date, "Сегодня" and "Ждут вас" keep their own — see those screens).
// Array.prototype.sort is a stable sort (guaranteed since ES2019), so two
// NULL positions never swap relative to each other here.
function sortByPosition(tasks: ApiTask[]): ApiTask[] {
  return [...tasks].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

export interface BoardColumn {
  id: string;
  // Exact header text — callers compose it fully themselves (e.g. Inbox
  // passes a bare project name; Today's overdue column passes "Просрочено
  // 8" as one string, per the product screenshot showing the count folded
  // into the label rather than a separate pill).
  title: string;
  // Leading dot before the title, in the column's own real color (a
  // project's `color` from the API). Status columns (Просрочено/Сегодня)
  // have no such color and omit this — they signal meaning through
  // titleClassName instead, mirroring exactly how the list layout already
  // styles those two labels (TodayScreen.tsx: red for overdue, sub for
  // today's date).
  //
  // Drag-and-drop reads this same flag as "is this column a project" —
  // see the file header. Set it (a real color, or a placeholder like
  // "var(--color-dim)") on EVERY column of a board for cards to become
  // droppable across columns there; leave it unset on every column for a
  // reorder-only board. Don't set it on some columns of a board and not
  // others — that's not a shape this component's drag logic handles.
  dotColor?: string;
  titleClassName?: string;
  // Separate trailing count pill, right-aligned — Inbox's project columns
  // only. Today's columns fold their count into `title` (Просрочено) or
  // show none at all (Сегодня), so this stays unset there.
  trailingCount?: number;
  tasks: ApiTask[];
  // Whether every card's due-date badge should use the list's existing
  // "overdue" red style (bg-red/15 text-red) or the neutral one. A
  // column-level flag, not per-card, because both current uses are
  // column-uniform: every card in "Просрочено" is overdue, none in
  // "Сегодня" or in an Inbox project column is.
  dueBadgeVariant?: "default" | "overdue";
  // Show each card's own project chip. Off for Inbox (the column already
  // *is* the project — repeating it on every card would be noise); on for
  // Today (its columns cut across projects, so the chip is the only place
  // that context still shows).
  showProjectBadge?: boolean;
  // Extra control in the header's right slot, e.g. Today's red "Перенести"
  // button on the overdue column.
  headerAction?: ReactNode;
  // Rendered below the column's cards (or its empty-state box), e.g.
  // Today's "Добавить задачу" pill under "Сегодня".
  footer?: ReactNode;
}

function BoardCard({
  task,
  overdue,
  showProjectBadge,
  onClick,
  dragListeners,
  dragAttributes,
  isDragging,
}: {
  task: ApiTask;
  overdue: boolean;
  showProjectBadge: boolean;
  onClick: () => void;
  // Undefined outside a DndContext (the DragOverlay preview renders a bare
  // BoardCard with no drag wiring needed — see TaskBoard below).
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  isDragging?: boolean;
}) {
  const isDone = task.status === "completed";
  const doneSub = task.subtasks.filter((s) => s.done).length;
  const label = task.labels[0];
  const hasFooter =
    !!task.due_date ||
    task.subtasks.length > 0 ||
    !!label ||
    (showProjectBadge && !!task.project_name);

  // Открываем задачу только на настоящем тапе: если палец ехал (прокрутка
  // колонок вбок или страницы вниз почти всегда начинается пальцем на
  // карточке), клик гасится. См. useTapGuard.
  const tap = useTapGuard(onClick);

  return (
    <button
      {...tap}
      {...(dragAttributes ?? {})}
      {...(dragListeners ?? {})}
      // pt-2 против pb-3 — намеренная асимметрия ОТСТУПОВ ради симметрии
      // ВОЗДУХА (владелец 19.08.2026: «посчитай расстояние от верха плашки
      // до первого слова и от последней метки до низа — они должны быть
      // одинаковыми, выровняй по нижней части»).
      // Замер до: сверху до рисунка аватарки 16pt и до текста 19pt, снизу
      // до кромки пилюль 12pt. Причина перекоса не в padding — он был
      // ровно 12/12, — а в том, что у аватарки внутри PNG своё поле ~4pt,
      // а нижние пилюли прижаты к своей кромке вплотную. Padding снизу
      // трогать нельзя (там всё уже ровно), поэтому убавлен верхний.
      //
      // Перетаскивание — ВСЕЙ карточкой (Максим 26.08.2026: «зажимаю
      // карточку и перетаскиваю», грип-точки убраны). На тач-устройстве
      // жест разводит TouchSensor (delay 200мс — см. sensors ниже): тап
      // открывает задачу, движение сразу — прокрутка, удержание — захват.
      // touchAction: manipulation, а не touch-none — иначе палец на
      // карточке не мог бы прокручивать колонку вовсе (тот же приём, что
      // у плашек DayHours). Синтетический клик после завершённого drag
      // гасит useTapGuard — палец двигался, значит это был не тап.
      style={{ touchAction: "manipulation", WebkitTouchCallout: "none" }}
      className={`tap-row w-full text-left bg-card rounded-xl px-3 pb-3 pt-2 flex items-stretch gap-1 ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        {/* gap-3 (12px), not gap-2 — owner 2026-08-13, tenth pass: dot size
            got unified to 18px everywhere in the first pass, but this row's
            own gap to the title text was missed, left at 8px while every
            other place that shows this same dot (TaskRow, SearchScreen,
            LabelTasksScreen, TaskDetailScreen — both spots) already used
            12px. Owner noticed the text sitting at a different distance
            from the dot depending on which screen/view showed the same
            task — this was the one outlier. */}
        <div className="w-full">
          {/* Проект — верхней строкой над названием, решётка плюс
              цветной текст без заливки. */}
          {showProjectBadge && task.project_name && (
            <div
              className="mb-1 inline-flex min-w-0 max-w-full items-center gap-1 text-[10px] font-medium leading-none"
              style={{ color: task.project_color || "#A6A6A6" }}
            >
              <Icon name="hash" size={9} className="shrink-0" />
              <span className="truncate">{task.project_name}</span>
            </div>
          )}

          {/* Строка названия с аватаркой исполнителя (если назначен) */}
          <div className="w-full flex items-center gap-1.5 min-w-0">
            {task.assignee_id && task.assignee_initials && (
              <Avatar
                initials={task.assignee_initials}
                color={task.assignee_color || "#A6A6A6"}
                avatar_url={task.assignee_avatar_url}
                size={18}
              />
            )}
            <div
              className={`text-[13px] leading-snug line-clamp-2 flex-1 min-w-0 ${isDone ? "line-through text-sub" : "text-text"}`}
            >
              <MarkdownInline source={task.title} />
            </div>
          </div>

          {/* Описание */}
          {task.description && (
            <div className="text-[11px] text-sub truncate mt-0.5">
              <MarkdownInline source={task.description} />
            </div>
          )}

          {/* Статус агента — сразу после заметки, своей строкой, просто
              цветное слово без плашки (Максим 26.08.2026: «после заметки…
              и фон не ставится, просто цветное слово»). Из футер-ряда
              пилюль убран — см. hasFooter выше. */}
          {task.agent_state && (
            <div className="mt-0.5">
              <AgentStateTag task={task} compact plain />
            </div>
          )}
        </div>
        {hasFooter && (
          <div className="w-full flex items-center gap-1.5 flex-wrap">
            {task.subtasks.length > 0 && (
              <span className="text-[10px] text-sub shrink-0 font-medium">
                {doneSub}/{task.subtasks.length}
              </span>
            )}
            {/* Поднятый флаг готовности и приоритет — прямо на карточке
                доски: владелец 11.09.2026 не должен проваливаться в каждую
                задачу, чтобы понять, подтверждена она или нет. */}
            {task.ready_for_pickup ? <ReadyFlag size={10} /> : null}
            <PriorityArrows priority={task.priority} size={8} />
            {task.due_date && (
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                  overdue ? "bg-red/15 text-red" : "bg-card2 text-sub"
                }`}
              >
                <Icon name="calendarSmall" size={9} />
                {formatCompactDate(task.due_date)}
              </span>
            )}
            {/* Статус агента был здесь пилюлей — переехал под заметку
                отдельной строкой (Максим 26.08.2026), см. выше. */}
            {label && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0"
                style={{
                  backgroundColor: label.color + "26",
                  color: label.color,
                }}
              >
                <Icon name="tag" size={9} />
                {label.name}
              </span>
            )}
            {/* Проект отсюда убран — он теперь над названием, см. выше. */}
          </div>
        )}
      </div>
    </button>
  );
}

// Wraps BoardCard with dnd-kit's per-item sortable hook. The whole card
// still receives `transform`/`transition` (so it slides out of the way
// during a neighbor's drag). `listeners`/`attributes` now go onto the card
// itself — drag starts by press-and-hold anywhere on the card (Максим
// 26.08.2026), the tap-vs-drag-vs-scroll split lives in the sensors'
// activation constraints (see TaskBoard below), not in a dedicated handle.
function SortableBoardCard({
  task,
  overdue,
  showProjectBadge,
  onClick,
}: {
  task: ApiTask;
  overdue: boolean;
  showProjectBadge: boolean;
  onClick: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <BoardCard
        task={task}
        overdue={overdue}
        showProjectBadge={showProjectBadge}
        onClick={onClick}
        dragListeners={listeners}
        dragAttributes={attributes}
        isDragging={isDragging}
      />
    </div>
  );
}

// The column's card area (or its empty-state box) as one droppable zone —
// needed on top of SortableContext's own item-level targets so dropping in
// the blank space of a short/empty column still resolves to that column
// (dnd-kit has nothing to hit-test against there otherwise: an empty
// column has zero sortable items).
function ColumnDropZone({
  columnId,
  taskIds,
  children,
}: {
  columnId: string;
  taskIds: string[];
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: columnId });
  return (
    <div ref={setNodeRef}>
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </div>
  );
}

export function TaskBoard({
  columns,
  onTaskClick,
  isLoading,
  emptyMessage = "Пока нечего показать",
}: {
  columns: BoardColumn[];
  onTaskClick: (taskId: string) => void;
  isLoading?: boolean;
  emptyMessage?: string;
}) {
  const qc = useQueryClient();

  // One card-id array per column — the actual thing dnd-kit reorders live
  // as you drag. Re-derived from props whenever the underlying data really
  // changes; the two guards below stop that resync from clobbering a drag
  // in progress:
  //  - `activeId`: a drag is literally in progress right now.
  //  - `persistingRef`: the drop just ended and PATCH requests are still
  //    in flight. This one exists because of src/api/ws.ts — every PATCH's
  //    server broadcast comes back over this same user's own websocket and
  //    invalidates ["tasks"] on receipt, so a multi-card reorder (several
  //    PATCHes in Promise.all) would otherwise see 2-3 partial-state
  //    resyncs land mid-flight, one per PATCH that's already landed.
  const [colItems, setColItems] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      columns.map((c) => [c.id, sortByPosition(c.tasks).map((t) => t.id)]),
    ),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const persistingRef = useRef(false);
  // Размер исходной карточки в ref — приходит из
  // active.rect.current.initial в onDragStart и кладётся сюда СИНХРОННО,
  // до первого рендера <DragOverlay>. Иначе overlay монтируется без
  // ширины, схлопывается в min-content (карточка flex-1 вне колонки),
  // а на следующем кадре расширяется до измеренной ширины —
  // «плоская узкая, потом расширяется» (Максим 26.08.2026).
  const dragRectRef = useRef<{ width: number; height: number } | null>(null);
  // Which column the active card started in — set on drag start, read on
  // drag end to tell "reordered in place" apart from "moved to another
  // column" (onDragOver below may already have relocated the id in
  // colItems by drag-end time, so colItems alone can't answer that).
  const dragSourceColRef = useRef<string | null>(null);
  // colItems exactly as it was before this drag touched it. onDragOver
  // mutates colItems live so a card visually joins whatever column it's
  // hovering — but a drag can end without a drop to persist: cancelled
  // (Escape, or dnd-kit aborting it) or released outside every droppable
  // (real on a phone — a finger dragged off the strip's edge). Both paths
  // must restore this snapshot, or the card is left sitting in the "new"
  // column on screen while nothing was ever written to the server — the
  // exact kind of UI lie this feature exists to avoid.
  const dragSnapshotRef = useRef<Record<string, string[]> | null>(null);
  // Над какой карточкой (или колонкой) палец висел на прошлом событии —
  // чтобы виброотклик приходился на пересечение границы, а не на каждое
  // событие перетаскивания.
  const lastOverRef = useRef<string | null>(null);

  // ─── Полоса на всю оставшуюся высоту экрана ───
  // Пролистывание колонок пальцем ловится только там, где есть сама полоса,
  // а её высота — это высота самой длинной колонки. Поэтому под карточками
  // оставалась мёртвая зона: свайп по пустому месту не переключал колонку
  // (просьба Максима 14.08.2026 — «чтобы двигались и по пустому месту»).
  // Лечится вёрсткой, а не своей обработкой жестов: полоса дотягивается до
  // низа видимой области, колонки внутри неё растягиваются (flex stretch),
  // и пустое место под карточками становится частью той же скроллируемой
  // полосы — переключение остаётся нативным, вместе со snap.
  //
  // Высота считается замером, без зашитых чисел: берётся ближайший
  // вертикальный скроллер (Layout.tsx: `flex-1 overflow-y-auto`), из его
  // видимой высоты вычитается отступ его контентной обёртки (класс
  // pb-content-safe — место под нижней навигацией; на десктопе он свой) и
  // расстояние от верха скроллера до полосы. Расстояние берётся с поправкой
  // на scrollTop, иначе прокрутка меняла бы замер и высота росла бы сама от
  // себя.
  const stripRef = useRef<HTMLDivElement>(null);

  const [stripMinH, setStripMinH] = useState<number>();
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      let scroller: HTMLElement | null = strip.parentElement;
      while (
        scroller &&
        !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      ) {
        scroller = scroller.parentElement;
      }
      if (!scroller) return;
      const wrap = scroller.firstElementChild as HTMLElement | null;
      const inset = wrap
        ? parseFloat(getComputedStyle(wrap).paddingBottom) || 0
        : 0;
      const offsetFromScrollerTop =
        strip.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const available = scroller.clientHeight - inset - offsetFromScrollerTop;
      setStripMinH(available > 0 ? available : undefined);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    if (strip.parentElement) ro.observe(strip.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [columns.length]);

  // ─── Помнить, на какой колонке (проекте) стоял пользователь ───
  // Максим 18.08.2026: заходит в задачу с колонки «Домашний сервер»
  // (не первой), выходит назад — доска встречает его на самой левой
  // колонке. React Router размонтирует TaskBoard при переходе на
  // /task/:id и монтирует заново при возврате — scrollLeft полосы
  // никто не помнит между этими двумя жизнями компонента.
  // sessionStorage, не сам React state — переживает именно размонтирование,
  // но не обязан жить дольше вкладки. Ключ — location.pathname, не общий:
  // Today (single-колонка) и Inbox не должны делить одну и ту же память.
  const location = useLocation();
  const scrollMemoryKey = `taskboard-scroll:${location.pathname}`;

  // Восстановление — один раз, как только колонки реально появились
  // (до этого strip пуст, восстанавливать нечего). restoredRef не даёт
  // сработать повторно при каждом обновлении columns (reorder, WS-
  // invalidate и т.п.) — иначе живой скролл пользователя откатывало бы
  // назад на сохранённое значение при каждом чужом чихе.
  const restoredScrollRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredScrollRef.current || columns.length === 0) return;
    restoredScrollRef.current = true;
    const strip = stripRef.current;
    const savedId = sessionStorage.getItem(scrollMemoryKey);
    if (!strip || !savedId) return;
    // window.CSS, не CSS — этот файл импортирует CSS из @dnd-kit/utilities
    // (transform-строки для drag), тот объект затеняет глобальный и не
    // имеет .escape(). Ловилось не сразу: TaskBoard падал целиком без
    // error boundary — ошибка утекала прямо в консоль, экран просто гас.
    const el = strip.querySelector<HTMLElement>(
      `[data-column-id="${window.CSS.escape(savedId)}"]`,
    );
    // "instant", не smooth: это восстановление состояния, не жест
    // пользователя — анимированный проезд через все колонки между
    // приходом на экран и прыжком на нужную выглядел бы как глюк.
    el?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [columns, scrollMemoryKey]);

  // Сохранение — какая колонка сейчас ближе всего к центру полосы,
  // debounced на прекращение скролла (150мс), не на каждый кадр.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || columns.length <= 1) return; // одна колонка (Today) не скроллится
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const stripRect = strip.getBoundingClientRect();
        const centerX = stripRect.left + stripRect.width / 2;
        let closestId: string | null = null;
        let closestDist = Infinity;
        strip
          .querySelectorAll<HTMLElement>("[data-column-id]")
          .forEach((el) => {
            const r = el.getBoundingClientRect();
            const dist = Math.abs(r.left + r.width / 2 - centerX);
            if (dist < closestDist) {
              closestDist = dist;
              closestId = el.dataset.columnId ?? null;
            }
          });
        if (closestId) sessionStorage.setItem(scrollMemoryKey, closestId);
      }, 150);
    };
    strip.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      strip.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, [scrollMemoryKey, columns.length]);

  useEffect(() => {
    if (activeId !== null || persistingRef.current) return;
    setColItems(
      Object.fromEntries(
        columns.map((c) => [c.id, sortByPosition(c.tasks).map((t) => t.id)]),
      ),
    );
    // Only the actual column data should trigger a resync — activeId/
    // persistingRef are read as guards, not as triggers (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  const taskById = useMemo(() => {
    const map = new Map<string, ApiTask>();
    for (const col of columns) for (const t of col.tasks) map.set(t.id, t);
    return map;
  }, [columns]);

  const columnById = useMemo(() => {
    const map = new Map<string, BoardColumn>();
    for (const col of columns) map.set(col.id, col);
    return map;
  }, [columns]);

  // See the file-header note — this is the one flag that turns a
  // cross-column drop into a project_id write.
  const projectBoard =
    columns.length > 0 && columns.every((c) => c.dotColor !== undefined);

  function findColumnOf(id: string): string | undefined {
    if (colItems[id]) return id; // dropped straight on a column/container id
    return Object.keys(colItems).find((key) => colItems[key].includes(id));
  }

  // Перетаскивание всей карточкой (грип-хендл убран, Максим 26.08.2026) —
  // тап, скролл и drag разводятся так же, как у плашек в DayHours:
  //   мышь  — порог 4px: курсор точный, тап без движения остаётся кликом
  //           (открыть задачу), а задержка была бы только раздражением;
  //   палец — удержание 200мс с допуском 8px: короткий тап открывает
  //           задачу, движение сразу — прокручивает колонку/полосу,
  //           удержание берёт карточку. Ровно жест «зажал и потащил».
  // PointerSensor с одним distance здесь больше нельзя: любое движение
  // пальца по карточке (начало прокрутки!) стартовало бы drag.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveId(id);
    dragSourceColRef.current = findColumnOf(id) ?? null;
    dragSnapshotRef.current = colItems;
    // initial rect приходит на самом первом тике drag — кладём в ref,
    // чтобы overlay при монтировании сразу знал свою ширину и высоту.
    const r = event.active.rect.current.initial;
    if (r) dragRectRef.current = { width: r.width, height: r.height };
    hapticGrab();
    lastOverRef.current = id;
  }

  // Cross-column boards only: live-move the dragged card into whichever
  // column it's currently hovering, so that column's own SortableContext
  // previews it in place. Same-column reordering doesn't need this —
  // dnd-kit's SortableContext already previews that from active/over state
  // without any array mutation until drop.
  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    // Виброотклик — ДО выхода по projectBoard: перестановка внутри одной
    // колонки ниже не обрабатывается вовсе (её превью dnd-kit рисует сам),
    // но пальцу-то карточка меняет соседа и там. Щёлкаем по смене того, НАД
    // ЧЕМ висим, — это и есть «пересёк границу карточки».
    const overId = over ? String(over.id) : null;
    if (overId !== lastOverRef.current) {
      lastOverRef.current = overId;
      if (overId) hapticCross();
    }
    if (!projectBoard) return;
    if (!over) return;
    const activeCol = findColumnOf(String(active.id));
    const overCol = findColumnOf(String(over.id));
    if (!activeCol || !overCol || activeCol === overCol) return;

    setColItems((prev) => {
      const activeItems = prev[activeCol];
      const overItems = prev[overCol];
      const activeIndex = activeItems.indexOf(String(active.id));
      if (activeIndex === -1) return prev;
      let overIndex = overItems.indexOf(String(over.id));
      if (overIndex === -1) overIndex = overItems.length;
      return {
        ...prev,
        [activeCol]: activeItems.filter((id) => id !== active.id),
        [overCol]: [
          ...overItems.slice(0, overIndex),
          String(active.id),
          ...overItems.slice(overIndex),
        ],
      };
    });
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const sourceCol = dragSourceColRef.current;
    const snapshot = dragSnapshotRef.current;
    setActiveId(null);
    dragSourceColRef.current = null;
    dragSnapshotRef.current = null;
    lastOverRef.current = null;

    // Released outside every droppable (real on a phone — a finger dragged
    // off the strip's edge) or nothing found to place against (defensive):
    // roll back whatever onDragOver already moved between columns, or the
    // card would be left sitting in the "new" column with nothing
    // persisted — see dragSnapshotRef's own comment.
    if (!over) {
      if (snapshot) setColItems(snapshot);
      return;
    }

    const activeIdStr = String(active.id);
    const destCol = findColumnOf(activeIdStr);
    if (!destCol) {
      if (snapshot) setColItems(snapshot);
      return;
    }

    const items = colItems[destCol];
    const oldIndex = items.indexOf(activeIdStr);
    const overIdStr = String(over.id);
    let newIndex = items.indexOf(overIdStr);
    if (newIndex === -1) newIndex = items.length - 1;
    if (newIndex < 0) {
      if (snapshot) setColItems(snapshot);
      return; // empty column, nothing to place against
    }

    const reordered =
      oldIndex === -1 ? items : arrayMove(items, oldIndex, newIndex);
    const movedAcrossColumns = sourceCol !== null && sourceCol !== destCol;

    // Nothing actually changed (dropped a card back where it started, same
    // column, same index) — skip the whole persist round-trip.
    const unchanged =
      !movedAcrossColumns &&
      reordered.length === items.length &&
      reordered.every((id, i) => id === items[i]);
    if (unchanged) return;

    // Карточка легла на новое место — то же правило, что в DayHours:
    // «щёлкает» только реальная перестановка, все возвраты выше молчат.
    hapticDrop();
    setColItems((prev) => ({ ...prev, [destCol]: reordered }));
    persistingRef.current = true;
    try {
      const patches: Promise<unknown>[] = [];
      reordered.forEach((taskId, index) => {
        const current = taskById.get(taskId);
        const body: { position?: number; project_id?: string | null } = {};
        if (current?.position !== index) body.position = index;
        if (taskId === activeIdStr && movedAcrossColumns) {
          const value = destCol === NO_PROJECT_COLUMN_ID ? null : destCol;
          if (current?.project_id !== value) body.project_id = value;
        }
        if (Object.keys(body).length > 0) {
          // Оптимистично применяем изменения в кэше ['tasks'] до
          // отправки PATCH — иначе карточка на одну-две отрисовки
          // возвращается на старое место. Откатываем при ошибке.
          patches.push(
            api.patch(`/api/tasks/${taskId}`, body).catch((err) => {
              console.error("Не удалось сохранить порядок задач", err);
              throw err;
            }),
          );
          qc.setQueryData<ApiTask[] | undefined>(["tasks"], (prev) => {
            if (!prev) return prev;
            return prev.map((t) =>
              t.id === taskId ? ({ ...t, ...body } as ApiTask) : t,
            );
          });
        }
      });
      if (patches.length > 0) {
        await Promise.all(patches);
        await qc.invalidateQueries({ queryKey: ["tasks"] });
      }
    } finally {
      persistingRef.current = false;
      // invalidate в любом случае — прийти свежий ответ, перезаписать
      // оптимистичный кэш (или откатить, если ответ пришёл с ошибкой).
      await qc.invalidateQueries({ queryKey: ["tasks"] });
    }
  }

  // The parent screen already renders its own "Загрузка…" line above the
  // list/board switch — nothing to add here, just don't flash an "empty"
  // message while the real data is still in flight.
  if (isLoading) return null;

  if (columns.length === 0) {
    return (
      <div className="py-10 text-center text-[13px] text-dim">
        {emptyMessage}
      </div>
    );
  }

  const single = columns.length === 1;
  const activeTask = activeId ? taskById.get(activeId) : undefined;
  const activeColumn = activeId
    ? columnById.get(findColumnOf(activeId) ?? "")
    : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        dragSourceColRef.current = null;
        lastOverRef.current = null;
        if (dragSnapshotRef.current) setColItems(dragSnapshotRef.current);
        dragSnapshotRef.current = null;
      }}
    >
      <div
        data-board-strip
        ref={stripRef}
        // items-stretch (дефолт flex) + min-height полосы = колонка занимает
        // всю её высоту, поэтому пустое место под карточками принадлежит
        // полосе и пролистывается тем же жестом, что и сами карточки.
        //
        // -mx-4 (было -mx-1 px-1 — компенсация была неполной, только до
        // края родительского px-4, не до физического края экрана): Максим
        // 17.08.2026, скриншот — между подглядывающим краем соседней
        // колонки и краем экрана оставалась полоса пустого фона. Теперь
        // полоса честно full-bleed (растянута на реальную ширину экрана —
        // на десктопе это по-прежнему ограничено родительским
        // max-w-[640px], -mx-4 компенсирует только свой прямой родитель,
        // не лезет дальше). Крайняя колонка при этом всё равно должна
        // останавливаться с тем же 16px отступом, что у остального
        // контента, а не вплотную к экрану — держит это НЕ scroll-padding
        // (пробовал: при snap-center с mandatory браузер откатывает
        // scrollLeft к границе 0, если «идеальная» точка центрирования
        // уходит в отрицательную область — крайняя колонка физически не
        // может остановиться на padding-отступе, только на 0 или на
        // максимуме), а пара spacer-элементов по краям списка колонок
        // ниже — они физически сдвигают координаты первой/последней
        // колонки, так что даже нулевой scrollLeft уже даёт нужный отступ.
        // WebkitOverflowScrolling: 18.08.2026, найдено на реальном iPhone
        // через WKWebView (Capacitor) — «ватная» доска, скролл двигается,
        // но не докручивается/не защёлкивается на snap-точку, можно
        // остановиться где угодно между колонками. В обычном мобильном
        // Safari инерционный скролл с iOS 13+ включён по умолчанию для
        // overflow:auto, но нативный WKWebView внутри Capacitor-приложения
        // (не полноценный Safari) этого не наследует сам по себе — без
        // явного свойства momentum-scrolling слабый, snap-mandatory не
        // успевает довести докрутку. На вебе/десктопе свойство — no-op,
        // сломать нечего.
        style={{
          ...(stripMinH ? { minHeight: stripMinH } : undefined),
          WebkitOverflowScrolling: "touch",
        }}
        // Полоса колонок прокручивается вбок со снапом — свайп «назад»
        // (useSwipeBack, ловится по всему экрану с 26.08.2026) не должен
        // перехватывать это движение.
        data-hswipe
        className={`-mx-4 flex gap-3 overflow-x-auto pb-2 ${
          // Scroll-snap fights dnd-kit's auto-scroll-to-edge while a drag is
          // active (each auto-scroll tick gets pulled back toward the
          // nearest snap point) — off for the duration of a drag, back on
          // the moment it ends.
          activeId ? "" : "snap-x snap-mandatory"
        }`}
      >
        {/* Spacer, не padding/scroll-padding — см. комментарий у полосы
            выше: только физический элемент сдвигает координаты первой
            колонки так, чтобы scrollLeft=0 уже давал нужный отступ.
            4px (не 16) — между ним и первой колонкой всё равно ляжет
            gap-3 (12px) самого flex-контейнера, 4+12=16, ровно тот же
            отступ, что у остального контента экрана. single (Today) не
            скроллится вовсе — там отступ уже даёт mx-auto колонки. */}
        {!single && <div className="w-1 shrink-0" aria-hidden="true" />}
        {columns.map((col) => {
          const taskIds = colItems[col.id] ?? [];
          return (
            <div
              key={col.id}
              data-column-id={col.id}
              // Максим 17.08.2026: снап к левому краю (snap-start) давал
              // подглядывание только справа — «слева нету ничего, справа
              // вылазит чуть больше», непонятно, где по счёту колонка и
              // сколько их вообще. snap-center вместо этого — активная
              // колонка всегда посередине видимой полосы, подглядывание
              // симметрично с обеих сторон (кроме краёв — там сосед только
              // с одной стороны, и это само по себе честный сигнал «дальше
              // некуда»).
              //
              // Второй заход, тот же день: первая версия (peek 28px)
              // считалась от полосы, урезанной на px-4 — Максим прислал
              // скриншот СТАРОГО (до snap-center) поведения, где на краю
              // подглядывало «почти на половину следующей задачи», и
              // попросил peek «на миллиметрик больше» текущего, не
              // колоссально. Пересчитано под полосу, которая теперь
              // честно full-bleed (-mx-4 без компенсирующего padding, см.
              // выше).
              //
              // Третий заход (17.08.2026): 32px оказался обратной
              // крайностью — «хвостики соседних плиток вылазят прям
              // капитально», нужно «чисто символически». 8px peek +
              // gap-3 (12px) = 20px с КАЖДОЙ стороны, ×2 = 40. min(...,632px)
              // — тот же кап под десктопный max-w-[640px]+bleed
              // (640+32−40=632).
              //
              // single (Today часто одна колонка) — w-full здесь раньше
              // означало «во всю ширину РОДИТЕЛЯ» (полоса ещё не была
              // full-bleed), теперь это буквально весь экран без единого
              // отступа — Максим 17.08.2026: «плитка прям до самого
              // экрана, надо, чтобы было отцентровано точно так же, как
              // во Входящих». mx-auto центрирует внутри full-bleed полосы,
              // w-[min(calc(100vw-32px),608px)] — та же ширина, что раньше
              // w-full фактически давал (100vw бленда минус 16px с каждой
              // стороны; 608=640−32 — тот же принцип десктопного капа).
              className={`shrink-0 snap-center ${single ? "mx-auto w-[min(calc(100vw-32px),608px)]" : "w-[min(calc(100vw-40px),632px)]"}`}
            >
              {/* min-h-11 on both column headers on purpose — the overdue
                  column's "Перенести" button is a 44px tap target, so without
                  matching that floor here the two headers would sit at
                  different heights and the first card in each column would
                  start at a different Y (exactly the misaligned-board-columns
                  failure mode). */}
              <div className="flex items-center gap-2 px-1 mb-2 min-h-11">
                {col.dotColor && (
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: col.dotColor }}
                  />
                )}
                <span
                  className={`text-[13px] font-semibold truncate ${
                    col.titleClassName ?? "text-text"
                  }`}
                >
                  {col.title}
                </span>
                {(col.trailingCount !== undefined || col.headerAction) && (
                  <div className="ml-auto shrink-0 flex items-center gap-1">
                    {col.trailingCount !== undefined && (
                      <span className="text-[11px] text-sub">
                        {col.trailingCount}
                      </span>
                    )}
                    {col.headerAction}
                  </div>
                )}
              </div>

              <ColumnDropZone columnId={col.id} taskIds={taskIds}>
                {taskIds.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-stroke py-6 text-center text-[12px] text-dim">
                    Нет задач
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {taskIds.map((taskId) => {
                      const task = taskById.get(taskId);
                      if (!task) return null;
                      return (
                        <SortableBoardCard
                          key={task.id}
                          task={task}
                          overdue={col.dueBadgeVariant === "overdue"}
                          showProjectBadge={!!col.showProjectBadge}
                          onClick={() => onTaskClick(task.id)}
                        />
                      );
                    })}
                  </div>
                )}
              </ColumnDropZone>

              {/* mt-4, а не mt-2: на mt-2 кнопка «Добавить задачу» вплотную
                  липла к последней карточке и читалась как ещё одна строка
                  списка, а не как действие (замечание владельца 11.08.2026). */}
              {col.footer && <div className="mt-4">{col.footer}</div>}
            </div>
          );
        })}
        {!single && <div className="w-1 shrink-0" aria-hidden="true" />}
      </div>

      {/* Rendered outside any column's scroll/transform context — dnd-kit's
          own recipe for dragging inside a scrollable container, otherwise
          the floating card inherits the strip's scroll offset and drifts. */}
      <DragOverlay dropAnimation={null}>
        {activeTask && dragRectRef.current ? (
          // drag-lift — «подъём» карточки в руке (масштаб + тень, как
          // иконки на домашнем экране iOS при long-press); сама карточка
          // на старом месте в этот момент полупрозрачна (opacity-40).
          //
          // Ширина и высота ФИКСИРОВАНЫ размером исходной карточки —
          // без этого overlay (он вне колонки, flex-1 родителя не имеет)
          // схлопывается в min-content и расширяется на следующем
          // кадре: «узкая плоская, потом расширяется» (Максим 26.08.2026).
          <div
            className="drag-lift rounded-xl"
            style={{
              width: dragRectRef.current.width,
              height: dragRectRef.current.height,
            }}
          >
            <BoardCard
              task={activeTask}
              overdue={activeColumn?.dueBadgeVariant === "overdue"}
              showProjectBadge={!!activeColumn?.showProjectBadge}
              onClick={() => {}}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
