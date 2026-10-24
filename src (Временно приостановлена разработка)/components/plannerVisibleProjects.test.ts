// Юнит-тесты селектора selectVisibleProjects. Чистая функция, без
// React — покрывается обычным vitest. Сам компонент PlannerProjectChips
// не тестируем рендером (в проекте нет @testing-library/react; вводить
// ради одной фичи — лишний шум), но инвариант «что попало в чипы»
// фиксируется здесь.
import { describe, expect, it } from "vitest";
import { selectVisibleProjects } from "./plannerVisibleProjects";
import type { ApiProject } from "../api/types";

function project(id: string, name = id): ApiProject {
  return {
    id,
    name,
    color: "#ff0000",
    owner_id: "u",
    archived: false,
    created_at: "",
    updated_at: "",
  } as unknown as ApiProject;
}

describe("selectVisibleProjects", () => {
  it("пустой словарь → пустой массив (дефолт = «только входящие»)", () => {
    expect(selectVisibleProjects([project("a"), project("b")], {})).toEqual(
      [],
    );
  });

  it("один проект в словаре — он один и возвращается", () => {
    const a = project("a");
    const b = project("b");
    expect(selectVisibleProjects([a, b], { a: true })).toEqual([a]);
  });

  it("сохраняет порядок исходного списка projects", () => {
    const a = project("a");
    const b = project("b");
    const c = project("c");
    // В словаре c и a, но список projects — a, b, c → результат a, c.
    expect(selectVisibleProjects([a, b, c], { c: true, a: true })).toEqual([
      a,
      c,
    ]);
  });

  it("id из словаря, которого нет в projects — тихо отбрасывается", () => {
    // Юзер успел добавить проект, потом проект удалили с сервера.
    const a = project("a");
    expect(selectVisibleProjects([a], { a: true, deleted: true })).toEqual([
      a,
    ]);
  });

  it("пустой projects и непустой словарь — []", () => {
    expect(selectVisibleProjects([], { a: true })).toEqual([]);
  });
});
