// ═══════════ РУТИНЫ (КРОН-ЗАДАЧИ) — экран «Мои рутины» ═══════════
//
// Рутина — запись, которая в назначенное время сама создаёт задачу по
// шаблону и поднимает на ней роль. Контракт API — из заметки «Рутины и
// расписание TaskFlow», раздел «6. API»; серверная часть —
// server/src/runtime/schedules/.
//
// Экран показывает: правило, местное время и часовой пояс, следующий
// запуск, последний запуск, статус (работает / на паузе) и историю
// запусков. Пауза останавливает будущие запуски, но уже созданную
// карточку не трогает.
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useRunScheduleNow,
  useSchedules,
  useScheduleRuns,
  useUpdateSchedule,
  type ApiSchedule,
  type ApiScheduleRun,
  type ScheduleRuleKind,
} from "../api/schedules";
import { useProjects } from "../api/projects";
import { useAgents } from "../api/agents";
import {
  Icon,
  ScreenHeader,
  ErrorBanner,
  Loading,
  Button,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";

const RULE_TITLES: Record<ScheduleRuleKind, string> = {
  daily: "Каждый день",
  weekdays: "По будням",
  weekly: "Раз в неделю",
  monthly: "Раз в месяц",
  weekly_days: "В выбранные дни",
  interval: "Через интервал",
};

const WEEKDAY_TITLES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function formatWhen(value: string | null, timezone: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString("ru-RU");
  }
}

function ruleSummary(schedule: ApiSchedule): string {
  const base = RULE_TITLES[schedule.rule_kind] ?? schedule.rule_kind;
  if (schedule.rule_kind === "interval") {
    return `${base} (${schedule.rule_expr ?? ""})`.trim();
  }
  if (schedule.rule_kind === "weekly_days") {
    const days = (schedule.rule_expr ?? "")
      .split(",")
      .map((d) => WEEKDAY_TITLES[Number(d.trim()) - 1])
      .filter(Boolean)
      .join(", ");
    return `${base}: ${days || "—"}`;
  }
  return `${base} в ${schedule.time_local}`;
}

function RunHistory({ schedule }: { schedule: ApiSchedule }) {
  const { data, isLoading } = useScheduleRuns(schedule.id);
  const runs: ApiScheduleRun[] = data?.runs ?? [];
  if (isLoading) return <Loading />;
  if (runs.length === 0) {
    return <p className="tf-row text-sub">Запусков пока не было.</p>;
  }
  return (
    <div className="space-y-1">
      {runs.slice(0, 10).map((run) => (
        <div
          key={run.id}
          className="flex items-center justify-between gap-3 py-1"
        >
          <span className="tf-row text-sub">
            {formatWhen(run.run_at, schedule.timezone)}
          </span>
          <span
            className={
              run.status === "created"
                ? "tf-meta text-green"
                : run.status === "skipped"
                  ? "tf-meta text-dim"
                  : "tf-meta text-red"
            }
          >
            {run.status === "created"
              ? "запуск"
              : run.status === "skipped"
                ? "пропуск"
                : run.status === "error"
                  ? "ошибка"
                  : "не создана"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RoutinesScreen() {
  const { data, isLoading, isError, error } = useSchedules();
  const schedules = data?.schedules ?? [];
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const runNow = useRunScheduleNow();
  const { confirm, dialog } = useDialog();
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects();
  const { data: agents = [] } = useAgents();

  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [kind, setKind] = useState<ScheduleRuleKind>("daily");
  const [timeLocal, setTimeLocal] = useState("09:00");
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [weekdays, setWeekdays] = useState<string[]>(["1"]);
  const [interval, setInterval] = useState("15m");
  const [assignee, setAssignee] = useState("");
  const [projectId, setProjectId] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Роли-исполнители: из списка агентов берём тех, у кого есть role_key.
  const roleAgents = agents.filter((a) => (a as { role_key?: string | null }).role_key);

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await createSchedule.mutateAsync({
      title: title.trim(),
      rule_kind: kind,
      rule_expr:
        kind === "weekly_days"
          ? weekdays.join(",")
          : kind === "interval"
            ? interval
            : null,
      time_local: kind === "interval" ? "09:00" : timeLocal,
      timezone,
      task_payload: {
        title: taskTitle.trim() || title.trim(),
        assignee_id: assignee || null,
        project_id: projectId || null,
      },
    });
    setTitle("");
    setTaskTitle("");
    setShowCreate(false);
  });

  const handleDelete = async (schedule: ApiSchedule) => {
    const ok = await confirm({
      title: `Удалить рутину «${schedule.title}»?`,
      description:
        "Уже созданные по ней карточки останутся — удаляется только сама рутина и её история запусков. Действие нельзя отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    await deleteSchedule.mutateAsync(schedule.id);
  };

  const togglePause = async (schedule: ApiSchedule) => {
    const paused = schedule.status === "paused";
    await updateSchedule.mutateAsync({
      id: schedule.id,
      status: paused ? "active" : "paused",
    });
  };

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader variant="compact" title="Мои рутины" />

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-card rounded-2xl p-4 mb-4">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Название рутины"
            className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text placeholder:text-dim outline-none mb-2"
          />
          <input
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            placeholder="Название создаваемой задачи (если отличается)"
            className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text placeholder:text-dim outline-none mb-3"
          />

          <label className="tf-meta text-sub block mb-1">Правило</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ScheduleRuleKind)}
            className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text outline-none mb-3"
          >
            {Object.entries(RULE_TITLES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          {kind === "weekly_days" && (
            <div className="flex gap-1 mb-3">
              {WEEKDAY_TITLES.map((day, index) => {
                const value = String(index + 1);
                const active = weekdays.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setWeekdays((prev) =>
                        prev.includes(value)
                          ? prev.filter((d) => d !== value)
                          : [...prev, value],
                      )
                    }
                    className={
                      active
                        ? "tf-row w-10 h-10 rounded-xl bg-red text-white"
                        : "tf-row w-10 h-10 rounded-xl bg-card2 text-sub"
                    }
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          )}

          {kind === "interval" ? (
            <input
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              placeholder="15m или 2h"
              className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text placeholder:text-dim outline-none mb-3"
            />
          ) : (
            <input
              value={timeLocal}
              onChange={(e) => setTimeLocal(e.target.value)}
              placeholder="ЧЧ:ММ"
              className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text placeholder:text-dim outline-none mb-3"
            />
          )}

          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Europe/Moscow"
            className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text placeholder:text-dim outline-none mb-3"
          />

          <label className="tf-meta text-sub block mb-1">Роль-исполнитель</label>
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text outline-none mb-3"
          >
            <option value="">— без роли —</option>
            {roleAgents.map((a) => (
              <option key={a.id} value={(a as { role_key?: string }).role_key}>
                {a.name}
              </option>
            ))}
          </select>

          <label className="tf-meta text-sub block mb-1">Проект</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="tf-input w-full bg-card2 rounded-xl px-3 py-2.5 text-text outline-none mb-3"
          >
            <option value="">— без проекта —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <ErrorBanner
            error={createSchedule.error}
            fallback="Не удалось создать рутину"
            variant="block"
            className="mb-3"
          />
          <button
            type="submit"
            disabled={!title.trim() || createSchedule.isPending}
            className="tf-row w-full h-12 bg-red rounded-xl text-white disabled:opacity-50 tap-fade"
          >
            {createSchedule.isPending ? "Создаём…" : "Создать рутину"}
          </button>
        </form>
      )}

      {isLoading && <Loading />}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить рутины"
        variant="inline"
        className="mb-2"
      />

      {!isLoading && !isError && schedules.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center text-center pt-16 px-4">
          <div className="w-[64px] h-[64px] rounded-full bg-card flex items-center justify-center mb-4">
            <Icon name="clock" size={28} className="text-dim" />
          </div>
          <h3 className="tf-title mb-1">Рутин пока нет</h3>
          <p className="tf-row text-sub leading-relaxed mb-6 max-w-[280px]">
            Рутина сама создаёт задачу по расписанию и поднимает на ней
            роль. Создайте первую — состав и время можно поменять позже.
          </p>
          <Button
            variant="primary"
            onClick={() => setShowCreate(true)}
            className="w-auto px-6"
            icon="plus"
          >
            Создать рутину
          </Button>
        </div>
      ) : (
        <div className="space-y-[2px]">
          {schedules.map((s) => (
            <div key={s.id} className="bg-card rounded-xl mb-[2px]">
              <button
                onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                className="w-full flex items-center gap-3 py-3 px-4 text-left tap-row"
              >
                <div className="flex-1 min-w-0">
                  <div className="tf-body text-text truncate">{s.title}</div>
                  <div className="tf-meta text-sub truncate">
                    {ruleSummary(s)} · {s.timezone}
                  </div>
                  <div className="tf-meta text-dim truncate">
                    Следующий запуск: {formatWhen(s.next_run_at, s.timezone)}
                  </div>
                </div>
                {s.status === "paused" && (
                  <span className="tf-meta text-dim shrink-0">на паузе</span>
                )}
              </button>
              {expanded === s.id && (
                <div className="px-4 pb-3">
                  <div className="tf-meta text-sub mb-2">
                    Последний запуск: {formatWhen(s.last_run_at, s.timezone)}
                  </div>
                  <RunHistory schedule={s} />
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => togglePause(s)}
                      className="tf-row flex-1 h-11 rounded-xl bg-card2 text-sub tap-row"
                    >
                      {s.status === "paused" ? "Продолжить" : "Пауза"}
                    </button>
                    <button
                      onClick={() => runNow.mutate(s.id)}
                      disabled={runNow.isPending}
                      className="tf-row flex-1 h-11 rounded-xl bg-card2 text-sub disabled:opacity-50 tap-row"
                    >
                      Запустить сейчас
                    </button>
                    <button
                      onClick={() => handleDelete(s)}
                      aria-label="Удалить рутину"
                      className="w-[44px] h-[44px] flex items-center justify-center text-dim tap-row"
                    >
                      <Icon name="trash" size={18} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!showCreate && schedules.length > 0 && (
        <button
          onClick={() => setShowCreate(true)}
          className="w-full flex items-center gap-3 py-3 px-4 mt-4 border border-dashed border-stroke rounded-xl tap-row"
        >
          <Icon name="plus" size={18} className="text-dim" />
          <span className="tf-row text-sub">Создать рутину</span>
        </button>
      )}
    </div>
  );
}
