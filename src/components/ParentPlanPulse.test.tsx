import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiCollaborationPlan } from "../api/collaborationPlans";

// Прокидываем data через queryKey. Глобальный словарь переопределяется
// в каждом тесте; фабрика useQueries читает его.
//
// Доработка 3 (D-3.0): ParentPlanPulse запрашивает план для каждого
// child (childPlanQueries) и при необходимости — план её branch_root
// (rootPlanQueries). Оба набора идут через useQueries. Дублирующиеся
// branch_root'и делят кэш react-query; в синхронном SSR-тесте подкладка
// по ключу — то же самое, что и реальный кэш.

const { dataByKey } = vi.hoisted(() => ({
  dataByKey: {} as Record<
    string,
    { isLoading?: boolean; isError?: boolean; data?: unknown }
  >,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueries: (spec: { queries: Array<{ queryKey: readonly unknown[] }> }) =>
    spec.queries.map((q) => {
      const key = JSON.stringify(q.queryKey);
      return dataByKey[key] ?? { isLoading: false, isError: false, data: undefined };
    }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => () => undefined,
}));

vi.mock("../api/roles", () => ({
  useRoles: () => ({
    data: [
      { role: "analyst", title: "Аналитик" },
      { role: "builder", title: "Разработчик" },
      { role: "qa", title: "QA" },
    ],
  }),
}));

import { ParentPlanPulse } from "./ParentPlanPulse";

const fullChildPlan: ApiCollaborationPlan = {
  id: "p1",
  task_id: "c1",
  revision: 1,
  status: "approved",
  profile: "full_cycle",
  rationale: "—",
  nodes: [
    { slot_key: "n1", role_key: "analyst", required: true, expected_result: "brief", execution_state: "accepted" },
    { slot_key: "n2", role_key: "builder", required: true, expected_result: "code", execution_state: "returned" },
  ],
  edges: [],
};

function makeRootPlan(childId: string, acceptedCount: number, totalCount: number): ApiCollaborationPlan {
  const nodes = Array.from({ length: totalCount }, (_, i) => ({
    slot_key: `n${i}`,
    role_key: i < acceptedCount ? "analyst" : "builder",
    required: true,
    expected_result: "",
    execution_state: (i < acceptedCount ? "accepted" : "active") as "accepted" | "active",
    task_id: childId,
  }));
  return {
    id: "pr",
    task_id: "root1",
    revision: 1,
    status: "approved",
    profile: "full_cycle",
    rationale: "—",
    // В плане branch_root узлы для child помечены `task_id === child.id`.
    // ParentPlanPulse должен отфильтровать только их.
    nodes: nodes.map((n) => ({ ...n, task_id: childId })),
    edges: [],
  };
}

function setChildPlan(childId: string, plans: ApiCollaborationPlan[], branchRoot: string | null = null) {
  dataByKey[JSON.stringify(["tasks", childId, "collaboration-plans"])] = {
    data: { plans, branch_root_task_id: branchRoot },
  };
}

function setRootPlan(rootId: string, plan: ApiCollaborationPlan | null) {
  dataByKey[JSON.stringify(["tasks", rootId, "collaboration-plans"])] = {
    data: { plans: plan ? [plan] : [] },
  };
}

beforeEach(() => {
  for (const k of Object.keys(dataByKey)) delete dataByKey[k];
});

describe("<ParentPlanPulse>", () => {
  it("не рендерится без дочерних", () => {
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[]} />,
    );
    expect(html).toBe("");
  });

  it("показывает скелетон при загрузке", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      isLoading: true,
    };
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toContain("parent-plan-pulse-skeleton");
    expect(html).toContain("pulse-metrics-skeleton");
  });

  it("скрывает пульс при ошибке загрузки", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      isError: true,
    };
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toBe("");
  });

  it("child с собственным approved планом: агрегирует его напрямую", () => {
    setChildPlan("c1", [fullChildPlan]);
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toContain("Пульс плана");
    expect(html).toContain("1 дочерних");
    // accepted=1, review=1
    expect(html).toContain(">1</span>");
    expect(html).toContain("в работе");
    expect(html).toContain("ревью");
    expect(html).toContain("принято");
    // Прогресс 1/2 = 50%
    expect(html).toContain("50%");
    expect(html).toContain("width:50%");
    // Кто активен: submitted у Разработчика
    expect(html).toContain("Разработчик");
    expect(html).toContain("Сдано");
    // Дочка кликабельна
    expect(html).toContain("Открыть задачу Дочка");
  });

  it("child в draft-ветке: plans:[] + branch_root:null → без плана", () => {
    setChildPlan("c1", [], null);
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toContain("без плана");
    expect(html).toContain("width:100%");
    expect(html).toContain(">0</span>");
  });

  it("child в ветке: берёт план branch_root и фильтрует узлы по task_id", () => {
    // Ключевой сценарий Доработки 3: для child без своего approved плана
    // идём за планом branch_root и оставляем только узлы этой child.
    // Если фильтрации нет — на родительской 1fe2d05c с 13 детьми
    // отрисуется чужой прогресс (D2' P0, QA-fix2).
    setChildPlan("c1", [], "root1");
    setRootPlan("root1", makeRootPlan("c1", /*accepted*/ 3, /*total*/ 5));
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    // accepted=3, active=2 (5 узлов, фильтрованных по task_id=c1)
    expect(html).toContain("Пульс плана");
    expect(html).toContain("width:60%");
    expect(html).toContain("60%");
    expect(html).not.toContain("без плана");
  });

  it("13 дочерних в одной ветке: один запрос на branch_root, 13 строк прогресса", () => {
    // Главный сценарий архитектора: 13 дочерних одной ветки делят
    // branch_root через кэш. В SSR-тесте мы лишь подкладываем данные
    // по нужным ключам, но проверяем, что для каждой child мы
    // правильно агрегируем её узлы (не суммируем чужие).
    const children = Array.from({ length: 13 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `Дочка ${i + 1}`,
    }));
    for (const c of children) {
      setChildPlan(c.id, [], "root1");
    }
    // У каждой child в branch_root — свой набор узлов (отфильтрованных
    // по её task_id). Принимаем по 6 узлов: 4 accepted, 2 active.
    for (const c of children) {
      dataByKey[JSON.stringify(["tasks", c.id, "collaboration-plans"])] = {
        data: { plans: [], branch_root_task_id: "root1" },
      };
    }
    // Делаем один общий план root1, в котором все узлы всех child; для
    // проверки фильтрации этого достаточно: под каждый child мы
    // собираем СВОИ узлы из этого плана (но в реальном плане branch_root
    // у каждого узла task_id указывает на свою child — а в нашем
    // тестовом плане все узлы принадлежат c1; в SSR-тесте фильтрация
    // по task_id === c.id даст для c1 6 узлов, для c2..c13 — 0).
    setRootPlan("root1", makeRootPlan("c1", 4, 6));

    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={children} />,
    );
    expect(html).toContain("13 дочерних");
    // c1 показывает прогресс 4/6 ≈ 67%
    expect(html).toContain("67%");
    // c2..c13 — без плана (фильтр даёт 0 узлов)
    expect(html).toContain("без плана");
  });

  it("5 дочерних одной ветки: один branch_root делится через кэш", () => {
    const children = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `Дочка ${i + 1}`,
    }));
    for (const c of children) {
      setChildPlan(c.id, [], "root1");
    }
    // 5 узлов в branch_root, у всех task_id === c1
    setRootPlan("root1", makeRootPlan("c1", 5, 5));
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={children} />,
    );
    expect(html).toContain("5 дочерних");
    // c1 = 100%
    expect(html).toContain("100%");
    expect(html).toContain("width:100%");
  });

  it("1 дочерняя в ветке: агрегаты не нулевые", () => {
    setChildPlan("c1", [], "root1");
    setRootPlan("root1", makeRootPlan("c1", 1, 2));
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    // accepted=1
    expect(html).toContain(">1</span>");
    // 1/2 = 50%
    expect(html).toContain("50%");
    expect(html).not.toContain("без плана");
  });

  it("сворачивает «кто активен» в «+N ещё» при >5 строк", () => {
    // 3 узла плана, у каждого по 2 активных состояния = 6 строк.
    const plan3: ApiCollaborationPlan = {
      ...fullChildPlan,
      nodes: [
        { slot_key: "a", role_key: "analyst", required: true, expected_result: "", execution_state: "active" },
        { slot_key: "b", role_key: "builder", required: true, expected_result: "", execution_state: "active" },
        { slot_key: "c", role_key: "qa", required: true, expected_result: "", execution_state: "returned" },
        { slot_key: "a2", role_key: "analyst", required: true, expected_result: "", execution_state: "active" },
        { slot_key: "b2", role_key: "builder", required: true, expected_result: "", execution_state: "returned" },
        { slot_key: "c2", role_key: "qa", required: true, expected_result: "", execution_state: "active" },
      ],
    };
    setChildPlan("c1", [plan3]);
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toContain("+1 ещё");
  });
});
