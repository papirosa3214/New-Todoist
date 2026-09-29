// ═══════════ ACTIVITY SCREEN ═══════════
// Closes a real hole: marking a task "выполнено" used to be a one-way door
// — the task vanished from every list (Inbox/Today/Upcoming all hard-filter
// to status:"active") with no screen anywhere showing completed tasks and
// no way to undo a stray tap. This screen is that missing screen: every
// completed task, grouped by the day it was finished, each with a
// "Вернуть в работу" action that PATCHes it back to status:"active".
//
// Drill-down screen (compact header + back button), not a tab — reached
// only from Settings → «Активность». Deliberately absent from
// Layout.tsx's TAB_ROUTES allowlist, so it gets no bottom nav / FAB.
//
// ── completed_at, and the empty-field fallback ──
// The server stamps `completed_at` only on the active→completed
// transition (see server/src/db.ts's migration + PATCH /api/tasks/:id) and
// backfilled every pre-existing completed task from `updated_at` at
// migration time. That backfill means a null `completed_at` on a
// status:"completed" row should be effectively impossible by the time this
// screen ships — but "should be" isn't "is", so `completionDate()` below
// still falls back to `updated_at` defensively rather than crashing or
// dropping the task from every group. No separate "Раньше"/unknown-date
// bucket: a task with no completed_at is simply grouped by the best date
// available, exactly the choice the server's own backfill already made.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks, useUpdateTask } from "../api/tasks";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  Loading,
  SheetHandle,
} from "../components/UI";
import { Card, FieldRow } from "../components/TaskFields";
import { MarkdownInline } from "../components/MarkdownInline";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { parseServerDate, todayStr, addDays } from "../lib/date";
import { useBottomSheet } from "../lib/useBottomSheet";
import { ActivityChart } from "../components/ActivityChart";
import type { ApiTask } from "../api/types";

const MONTHS_FULL = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

export type Period = "week" | "month" | "quarter" | "year";

interface Filters {
  projectId: string | null; // null = все проекты
  labelId: string | null; // null = все метки
  assigneeKey: string | null; // null = все, "__none" = без исполнителя, иначе user id
  period: Period;
}

const DEFAULT_FILTERS: Filters = {
  projectId: null,
  labelId: null,
  assigneeKey: null,
  period: "week",
};

const PERIOD_OPTIONS: { key: Period; label: string }[] = [
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "quarter", label: "3 месяца" },
  { key: "year", label: "Год" },
];

// completed_at is SQLite `datetime('now')` (UTC, no offset marker) — must
// go through parseServerDate, never `new Date(str)` directly, or anything
// completed after ~21:00 Moscow time lands in the wrong day's group.
function completionDate(task: ApiTask): Date {
  const raw = task.completed_at ?? task.updated_at;
  return parseServerDate(raw);
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function groupLabel(
  key: string,
  todayKey: string,
  yesterdayKey: string,
): string {
  if (key === todayKey) return "Сегодня";
  if (key === yesterdayKey) return "Вчера";
  const parts = key.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  return `${d} ${MONTHS_FULL[m - 1]}`;
}

// ═══════════ ONE CARD ═══════════
// Own useGuardedCallback + own useUpdateTask instance per card — a shared
// guard across the .map() would silently no-op every row but the first one
// in flight (see useGuardedCallback.ts's own doc comment on this).
function CompletedTaskCard({ task }: { task: ApiTask }) {
  const navigate = useNavigate();
  const updateTask = useUpdateTask();

  const restore = useGuardedCallback(async () => {
    await updateTask.mutateAsync({ id: task.id, status: "active" });
  });

  const completedAt = completionDate(task);
  const timeLabel = Number.isNaN(completedAt.getTime())
    ? null
    : `${String(completedAt.getHours()).padStart(2, "0")}:${String(
        completedAt.getMinutes(),
      ).padStart(2, "0")}`;

  return (
    <div className="bg-card rounded-2xl overflow-hidden">
      <button
        onClick={() => navigate(`/task/${task.id}`)}
        className="tap-row w-full text-left px-4 pt-3 pb-2.5 flex flex-col gap-1.5"
      >
        <span className="text-[15px] text-sub line-through leading-snug">
          <MarkdownInline source={task.title} />
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {timeLabel && (
            <span className="text-[12px] text-dim">{timeLabel}</span>
          )}
          {task.project_name && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
              style={{
                backgroundColor: (task.project_color || "#A6A6A6") + "26",
                color: task.project_color || "#A6A6A6",
              }}
            >
              <Icon name="hash" size={10} />
              {task.project_name}
            </span>
          )}
          {task.labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
              style={{ backgroundColor: l.color + "26", color: l.color }}
            >
              <Icon name="tag" size={10} />
              {l.name}
            </span>
          ))}
        </div>
      </button>

      <div className="border-t border-stroke">
        <button
          onClick={restore}
          disabled={updateTask.isPending}
          className="tap-row w-full flex items-center justify-center gap-2 h-11 text-[13px] font-semibold text-red disabled:opacity-50"
        >
          <Icon name="sync" size={14} />
          Вернуть в работу
        </button>
      </div>
      <ErrorBanner
        error={updateTask.error}
        fallback="Не удалось вернуть задачу в работу"
        variant="inline"
        className="px-4 pb-2"
      />
    </div>
  );
}

// ═══════════ FILTER SHEET ═══════════
// Same bottom-sheet chrome as RescheduleSheet.tsx (scrim + bg-card
// rounded-sheet-top panel, pb-bottom-safe, max-h-[85vh] overflow-y-auto) —
// used here as the style reference per direct instruction. Unlike
// RescheduleSheet's quick-pick rows (which apply immediately and close the
// whole sheet), each facet here expands in place and applies immediately
// but only collapses its own section — the four filters are independent
// and meant to be combined in one visit, so the sheet itself only closes
// via the X or the scrim.
function FilterPicker({
  sectionKey,
  openSection,
  setOpenSection,
  fieldIcon,
  fieldLabel,
  allLabel,
  currentLabel,
  optionIcon,
  options,
  selectedId,
  onSelect,
  emptyText,
}: {
  sectionKey: string;
  openSection: string | null;
  setOpenSection: (k: string | null) => void;
  fieldIcon: string;
  fieldLabel: string;
  allLabel: string;
  currentLabel: string;
  optionIcon: string;
  options: { id: string; label: string; color: string }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  emptyText: string;
}) {
  const isOpen = openSection === sectionKey;
  return (
    <Card>
      <FieldRow
        icon={fieldIcon}
        label={fieldLabel}
        value={currentLabel}
        chevronOpen={isOpen}
        onClick={() => setOpenSection(isOpen ? null : sectionKey)}
      />
      {isOpen && (
        <div className="border-t border-stroke">
          <button
            onClick={() => onSelect(null)}
            className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
          >
            <span className="text-[14px] text-text flex-1">{allLabel}</span>
            {selectedId === null && (
              <Icon name="check" size={16} className="text-red" />
            )}
          </button>
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => onSelect(opt.id)}
              className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
            >
              <Icon name={optionIcon} size={16} style={{ color: opt.color }} />
              <span className="text-[14px] text-text flex-1 truncate">
                {opt.label}
              </span>
              {selectedId === opt.id && (
                <Icon name="check" size={16} className="text-red" />
              )}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-dim">{emptyText}</div>
          )}
        </div>
      )}
    </Card>
  );
}

function ActivityFilterSheet({
  open,
  onClose,
  filters,
  setFilters,
  projectOptions,
  labelOptions,
  assigneeOptions,
}: {
  open: boolean;
  onClose: () => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  projectOptions: { id: string; label: string; color: string }[];
  labelOptions: { id: string; label: string; color: string }[];
  assigneeOptions: {
    list: {
      id: string;
      name: string;
      color: string;
      initials: string;
      avatar_url?: string | null;
    }[];
    hasUnassigned: boolean;
  };
}) {
  const [openSection, setOpenSection] = useState<string | null>(null);

  useEffect(() => {
    if (open) setOpenSection(null);
  }, [open]);

  // §3 Interruptibility, §5 Velocity handoff, §7 Spatial consistency
  const sheet = useBottomSheet({ open, onClose });

  if (!sheet.mounted) return null;

  const hasActive =
    !!filters.projectId ||
    !!filters.labelId ||
    !!filters.assigneeKey ||
    filters.period !== "week";

  const projectLabel =
    (filters.projectId &&
      projectOptions.find((p) => p.id === filters.projectId)?.label) ||
    "Все проекты";
  const labelLabel =
    (filters.labelId &&
      labelOptions.find((l) => l.id === filters.labelId)?.label) ||
    "Все метки";
  const assigneeLabel =
    filters.assigneeKey === "__none"
      ? "Без исполнителя"
      : (filters.assigneeKey &&
          assigneeOptions.list.find((a) => a.id === filters.assigneeKey)
            ?.name) ||
        "Все исполнители";
  const periodLabel =
    PERIOD_OPTIONS.find((p) => p.key === filters.period)?.label ?? "Неделя";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      {/* Scrim: opacity animated by useBottomSheet spring */}
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle: drag target for dismiss gesture */}
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          {/* Заголовок шторки — 17px, как заголовок вторичного экрана
              (ScreenHeader variant="compact"): шторка это тот же уровень
              навигации. 16px здесь был сиротой вне шкалы — в проекте 16px
              значит «поле ввода, защита от автозума iOS», см. index.css. */}
          <h3 className="text-[17px] font-semibold text-text">Фильтры</h3>
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            disabled={!hasActive}
            className="text-[13px] text-sub disabled:opacity-40 -mr-1 px-2 h-11"
          >
            Сбросить
          </button>
        </div>

        <div className="flex flex-col gap-3 pb-3">
          <FilterPicker
            sectionKey="project"
            openSection={openSection}
            setOpenSection={setOpenSection}
            fieldIcon="hash"
            fieldLabel="Проект"
            allLabel="Все проекты"
            currentLabel={projectLabel}
            optionIcon="hash"
            options={projectOptions}
            selectedId={filters.projectId}
            onSelect={(id) => {
              setFilters({ ...filters, projectId: id });
              setOpenSection(null);
            }}
            emptyText="Нет выполненных задач с проектом"
          />

          <FilterPicker
            sectionKey="label"
            openSection={openSection}
            setOpenSection={setOpenSection}
            fieldIcon="tag"
            fieldLabel="Метка"
            allLabel="Все метки"
            currentLabel={labelLabel}
            optionIcon="tag"
            options={labelOptions}
            selectedId={filters.labelId}
            onSelect={(id) => {
              setFilters({ ...filters, labelId: id });
              setOpenSection(null);
            }}
            emptyText="Нет выполненных задач с метками"
          />

          <Card>
            <FieldRow
              icon="person"
              label="Исполнитель"
              value={assigneeLabel}
              chevronOpen={openSection === "assignee"}
              onClick={() =>
                setOpenSection(openSection === "assignee" ? null : "assignee")
              }
            />
            {openSection === "assignee" && (
              <div className="border-t border-stroke">
                <button
                  onClick={() => {
                    setFilters({ ...filters, assigneeKey: null });
                    setOpenSection(null);
                  }}
                  className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
                >
                  <span className="text-[14px] text-text flex-1">
                    Все исполнители
                  </span>
                  {filters.assigneeKey === null && (
                    <Icon name="check" size={16} className="text-red" />
                  )}
                </button>
                {assigneeOptions.list.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setFilters({ ...filters, assigneeKey: a.id });
                      setOpenSection(null);
                    }}
                    className="tap-row w-full flex items-center gap-3 py-2.5 px-4 text-left"
                  >
                    <Avatar
                      initials={a.initials}
                      color={a.color}
                      avatar_url={a.avatar_url}
                      size={24}
                    />
                    <span className="text-[14px] text-text flex-1 truncate">
                      {a.name}
                    </span>
                    {filters.assigneeKey === a.id && (
                      <Icon name="check" size={16} className="text-red" />
                    )}
                  </button>
                ))}
                {assigneeOptions.hasUnassigned && (
                  <button
                    onClick={() => {
                      setFilters({ ...filters, assigneeKey: "__none" });
                      setOpenSection(null);
                    }}
                    className="tap-row w-full flex items-center gap-3 py-2.5 px-4 text-left"
                  >
                    <div className="w-[24px] h-[24px] rounded-full bg-card2 flex items-center justify-center shrink-0">
                      <Icon name="person" size={12} className="text-dim" />
                    </div>
                    <span className="text-[14px] text-text flex-1">
                      Без исполнителя
                    </span>
                    {filters.assigneeKey === "__none" && (
                      <Icon name="check" size={16} className="text-red" />
                    )}
                  </button>
                )}
                {assigneeOptions.list.length === 0 &&
                  !assigneeOptions.hasUnassigned && (
                    <div className="px-4 py-3 text-[13px] text-dim">
                      Нет данных об исполнителях
                    </div>
                  )}
              </div>
            )}
          </Card>

          <Card>
            <FieldRow
              icon="calendarSmall"
              label="Период"
              value={periodLabel}
              chevronOpen={openSection === "period"}
              onClick={() =>
                setOpenSection(openSection === "period" ? null : "period")
              }
            />
            {openSection === "period" && (
              <div className="border-t border-stroke">
                {PERIOD_OPTIONS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => {
                      setFilters({ ...filters, period: p.key });
                      setOpenSection(null);
                    }}
                    className="tap-row w-full flex items-center gap-3 py-3 px-4 text-left"
                  >
                    <span className="text-[14px] text-text flex-1">
                      {p.label}
                    </span>
                    {filters.period === p.key && (
                      <Icon name="check" size={16} className="text-red" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ═══════════ SCREEN ═══════════

export function ActivityScreen() {
  const { data: allTasks = [], isLoading, error } = useTasks();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);

  const completed = useMemo(
    () => allTasks.filter((t) => t.status === "completed"),
    [allTasks],
  );

  // Filter option lists are built from the full completed set (not the
  // already-filtered one) — every option shown is guaranteed to match at
  // least one completed task somewhere, even if combining it with another
  // active filter currently yields zero (that's the "filtered empty state"
  // below, not a dead option in the picker).
  const projectOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string; color: string }>();
    for (const t of completed) {
      if (t.project_id && t.project_name && !map.has(t.project_id)) {
        map.set(t.project_id, {
          id: t.project_id,
          label: t.project_name,
          color: t.project_color || "#A6A6A6",
        });
      }
    }
    return [...map.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "ru"),
    );
  }, [completed]);

  const labelOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string; color: string }>();
    for (const t of completed) {
      for (const l of t.labels) {
        if (!map.has(l.id)) {
          map.set(l.id, { id: l.id, label: l.name, color: l.color });
        }
      }
    }
    return [...map.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "ru"),
    );
  }, [completed]);

  const assigneeOptions = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        color: string;
        initials: string;
        avatar_url?: string | null;
      }
    >();
    let hasUnassigned = false;
    for (const t of completed) {
      if (t.assignee_id) {
        if (!map.has(t.assignee_id)) {
          map.set(t.assignee_id, {
            id: t.assignee_id,
            name: t.assignee_name || "Без имени",
            color: t.assignee_color || "#A6A6A6",
            initials: t.assignee_initials || "?",
            avatar_url: t.assignee_avatar_url,
          });
        }
      } else {
        hasUnassigned = true;
      }
    }
    return {
      list: [...map.values()].sort((a, b) =>
        a.name.localeCompare(b.name, "ru"),
      ),
      hasUnassigned,
    };
  }, [completed]);

  // Rolling window (now − N days), not calendar week/month — "неделя"
  // means "last 7 days", so a task completed last Tuesday still counts on
  // this Monday. Recomputed only when the period selection changes.
  const periodCutoff = useMemo(() => {
    const d = new Date();
    if (filters.period === "week") {
      d.setDate(d.getDate() - 7);
      return d;
    }
    if (filters.period === "month") {
      return new Date(d.getFullYear(), d.getMonth(), 1);
    }
    if (filters.period === "quarter") {
      d.setDate(d.getDate() - 90);
      return d;
    }
    // "year" — с 1 января текущего года
    return new Date(d.getFullYear(), 0, 1);
  }, [filters.period]);

  const filtered = useMemo(() => {
    return completed.filter((t) => {
      if (filters.projectId && t.project_id !== filters.projectId) return false;
      if (filters.labelId && !t.labels.some((l) => l.id === filters.labelId))
        return false;
      if (filters.assigneeKey === "__none") {
        if (t.assignee_id) return false;
      } else if (filters.assigneeKey && t.assignee_id !== filters.assigneeKey) {
        return false;
      }
      if (periodCutoff && completionDate(t).getTime() < periodCutoff.getTime())
        return false;
      return true;
    });
  }, [completed, filters, periodCutoff]);

  const today = todayStr();
  const yesterday = addDays(today, -1);

  const groups = useMemo(() => {
    const map = new Map<string, ApiTask[]>();
    for (const t of filtered) {
      const key = dayKey(completionDate(t));
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    for (const arr of map.values()) {
      arr.sort(
        (a, b) => completionDate(b).getTime() - completionDate(a).getTime(),
      );
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, tasks]) => ({
        key,
        label: groupLabel(key, today, yesterday),
        tasks,
      }));
  }, [filtered, today, yesterday]);

  const filteredAllTasks = useMemo(() => {
    return allTasks.filter((t) => {
      if (filters.projectId && t.project_id !== filters.projectId) return false;
      if (filters.labelId && !t.labels.some((l) => l.id === filters.labelId))
        return false;
      if (filters.assigneeKey === "__none") {
        if (t.assignee_id) return false;
      } else if (filters.assigneeKey && t.assignee_id !== filters.assigneeKey) {
        return false;
      }
      return true;
    });
  }, [allTasks, filters]);

  // Счётчик активных фильтров больше не нужен: индикатор с кнопки убран
  // (26.08.2026). Шторка сама показывает, что выбрано.

  const periodWord =
    filters.period === "week"
      ? "неделю"
      : filters.period === "month"
        ? "месяц"
        : filters.period === "quarter"
          ? "3 месяца"
          : "год";
  const summaryText = `За ${periodWord} выполнено ${filtered.length}`;

  const showTrueEmpty = !isLoading && completed.length === 0;
  const showFilteredEmpty =
    !isLoading && completed.length > 0 && filtered.length === 0;

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title="Активность"
        actions={
          /* Кнопка фильтра — ровно та же, что на остальных экранах
             (TaskFilterButton): иконка-воронка 44×44, без подписи и без
             своей плашки. Раньше здесь была пилюля bg-card2 со словом
             «Фильтры» и иконкой списка — единственная такая в приложении
             (Максим 26.08.2026: «в активностях фильтры не как воронка, как
             везде, а какое-то слово»). Красной точки-индикатора нет ни
             здесь, ни на других экранах — по его же просьбе. */
          <button
            onClick={() => setSheetOpen(true)}
            aria-label="Фильтры"
            className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
          >
            <Icon name="filter" size={18} />
          </button>
        }
      />

      {isLoading && <Loading className="mt-3" />}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить выполненные задачи"
        variant="inline"
        className="mt-3"
      />

      {!isLoading && (
        <ActivityChart
          tasks={filteredAllTasks}
          period={filters.period}
          onPeriodChange={(newP) => setFilters((f) => ({ ...f, period: newP }))}
        />
      )}

      {!isLoading && !showTrueEmpty && (
        <p className="px-1 text-[13px] text-sub mt-2 mb-3">{summaryText}</p>
      )}

      {showTrueEmpty && (
        <div className="text-center py-16 px-6">
          <Icon name="check" size={32} className="text-dim mx-auto mb-3" />
          <p className="text-[14px] text-text mb-1">Пока ничего не выполнено</p>
          <p className="text-[13px] text-dim">
            Задачи, которые вы отметите выполненными, появятся здесь — и их
            всегда можно будет вернуть в работу
          </p>
        </div>
      )}

      {showFilteredEmpty && (
        <div className="text-center py-16 px-6">
          <Icon name="list" size={32} className="text-dim mx-auto mb-3" />
          <p className="text-[14px] text-text mb-1">
            Под выбранные фильтры ничего не подошло
          </p>
          <p className="text-[13px] text-dim mb-4">
            Попробуйте изменить период или сбросить фильтры
          </p>
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="tap-fade inline-flex items-center justify-center h-11 px-5 rounded-xl bg-card2 text-[14px] text-text"
          >
            Сбросить фильтры
          </button>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key} className="mb-5">
          <h3 className="text-[13px] font-semibold text-sub mb-2 px-1">
            {g.label}
          </h3>
          <div className="flex flex-col gap-2">
            {g.tasks.map((t) => (
              <CompletedTaskCard key={t.id} task={t} />
            ))}
          </div>
        </div>
      ))}

      <ActivityFilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={filters}
        setFilters={setFilters}
        projectOptions={projectOptions}
        labelOptions={labelOptions}
        assigneeOptions={assigneeOptions}
      />
    </div>
  );
}
