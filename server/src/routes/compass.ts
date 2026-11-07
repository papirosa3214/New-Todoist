import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getProjectForUser } from "../access.js";

/**
 * Compass — компактный маршрут проекта.
 *
 * Не хранит этапы: собирает их на лету из существующих данных.
 *
 * Стратегия — по проекту:
 *   1. Найти в проекте явные метки этапов: задачи с префиксом
 *      "Спек X", "Спек X.Y" или "Этап N".
 *   2. Приписать остальные задачи к ближайшему по префиксу.
 *      Например, в проекте с метками "Спек 1.1" и "Спек 1.2"
 *      задачи "1.1.5" и "1.2.3" уходят к своим этапам.
 *      Задачи без числового префикса — в отдельный "misc".
 *   3. Если явных меток меньше двух — падаем на временные кластеры
 *      с разрывом `gap_days` дней.
 *
 * Возвраты считаются из task_events (цепочки
 * in_progress → review → changes_requested → in_progress); версии
 * — из artifact_versions; входящие связи — из task_dependencies
 * и parent_id.
 *
 * V1 (alpha, сентябрь 2026): кеша нет, пересчёт на запрос.
 * Допустимый порядок — десятки задач, потому что выборки маленькие.
 * Дальше — кеш 60 секунд + WS push при task_events:created.
 */

const STAGE_GAP_DAYS_DEFAULT = 14;

const NUM_PREFIX_RE = /^(\d+(?:\.\d+)*)/;
const SPEK_PREFIX_RE = /^Спек\s+(\d+(?:\.\d+)?)/;
const ETAP_PREFIX_RE = /^Этап\s+(\d+)/;

interface RawTask {
  id: string;
  title: string;
  status: "active" | "completed";
  priority: number;
  assignee_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  parent_id: string | null;
  project_id: string;
}

interface RawEvent {
  id: string;
  task_id: string;
  kind: string;
  field: string | null;
  from_value: string | null;
  to_value: string | null;
  created_at: string;
}

interface RawReview {
  id: string;
  task_id: string;
  verdict: string;
  created_at: string;
}

interface EnrichedTask {
  id: string;
  title: string;
  status: "active" | "completed";
  priority: number;
  started_at: string;
  completed_at: string | null;
  return_count: number;
  last_return_reason: string | null;
  version_count: number;
  has_review_changes: boolean;
  stage_key: string;
  label_hint: string | null;
  full_label: string | null;
}

interface ProjectLabel {
  key: string;
  num: string;
  full: string;
  label: string;
  short: string;
}

interface StageShape {
  id: string;
  key: string;
  name: string;
  short_name: string;
  started_at: string;
  completed_at: string | null;
  status: "active" | "completed" | "planned";
  task_count: number;
  completed_count: number;
  active_count: number;
  completion_ratio: number;
  return_count: number;
  tasks: Array<{
    id: string;
    title: string;
    status: "active" | "completed";
    priority: number;
    started_at: string;
    completed_at: string | null;
    return_count: number;
    has_reviews: boolean;
  }>;
  returns: Array<{
    task_id: string;
    title: string;
    attempts: number;
    last_reason: string | null;
  }>;
  versions_summary: Array<{
    task_id: string;
    title: string;
    version_count: number;
    latest_version_no: number;
  }>;
}

function detectLabel(title: string): ProjectLabel | null {
  const spek = title.match(SPEK_PREFIX_RE);
  if (spek) {
    const num = spek[1];
    const rest = title
      .slice(spek[0].length)
      .replace(/^[\s—–\-:.]+/, "")
      .trim();
    const short = rest.split(/\s+/).slice(0, 6).join(" ");
    return {
      key: num,
      num,
      full: `Спек ${num}`,
      label: short ? `Спек ${num} — ${short}` : `Спек ${num}`,
      short: short || `Спек ${num}`,
    };
  }
  const etap = title.match(ETAP_PREFIX_RE);
  if (etap) {
    return {
      key: etap[1],
      num: etap[1],
      full: `Этап ${etap[1]}`,
      label: `Этап ${etap[1]}`,
      short: `Этап ${etap[1]}`,
    };
  }
  return null;
}

function numericPrefix(title: string): string | null {
  const m = title.match(NUM_PREFIX_RE);
  return m ? m[1] : null;
}

function chooseStageKey(
  taskNumPrefix: string | null,
  taskLabel: ProjectLabel | null,
  projectLabels: ProjectLabel[],
): { key: string; labelHint: string | null; fullLabel: string | null } {
  // 1. Если у самой задачи явная метка — она определяет ключ.
  if (taskLabel) {
    return {
      key: taskLabel.key,
      labelHint: taskLabel.short,
      fullLabel: taskLabel.full,
    };
  }
  // 2. Если у проекта есть метки — приписать по самой длинной подходящей.
  if (projectLabels.length > 0) {
    for (const lbl of projectLabels) {
      if (taskNumPrefix) {
        // Совпадение: задача "1.1.5" → подходит метка "1.1"
        if (taskNumPrefix === lbl.num) {
          return { key: lbl.num, labelHint: null, fullLabel: null };
        }
        // "2" — точное равенство
        if (lbl.num === taskNumPrefix) {
          return { key: lbl.num, labelHint: null, fullLabel: null };
        }
        // "1.1.10" → начинается с "1.1."
        if (taskNumPrefix.startsWith(lbl.num + ".")) {
          return { key: lbl.num, labelHint: null, fullLabel: null };
        }
      }
    }
    // Метки есть, но ни одна не подошла — отдельный misc.
    return { key: "misc", labelHint: null, fullLabel: null };
  }
  // 3. Меток нет — взять первую цифровую группу.
  if (taskNumPrefix) {
    const parts = taskNumPrefix.split(".");
    const major = parts[0];
    return { key: major, labelHint: null, fullLabel: null };
  }
  return { key: "misc", labelHint: null, fullLabel: null };
}

function derivedStartedAt(task: RawTask, events: RawEvent[]): string {
  for (const e of events) {
    if (
      e.task_id === task.id &&
      e.kind === "state_changed" &&
      e.field === "agent_state" &&
      e.to_value === "in_progress"
    ) {
      return e.created_at;
    }
  }
  return task.created_at;
}

function returnSignals(taskId: string, events: RawEvent[]): {
  count: number;
  lastReason: string | null;
} {
  let count = 0;
  let sawChangesRequested = false;
  for (const e of events) {
    if (e.task_id !== taskId) continue;
    if (e.kind !== "state_changed" || e.field !== "agent_state") continue;
    if (e.to_value === "changes_requested") sawChangesRequested = true;
    else if (e.to_value === "in_progress" && sawChangesRequested) {
      count += 1;
      sawChangesRequested = false;
    }
  }
  let latest: RawEvent | null = null;
  for (const e of events) {
    if (
      e.task_id === taskId &&
      e.kind === "subtask_started" &&
      e.to_value &&
      (!latest || e.created_at > latest.created_at)
    ) {
      latest = e;
    }
  }
  return {
    count,
    lastReason: latest?.to_value ? clipReason(latest.to_value) : null,
  };
}

function clipReason(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length > 140 ? trimmed.slice(0, 137) + "…" : trimmed;
}

function isoDate(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${m[3]}.${m[2]}`;
}

function formatRange(startsAt: string, endsAt: string | null): string {
  const start = isoDate(startsAt);
  const end = endsAt ? isoDate(endsAt) : null;
  if (!end || end === start) return start;
  return `${start} — ${end}`;
}

function buildLabeledStages(
  enriched: EnrichedTask[],
  labels: ProjectLabel[],
): StageShape[] {
  const byKey = groupBy(enriched, (t) => t.stage_key);
  const keys = Array.from(byKey.keys()).sort((a, b) => {
    if (a === "misc") return 1;
    if (b === "misc") return -1;
    const aLabel = labels.find((l) => l.num === a);
    const bLabel = labels.find((l) => l.num === b);
    if (aLabel && bLabel) return aLabel.num.localeCompare(bLabel.num, "ru", { numeric: true });
    const aNum = Number(a);
    const bNum = Number(b);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
    return a.localeCompare(b, "ru", { numeric: true });
  });

  return keys.map((k, idx) => {
    const items = byKey.get(k)!;
    items.sort((a, b) => a.started_at.localeCompare(b.started_at));
    const labelMeta = labels.find((l) => l.num === k);
    const name = labelMeta?.label ?? items.find((i) => i.label_hint)?.label_hint ?? `Этап ${k}`;
    const shortName =
      labelMeta?.short ??
      items.find((i) => i.label_hint)?.label_hint ??
      `Этап ${k}`;
    const completedAt = items
      .map((t) => t.completed_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] ?? null;
    const active = items.some((t) => t.status === "active");
    const doneCount = items.filter((t) => t.status === "completed").length;
    const returns = items
      .filter((t) => t.return_count > 0)
      .map((t) => ({
        task_id: t.id,
        title: t.title,
        attempts: t.return_count,
        last_reason: t.last_return_reason,
      }));
    const versionsSummary = items
      .filter((t) => t.version_count > 0)
      .map((t) => ({
        task_id: t.id,
        title: t.title,
        version_count: t.version_count,
        latest_version_no: t.version_count,
      }));
    const first = items[0];
    return {
      id: `s-${k}-${idx + 1}`,
      key: k,
      name: shortName.length > 48 ? shortName.slice(0, 45) + "…" : name,
      short_name: shortName.length > 32 ? shortName.slice(0, 29) + "…" : shortName,
      started_at: first.started_at,
      completed_at: completedAt,
      status: active ? "active" : doneCount > 0 ? "completed" : "planned",
      task_count: items.length,
      completed_count: doneCount,
      active_count: items.length - doneCount,
      completion_ratio: items.length ? doneCount / items.length : 0,
      return_count: returns.reduce((s, r) => s + r.attempts, 0),
      tasks: items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        started_at: t.started_at,
        completed_at: t.completed_at,
        return_count: t.return_count,
        has_reviews: t.has_review_changes,
      })),
      returns,
      versions_summary: versionsSummary,
    };
  });
}

function buildTimeStages(
  enriched: EnrichedTask[],
  gapDays: number,
): StageShape[] {
  const sorted = [...enriched].sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  );
  const clusters: EnrichedTask[][] = [];
  for (const t of sorted) {
    if (clusters.length === 0) {
      clusters.push([t]);
      continue;
    }
    const last = clusters[clusters.length - 1];
    const lastEnd = last
      .map((x) => x.completed_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] ?? last[last.length - 1].started_at;
    const gap = (Date.parse(t.started_at) - Date.parse(lastEnd)) / 86_400;
    if (gap > gapDays) {
      clusters.push([t]);
    } else {
      last.push(t);
    }
  }
  return clusters.map((items, idx) => {
    const started_at = items[0].started_at;
    const completed_at = items
      .map((t) => t.completed_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] ?? null;
    const active = items.some((t) => t.status === "active");
    const doneCount = items.filter((t) => t.status === "completed").length;
    return {
      id: `t-${idx + 1}`,
      key: `cluster-${idx + 1}`,
      name: formatRange(started_at, completed_at),
      short_name: isoDate(started_at),
      started_at,
      completed_at,
      status: active ? "active" : doneCount > 0 ? "completed" : "planned",
      task_count: items.length,
      completed_count: doneCount,
      active_count: items.length - doneCount,
      completion_ratio: items.length ? doneCount / items.length : 0,
      return_count: items.reduce((s, t) => s + t.return_count, 0),
      tasks: items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        started_at: t.started_at,
        completed_at: t.completed_at,
        return_count: t.return_count,
        has_reviews: t.has_review_changes,
      })),
      returns: items
        .filter((t) => t.return_count > 0)
        .map((t) => ({
          task_id: t.id,
          title: t.title,
          attempts: t.return_count,
          last_reason: t.last_return_reason,
        })),
      versions_summary: items
        .filter((t) => t.version_count > 0)
        .map((t) => ({
          task_id: t.id,
          title: t.title,
          version_count: t.version_count,
          latest_version_no: t.version_count,
        })),
    };
  });
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

export function registerCompassRoutes(app: FastifyInstance): void {
  app.get<{
    Params: { id: string };
    Querystring: { mode?: string; gap_days?: string };
  }>(
    "/api/projects/:id/compass",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const project = getProjectForUser(req.params.id, req.userId);
      if (!project) return reply.code(404).send({ error: "Проект не найден" });

      const requestedMode = (req.query.mode ?? "auto").toLowerCase();
      const gapDays = Math.max(
        1,
        Math.min(180, Number(req.query.gap_days) || STAGE_GAP_DAYS_DEFAULT),
      );

      const tasks = db
        .prepare(
          `SELECT id, title, status, priority, assignee_id,
                  created_at, updated_at, completed_at,
                  parent_id, project_id
             FROM tasks
            WHERE project_id = ?`,
        )
        .all(req.params.id) as RawTask[];

      if (tasks.length === 0) {
        return reply.send({
          project: {
            id: project.id,
            name: project.name,
            color: project.color,
            owner_id: project.owner_id,
            created_at: project.created_at,
          },
          algorithm: {
            mode_requested: requestedMode,
            mode_used: "structured",
            gap_days: gapDays,
            labels_detected: 0,
            task_count: 0,
          },
          summary: {
            total_tasks: 0,
            completed: 0,
            active: 0,
            completion_ratio: 0,
            first_activity_at: null,
            last_activity_at: null,
            stage_count: 0,
            return_count: 0,
            attempts_total: 0,
            reviews_changes_total: 0,
            versions_total: 0,
          },
          stages: [],
        });
      }

      const ids = tasks.map((t) => t.id);
      const placeholders = ids.map(() => "?").join(",");
      const bind = (sql: string) =>
        db.prepare(sql).all(...ids) as any[];

      const events = bind(
        `SELECT id, task_id, kind, field, from_value, to_value, created_at
           FROM task_events
          WHERE task_id IN (${placeholders})
            AND kind IN ('state_changed', 'subtask_started')
          ORDER BY task_id, created_at`,
      ) as RawEvent[];

      const reviews = bind(
        `SELECT id, task_id, verdict, created_at
           FROM reviews
          WHERE task_id IN (${placeholders})`,
      ) as RawReview[];
      const reviewsChangesByTask = new Set<string>();
      for (const r of reviews) {
        if (r.verdict === "changes_requested" || r.verdict === "blocked") {
          reviewsChangesByTask.add(r.task_id);
        }
      }

      const versions = bind(
        `SELECT id, task_id, version_no, created_at
           FROM artifact_versions
          WHERE task_id IN (${placeholders})`,
      );
      const versionsByTask = new Map<string, number>();
      for (const v of versions) {
        versionsByTask.set(v.task_id, (versionsByTask.get(v.task_id) ?? 0) + 1);
      }

      const attempts = bind(
        `SELECT id, task_id, started_at, ended_at, outcome, reason_code
           FROM attempts
          WHERE task_id IN (${placeholders})
          ORDER BY started_at`,
      );

      // Шаг 1: выявляем метки этапов в проекте.
      const labelsRaw: ProjectLabel[] = [];
      for (const t of tasks) {
        const lbl = detectLabel(t.title);
        if (lbl && !labelsRaw.find((x) => x.num === lbl.num)) {
          labelsRaw.push(lbl);
        }
      }
      // Сортируем по длине (длинные — более специфичные — первыми) и по
      // числовому значению.
      labelsRaw.sort((a, b) => {
        if (a.num.length !== b.num.length) return b.num.length - a.num.length;
        return a.num.localeCompare(b.num, "ru", { numeric: true });
      });

      // Шаг 2: каждую задачу приписываем к этапу.
      const enriched: EnrichedTask[] = tasks.map((t) => {
        const rsig = returnSignals(t.id, events);
        const ownLabel = detectLabel(t.title);
        const numPfx = numericPrefix(t.title);
        const sk = chooseStageKey(numPfx, ownLabel, labelsRaw);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          started_at: derivedStartedAt(t, events),
          completed_at: t.completed_at,
          return_count:
            rsig.count + (reviewsChangesByTask.has(t.id) ? 1 : 0),
          last_return_reason: rsig.lastReason,
          version_count: versionsByTask.get(t.id) ?? 0,
          has_review_changes: reviewsChangesByTask.has(t.id),
          stage_key: sk.key,
          label_hint: sk.labelHint,
          full_label: sk.fullLabel,
        };
      });

      const useStructured =
        requestedMode === "structured" ||
        (requestedMode === "auto" &&
          labelsRaw.length >= 2 &&
          enriched.length > labelsRaw.length);
      const stages = useStructured
        ? buildLabeledStages(enriched, labelsRaw)
        : buildTimeStages(enriched, gapDays);

      const completed = enriched.filter((t) => t.status === "completed").length;
      const totalReturn = enriched.reduce((s, t) => s + t.return_count, 0);
      const activityDates = enriched
        .map((t) => t.completed_at ?? t.started_at)
        .filter(Boolean) as string[];

      return reply.send({
        project: {
          id: project.id,
          name: project.name,
          color: project.color,
          owner_id: project.owner_id,
          created_at: project.created_at,
        },
        algorithm: {
          mode_requested: requestedMode,
          mode_used: useStructured ? "structured" : "time",
          gap_days: gapDays,
          labels_detected: labelsRaw.length,
          task_count: enriched.length,
        },
        summary: {
          total_tasks: enriched.length,
          completed,
          active: enriched.length - completed,
          completion_ratio: enriched.length ? completed / enriched.length : 0,
          first_activity_at:
            activityDates.length ? activityDates.sort()[0] : null,
          last_activity_at:
            activityDates.length ? activityDates.sort().slice(-1)[0] : null,
          stage_count: stages.length,
          return_count: totalReturn,
          attempts_total: attempts.length,
          reviews_changes_total: reviewsChangesByTask.size,
          versions_total: versions.length,
        },
        stages,
      });
    },
  );
}
