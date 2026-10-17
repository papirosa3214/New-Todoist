import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// Хук после Доработки 3 — один запрос на `taskId`, без followup на
// branch_root. Подмену child→branch_root убрали: D2'/D1'' (P0, QA-fix2).
// Серверный контракт `task-collaboration-plans.ts:567` для child
// намеренно возвращает `plans: []` + `branch_root_task_id` — это
// правильное поведение, агрегацию делает ParentPlanPulse.

const { dataByKey } = vi.hoisted(() => ({
  dataByKey: {} as Record<
    string,
    { isLoading?: boolean; isError?: boolean; data?: unknown }
  >,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (spec: { queryKey: readonly unknown[] }) => {
    const key = JSON.stringify(spec.queryKey);
    return dataByKey[key] ?? { isLoading: false, isError: false, data: undefined };
  },
}));

import { useCollaborationPlans } from "./collaborationPlans";

const rootPlan = {
  id: "pr",
  task_id: "root1",
  revision: 1,
  status: "approved",
  profile: "full_cycle",
  rationale: "—",
  nodes: [
    { slot_key: "n1", role_key: "analyst", required: true, expected_result: "brief" },
  ],
  edges: [],
};

function Probe(props: { taskId: string }): React.ReactElement {
  const r = useCollaborationPlans(props.taskId);
  if (r.isLoading) return React.createElement("span", null, "loading");
  if (r.isError) return React.createElement("span", null, "error");
  const plans = (r.data?.plans as { id: string }[] | undefined) ?? [];
  const branch = r.data?.branch_root_task_id ?? null;
  return React.createElement("span", null, `${plans.length}|${branch ?? "_"}`);
}

beforeEach(() => {
  for (const k of Object.keys(dataByKey)) delete dataByKey[k];
});

describe("useCollaborationPlans (Доработка 3 — D-3.0)", () => {
  it("branch_root карточка: один запрос, возвращает свой план", () => {
    dataByKey[JSON.stringify(["tasks", "root1", "collaboration-plans"])] = {
      data: { plans: [rootPlan], branch_root_task_id: null },
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "root1" }));
    // 1 план + branch_root=null → "1|_"
    expect(html).toContain("1|_");
  });

  it("child карточка без указателя branch_root: возвращает пустой plans", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [], branch_root_task_id: null },
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("0|_");
  });

  it("child карточка с branch_root: НЕ подменяет план, отдаёт plans:[] + указатель", () => {
    // Главный сценарий архитектурного решения D-3.0: хук больше не
    // делает followup на branch_root. Это убирает D2' (обманчивые нули)
    // и D1'' (CollaborationPlanPanel на child не получает draft-план
    // root'а). Агрегацию берёт на себя ParentPlanPulse.
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [], branch_root_task_id: "root1" },
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("0|root1");
  });

  it("child с собственным approved планом: возвращает его", () => {
    const ownPlan = { ...rootPlan, id: "pc", task_id: "c1" };
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [ownPlan], branch_root_task_id: null },
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("1|_");
  });

  it("isLoading корректно отдаётся через мок", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      isLoading: true,
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("loading");
  });

  it("ошибка в запросе пробрасывается как isError", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      isError: true,
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("error");
  });
});
