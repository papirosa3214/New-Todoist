import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type {
  ApiCollaborationPlan,
  ApiRoleSlot,
  RoleSlotState,
  PlanNodeExecutionState,
} from "../api/collaborationPlans";
import { api } from "../api/client";
import { useRoles } from "../api/roles";

// Пульс родительской задачи с дочерними (карточка 2b130833, MAK-«граф
// плана», 2026-10-07). Своим графом родительская не рисуется — вместо
// него агрегаты: 4 метрики состояний, прогресс-бар по каждой дочерней
// и «кто сейчас активен». Дочерние в пульсе — кликабельные ссылки на
// их карточки.
//
// Загрузка по дочерней (Доработка 3, архитектурное решение D-3.0):
// 1) `/collaboration-plans` на child — получаем либо её собственный
//    approved план (если есть), либо `plans: []` и `branch_root_task_id`.
// 2) Если своего нет — по `branch_root_task_id` идём за планом корня
//    ветки и берём только узлы с `task_id === child.id` (на сервере
//    узел плана ветки помечен `task_id` той дочерней, которой он
//    соответствует). Так мы видим реальный прогресс дочерней, а не
//    draft-план root'а целиком.
// 3) Несколько дочерних одной ветки (типично: 13 на родительской
//    1fe2d05c) идут в один и тот же кэш react-query — дублей запросов
//    на root не будет. Данные поднимаются в ParentPlanPulse и
//    раздаются вниз, чтобы не гонять одни и те же запросы дважды
//    (метрики + прогресс-бары).

const PROFILE_LABELS: Record<string, string> = {
  single_executor: "Один исполнитель",
  research: "Исследование",
  delivery: "Доставка",
  full_cycle: "Полный цикл",
  manual: "Вручную",
};

const STATE_DOT: Record<RoleSlotState, string> = {
  waiting: "var(--color-dim)",
  ready: "var(--color-blue)",
  active: "var(--color-orange)",
  submitted: "var(--color-purple)",
  accepted: "var(--color-green)",
};

const STATE_LABELS: Record<RoleSlotState, string> = {
  waiting: "Ждёт",
  ready: "Готов к старту",
  active: "В работе",
  submitted: "Сдано",
  accepted: "Принято",
};

const ACTIVE_STATES: RoleSlotState[] = ["active", "submitted"];

// Количество «активных» строк до того, как хвост свернётся в «+N ещё».
const ACTIVE_VISIBLE = 5;

interface ChildSnapshot {
  childId: string;
  childTitle: string;
  plan: ApiCollaborationPlan | null;
  slots: ApiRoleSlot[];
  metrics: { active: number; review: number; accepted: number; ready: number };
  progress: number | null; // null = без плана
  active: { roleKey: string; state: RoleSlotState }[];
}

function aggregateChild(
  childId: string,
  childTitle: string,
  plan: ApiCollaborationPlan | null,
  slots: ApiRoleSlot[],
): ChildSnapshot {
  const metrics = { active: 0, review: 0, accepted: 0, ready: 0 };
  for (const s of slots) {
    if (s.state === "active") metrics.active++;
    else if (s.state === "submitted") metrics.review++;
    else if (s.state === "accepted") metrics.accepted++;
    else if (s.state === "ready") metrics.ready++;
    // waiting — не считаем ни в одну из 4 метрик
  }
  let progress: number | null = null;
  if (plan) {
    const total = plan.nodes.length;
    if (total > 0) {
      // Считаем по `execution_state` напрямую — это источник истины
      // (маппинг в `ApiRoleSlot.state` мог схлопнуть `blocked`/`returned`
      // в другие категории).
      const acceptedFromPlan = plan.nodes.filter(
        (n) => n.execution_state === "accepted",
      ).length;
      progress = Math.round((acceptedFromPlan / total) * 100);
    } else {
      progress = 0;
    }
  }
  const active = slots
    .filter((s) => ACTIVE_STATES.includes(s.state))
    .map((s) => ({ roleKey: s.role_key, state: s.state }));
  return { childId, childTitle, plan, slots, metrics, progress, active };
}

export interface ParentPlanPulseProps {
  parentId: string;
  // Список дочерних для агрегации. Именован `childList`, а не
  // `children`, чтобы не конфликтовать с зарезервированным React-проп
  // (oxlint `react/no-children-prop`).
  childList: { id: string; title: string }[];
}

// Корневой компонент пульса родительской. Не рисуется, если дочерних
// нет. Поднимает запросы по дочерним и раздаёт данные вниз.
export function ParentPlanPulse({ parentId: _parentId, childList: children }: ParentPlanPulseProps) {
  const navigate = useNavigate();

  // Хуки должны вызываться безусловно и в одном порядке на каждом
  // рендере. Сначала фиксируем список branch_root'ов, которые нужно
  // догрузить (на пустом children — пустой массив, без сайд-эффектов
  // в .map), затем — оба набора useQueries, и только потом ранний
  // return. Иначе oxlint `rules-of-hooks` и React в рендере с
  // переменным числом дочерних дадут неверный порядок хуков.

  // Параллельные запросы по дочерним: сначала план самой child, затем
  // (если своего approved нет) — план её branch_root. Два набора
  // запросов склеиваем по индексу дочерней.
  const childPlanQueries = useQueries({
    queries: children.map((c) => ({
      queryKey: ["tasks", c.id, "collaboration-plans"] as const,
      queryFn: () =>
        api.get<{ plans: ApiCollaborationPlan[]; branch_root_task_id: string | null }>(
          `/api/tasks/${c.id}/collaboration-plans`,
        ),
      retry: 1,
    })),
  });

  // Какие branch_root реально нужно догрузить: уникальные id, для
  // которых у child нет своего approved плана. Считаем по уже
  // загруженным ответам childPlanQueries — порядок дочерних фиксирован,
  // id'ы дедуплицируются стабильно.
  const branchRootsToFetch = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    children.forEach((c, i) => {
      const resp = childPlanQueries[i]?.data;
      if (!resp) return;
      const ownApproved = resp.plans.find((p) => p.status === "approved");
      if (ownApproved) return;
      const root = resp.branch_root_task_id;
      if (root && root !== c.id && !seen.has(root)) {
        seen.add(root);
        out.push(root);
      }
    });
    return out;
  })();
  const rootByChild: (string | null)[] = children.map((c, i) => {
    const resp = childPlanQueries[i]?.data;
    if (!resp) return null;
    const ownApproved = resp.plans.find((p) => p.status === "approved");
    if (ownApproved) return null;
    const root = resp.branch_root_task_id;
    return root && root !== c.id ? root : null;
  });

  const rootPlanQueries = useQueries({
    queries: branchRootsToFetch.map((root) => ({
      queryKey: ["tasks", root, "collaboration-plans"] as const,
      queryFn: () =>
        api.get<{ plans: ApiCollaborationPlan[]; branch_root_task_id: string | null }>(
          `/api/tasks/${root}/collaboration-plans`,
        ),
      retry: 1,
    })),
  });
  const rootPlanByRoot: Record<string, ApiCollaborationPlan | null> = {};
  branchRootsToFetch.forEach((root, i) => {
    const plans = rootPlanQueries[i]?.data?.plans ?? [];
    rootPlanByRoot[root] =
      plans.find((p) => p.status === "approved") ?? null;
  });

  if (!children || children.length === 0) return null;

  const isLoading =
    childPlanQueries.some((q) => q.isLoading) ||
    rootPlanQueries.some((q) => q.isLoading);
  if (isLoading) {
    return <PulseSkeleton childCount={children.length} />;
  }

  // Любой упавший запрос — пульс не рисуем (как CollaborationPlanPanel
  // при ошибке возвращает null).
  const hasError =
    childPlanQueries.some((q) => q.isError) ||
    rootPlanQueries.some((q) => q.isError);
  if (hasError) {
    if (typeof console !== "undefined") {
      console.warn("ParentPlanPulse: ошибка загрузки, пульс скрыт");
    }
    return null;
  }

  const aggregated: ChildSnapshot[] = children.map((c, i) => {
    const resp = childPlanQueries[i]?.data;
    // 1) Свой approved план child — приоритет (КП №1 для child с own
    //    approved вне ветки; на типичной дочерней в ветке такого нет).
    let plan = resp?.plans.find((p) => p.status === "approved") ?? null;
    // 2) Если своего нет — план корня ветки, отфильтрованный по child.id.
    if (!plan) {
      const rootId = rootByChild[i];
      if (rootId) {
        const rootPlan = rootPlanByRoot[rootId];
        if (rootPlan) {
          const childNodes = rootPlan.nodes.filter(
            (n) => n.task_id === c.id,
          );
          if (childNodes.length > 0) {
            plan = { ...rootPlan, nodes: childNodes };
          }
        }
      }
    }
    // Слоты — проекция execution_state в RoleSlotState; считается из
    // того же плана, без сети.
    const slots: ApiRoleSlot[] = plan
      ? plan.nodes.flatMap((n) => {
            const state = executionToSlotState(n.execution_state);
            if (!state) return [];
            return [{
              id: `${plan!.id}:${n.slot_key}`,
              task_id: plan!.task_id,
              slot_key: n.slot_key,
              role_key: n.role_key,
              state,
              required: n.required,
              plan_node_key: n.slot_key,
            }];
          })
        : [];
    return aggregateChild(c.id, c.title, plan, slots);
  });

  return (
    <PulseBody
      childList={children}
      aggregated={aggregated}
      onOpenChild={(id) => navigate(`/task/${id}`)}
    />
  );
}

/** Серверные 6 состояний → 5 «слотовых». Дубликат маппинга из
 *  `collaborationPlans.toRoleSlotState` — здесь он нужен на этапе
 *  агрегации (до того, как мы вызываем `aggregateChild`). */
function executionToSlotState(exec: PlanNodeExecutionState | undefined): RoleSlotState | null {
  if (!exec || exec === "blocked") return "waiting";
  if (exec === "returned") return "submitted";
  if (exec === "ready") return "ready";
  if (exec === "active") return "active";
  if (exec === "accepted") return "accepted";
  return null;
}

function PulseSkeleton({ childCount }: { childCount: number }) {
  const rows = Math.max(1, Math.min(childCount, 5));
  return (
    <div
      className="py-3 px-4 bg-card rounded-xl"
      data-testid="parent-plan-pulse-skeleton"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 w-24 rounded-pill bg-card2 animate-pulse" />
        <div className="h-3 w-16 rounded-pill bg-card2 animate-pulse" />
      </div>
      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        data-testid="pulse-metrics-skeleton"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="h-5 w-10 rounded-pill bg-card2 animate-pulse" />
            <div className="h-3 w-16 rounded-pill bg-card2 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        <div className="h-3 w-32 rounded-pill bg-card2 animate-pulse mb-1" />
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-1 rounded-pill bg-card2 animate-pulse"
            data-testid="pulse-progress-skeleton"
          />
        ))}
      </div>
    </div>
  );
}

function PulseBody({
  childList: children,
  aggregated,
  onOpenChild,
}: {
  childList: { id: string; title: string }[];
  aggregated: ChildSnapshot[];
  onOpenChild: (id: string) => void;
}) {
  const { data: rolesData } = useRoles();
  const roleTitle = (key: string) =>
    rolesData?.find((r) => r.role === key)?.title ?? key;

  // Суммарные метрики по всем дочерним.
  const totals = { active: 0, review: 0, accepted: 0, ready: 0 };
  for (const m of aggregated) {
    totals.active += m.metrics.active;
    totals.review += m.metrics.review;
    totals.accepted += m.metrics.accepted;
    totals.ready += m.metrics.ready;
  }
  const metrics: Array<{ key: string; value: number; label: string; aria: string }> = [
    { key: "active", value: totals.active, label: "в работе", aria: `В работе: ${totals.active} из ${children.length} дочерних` },
    { key: "review", value: totals.review, label: "ревью", aria: `На ревью: ${totals.review} из ${children.length} дочерних` },
    { key: "accepted", value: totals.accepted, label: "принято", aria: `Принято: ${totals.accepted} из ${children.length} дочерних` },
    { key: "ready", value: totals.ready, label: "готов", aria: `Готово: ${totals.ready} из ${children.length} дочерних` },
  ];

  const allActive = aggregated.flatMap((m) =>
    m.active.map((a) => ({ ...a, childId: m.childId, childTitle: m.childTitle })),
  );
  const visibleActive = allActive.slice(0, ACTIVE_VISIBLE);
  const restActive = allActive.length - visibleActive.length;

  return (
    <div
      className="py-3 px-4 bg-card rounded-xl"
      data-testid="parent-plan-pulse"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="tf-action text-text">Пульс плана</span>
        <span className="tf-meta text-sub">{children.length} дочерних</span>
      </div>
      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        data-testid="pulse-metrics"
      >
        {metrics.map((it) => (
          <div
            key={it.key}
            className="flex flex-col gap-0.5"
            aria-label={it.aria}
          >
            <span className="tf-title text-text">{it.value}</span>
            <span className="tf-caption text-sub">{it.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <div className="tf-meta text-sub mb-1">Прогресс по дочерним</div>
        <div className="flex flex-col gap-1.5">
          {aggregated.map((m) => {
            const profileLabel = m.plan
              ? PROFILE_LABELS[m.plan.profile] ?? m.plan.profile
              : "без плана";
            return (
              <button
                key={m.childId}
                type="button"
                onClick={() => onOpenChild(m.childId)}
                className="flex items-center gap-2 text-left w-full min-h-[var(--tap-min)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red/40 rounded-md"
                data-testid={`pulse-child-${m.childId}`}
                aria-label={`Открыть задачу ${m.childTitle}`}
              >
                <span
                  className="block h-1 rounded-pill"
                  style={{
                    // Ширина = `accepted/total` × 100% (спека §3.6, карточка
                    // 2b130833). Без плана — серая полоска 100% как индикатор
                    // «пусто». Прежняя реализация (фиксированная 60% с opacity
                    // по прогрессу, D2 в QA-отчёте) делала 0% похожим на 11% и
                    // путала глаз.
                    width: m.progress === null ? "100%" : `${m.progress}%`,
                    background: m.progress === null
                      ? "var(--color-card2)"
                      : "var(--color-frame)",
                  }}
                  role="progressbar"
                  aria-valuenow={m.progress ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${profileLabel}, ${m.progress ?? 0} процентов`}
                />
                <span className="tf-caption text-sub shrink-0">
                  {profileLabel}
                  {m.progress === null
                    ? " · без плана"
                    : m.progress === 100
                      ? " · ✓"
                      : ` · ${m.progress}%`}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {allActive.length > 0 && (
        <div className="mt-3">
          <div className="tf-meta text-sub mb-1">Кто сейчас активен</div>
          <div className="flex flex-col" data-testid="pulse-active-list">
            {visibleActive.map((row, idx) => {
              const dotColor = STATE_DOT[row.state];
              return (
                <button
                  key={`${row.childId}-${row.roleKey}-${idx}`}
                  type="button"
                  onClick={() => onOpenChild(row.childId)}
                  className="flex items-center gap-2 min-h-[var(--tap-min)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red/40 rounded-md"
                  aria-label={`Открыть задачу ${row.childTitle} — ${roleTitle(row.roleKey)} ${STATE_LABELS[row.state]}`}
                >
                  <span
                    className="block rounded-full shrink-0"
                    style={{ width: 8, height: 8, background: dotColor }}
                    aria-hidden="true"
                  />
                  <span className="tf-row truncate">
                    {roleTitle(row.roleKey)}
                  </span>
                  <span className="tf-caption text-sub shrink-0">
                    · {row.childTitle}
                  </span>
                  <span
                    className="tf-caption ml-auto"
                    style={{ color: dotColor }}
                  >
                    {STATE_LABELS[row.state]}
                  </span>
                </button>
              );
            })}
            {restActive > 0 && (
              <div
                className="tf-caption text-sub py-1"
                aria-label={`Показать ещё ${restActive} активных ролей`}
              >
                +{restActive} ещё
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
