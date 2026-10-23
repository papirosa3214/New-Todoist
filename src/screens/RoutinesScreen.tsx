// ═══════════ РУТИНЫ (КРОН-ЗАДАЧИ) — экран «Мои рутины» ═══════════
//
// Рутина — запись, которая в назначенное время сама создаёт задачу по
// шаблону и поднимает на ней роль. Контракт API — из заметки «Рутины и
// расписание TaskFlow», раздел «6. API»; серверная часть —
// server/src/runtime/schedules/. Разметка и состояния — по разделу
// «Этап 2 — экран “Мои рутины”» (дизайн, 22.10.2026).
//
// Экран показывает: название, правило (подпись с сервера), роль, время
// запуска в зоне рутины, следующий и последний запуск, статус паузы и
// историю запусков. Пауза останавливает будущие запуски, но уже
// созданную карточку не трогает.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useRunScheduleNow,
  useSchedulePreview,
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
  Button,
  Divider,
  ErrorBanner,
  Icon,
  IconButton,
  ScreenHeader,
  Switch,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { formatNextRun, formatWhen, ruleSummary, runStatusLabel } from "./routinesFormat";

/** Правила в форме (дизайн, §2.5): шесть вариантов. */
const RULE_OPTIONS: Array<{ value: ScheduleRuleKind; label: string }> = [
  { value: "daily", label: "Ежедневно" },
  { value: "weekdays", label: "По будням" },
  { value: "weekly", label: "Еженедельно" },
  { value: "weekly_days", label: "Конкретные дни" },
  { value: "monthly", label: "Ежемесячно" },
  { value: "interval", label: "Каждые N минут" },
];

const WEEKDAY_TITLES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Интервалы от 5 минут (минимальный интервал планировщика). */
const INTERVAL_OPTIONS = [
  { value: "5m", label: "Каждые 5 минут" },
  { value: "10m", label: "Каждые 10 минут" },
  { value: "15m", label: "Каждые 15 минут" },
  { value: "30m", label: "Каждые 30 минут" },
  { value: "1h", label: "Каждый час" },
  { value: "2h", label: "Каждые 2 часа" },
  { value: "4h", label: "Каждые 4 часа" },
];

/** День недели по умолчанию — сегодняшний (ISO: 1=Пн..7=Вс). */
function todayWeekday(timezone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "weekday")?.value;
    const map: Record<string, string> = {
      Mon: "1",
      Tue: "2",
      Wed: "3",
      Thu: "4",
      Fri: "5",
      Sat: "6",
      Sun: "7",
    };
    return part ? (map[part] ?? "1") : "1";
  } catch {
    return "1";
  }
}

/** День месяца по умолчанию — сегодняшний. */
function todayMonthDay(timezone: string): string {
  try {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, day: "2-digit" })
      .formatToParts(new Date())
      .find((p) => p.type === "day")?.value;
    return day ? String(Number(day)) : "1";
  } catch {
    return "1";
  }
}

function SkeletonList() {
  return (
    <div className="space-y-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-card r-surface px-4 py-3.5">
          <div className="h-4 w-1/2 rounded bg-card2 mb-2" />
          <div className="h-3 w-2/3 rounded bg-card2" />
        </div>
      ))}
    </div>
  );
}

function RunHistory({
  schedule,
  onOpenTask,
}: {
  schedule: ApiSchedule;
  onOpenTask: (taskId: string) => void;
}) {
  const { data, isLoading, isError } = useScheduleRuns(schedule.id);
  const [showAll, setShowAll] = useState(false);
  const runs: ApiScheduleRun[] = data?.runs ?? [];
  if (isLoading) return <p className="tf-action text-dim">Загружаем историю…</p>;
  if (isError) {
    return <ErrorBanner error="История запусков не загрузилась" fallback="Не удалось загрузить историю" />;
  }
  if (runs.length === 0) {
    return <p className="tf-action text-sub">Запусков ещё не было.</p>;
  }
  const visible = showAll ? runs : runs.slice(0, 10);
  return (
    <div>
      {visible.map((run) => (
        <div key={run.id} className="py-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="tf-action text-sub">
              {formatWhen(run.run_at, schedule.timezone)}
            </span>
            {run.task_id ? (
              <button
                type="button"
                onClick={() => onOpenTask(run.task_id!)}
                className="tf-action text-blue"
              >
                {run.status === "created" ? "задача запуска" : runStatusLabel(run.status)}
              </button>
            ) : (
              <span
                className={
                  run.status === "skipped"
                    ? "tf-action text-dim"
                    : "tf-action text-coral"
                }
              >
                {runStatusLabel(run.status)}
              </span>
            )}
          </div>
          {run.detail && run.status !== "created" && (
            <p className="tf-action text-dim">{run.detail}</p>
          )}
        </div>
      ))}
      {runs.length > 10 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="tf-action text-blue mt-1"
        >
          Показать все запуски ({runs.length})
        </button>
      )}
    </div>
  );
}

export function RoutinesScreen() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useSchedules();
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
  const [weeklyDay, setWeeklyDay] = useState(() => todayWeekday("Europe/Moscow"));
  const [monthlyDay, setMonthlyDay] = useState(() => todayMonthDay("Europe/Moscow"));
  const [interval, setInterval] = useState("15m");
  const [assignee, setAssignee] = useState("");
  const [projectId, setProjectId] = useState("");
  const [skipOverlap, setSkipOverlap] = useState(true);
  const [catchUp, setCatchUp] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [createdNotice, setCreatedNotice] = useState(false);
  const [runNotice, setRunNotice] = useState<{
    status: string;
    taskId: string | null;
    detail: string | null;
  } | null>(null);

  // Роли-исполнители: из списка агентов берём тех, у кого есть role_key.
  const roleAgents = agents.filter((a) => (a as { role_key?: string | null }).role_key);
  const roleTitle = (key: string | null | undefined) => {
    if (!key) return "";
    const found = roleAgents.find((a) => (a as { role_key?: string }).role_key === key) as
      | { name?: string }
      | undefined;
    return found?.name ?? key;
  };

  const ruleExpr =
    kind === "weekly_days"
      ? weekdays.join(",")
      : kind === "weekly"
        ? weeklyDay
        : kind === "monthly"
          ? monthlyDay
          : kind === "interval"
            ? interval
            : null;

  // Превью правила: ближайший запуск считает сервер (дизайн, критерий 6).
  const preview = useSchedulePreview({
    rule_kind: kind,
    rule_expr: ruleExpr,
    time_local: kind === "interval" ? undefined : timeLocal,
    timezone,
    enabled: showCreate,
  });

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (kind === "weekly_days" && weekdays.length === 0) return;
    await createSchedule.mutateAsync({
      title: title.trim(),
      rule_kind: kind,
      rule_expr: ruleExpr,
      time_local: kind === "interval" ? "09:00" : timeLocal,
      timezone,
      catch_up: catchUp,
      overlap_policy: skipOverlap ? "skip" : "allow",
      task_payload: {
        title: taskTitle.trim() || title.trim(),
        assignee_id: assignee || null,
        project_id: projectId || null,
      },
    });
    setTitle("");
    setTaskTitle("");
    setShowCreate(false);
    setCreatedNotice(true);
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

  const runNowAndReport = async (schedule: ApiSchedule) => {
    const result = await runNow.mutateAsync(schedule.id);
    const run = result?.run ?? null;
    setRunNotice({
      status: run?.status ?? "error",
      // Пропуск из-за незакрытого прошлого запуска — ссылка на него.
      taskId: run?.task_id ?? schedule.current_task_id ?? null,
      detail: run?.detail ?? null,
    });
    await qc.invalidateQueries({ queryKey: ["schedules"] });
  };

  const openTask = (taskId: string) => navigate(`/task/${taskId}`);

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader
        variant="compact"
        title="Мои рутины"
        actions={
          <IconButton
            icon="plus"
            label="Создать рутину"
            onClick={() => setShowCreate((v) => !v)}
          />
        }
      />

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-card r-surface p-4 mb-4">
          <label className="tf-action text-sub block mb-1" htmlFor="routine-title">
            Название рутины
          </label>
          <input
            id="routine-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ежедневный отчёт продаж"
            className="tf-input w-full bg-card2 r-control-md px-3 h-control-lg text-text placeholder:text-dim outline-none mb-3"
          />

          <span className="tf-action text-sub block mb-1" id="routine-rule-label">
            Правило
          </span>
          <div
            role="radiogroup"
            aria-labelledby="routine-rule-label"
            className="r-surface overflow-hidden mb-3"
          >
            {RULE_OPTIONS.map((option) => {
              const selected = kind === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setKind(option.value)}
                  className="w-full flex items-center gap-3 px-4 h-control-lg bg-card text-left tap-row"
                >
                  <span className="flex-1 min-w-0 tf-body text-text">{option.label}</span>
                  <span
                    aria-hidden
                    className={
                      selected
                        ? "w-[18px] h-[18px] rounded-full border-2 border-red"
                        : "w-[18px] h-[18px] rounded-full border-2 border-stroke"
                    }
                  />
                </button>
              );
            })}
          </div>

          {kind === "weekly_days" && (
            <div className="mb-3">
              <span className="tf-action text-sub block mb-1" id="routine-weekdays-label">
                Дни недели
              </span>
              <div role="group" aria-labelledby="routine-weekdays-label" className="flex gap-1">
                {WEEKDAY_TITLES.map((day, index) => {
                  const value = String(index + 1);
                  const active = weekdays.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      aria-label={day}
                      onClick={() =>
                        setWeekdays((prev) =>
                          prev.includes(value)
                            ? prev.filter((d) => d !== value)
                            : [...prev, value],
                        )
                      }
                      className={`tf-action w-11 h-11 r-control-md ${
                        active ? "bg-red text-white" : "bg-card2 text-sub"
                      }`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
              {weekdays.length === 0 && (
                <p className="tf-action text-coral mt-1">
                  Выберите хотя бы один день
                </p>
              )}
            </div>
          )}

          {kind === "weekly" && (
            <div className="mb-3">
              <span className="tf-action text-sub block mb-1" id="routine-weeklyday-label">
                День недели
              </span>
              <div
                role="radiogroup"
                aria-labelledby="routine-weeklyday-label"
                className="flex gap-1"
              >
                {WEEKDAY_TITLES.map((day, index) => {
                  const value = String(index + 1);
                  const active = weeklyDay === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setWeeklyDay(value)}
                      className={`tf-action w-11 h-11 r-control-md ${
                        active ? "bg-red text-white" : "bg-card2 text-sub"
                      }`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {kind === "monthly" && (
            <div className="mb-3">
              <label className="tf-action text-sub block mb-1" htmlFor="routine-monthday">
                День месяца
              </label>
              <select
                id="routine-monthday"
                value={monthlyDay}
                onChange={(e) => setMonthlyDay(e.target.value)}
                className="tf-input w-full bg-card2 r-control-md px-3 h-control-lg text-text outline-none"
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <option key={day} value={String(day)}>
                    {day}-е число
                  </option>
                ))}
              </select>
            </div>
          )}

          {kind === "interval" ? (
            <div className="mb-3">
              <label className="tf-action text-sub block mb-1" htmlFor="routine-interval">
                Интервал
              </label>
              <select
                id="routine-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="tf-input w-full bg-card2 r-control-md px-3 h-control-lg text-text outline-none"
              >
                {INTERVAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="mb-3">
              <label className="tf-action text-sub block mb-1" htmlFor="routine-time">
                Время запуска
              </label>
              <input
                id="routine-time"
                value={timeLocal}
                onChange={(e) => setTimeLocal(e.target.value)}
                placeholder="ЧЧ:ММ"
                className="tf-input w-full bg-card2 r-control-md px-3 h-control-lg text-text placeholder:text-dim outline-none"
              />
            </div>
          )}

          <div className="mb-3">
            <label className="tf-action text-sub block mb-1" htmlFor="routine-tz">
              Часовой пояс
            </label>
            <input
              id="routine-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Europe/Moscow"
              className="tf-input w-full bg-card2 r-control-md px-3 h-control-lg text-text placeholder:text-dim outline-none"
            />
          </div>

          <div className="bg-card2 r-control-md p-3 mb-3">
            <span className="tf-action text-sub block mb-2">Что создаст задачу</span>
            <input
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder={`Название задачи (по умолчанию — ${title.trim() || "название рутины"})`}
              className="tf-input w-full bg-card r-control-md px-3 h-control-lg text-text placeholder:text-dim outline-none mb-2"
            />
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              aria-label="Роль-исполнитель"
              className="tf-input w-full bg-card r-control-md px-3 h-control-lg text-text outline-none mb-2"
            >
              <option value="">— без роли —</option>
              {roleAgents.map((a) => (
                <option key={a.id} value={(a as { role_key?: string }).role_key}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label="Проект"
              className="tf-input w-full bg-card r-control-md px-3 h-control-lg text-text outline-none"
            >
              <option value="">— без проекта —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="bg-card r-surface overflow-hidden mb-3">
            <div className="flex items-center gap-3 px-4 h-control-lg">
              <span className="flex-1 tf-action text-sub">
                Пропускать запуск, пока прошлый не закрыт
              </span>
              <Switch
                checked={skipOverlap}
                onChange={setSkipOverlap}
                ariaLabel="Пропускать запуск, пока прошлый не закрыт"
              />
            </div>
            <Divider />
            <div className="flex items-center gap-3 px-4 h-control-lg">
              <span className="flex-1 tf-action text-sub">
                Догонять пропущенный запуск
              </span>
              <Switch
                checked={catchUp}
                onChange={setCatchUp}
                ariaLabel="Догонять пропущенный запуск"
              />
            </div>
          </div>

          {preview.isError && (
            <div className="bg-card2 r-control-md p-3 mb-3">
              <p className="tf-action text-sub leading-relaxed">
                Не удалось посчитать ближайший запуск — проверьте правило, время и
                часовой пояс.
              </p>
            </div>
          )}

          {preview.data && (
            <div className="bg-card2 r-control-md p-3 mb-3">
              <p className="tf-action text-sub leading-relaxed">
                Создаст задачу «{taskTitle.trim() || title.trim() || "…"}»{" "}
                {preview.data.rule_label}
                {kind === "interval" ? "" : ` в ${timeLocal}`}. Ближайший запуск —{" "}
                {preview.data.next_run_at
                  ? formatNextRun(preview.data.next_run_at, preview.data.timezone)
                  : "не удалось посчитать"}
                .
              </p>
            </div>
          )}

          <ErrorBanner
            error={createSchedule.error}
            fallback="Не удалось создать рутину"
            variant="block"
            className="mb-3"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowCreate(false)}
              className="flex-1"
            >
              Отмена
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={
                !title.trim() ||
                (kind === "weekly_days" && weekdays.length === 0) ||
                createSchedule.isPending
              }
            >
              {createSchedule.isPending ? "Создаём…" : "Создать рутину"}
            </Button>
          </div>
        </form>
      )}

      {createdNotice && (
        <div className="bg-card2 r-control-md px-3 py-2.5 mb-3 flex items-center gap-2">
          <span className="tf-action text-sub flex-1">Рутина создана</span>
          <IconButton
            icon="close"
            label="Скрыть"
            size={14}
            onClick={() => setCreatedNotice(false)}
          />
        </div>
      )}

      {runNotice && (
        <div className="bg-card2 r-control-md px-3 py-2.5 mb-3 flex items-center gap-2">
          <span className="tf-action text-sub flex-1">
            {runNotice.status === "created"
              ? "Запуск создан"
              : runNotice.status === "skipped"
                ? `Пропущено: ${runNotice.detail ?? "прошлый запуск ещё не закрыт"}`
                : `Не удалось запустить: ${runNotice.detail ?? runStatusLabel(runNotice.status)}`}
          </span>
          {runNotice.taskId && (
            <button
              type="button"
              onClick={() => openTask(runNotice.taskId!)}
              className="tf-action text-blue"
            >
              Открыть задачу
            </button>
          )}
          <IconButton
            icon="close"
            label="Скрыть"
            size={14}
            onClick={() => setRunNotice(null)}
          />
        </div>
      )}

      {lastRunNotice && (
        <div className="bg-card2 rounded-xl px-3 py-2.5 mb-3 flex items-center gap-2">
          <span className="tf-action text-sub flex-1">{lastRunNotice}</span>
          <IconButton
            icon="close"
            label="Скрыть"
            size={14}
            onClick={() => setLastRunNotice(null)}
          />
        </div>
      )}

      {isLoading && <SkeletonList />}

      {isError && (
        <div className="bg-card r-surface p-4">
          <ErrorBanner error={error} fallback="Не удалось загрузить рутины" />
          <Button variant="secondary" className="mt-3" onClick={() => refetch()}>
            Повторить
          </Button>
        </div>
      )}

      {!isLoading && !isError && schedules.length === 0 && !showCreate && (
        <div className="flex flex-col items-center text-center pt-16 px-4">
          <div className="w-16 h-16 rounded-full bg-card flex items-center justify-center mb-4">
            <Icon name="clock" size={28} className="text-dim" />
          </div>
          <h3 className="tf-body font-semibold text-text mb-1">Рутин пока нет</h3>
          <p className="tf-action text-sub leading-relaxed mb-6 max-w-[280px]">
            Рутина сама создаёт задачу в заданное время. Создайте первую —
            состав и время можно поменять позже.
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
      )}

      {!isLoading && !isError && schedules.length > 0 && (
        <div className="space-y-[2px]">
          {schedules.map((s) => {
            const role = roleTitle(s.task_payload?.assignee_id);
            return (
              <div key={s.id} className="bg-card r-surface mb-[2px]">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                  aria-expanded={expanded === s.id}
                  className="w-full flex items-center gap-3 py-3 px-4 text-left tap-row"
                >
                  <Icon name="clock" size={18} className="text-dim shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="tf-body text-text truncate">{s.title}</div>
                    <div className="tf-action text-sub truncate">
                      {ruleSummary(s)}
                      {role ? ` · ${role}` : ""}
                    </div>
                    <div className="tf-action text-dim truncate">
                      {s.status === "paused"
                        ? s.last_run_at
                          ? `Последний запуск: ${formatWhen(s.last_run_at, s.timezone)}`
                          : "Запусков ещё не было"
                        : `Следующий запуск: ${formatNextRun(s.next_run_at, s.timezone)}`}
                    </div>
                  </div>
                  {s.status === "paused" && (
                    <span className="tf-action text-dim shrink-0">На паузе</span>
                  )}
                </button>
                {expanded === s.id && (
                  <div className="px-4 pb-3">
                    <div className="tf-action text-sub mb-1">
                      Часовой пояс: {s.timezone}
                    </div>
                    {s.current_task_id && (
                      <button
                        type="button"
                        onClick={() => openTask(s.current_task_id!)}
                        className="tf-action text-blue mb-1"
                      >
                        Прошлый запуск ещё не закрыт — открыть задачу
                      </button>
                    )}
                    <RunHistory schedule={s} onOpenTask={openTask} />
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => togglePause(s)}
                        className="tf-action flex-1 h-11 r-control-md bg-card2 text-sub tap-row"
                      >
                        {s.status === "paused" ? "Возобновить" : "Пауза"}
                      </button>
                      <button
                        type="button"
                        onClick={() => runNowAndReport(s)}
                        disabled={runNow.isPending || s.status !== "active"}
                        className="tf-action flex-1 h-11 r-control-md bg-card2 text-sub disabled:opacity-50 tap-row"
                      >
                        Запустить сейчас
                      </button>
                      <IconButton
                        icon="trash"
                        label="Удалить рутину"
                        onClick={() => handleDelete(s)}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!showCreate && schedules.length > 0 && (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="w-full flex items-center gap-3 py-3 px-4 mt-4 border border-dashed border-stroke r-control-md tap-row"
        >
          <Icon name="plus" size={18} className="text-dim" />
          <span className="tf-action text-sub">Создать рутину</span>
        </button>
      )}
    </div>
  );
}
