// Экран «Загрузка ролей» — карточка 1117d06c… (Гант по факту).
//
// Что показываем:
//   • Роли по вертикали (одна строка на включённую роль из roles,
//     в порядке position);
//   • Время по горизонтали: три окна (24ч / 3 дня / неделя);
//   • Полосы — каждый заход из attempts, длина от started_at до ended_at;
//   • Поверх факта два слоя:
//       — кто занят прямо сейчас (active_now) — пульсирующая рамка;
//       — открытые слоты без исполнителя (open_slots) — отдельный
//         «штрихованный» брусок слева в своей роли дорожке, чтобы они
//         не терялись с глаз;
//   • Вертикальная линия «сейчас»;
//   • Клик по полосе открывает карточку задачи.
//
// Чего НЕ делаем (по границам карточки): плановых сроков и оценок
// длительности — нет данных, гадать нельзя.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScreenHeader, ErrorBanner, Loading, Icon } from "../components/UI";
import {
  useRoleLoad,
  type RoleLoadActive,
  type RoleLoadAttempt,
  type RoleLoadOpenSlot,
  type RoleLoadWindow,
} from "../api/roleLoad";

const WINDOW_LABELS: Record<RoleLoadWindow, string> = {
  "24h": "Сутки",
  "3d": "3 дня",
  week: "Неделя",
};

const WINDOWS: RoleLoadWindow[] = ["24h", "3d", "week"];

// Высота роли в px. На десктопе чуть больше, чем на мобильном: на узком
// экране вертикальная плотность важнее читаемости отдельной полосы.
const ROW_H = 44;
const HEADER_H = 28;
const LEFT_AXIS_W = 130; // ширина столбца с названием роли

export function RoleLoadScreen() {
  const navigate = useNavigate();
  const [windowKey, setWindowKey] = useState<RoleLoadWindow>("24h");
  const { data, isLoading, isError, error } = useRoleLoad(windowKey);

  const empty =
    !isLoading &&
    !isError &&
    (data?.attempts.length ?? 0) === 0 &&
    (data?.active_now.length ?? 0) === 0 &&
    (data?.open_slots.length ?? 0) === 0;

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title="Загрузка ролей"
        actions={
          // Сегмент-контрол окна: владелец выбирает масштаб так же,
          // как в TodayScreenTimeline (Фокус дня / Обзор недели).
          <div className="flex items-center gap-1 bg-card r-surface p-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindowKey(w)}
                className={`tf-meta px-3 h-8 rounded-lg tap-row ${
                  w === windowKey
                    ? "bg-blue/25 text-blue"
                    : "text-sub"
                }`}
                aria-pressed={w === windowKey}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>
        }
      />

      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить загрузку ролей"
        variant="inline"
        className="mb-2"
      />

      {isLoading && <Loading />}

      {!isLoading && !isError && data && data.roles.length === 0 && (
        <div className="bg-card r-surface p-4 text-sub tf-body">
          Нет включённых ролей — откройте «Настройки → Команда».
        </div>
      )}

      {!isLoading && !isError && data && data.roles.length > 0 && (
        <Gantt
          window={windowKey}
          fromIso={data.from}
          toIso={data.to}
          nowIso={data.now}
          roles={data.roles}
          attempts={data.attempts}
          activeNow={data.active_now}
          openSlots={data.open_slots}
          empty={empty}
          onOpenTask={(id) => navigate(`/task/${id}`)}
        />
      )}
    </div>
  );
}

type GanttProps = {
  window: RoleLoadWindow;
  fromIso: string;
  toIso: string;
  nowIso: string;
  roles: RoleLoad["roles"];
  activeNow: RoleLoadActive[];
  openSlots: RoleLoadOpenSlot[];
  attempts: RoleLoadAttempt[];
  empty: boolean;
  onOpenTask: (id: string) => void;
};

// Вынесен, чтобы useMemo с тяжёлыми группировками пересчитывались
// только при смене данных (а не Window/кнопок).
function Gantt(props: GanttProps) {
  const { fromIso, toIso, nowIso, roles, attempts, activeNow, openSlots, onOpenTask } =
    props;

  const fromMs = useMemo(() => Date.parse(fromIso), [fromIso]);
  const toMs = useMemo(() => Date.parse(toIso), [toIso]);
  const nowMs = useMemo(() => Date.parse(nowIso), [nowIso]);
  const span = Math.max(toMs - fromMs, 1);

  // Группируем все три слоя по role_key (или по отсутствию — отдельная
  // строка «без роли» для слотов без исполнителя).
  const rows = useMemo(() => {
    type Row = {
      roleKey: string | null;
      attempts: RoleLoadAttempt[];
      active: RoleLoadActive[];
      open: RoleLoadOpenSlot[];
    };
    const map = new Map<string | null, Row>();
    function ensure(key: string | null): Row {
      let r = map.get(key);
      if (!r) {
        r = { roleKey: key, attempts: [], active: [], open: [] };
        map.set(key, r);
      }
      return r;
    }
    for (const a of attempts) {
      const key = a.routing_role ?? null;
      ensure(key).attempts.push(a);
    }
    for (const s of activeNow) ensure(s.role_key).active.push(s);
    for (const s of openSlots) ensure(s.role_key).open.push(s);
    return Array.from(map.values()).sort((a, b) => {
      // Сначала строки с известной ролью (по position), потом null.
      if (a.roleKey && b.roleKey) {
        const pa = roles.find((r) => r.key === a.roleKey)?.position ?? 0;
        const pb = roles.find((r) => r.key === b.roleKey)?.position ?? 0;
        return pa - pb;
      }
      if (a.roleKey) return -1;
      if (b.roleKey) return 1;
      return 0;
    });
  }, [attempts, activeNow, openSlots, roles]);

  // Ось времени — метки часов для 24h, дней для 3d/week. Без локали:
  // устройство само покажет в своей зоне, но держим единый формат.
  const ticks = useMemo(() => buildTicks(fromMs, toMs), [fromMs, toMs]);

  return (
    <div className="bg-card r-surface overflow-hidden">
      {/* Шапка оси времени */}
      <div
        className="flex border-b border-stroke"
        style={{ height: HEADER_H }}
      >
        <div
          className="shrink-0 text-sub tf-meta px-2 flex items-center"
          style={{ width: LEFT_AXIS_W }}
        >
          Роль
        </div>
        <div className="flex-1 relative">
          {ticks.map((t, i) => (
            <div
              key={i}
              className="absolute top-0 bottom-0 flex items-center"
              style={{ left: `${pct(t.ms, fromMs, span)}%` }}
            >
              <span
                className={`tf-micro whitespace-nowrap px-1 ${
                  t.primary ? "text-text" : "text-dim"
                }`}
              >
                {t.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Дорожки ролей */}
      <div className="relative">
        {rows.map((row, idx) => (
          <div
            key={row.roleKey ?? "__none__"}
            className={`flex ${
              idx > 0 ? "border-t border-stroke" : ""
            }`}
            style={{ minHeight: ROW_H }}
          >
            {/* Название роли слева — закреплено, не скроллится по
                горизонтали вместе с осью. */}
            <div
              className="shrink-0 px-2 flex items-center text-text tf-body"
              style={{ width: LEFT_AXIS_W }}
            >
              <div className="min-w-0 truncate">
                {row.roleKey
                  ? roles.find((r) => r.key === row.roleKey)?.title ??
                    row.roleKey
                  : "Без роли"}
              </div>
            </div>

            {/* Полоса дорожки */}
            <div className="flex-1 relative">
              {/* Сетка вертикальных линий по тикам */}
              {ticks.map((t, i) => (
                <div
                  key={i}
                  className={`absolute top-0 bottom-0 ${
                    t.primary ? "border-l border-stroke" : "border-l border-stroke/40"
                  }`}
                  style={{ left: `${pct(t.ms, fromMs, span)}%` }}
                />
              ))}

              {/* Open slots — отдельный стиль, факт того, что висит
                  без исполнителя. Рисуются в самом начале своей
                  дорожки, как блок-предупреждение. */}
              {row.open.map((s) => (
                <OpenSlotBar
                  key={`open-${s.id}`}
                  slot={s}
                  onClick={() => onOpenTask(s.id)}
                />
              ))}

              {/* Попытки — основная фактическая полоса */}
              {row.attempts.map((a) => (
                <AttemptBar
                  key={a.id}
                  attempt={a}
                  fromMs={fromMs}
                  span={span}
                  nowMs={nowMs}
                  onClick={() => onOpenTask(a.task_id)}
                />
              ))}

              {/* Активные слоты — пульс-рамка поверх текущих попыток
                  (ended_at === null). Рисуется после самих полос, чтобы
                  обводка лежала поверх. */}
              {row.active.map((s) => (
                <ActiveNowHalo
                  key={`halo-${s.id}`}
                  slot={s}
                  attempts={row.attempts}
                  fromMs={fromMs}
                  span={span}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Линия «сейчас» — поверх всех дорожек */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `calc(${LEFT_AXIS_W}px + (100% - ${LEFT_AXIS_W}px) * ${pct(
              nowMs,
              fromMs,
              span,
            )}%)`,
          }}
        >
          <div className="w-px h-full bg-blue" />
        </div>
      </div>

      {/* Пустое состояние — заметное, но без «сломано»-эстетики. Если
          ровно пусто в attempts и в active_now и open_slots, то
          отдельным блоком поверх дорожек. */}
      {props.empty && (
        <div className="px-3 py-6 text-sub tf-body">
          За выбранное окно роли ещё не заходили. Выберите «Неделя» —
          обычно там что-то есть.
        </div>
      )}
    </div>
  );
}

function AttemptBar({
  attempt,
  fromMs,
  span,
  nowMs,
  onClick,
}: {
  attempt: RoleLoadAttempt;
  fromMs: number;
  span: number;
  nowMs: number;
  onClick: () => void;
}) {
  const startMs = Date.parse(attempt.started_at);
  const endMs = attempt.ended_at
    ? Date.parse(attempt.ended_at)
    : Math.max(nowMs, startMs + 60_000);
  if (Number.isNaN(startMs)) return null;
  const left = pct(startMs, fromMs, span);
  const width = Math.max(pct(endMs, fromMs, span) - left, 0.4);
  const tone = barTone(attempt.outcome, attempt.active);
  const title = attempt.task_title;
  return (
    <button
      onClick={onClick}
      title={`${title} · ${attempt.outcome ?? "в процессе"}`}
      className={`absolute top-1 bottom-1 rounded-md ${tone.bg} ${tone.ring} tap-row truncate px-2 tf-micro text-text flex items-center`}
      style={{
        left: `${left}%`,
        width: `${width}%`,
      }}
    >
      <span className="truncate">{title}</span>
    </button>
  );
}

function ActiveNowHalo({
  slot,
  attempts,
  fromMs,
  span,
}: {
  slot: RoleLoadActive;
  attempts: RoleLoadAttempt[];
  fromMs: number;
  span: number;
}) {
  // Ищем активную попытку этого слота, чтобы подсветить её рамкой.
  // Если попытки нет (бывает у task-level без subtask) — рисуем
  // короткий брусок от heartbeat_at до now.
  const attempt = attempts.find(
    (a) => a.subtask_id === slot.id && a.ended_at === null,
  );
  const startMs = attempt
    ? Date.parse(attempt.started_at)
    : slot.started_at
      ? Date.parse(slot.started_at)
      : slot.heartbeat_at
        ? Date.parse(slot.heartbeat_at)
        : NaN;
  const nowMs = Date.now();
  if (Number.isNaN(startMs)) return null;
  const left = pct(startMs, fromMs, span);
  const width = Math.max(pct(nowMs, fromMs, span) - left, 0.4);
  return (
    <div
      className="absolute top-0.5 bottom-0.5 rounded-md pointer-events-none ring-2 ring-blue animate-pulse"
      style={{
        left: `${left}%`,
        width: `${width}%`,
      }}
    />
  );
}

function OpenSlotBar({
  slot,
  onClick,
}: {
  slot: RoleLoadOpenSlot;
  onClick: () => void;
}) {
  // Без исполнителя = без времени старта попытки. Показываем метку
  // слева в дорожке, чтобы было видно «висит, никто не делает». Сам
  // слот без явной даты начала не растянется по шкале — вместо этого
  // узкая штрихованная плашка слева.
  return (
    <button
      onClick={onClick}
      title={`${slot.task_title} · без исполнителя · ${slot.state}`}
      className="absolute left-1 top-1 bottom-1 px-2 tap-row rounded-md bg-orange/15 ring-1 ring-orange/40 text-orange tf-micro flex items-center gap-1"
      style={{ maxWidth: 140 }}
    >
      <Icon name="flag" size={12} />
      <span className="truncate">{slot.task_title}</span>
    </button>
  );
}

function barTone(
  outcome: string | null,
  active: boolean,
): { bg: string; ring: string } {
  if (active) {
    return { bg: "bg-blue/30", ring: "ring-1 ring-blue/50" };
  }
  switch (outcome) {
    case "done":
      return { bg: "bg-green/30", ring: "ring-1 ring-green/40" };
    case "failed":
      return { bg: "bg-red/25", ring: "ring-1 ring-red/40" };
    case "blocked":
      return { bg: "bg-orange/20", ring: "ring-1 ring-orange/40" };
    default:
      return { bg: "bg-card2", ring: "ring-1 ring-stroke" };
  }
}

function pct(ms: number, fromMs: number, span: number): number {
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.min(100, ((ms - fromMs) / span) * 100));
}

type Tick = { ms: number; label: string; primary: boolean };

function buildTicks(fromMs: number, toMs: number): Tick[] {
  // Выбор шага: <2 days → каждый час, иначе каждый день. 3d/week —
  // дневные метки с подписью числа.
  const span = toMs - fromMs;
  const isShort = span <= 36 * 60 * 60 * 1000;
  const ticks: Tick[] = [];
  if (isShort) {
    const start = new Date(fromMs);
    start.setMinutes(0, 0, 0);
    let t = start.getTime();
    while (t <= toMs) {
      const d = new Date(t);
      const primary = d.getHours() === 0 || d.getHours() === 12;
      ticks.push({
        ms: t,
        label: primary ? formatDayHour(d) : formatHour(d),
        primary,
      });
      t += 60 * 60 * 1000;
    }
  } else {
    const start = new Date(fromMs);
    start.setHours(0, 0, 0, 0);
    let t = start.getTime();
    while (t <= toMs) {
      ticks.push({
        ms: t,
        label: formatDay(new Date(t)),
        primary: new Date(t).getDay() === 1, // понедельник — крупная метка
      });
      t += 24 * 60 * 60 * 1000;
    }
  }
  return ticks;
}

function formatHour(d: Date): string {
  return `${pad2(d.getHours())}:00`;
}

function formatDayHour(d: Date): string {
  return `${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
}

function formatDay(d: Date): string {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Не используем напрямую, но TS просит импорт типа подсказки.
type RoleLoad = import("../api/roleLoad").RoleLoadData;