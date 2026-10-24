import { useQuery } from "@tanstack/react-query";
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
// 2026-10-07 (Доработка 3, архитектурное решение D-3.0): клиент **не**
// подменяет план child на план branch_root. Серверный контракт
// `task-collaboration-plans.ts:567` для child намеренно отдаёт
// `plans: []` + `branch_root_task_id: <root_id>` — план ветки живёт в
// корневой карточке (`branchPlan.ts:251`). Подмена child→root в Доработке 2
// (fix D1') породила D2' и D1'' (P0 на живой копии, QA-fix2): все child
// одной ветки получали один и тот же draft-план root'а, прогресс
// дочерних скрывался. Решение: `useCollaborationPlans(taskId)` — один
// запрос на `taskId`, без followup. Агрегирует по ветке только
// `ParentPlanPulse`, который явно ходит за планом branch_root и
// фильтрует узлы по `task_id === child.id`. `CollaborationPlanPanel` на
// child с собственным approved планом (вне ветки) сейчас получит
// `plans: []` — это известное ограничение, вопрос к владельцу в
// документе архитектора doc 33a48ee4.

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
  // Ссылка на заметку с человекочитаемым отчётом роли (server:
  // lib/roleResultReport.ts, roleResultDocument). Доступна только после
  // сдачи этапа; владелец открывает заметку через /notes/:id.
  result_document?: { id: string; title: string } | null;
  /** `task_id` дочерней, которой принадлежит узел плана ветки. Сервер
   *  (`task-collaboration-plans.ts: presentSingle`) выдаёт это поле в
   *  плане branch_root; на собственных approved планах child узел
   *  соответствует самой карточке и поле можно игнорировать. Опциональное
   *  — чтобы не ломать старые approved планы без него. */
  task_id?: string;
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

export type CollaborationPlanResponse = {
  plans: ApiCollaborationPlan[];
  branch_root_task_id: string | null;
};

export function useCollaborationPlans(taskId: string | undefined) {
  // Один запрос на `taskId`. Сервер сам отдаёт `branch_root_task_id` —
  // он нужен только агрегатору `ParentPlanPulse`, который ходит за планом
  // branch_root отдельно (один уникальный запрос на ветку, react-query
  // кэширует). Здесь followup не делаем — иначе на дочерней карточке
  // видим draft-план root'а вместо её собственного состояния (D2' P0,
  // QA-fix2). См. комментарий в шапке файла.
  return useQuery<CollaborationPlanResponse>({
    queryKey: ["tasks", taskId, "collaboration-plans"] as const,
    queryFn: () =>
      api.get<CollaborationPlanResponse>(
        `/api/tasks/${taskId}/collaboration-plans`,
      ),
    enabled: !!taskId,
    retry: 1,
  });
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