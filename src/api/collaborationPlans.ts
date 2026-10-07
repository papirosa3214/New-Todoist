import { useQueries } from "@tanstack/react-query";
import { api } from "./client";

// Граф совместной работы над задачей (server: task-collaboration-plans.ts,
// план-узлы как subtasks через `planSubtaskAdmission.ts`). Читаем только для
// отображения — создание и утверждение плана делает оркестратор/владелец
// через API напрямую, отдельного UI-редактора графа здесь нет и не
// планируется (см. docs/2026-09-28-parent-child-execution-context, этап 10,
// "вне первого этапа").
//
// 2026-10-07, карточка 2b130833 (MAK-«граф плана»): бывший
// `/api/tasks/:id/role-slots` заменён серверной моделью
// `task_collaboration_plan_nodes` + `subtasks` — отдельного REST-эндпоинта
// больше нет. Состояние узла теперь живёт в `plan.nodes[].execution_state`
// (см. `presentSingle` в `task-collaboration-plans.ts`), которое вычисляется
// на сервере через `canPlanSubtaskBecomeReady`. `useRoleSlots` остаётся
// обратно-совместимым хуком для UI (`{ data: { slots } }`), только источник —
// тот же план, а не отдельный запрос. Это убирает D1 P0 и делает
// `ParentPlanPulse` проверяемым на живой БД.
//
// 2026-10-07 (Доработка 2, fix D1' P0): сервер для **дочерней** карточки
// возвращает `plans: []` + `branch_root_task_id: <root_id>`. UI должен
// следовать этому указателю и догрузить план корня ветки — иначе
// `ParentPlanPulse` на родительской рисует нули (у 13 дочерних карточки
// 1fe2d05c план сидит на branch_root, до клиента не доходит). Ниже
// `useCollaborationPlans` сам подменяет запрос на branch_root; остальные
// хуки и компоненты остаются без изменений. Серверную часть не трогаем
// (границы задачи).

export type CollaborationPlanStatus = "draft" | "approved" | "superseded";
export type CollaborationPlanProfile =
  | "single_executor"
  | "research"
  | "delivery"
  | "full_cycle"
  | "manual";

/** `execution_state` считает сервер и кладёт в каждый узел плана.
 *  См. `task-collaboration-plans.ts: presentSingle`. */
export type PlanNodeExecutionState =
  | "waiting"
  | "ready"
  | "active"
  | "blocked"
  | "accepted"
  | "returned";

export interface ApiCollaborationPlanNode {
  slot_key: string;
  role_key: string;
  required: boolean;
  expected_result: string;
  execution_state?: PlanNodeExecutionState;
}

export interface ApiCollaborationPlanEdge {
  from_slot_key: string;
  to_slot_key: string;
  start_condition: "submitted" | "accepted" | "artifact_ready";
}

export interface ApiCollaborationPlan {
  id: string;
  task_id: string;
  revision: number;
  status: CollaborationPlanStatus;
  profile: CollaborationPlanProfile;
  rationale: string;
  nodes: ApiCollaborationPlanNode[];
  edges: ApiCollaborationPlanEdge[];
}

export type RoleSlotState = "waiting" | "ready" | "active" | "submitted" | "accepted";

/** Слот роли — синтетический объект, который мы строим из `plan.nodes`
 *  для обратной совместимости UI. Источник истины — `execution_state` в
 *  узле плана (см. `planSubtaskAdmission.canPlanSubtaskBecomeReady`). */
export interface ApiRoleSlot {
  id: string;
  task_id: string;
  slot_key: string;
  role_key: string;
  state: RoleSlotState;
  required: boolean;
  plan_node_key: string | null;
}

export function useCollaborationPlans(taskId: string | undefined) {
  // Двухшаговая загрузка: сначала сам `taskId`. Если в ответе пришёл
  // `branch_root_task_id` и он отличается от нашего `taskId` — делаем
  // второй запрос на корень ветки и берём планы оттуда (сервер для child
  // возвращает `plans: []`).
  //
  // Сделано через `useQueries` ради декларативности: оба ключа
  // материализуются одинаково, и кэш react-query делит результат между
  // всеми вызывающими (например, две дочерние карточки одного branch_root
  // не сделают третий запрос — попадут в кэш). Статус `isLoading` и
  // `isError` аккуратно склеиваются, чтобы UI показывал скелетон или
  // скрывался так же, как раньше.
  const enabled = !!taskId;
  const initial = useQueries({
    queries: [
      {
        queryKey: ["tasks", taskId, "collaboration-plans"] as const,
        queryFn: () =>
          api.get<{ plans: ApiCollaborationPlan[]; branch_root_task_id: string | null }>(
            `/api/tasks/${taskId}/collaboration-plans`,
          ),
        enabled,
        retry: 1,
      },
    ],
  });
  const initialData = initial[0]?.data;
  const branchRoot = initialData?.branch_root_task_id ?? null;
  // Запрос на branch_root нужен только если:
  //   - первичный запрос прошёл,
  //   - сервер указал branch_root_task_id,
  //   - этот id не совпадает с нашим (иначе мы и так branch_root).
  const needFollowup =
    enabled && !!branchRoot && branchRoot !== taskId;

  const followup = useQueries({
    queries: needFollowup
      ? [
          {
            queryKey: ["tasks", branchRoot, "collaboration-plans"] as const,
            queryFn: () =>
              api.get<{ plans: ApiCollaborationPlan[]; branch_root_task_id: string | null }>(
                `/api/tasks/${branchRoot}/collaboration-plans`,
              ),
            enabled: true,
            retry: 1,
          },
        ]
      : [],
  });

  const isLoading = initial.some((q) => q.isLoading) ||
    followup.some((q) => q.isLoading);
  const isError = initial.some((q) => q.isError) ||
    followup.some((q) => q.isError);
  const error = initial.find((q) => q.error)?.error ??
    followup.find((q) => q.error)?.error ??
    null;

  // Склеиваем данные: если есть branch_root — он источник истины для
  // планов этой карточки. Иначе — первичный ответ.
  const data = (() => {
    if (!enabled) return undefined;
    if (needFollowup) {
      const root = followup[0]?.data;
      if (!root) return undefined;
      return {
        plans: root.plans,
        branch_root_task_id: root.branch_root_task_id,
      };
    }
    return initialData
      ? {
          plans: initialData.plans,
          branch_root_task_id: initialData.branch_root_task_id,
        }
      : undefined;
  })();

  return {
    data,
    isLoading: enabled ? isLoading : false,
    isError: enabled ? isError : false,
    error,
    // Совместимость с `useQuery` (вызывающий код не использует, но пусть
    // будет — `ParentPlanPulse` работает через `useQueries` сам).
    isSuccess: !!data && !isError,
    refetch: () => {
      initial.forEach((q) => q.refetch());
      followup.forEach((q) => q.refetch());
    },
  } as const;
}

/** Источник состояний узлов плана. Возвращает тот же `useQuery`-совместимый
 *  объект с `data: { slots: ApiRoleSlot[] }`, что и раньше, но без сети:
 *  берём `nodes[].execution_state` из уже загруженного плана той же карточки
 *  (одного запроса достаточно — узлы плана не меняются независимо от плана).
 *  Если планов нет/не загружены — `data` остаётся пустым массивом. */
export function useRoleSlots(taskId: string | undefined) {
  const plansQuery = useCollaborationPlans(taskId);
  const plans = plansQuery.data?.plans ?? [];
  const slots: ApiRoleSlot[] = [];
  for (const plan of plans) {
    for (const node of plan.nodes) {
      const state = toRoleSlotState(node.execution_state);
      if (!state) continue;
      slots.push({
        id: `${plan.id}:${node.slot_key}`,
        task_id: plan.task_id,
        slot_key: node.slot_key,
        role_key: node.role_key,
        state,
        required: node.required,
        plan_node_key: node.slot_key,
      });
    }
  }
  return {
    ...plansQuery,
    data: { slots },
  };
}

/** Серверные 6 состояний → 5 «слотовых» (UI-цвета), которые уже есть в
 *  существующей палитре CollaborationPlanPanel: `blocked` мапится на
 *  `waiting` (UI не различает — оба серые), `returned` (изменения
 *  запрошены, узел вернули на доработку) — на `submitted`, чтобы владелец
 *  увидел в колонке слот, требующий внимания. Маппинг — только для
 *  визуализации; истина по-прежнему в `execution_state`. */
function toRoleSlotState(exec: PlanNodeExecutionState | undefined): RoleSlotState | null {
  if (!exec || exec === "blocked") return "waiting";
  if (exec === "returned") return "submitted";
  if (exec === "ready") return "ready";
  if (exec === "active") return "active";
  if (exec === "accepted") return "accepted";
  return null;
}