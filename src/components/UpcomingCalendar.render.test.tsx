// Регрессия 72eb2f27: в файлах веба компонент рендера названий задач
// использовался без импорта, и экран падал целиком («Экран не смог
// отрисоваться», ReferenceError: MarkdownInline is not defined) ровно в
// тот момент, когда на нём рисовалось название задачи.
//
// Этот тест рендерит настоящий компонент сетки месяца с задачей внутри:
// до правки он падал с ReferenceError, после — отдаёт разметку с
// названием задачи.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthGrid } from "./UpcomingCalendar";
import type { ApiTask } from "../api/types";

const task: ApiTask = {
  id: "t1",
  title: "Купить **молоко**",
  description: null,
  due_date: "2026-10-15",
  project_id: null,
  priority: 3,
  assignee_id: null,
  creator_id: "u1",
  status: "active",
  completed_at: null,
  position: null,
  labels: [],
  subtasks: [],
  parent_id: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

describe("сетка месяца рисует название задачи", () => {
  it("не падает и отдаёт название задачи в разметке", () => {
    const html = renderToStaticMarkup(
      <MonthGrid
        initialMonday="2026-10-12"
        byDate={new Map([["2026-10-15", [task]]])}
        openDay={null}
        onDayClick={() => {}}
        onTaskClick={() => {}}
        onVisibleMonthChange={() => {}}
      />,
    );
    expect(html).toContain("Купить");
    // Inline-Markdown отрендерен как разметка, а не как сырые звёздочки.
    expect(html).toContain("<strong>молоко</strong>");
  });
});
