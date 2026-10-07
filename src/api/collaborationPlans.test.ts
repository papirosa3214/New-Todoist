import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// Хук внутри использует `useQueries` дважды (primary + optional followup
// на branch_root). Мок `useQueries` ниже отдаёт срезы по `queryKey`.
// Хук в тестах не рендерится — он вызывается только как функция внутри
// прокси-компонента, который выводит `data?.plans.length` в DOM.

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

describe("useCollaborationPlans (Доработка 2 — fix D1' P0)", () => {
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

  // Главный сценарий: child карточка вернула `branch_root_task_id`. Хук
  // должен автоматически догрузить план корня и отдать его как
  // `data.plans` (а не пустой массив, как было до фикса — D1' P0).
  it("child карточка с branch_root: догружает план корня и отдаёт его", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [], branch_root_task_id: "root1" },
    };
    dataByKey[JSON.stringify(["tasks", "root1", "collaboration-plans"])] = {
      data: { plans: [rootPlan], branch_root_task_id: null },
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    // data.plans — это план от root1, не пусто.
    expect(html).toContain("1|");
    // branch_root_task_id пробрасывается как null (т.к. root1 и есть
    // branch_root, и для него это null).
    expect(html).toContain("|_");
    // sanity: НЕ показывает 0 планов
    expect(html).not.toContain(">0|");
  });

  it("isLoading корректно отдаётся через мок, когда первичный ответ isLoading=true", () => {
    // Мок useQueries поддерживает `isLoading` — это полезный сигнал для
    // UI. Хук склеивает isLoading с обоих вызовов. Здесь у нас
    // первичный ещё грузится — хук отдаёт isLoading=true.
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      isLoading: true,
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("loading");
  });

it("ошибка в первичном запросе пробрасывается как isError", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      isError: true,
    };
    const html = renderToStaticMarkup(React.createElement(Probe, { taskId: "c1" }));
    expect(html).toContain("error");
  });
});
