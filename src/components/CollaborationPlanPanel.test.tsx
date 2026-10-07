import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CollaborationPlanPanel } from "./CollaborationPlanPanel";

// Мокаем API-хуки, чтобы тест не ходил в сеть. Каждый тест подменяет
// реализацию нужным срезом данных — approved/draft/null, плюс слоты.

const mockUseCollaborationPlans = vi.fn();
const mockUseRoleSlots = vi.fn();
const mockUseRoles = vi.fn();

vi.mock("../api/collaborationPlans", () => ({
  useCollaborationPlans: (...args: unknown[]) =>
    mockUseCollaborationPlans(...args),
  useRoleSlots: (...args: unknown[]) => mockUseRoleSlots(...args),
}));

vi.mock("../api/roles", () => ({
  useRoles: () => mockUseRoles(),
}));

const approvedPlan = {
  id: "p1",
  task_id: "t1",
  revision: 1,
  status: "approved" as const,
  profile: "full_cycle" as const,
  rationale: "—",
  nodes: [
    { slot_key: "s1", role_key: "analyst", required: true, expected_result: "brief" },
    { slot_key: "s2", role_key: "designer", required: true, expected_result: "макет" },
  ],
  edges: [
    { from_slot_key: "s1", to_slot_key: "s2", start_condition: "accepted" as const },
  ],
};

const draftPlan = { ...approvedPlan, id: "p2", status: "draft" as const };

const slots = [
  { id: "sl1", task_id: "t1", slot_key: "s1", role_key: "analyst", state: "accepted" as const, required: true, plan_node_key: "s1" },
  { id: "sl2", task_id: "t1", slot_key: "s2", role_key: "designer", state: "active" as const, required: true, plan_node_key: "s2" },
];
void slots; // объявлен для обозримости, в актуальных тестах используется slotsWaiting

const roles = [
  { role: "analyst", title: "Аналитик" },
  { role: "designer", title: "Дизайнер" },
];

describe("<CollaborationPlanPanel>", () => {
  it("возвращает null без approved плана", () => {
    mockUseCollaborationPlans.mockReturnValue({ data: { plans: [draftPlan] } });
    mockUseRoleSlots.mockReturnValue({ data: { slots: [] } });
    mockUseRoles.mockReturnValue({ data: roles });
    const html = renderToStaticMarkup(<CollaborationPlanPanel taskId="t1" />);
    expect(html).toBe("");
  });

  it("возвращает null, когда планов вообще нет", () => {
    mockUseCollaborationPlans.mockReturnValue({ data: { plans: [] } });
    mockUseRoleSlots.mockReturnValue({ data: { slots: [] } });
    mockUseRoles.mockReturnValue({ data: roles });
    const html = renderToStaticMarkup(<CollaborationPlanPanel taskId="t1" />);
    expect(html).toBe("");
  });

  it("рисует approved план с уникальными узлами и секцией рамки", () => {
    // Слотов у Дизайнера state='waiting' — тогда покажется блокер
    // (ждёт принятия Аналитика). Аналитик — accepted.
    const slotsWaiting = [
      { id: "sl1", task_id: "t1", slot_key: "s1", role_key: "analyst", state: "accepted" as const, required: true, plan_node_key: "s1" },
      { id: "sl2", task_id: "t1", slot_key: "s2", role_key: "designer", state: "waiting" as const, required: true, plan_node_key: "s2" },
    ];
    mockUseCollaborationPlans.mockReturnValue({ data: { plans: [approvedPlan] } });
    mockUseRoleSlots.mockReturnValue({ data: { slots: slotsWaiting } });
    mockUseRoles.mockReturnValue({ data: roles });
    const html = renderToStaticMarkup(<CollaborationPlanPanel taskId="t1" />);

    // Заголовок и профиль
    expect(html).toContain("План совместной работы");
    expect(html).toContain("Полный цикл");

    // Уникальные узлы — по роли и состоянию
    expect(html).toContain("Аналитик");
    expect(html).toContain("Принято");
    expect(html).toContain("Дизайнер");
    expect(html).toContain("Ждёт");

    // Блокер у Дизайнера — он ждёт принятия Аналитика
    expect(html).toContain("ждёт: Аналитик");

    // Секция рамки — три кружка и подписи
    expect(html).toContain("всегда есть");
    expect(html).toContain("Рамка процесса — Раз");
    expect(html).toContain("Рамка процесса — QA");
    expect(html).toContain("Рамка процесса — Критик");
    // Подписи под кружком
    expect(html).toContain(">Раз</span>");
    expect(html).toContain(">QA</span>");
    expect(html).toContain(">Критик</span>");
  });

  it("waiting-узел без блокеров не пишет «ждёт:»", () => {
    const planNoEdges = {
      ...approvedPlan,
      edges: [],
    };
    const onlyWaiting = [
      { id: "sl1", task_id: "t1", slot_key: "s1", role_key: "analyst", state: "waiting" as const, required: true, plan_node_key: "s1" },
      { id: "sl2", task_id: "t1", slot_key: "s2", role_key: "designer", state: "waiting" as const, required: true, plan_node_key: "s2" },
    ];
    mockUseCollaborationPlans.mockReturnValue({ data: { plans: [planNoEdges] } });
    mockUseRoleSlots.mockReturnValue({ data: { slots: onlyWaiting } });
    mockUseRoles.mockReturnValue({ data: roles });
    const html = renderToStaticMarkup(<CollaborationPlanPanel taskId="t1" />);
    expect(html).not.toContain("ждёт:");
  });
});
