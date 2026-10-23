// Регрессия D6 (карточка 64e7d624): в экран «Мои рутины» попал блок
// уведомления из старой версии файла, где состояние называлось
// lastRunNotice. В текущей версии состояние называется runNotice, и блок
// остался без объявления — экран падал целиком при открытии с
// «ReferenceError: lastRunNotice is not defined».
//
// Тест рендерит настоящий экран с подменёнными ответами API: до правки
// он падает с ReferenceError, после — отдаёт разметку со списком рутин.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoutinesScreen } from "./RoutinesScreen";
import type { ApiSchedule } from "../api/schedules";

const schedule: ApiSchedule = {
  id: "s1",
  title: "Ежедневный отчёт",
  task_payload: { title: "Ежедневный отчёт" },
  rule_kind: "daily",
  rule_expr: null,
  rule_label: "Ежедневно",
  time_local: "09:00",
  timezone: "Europe/Moscow",
  next_run_at: "2026-10-26T06:00:00.000Z",
  last_run_at: null,
  status: "active",
  catch_up: true,
  overlap_policy: "skip",
  current_task_id: null,
  created_at: "",
  updated_at: "",
} as ApiSchedule;

vi.mock("../api/schedules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/schedules")>();
  return {
    ...actual,
    useSchedules: () => ({
      data: { schedules: [schedule] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }),
    useSchedulePreview: () => ({ data: undefined }),
    useScheduleRuns: () => ({ data: { runs: [] }, isLoading: false, isError: false }),
    useCreateSchedule: () => ({ mutateAsync: async () => ({}), isPending: false }),
    useUpdateSchedule: () => ({ mutateAsync: async () => ({}), isPending: false }),
    useDeleteSchedule: () => ({ mutateAsync: async () => ({}), isPending: false }),
    useRunScheduleNow: () => ({ mutateAsync: async () => ({}), isPending: false }),
  };
});

vi.mock("../api/projects", () => ({ useProjects: () => ({ data: [] }) }));
vi.mock("../api/agents", () => ({ useAgents: () => ({ data: [] }) }));

describe("экран «Мои рутины» открывается", () => {
  it("рендерится без ReferenceError и показывает рутину", () => {
    const qc = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RoutinesScreen />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Мои рутины");
    expect(html).toContain("Ежедневный отчёт");
  });
});
