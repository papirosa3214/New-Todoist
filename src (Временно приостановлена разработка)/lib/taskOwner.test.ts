// Юнит-тесты чистого предиката «isWaitingForUser» — без React, без сети,
// без DOM. Извлечён из TodayScreen в Шаге 2 (feature/projects-decouple-
// planner-merge), чтобы TodayScreen и фикс-ветка Шага 1 звали одну
// функцию вместо двух копий inline-логики. Каждый кейс проверяет ровно
// одно условие формулы, чтобы регрессия в любом из них была видна.
import { describe, expect, it } from "vitest";
import { isWaitingForUser, waitingBlockedFirst } from "./taskOwner";
import type { ApiTask, ApiUser } from "../api/types";

const owner: ApiUser = {
  id: "user-1",
  name: "Максим",
  email: "m@example",
  role: "owner",
  type: "human",
  avatar_color: "#000",
  initials: "М",
  status: "active",
};
const viewer: ApiUser = {
  id: "user-2",
  name: "Сосед",
  email: "s@example",
  role: "viewer",
  type: "human",
  avatar_color: "#000",
  initials: "С",
  status: "active",
};

// Минимальная задача: только поля, которые читает предикат.
// status/parent_id/creator_id/agent_state — всё, что нужно.
function task(over: Partial<ApiTask> = {}): ApiTask {
  return {
    id: "t-1",
    title: "",
    status: "active",
    parent_id: null,
    creator_id: "user-1",
    assignee_id: null,
    agent_state: "blocked",
    project_id: null,
    priority: 3,
    due_date: null,
    start_time: null,
    duration_min: null,
    description: null,
    labels: [],
    subtasks: [],
    attachments: [],
    created_at: "",
    updated_at: "",
    ...over,
  } as ApiTask;
}

describe("isWaitingForUser", () => {
  it("null user → false (нет кому показывать)", () => {
    expect(isWaitingForUser(task(), null)).toBe(false);
  });

  it("viewer (не owner и не creator) → false", () => {
    // creator_id=user-1, viewer.id=user-2 → не подходит ни под owner,
    // ни под creator. Та же задача для владельца трекера user-2 тут
    // тоже не подойдёт, потому что user-2 — viewer, а не owner.
    expect(isWaitingForUser(task(), viewer)).toBe(false);
  });

  it("дочерняя задача (parent_id !== null) → false", () => {
    expect(isWaitingForUser(task({ parent_id: "parent-1" }), owner)).toBe(
      false,
    );
  });

  it("статус !== active (например completed) → false", () => {
    expect(isWaitingForUser(task({ status: "completed" }), owner)).toBe(
      false,
    );
  });

  it("agent_state = null → false (никого не ждём)", () => {
    expect(isWaitingForUser(task({ agent_state: null }), owner)).toBe(false);
  });

  it("agent_state = blocked, owner-владелец → true", () => {
    expect(isWaitingForUser(task({ agent_state: "blocked" }), owner)).toBe(
      true,
    );
  });

  it("agent_state = review, owner-владелец → true", () => {
    expect(isWaitingForUser(task({ agent_state: "review" }), owner)).toBe(
      true,
    );
  });

  it("creator-владелец (не owner-role) тоже проходит", () => {
    // viewer как creator_id своей задачи: role=viewer, id=user-2,
    // task.creator_id=user-2 → подходит под creator-ветку isTaskOwner.
    const creator = { ...viewer, id: "user-2" };
    expect(isWaitingForUser(task({ creator_id: "user-2" }), creator)).toBe(
      true,
    );
  });
});

describe("waitingBlockedFirst", () => {
  it("blocked идёт раньше review", () => {
    const blocked = task({ agent_state: "blocked" });
    const review = task({ agent_state: "review" });
    expect(waitingBlockedFirst(blocked, review)).toBeLessThan(0);
    expect(waitingBlockedFirst(review, blocked)).toBeGreaterThan(0);
  });

  it("одинаковые состояния → 0", () => {
    expect(
      waitingBlockedFirst(
        task({ agent_state: "blocked" }),
        task({ agent_state: "blocked" }),
      ),
    ).toBe(0);
  });
});
