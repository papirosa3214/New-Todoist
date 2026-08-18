import { useEffect, useMemo, useRef, useState } from "react";
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
const HOUR_H = 64;
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00–23:00
const FIRST_HOUR = HOURS[0];

/** «14:30» → 14.5; неразобранное время → null, блок просто не рисуется. */
function hoursFromTime(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h + m / 60;
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
      <span className="w-[46px] shrink-0 text-right pr-1.5 text-[10px] font-medium text-red">
        {String(now.getHours()).padStart(2, "0")}:
        {String(now.getMinutes()).padStart(2, "0")}
      </span>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-red" />
      <span className="h-[1.5px] flex-1 bg-red" />
    </div>
  );
}

export function DayHours({
  tasks,
  projectColor,
  onTaskClick,
  isToday,
}: {
  tasks: ApiTask[];
  /** Цвет проекта задачи; без проекта — приглушённый серый. */
  projectColor: (task: ApiTask) => string;
  onTaskClick: (id: string) => void;
  isToday: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="mt-2">
      {timed.length === 0 ? (
        <div className="rounded-2xl bg-card px-4 py-6 text-center">
          <p className="text-[14px] text-sub">Ничего не назначено на время</p>
          <p className="mt-1 text-[12px] text-dim">
            Час начала задаётся в задаче, рядом со сроком
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="relative max-h-[62vh] overflow-y-auto rounded-2xl bg-card"
        >
          <div
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

            <div className="absolute bottom-0 left-[46px] right-2 top-0">
              {timed.map((t) => {
                const start = hoursFromTime(t.start_time)!;
                const dur = t.duration_min ?? 60;
                const color = projectColor(t);
                const done = t.status === "completed";
                const height = Math.max(34, (dur / 60) * HOUR_H - 3);
                return (
                  <button
                    key={t.id}
                    onClick={() => onTaskClick(t.id)}
                    className="absolute left-0 right-0 flex gap-2 overflow-hidden rounded-lg bg-card2 px-2 py-1.5 text-left active:opacity-80"
                    style={{
                      top: Math.max(0, (start - FIRST_HOUR) * HOUR_H + 1),
                      height,
                      // Заливка от цвета проекта, но слабая: блок крупный,
                      // плотный цвет на такой площади перетягивает экран.
                      // Цвет несёт полоска слева.
                      boxShadow: `inset 3px 0 0 0 ${color}`,
                      opacity: done ? 0.55 : 1,
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[13px] font-medium ${
                          done ? "text-sub line-through" : "text-text"
                        }`}
                      >
                        {t.title}
                      </span>
                      {height > 44 && (
                        <span className="mt-0.5 block text-[11px] text-dim tabular-nums">
                          {t.start_time} · {minutesLabel(dur)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {isToday && <NowLine />}
          </div>
        </div>
      )}

      {untimed.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 px-1">
            <Icon name="list" size={13} className="text-dim" />
            <span className="text-[13px] font-semibold text-sub">
              Без времени — {untimed.length}
            </span>
          </div>
          <div className="overflow-hidden rounded-2xl bg-card">
            {untimed.map((t, i) => (
              <button
                key={t.id}
                onClick={() => onTaskClick(t.id)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/[0.04] ${
                  i > 0 ? "border-t border-stroke" : ""
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: projectColor(t) }}
                />
                <span
                  className={`min-w-0 flex-1 truncate text-[14px] ${
                    t.status === "completed"
                      ? "text-sub line-through"
                      : "text-text"
                  }`}
                >
                  {t.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
