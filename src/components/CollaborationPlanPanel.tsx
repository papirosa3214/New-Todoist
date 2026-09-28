import { useCollaborationPlans, useRoleSlots } from "../api/collaborationPlans";
import { useRoles } from "../api/roles";

// Краткий граф совместной работы над задачей — этап 10 плана
// docs/2026-09-28-parent-child-execution-context. Только чтение: рисует
// текущий УТВЕРЖДЁННЫЙ план (черновики не показываем — они ещё ничего не
// запускают и путали бы владельца). У большинства задач approved-плана
// нет вовсе — тогда компонент не рисует ничего, ровно как AttemptLadderBadge
// и AgentOwnerActions рядом с ним.

const PROFILE_LABELS: Record<string, string> = {
  single_executor: "Один исполнитель",
  research: "Исследование",
  delivery: "Доставка",
  full_cycle: "Полный цикл",
  manual: "Вручную",
};

const STATE_LABELS: Record<string, string> = {
  waiting: "Ждёт",
  ready: "Готов к старту",
  active: "В работе",
  submitted: "Сдано",
  accepted: "Принято",
};

const STATE_TONE: Record<string, string> = {
  waiting: "border-border bg-card text-sub",
  ready: "border-blue-500/30 bg-blue-500/10 text-blue-500",
  active: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  submitted: "border-purple-500/30 bg-purple-500/10 text-purple-500",
  accepted: "border-green-500/30 bg-green-500/10 text-green-600",
};

export function CollaborationPlanPanel({ taskId }: { taskId: string }) {
  const { data: plansData } = useCollaborationPlans(taskId);
  const { data: slotsData } = useRoleSlots(taskId);
  const { data: rolesData } = useRoles();

  const plan = plansData?.plans.find((p) => p.status === "approved");
  if (!plan) return null;

  const roleTitle = (roleKey: string) =>
    rolesData?.roles.find((r) => r.role === roleKey)?.title ?? roleKey;

  const slotByNode = new Map(
    (slotsData?.slots ?? [])
      .filter((s) => s.plan_node_key)
      .map((s) => [s.plan_node_key as string, s]),
  );

  // Для waiting-узла — кто именно ещё не сдал (человеку понятнее, чем
  // "ждёт своей очереди").
  const predecessorsOf = (slotKey: string) =>
    plan.edges
      .filter((e) => e.to_slot_key === slotKey)
      .map((e) => plan.nodes.find((n) => n.slot_key === e.from_slot_key))
      .filter((n): n is NonNullable<typeof n> => !!n);

  return (
    <div className="py-3 px-4 bg-card rounded-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-medium text-text">
          План совместной работы
        </span>
        <span className="text-[12px] text-sub">
          {PROFILE_LABELS[plan.profile] ?? plan.profile}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {plan.nodes.map((node) => {
          const slot = slotByNode.get(node.slot_key);
          const state = slot?.state ?? "waiting";
          const blockers = state === "waiting" ? predecessorsOf(node.slot_key) : [];
          return (
            <div
              key={node.slot_key}
              className="flex items-center justify-between gap-2 text-[13px]"
            >
              <span className="text-text">
                {roleTitle(node.role_key)}
                {blockers.length > 0 && (
                  <span className="text-sub">
                    {" "}
                    — ждёт: {blockers.map((b) => roleTitle(b.role_key)).join(", ")}
                  </span>
                )}
              </span>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  STATE_TONE[state] ?? STATE_TONE.waiting
                }`}
              >
                {STATE_LABELS[state] ?? state}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
