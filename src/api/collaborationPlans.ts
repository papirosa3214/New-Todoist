import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

// Граф совместной работы над задачей (server: task-collaboration-plans.ts,
// task-role-slots.ts). Читаем только для отображения — создание и
// утверждение плана делает оркестратор/владелец через API напрямую,
// отдельного UI-редактора графа здесь нет и не планируется (см. docs/
// 2026-09-28-parent-child-execution-context, этап 10, "вне первого этапа").

export type CollaborationPlanStatus = "draft" | "approved" | "superseded";
export type CollaborationPlanProfile =
  | "single_executor"
  | "research"
  | "delivery"
  | "full_cycle"
  | "manual";

export interface ApiCollaborationPlanNode {
  slot_key: string;
  role_key: string;
  required: boolean;
  expected_result: string;
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
  return useQuery({
    queryKey: ["tasks", taskId, "collaboration-plans"],
    queryFn: () => api.get<{ plans: ApiCollaborationPlan[] }>(`/api/tasks/${taskId}/collaboration-plans`),
    enabled: !!taskId,
  });
}

export function useRoleSlots(taskId: string | undefined) {
  return useQuery({
    queryKey: ["tasks", taskId, "role-slots"],
    queryFn: () => api.get<{ slots: ApiRoleSlot[] }>(`/api/tasks/${taskId}/role-slots`),
    enabled: !!taskId,
  });
}
