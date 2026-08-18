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

// ═══════════ Календарная развёртка дня по часам ═══════════
//
// 18.08.2026. Геометрия перенесена из присланного владельцем прототипа
// (task-manager-mobile, DayView.tsx): часовая шкала абсолютным
// позиционированием, задача — блок высотой пропорционально длительности.
// Числа прототипа взяты как есть (сетка 6:00–23:00, час = 64px), сам код
// переписан под наш стек: там Tailwind 3 с собственным конфигом цветов и
// framer-motion, у нас Tailwind 4 с токенами в CSS и свои пружины.
//
// Цвет блока берётся от ПРОЕКТА задачи, а не из отдельной палитры: в
// прототипе у задачи было своё поле color с 14 цветами Todoist, у нас
// цвет уже есть у проекта (lib/projectColors.ts) — заводить вторую
// палитру значило бы, что одна и та же задача в списке и в сетке разного
// цвета.
//
// 19.08.2026 — перетаскивание. Владелец: «вижу, что у меня куча задач без
// времени, и я могу эту задачу перетащить на временную шкалу и там себе
// определить, куда я её хочу вставить, тем самым назначить время».
// Поэтому список задач без времени переехал НАВЕРХ (раньше был под
// сеткой): тащить снизу вверх через весь экран неудобно, а сверху он ещё
// и виден сразу, не прокручивая сетку до конца.
const HOUR_H = 64;
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00–23:00
const FIRST_HOUR = HOURS[0];
// Шаг привязки при перетаскивании. 15 минут — как в форме: попадать
// пальцем в минуту на шкале высотой 64px/час невозможно, а «ровные»
// четверти часа и так покрывают почти все реальные планы.
const SNAP_MIN = 15;

/** «14:30» → 14.5; неразобранное время → null, блок просто не рисуется. */
function hoursFromTime(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h + m / 60;
}

/** Смещение в пикселях от верха сетки → «ЧЧ:ММ», округлённое до SNAP_MIN. */
function timeFromOffset(px: number): string {
  const raw = FIRST_HOUR * 60 + (px / HOUR_H) * 60;
  const snapped = Math.round(raw / SNAP_MIN) * SNAP_MIN;
  const clamped = Math.min(
    Math.max(snapped, FIRST_HOUR * 60),
    (FIRST_HOUR + HOURS.length) * 60 - SNAP_MIN,
  );
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Линия текущего времени. Отдельным компонентом со своим таймером —
 *  иначе она замерла бы на времени последнего рендера всего экрана. */
function NowLine() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Минуты достаточно: линия двигается на пиксель с небольшим —
    // чаще перерисовывать нечего, а таймер на секундах будил бы экран зря.
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const pos = now.getHours() + now.getMinutes() / 60;
  if (pos < FIRST_HOUR || pos > FIRST_HOUR + HOURS.length) return null;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
      style={{ top: (pos - FIRST_HOUR) * HOUR_H }}
    >
      <span className="w-[46px] shrink-0 pr-1.5 text-right text-[10px] font-medium text-red">
        {String(now.getHours()).padStart(2, "0")}:
        {String(now.getMinutes()).padStart(2, "0")}
      </span>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-red" />
      <span className="h-[1.5px] flex-1 bg-red" />
    </div>
  );
}

/** Строка задачи без времени — её и тащат на шкалу. */
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

/** Блок задачи внутри сетки — тоже перетаскивается, меняя время. */
function TimedBlock({
  task,
  color,
  top,
  height,
  durKnown,
  dur,
  onClick,
}: {
  task: ApiTask;
  color: string;
  top: number;
  height: number;
  durKnown: boolean;
  dur: number;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  const done = task.status === "completed";
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className="absolute left-0 right-0 flex gap-2 overflow-hidden rounded-lg bg-card2 px-2 py-1.5 text-left active:opacity-80"
      style={{
        top,
        height,
        touchAction: "none",
        boxShadow: `inset 3px 0 0 0 ${color}`,
        opacity: isDragging ? 0.4 : done ? 0.55 : 1,
        // Конец не задан — низ блока размыт, чтобы он не читался как
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
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] font-medium ${
            done ? "text-sub line-through" : "text-text"
          }`}
        >
          {task.title}
        </span>
        {height > 44 && (
          <span className="mt-0.5 block text-[11px] text-dim tabular-nums">
            {task.start_time}
            {durKnown ? ` · ${minutesLabel(dur)}` : ""}
          </span>
        )}
      </span>
    </div>
  );
}

export function DayHours({
  tasks,
  projectColor,
  onTaskClick,
  onSchedule,
  isToday,
}: {
  tasks: ApiTask[];
  /** Цвет проекта задачи; без проекта — приглушённый серый. */
  projectColor: (task: ApiTask) => string;
  onTaskClick: (id: string) => void;
  /** Задачу перетащили на шкалу — назначить ей это время. */
  onSchedule: (id: string, time: string) => void;
  isToday: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Мышь/палец начинают тащить только после 6px — иначе обычный тап по
  // строке превращался бы в микро-перетаскивание и не открывал задачу.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const timed = useMemo(
    () =>
      tasks
        .filter((t) => hoursFromTime(t.start_time) !== null)
        .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "")),
    [tasks],
  );
  const untimed = useMemo(
    () => tasks.filter((t) => hoursFromTime(t.start_time) === null),
    [tasks],
  );

  // Прокрутка к текущему часу при открытии — иначе экран открывается на
  // 6 утра, а человек смотрит день в середине дня. 120px запаса сверху,
  // чтобы было видно, что было прямо перед «сейчас».
  useEffect(() => {
    if (!isToday || !scrollRef.current || timed.length === 0) return;
    const now = new Date();
    const pos = now.getHours() + now.getMinutes() / 60;
    scrollRef.current.scrollTop = Math.max(
      0,
      (pos - FIRST_HOUR) * HOUR_H - 120,
    );
  }, [isToday, timed.length]);

  function handleDragStart(e: DragStartEvent) {
    setDragging(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setDragging(null);
    setPreview(null);
    const grid = gridRef.current;
    if (!grid) return;
    // Координата отпускания в системе координат сетки: dnd-kit даёт
    // прямоугольник перетаскиваемого элемента, берём его верх.
    const rect = e.active.rect.current.translated;
    if (!rect) return;
    const gridBox = grid.getBoundingClientRect();
    const offset = rect.top - gridBox.top;
    // Отпустили выше сетки (например, обратно в список) — не трогаем.
    if (offset < -HOUR_H) return;
    onSchedule(String(e.active.id), timeFromOffset(offset));
  }

  function handleDragMove(e: { active: DragEndEvent["active"] }) {
    const grid = gridRef.current;
    const rect = e.active.rect.current.translated;
    if (!grid || !rect) return;
    const offset = rect.top - grid.getBoundingClientRect().top;
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
        {/* Задачи без времени — НАД сеткой: их перетаскивают вниз на шкалу,
            и держать их под ней значило бы тащить через весь экран. */}
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

        <div
          ref={scrollRef}
          className="relative max-h-[58vh] overflow-y-auto rounded-2xl bg-card"
        >
          <div
            ref={gridRef}
            className="relative"
            style={{ height: HOURS.length * HOUR_H + 8 }}
          >
            {HOURS.map((h, i) => (
              <div
                key={h}
                className="absolute left-0 right-0 border-t border-stroke"
                style={{ top: i * HOUR_H }}
              >
                <span className="absolute -top-[7px] left-2 bg-card px-1 text-[10px] font-medium text-dim tabular-nums">
                  {String(h).padStart(2, "0")}:00
                </span>
              </div>
            ))}

            {/* Подсказка времени под пальцем — иначе непонятно, куда
                именно встанет задача при отпускании. */}
            {preview && (
              <div
                className="pointer-events-none absolute left-0 right-0 z-30 flex items-center gap-2"
                style={{
                  top:
                    (Number(preview.split(":")[0]) +
                      Number(preview.split(":")[1]) / 60 -
                      FIRST_HOUR) *
                    HOUR_H,
                }}
              >
                <span className="w-[46px] shrink-0 pr-1.5 text-right text-[10px] font-semibold text-red tabular-nums">
                  {preview}
                </span>
                <span className="h-[2px] flex-1 rounded bg-red/70" />
              </div>
            )}

            <div className="absolute bottom-0 left-[46px] right-2 top-0">
              {timed.map((t) => {
                const start = hoursFromTime(t.start_time)!;
                // Длительность необязательная (владелец 19.08.2026: «если
                // я не знаю, сколько займёт, просто указал время»). Без неё
                // блок рисуется коротким — получасовой меткой начала, а не
                // часовым прямоугольником: занимать час экрана под задачу,
                // про которую известно только «в 14:30», значит показывать
                // то, чего никто не утверждал.
                const dur = t.duration_min ?? 30;
                const durKnown = t.duration_min != null;
                return (
                  <TimedBlock
                    key={t.id}
                    task={t}
                    color={projectColor(t)}
                    top={Math.max(0, (start - FIRST_HOUR) * HOUR_H + 1)}
                    height={Math.max(34, (dur / 60) * HOUR_H - 3)}
                    durKnown={durKnown}
                    dur={dur}
                    onClick={() => !dragging && onTaskClick(t.id)}
                  />
                );
              })}
            </div>

            {isToday && <NowLine />}
          </div>
        </div>

        {timed.length === 0 && (
          <p className="px-1 text-center text-[12px] text-dim">
            На время пока ничего не назначено
          </p>
        )}
      </div>
    </DndContext>
  );
}
