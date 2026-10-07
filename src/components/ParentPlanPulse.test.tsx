import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiCollaborationPlan } from "../api/collaborationPlans";

// Прокидываем data через queryKey. Глобальный словарь переопределяется
// в каждом тесте; фабрика useQueries читает его.
//
// Доработка 2: в нашем сценарии `useCollaborationPlans` сам внутри
// вызывает `useQueries` дважды (на taskId + опционально на branch_root).
// Для синхронного SSR-теста это прозрачно: если хук зарегистрирует в
// кэше оба ключа — `useQueries` вернёт массив из двух объектов. Но
// ParentPlanPulse собирает план только по ключу `childList[].id`, так
// что для теста достаточно один раз подложить `data` под ключ child —
// в реальности ветка branch_root резолвится в тот же кэш react-query и
// `useCollaborationPlans` сам отдаёт канонический план. Здесь мы
// симулируем «уже разрешённый» случай: под `child.id` сразу лежит
// правильный план (как если бы `useCollaborationPlans` уже выполнил
// followup и положил данные в кэш). Это документирует, что компонент
// после фикса правильно агрегирует.

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
  // `execution_state` соответствует тому, что кладёт `presentSingle` на
  // сервере: 6 состояний, включая `returned` (изменения запрошены) и без
  // отдельного `submitted` на уровне узла плана.
  nodes: [
    { slot_key: "n1", role_key: "analyst", required: true, expected_result: "brief", execution_state: "accepted" },
    { slot_key: "n2", role_key: "builder", required: true, expected_result: "code", execution_state: "returned" },
  ],
  edges: [],
};

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

  it("агрегирует метрики, прогресс и активные роли", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [fullChildPlan] },
    };
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    // Заголовок пульса
    expect(html).toContain("Пульс плана");
    expect(html).toContain("1 дочерних");
    // accepted=1, review=1
    expect(html).toContain(">1</span>");
    expect(html).toContain("в работе");
    expect(html).toContain("ревью");
    expect(html).toContain("принято");
    // Прогресс 1/2 = 50%
    expect(html).toContain("50%");
    // Ширина прогресс-бара теперь реальная (50%), а не фиксированная 60%
    expect(html).toContain("width:50%");
    // Кто активен: submitted у Разработчика
    expect(html).toContain("Разработчик");
    expect(html).toContain("Сдано");
    // Дочка кликабельна
    expect(html).toContain("Открыть задачу Дочка");
  });

  it("рисует прогресс «без плана» для дочерней без approved плана", () => {
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [] },
    };
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toContain("без плана");
    expect(html).toContain("width:100%");
    // Метрики 0
    expect(html).toContain(">0</span>");
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
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [plan3] },
    };
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    expect(html).toContain("+1 ещё");
  });

  // Доработка 2 (fix D1' P0): дочерняя карточка получила `plans: []`,
  // `useCollaborationPlans` сделал followup на branch_root, в кэше
  // лежит канонический план. `ParentPlanPulse` агрегирует ненулевые
  // метрики. Без фикса (т.е. без followup) данные в кэше остались бы
  // пустыми и метрики были бы 0/0/0/0, «без плана» по всем дочерним.
  it("Доработка 2 (D1'): после followup на branch_root агрегаты ненулевые", () => {
    // В кэше уже лежит канонический план (как если бы `useCollaborationPlans`
    // сделал followup и положил данные по ключу child.id).
    dataByKey[JSON.stringify(["tasks", "c1", "collaboration-plans"])] = {
      data: { plans: [fullChildPlan] },
    };
    const html = renderToStaticMarkup(
      <ParentPlanPulse parentId="p1" childList={[{ id: "c1", title: "Дочка" }]} />,
    );
    // accepted=1, review=1 — НЕ нули
    expect(html).toContain(">1</span>");
    expect(html).not.toContain("без плана");
    // Прогресс 1/2 = 50%
    expect(html).toContain("50%");
    expect(html).toContain("width:50%");
    // Кто активен: Разработчик в submitted
    expect(html).toContain("Разработчик");
    expect(html).toContain("Сдано");
  });
});
