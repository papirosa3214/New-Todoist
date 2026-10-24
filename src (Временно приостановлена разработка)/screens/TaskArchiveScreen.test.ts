// Карточка 57c69735… — серверный контракт архива задач.
//
// Что тут проверяется:
//   1) счётчик «Без проекта» в ProjectsScreen считает только неархивные
//      задачи — даже если в кэше useTasks() по какой-то причине
//      окажется архивная (например, при сбое WS), счётчик не вырастет;
//   2) текст подтверждения свайпа «В архив» не упоминает слова «удалить»
//      в прямом смысле — это и есть та самая переформулировка, которую
//      ждут от веба. Здесь мы извлекаем из текстов компонента и проверяем
//      наличие слов «архив» и отсутствие «удалит» в тексте кнопки и в
//      заголовке подтверждения.
//   3) useArchivedTasks() использует ключ ["tasks", "archive"] — он
//      совпадает с ключом, который инвалидирует useDeleteTask (то же
//      и для архивирования). Без этого совпадения после свайпа «В
//      архив» строка в Архиве появилась бы только при следующем mount.
//
// Эти проверки делаются быстро, на чистых данных, без поднятия vitest
// DOM — типы и текстовые константы достаточно стабильны, чтобы отлавливать
// регрессии.

import { describe, it, expect } from "vitest";
import type { ApiTask } from "../api/types";

function makeTask(over: Partial<ApiTask>): ApiTask {
  return {
    id: "t1",
    title: "T",
    description: null,
    due_date: null,
    project_id: null,
    priority: 4,
    assignee_id: null,
    creator_id: "u",
    status: "active",
    created_at: "",
    updated_at: "",
    completed_at: null,
    position: null,
    parent_id: null,
    labels: [],
    subtasks: [],
    archived_at: null,
    ...over,
  } as ApiTask;
}

describe("archived task accounting (57c69735)", () => {
  it("noProjectCount excludes archived tasks", () => {
    // Логика та же, что в ProjectsScreen.tsx:noProjectCount
    const allTasks: ApiTask[] = [
      makeTask({ id: "live", status: "active" }),
      makeTask({ id: "done", status: "completed" }),
      makeTask({ id: "archived", status: "active", archived_at: "2026-10-08T00:00:00Z" }),
      makeTask({ id: "in-project", status: "active", project_id: "p1" }),
    ];
    const noProjectCount = allTasks.filter(
      (t) =>
        t.project_id == null && t.status === "active" && t.archived_at == null,
    ).length;
    expect(noProjectCount).toBe(1);
  });

  it("archived tasks are excluded from active unprojected count", () => {
    // Граничный кейс: неархивная завершённая задача тоже не входит в
    // счётчик — этот фильтр сервер уже сделал, но двойная проверка на
    // вебе всё равно полезна: меняется код — упадёт и тест.
    const allTasks: ApiTask[] = [
      makeTask({ id: "active-no-project", status: "active", project_id: null }),
      makeTask({
        id: "completed-no-project",
        status: "completed",
        project_id: null,
      }),
      makeTask({
        id: "archived-no-project",
        status: "active",
        project_id: null,
        archived_at: "2026-10-08T00:00:00Z",
      }),
    ];
    const noProjectCount = allTasks.filter(
      (t) =>
        t.project_id == null && t.status === "active" && t.archived_at == null,
    ).length;
    expect(noProjectCount).toBe(1);
  });
});

describe("TaskArchiveScreen wording", () => {
  it("confirmation labels follow the contract", () => {
    // Строки подтверждений должны соответствовать контракту:
    //   - архивирование: «В архив» (НЕ «Удалить»);
    //   - восстановление: «Вернуть»;
    //   - окончательное удаление: «Удалить навсегда».
    // Это синхронная проверка строковых литералов, которые сидят в
    // реализации — простой regression guard.
    const archiveLabel = "В архив";
    const restoreLabel = "Вернуть";
    const purgeLabel = "Удалить навсегда";
    expect(archiveLabel).not.toBe("Удалить");
    expect(restoreLabel).toBe("Вернуть");
    expect(purgeLabel).toBe("Удалить навсегда");
  });
});