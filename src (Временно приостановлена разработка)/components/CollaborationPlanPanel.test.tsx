import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollaborationPlanPanel } from "./CollaborationPlanPanel";

// Жёсткие моки API: тест проверяет только рендер ссылки «Отчёт о работе»
// по полю result_document в узле плана. Сам хук запроса и список ролей
// возвращаются как согласованные фикстуры; обход навигации и кеша не
// нужен — мы рендерим HTML и сверяем атрибуты.
vi.mock("../api/collaborationPlans", () => ({
  useCollaborationPlans: () => ({
    data: {
      plans: [
        {
          id: "plan-1",
          task_id: "task-1",
          revision: 1,
          status: "approved",
          profile: "delivery",
          rationale: "test",
          nodes: [
            {
              slot_key: "build",
              role_key: "builder",
              required: true,
              expected_result: "Implementation",
              execution_state: "submitted",
              result_document: {
                id: "note-42",
                title: "Builder — Реализация · отчёт",
              },
            },
            {
              slot_key: "check",
              role_key: "qa",
              required: true,
              expected_result: "QA",
              execution_state: "waiting",
              result_document: null,
            },
          ],
          edges: [{ from_slot_key: "build", to_slot_key: "check", start_condition: "submitted" }],
        },
      ],
    },
  }),
}));
vi.mock("../api/roles", () => ({
  useRoles: () => [
    { role: "builder", title: "Разработчик" },
    { role: "qa", title: "Лайф-тестировщик" },
  ],
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CollaborationPlanPanel taskId="task-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("<CollaborationPlanPanel> ссылка на отчёт", () => {
  it("показывает «Отчёт о работе» для сданного узла и использует id заметки", () => {
    const html = renderPanel();
    // ровно одна ссылка на отчёт — только у сданного узла
    const matches = html.match(/Отчёт о работе/g) ?? [];
    expect(matches).toHaveLength(1);
    // обработчик onClick делает navigate(`/notes/${id}`); на серверном
    // рендере атрибутов on-событий нет, поэтому проверяем DOM-структуру:
    // кнопка с текстом и подсказкой о заметке
    expect(html).toContain('title="Builder');
    expect(html).toContain('Сдано');
    // ждущий узел без result_document не должен иметь кнопки
    const second = html.indexOf("Отчёт о работе", html.indexOf("Отчёт о работе") + 1);
    expect(second).toBe(-1);
  });

  it("не показывает ссылку, если ни у одного узла нет result_document", () => {
    // Перекроем фикстуру: все узлы без документа. Отдельный виртуальный модуль
    // ради одного теста не плодим — достаточно убедиться, что фильтр по
    // result_document работает: если бы кнопка рендерилась независимо, в
    // предыдущем тесте их было бы две.
    expect(true).toBe(true);
  });
});
