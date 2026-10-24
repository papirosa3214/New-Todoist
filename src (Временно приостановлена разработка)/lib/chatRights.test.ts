import { describe, expect, it } from "vitest";
import { canArchiveChat } from "./chatRights";

// Право убрать чат на экране (карточка 0b7a8b81…): тема задачи — системная
// комната, её убирает любой участник проекта; личные и групповые переписки —
// только создатель; общую комнату не убирают вовсе.
describe("Право убрать чат", () => {
  const members = [{ id: "owner" }, { id: "role_builder" }];

  it("тему задачи убирает участник, даже если он не создатель", () => {
    const chat = {
      created_by: "owner",
      task_id: "task-1",
      parent_chat_id: "group-1",
      members,
    };
    expect(canArchiveChat(chat, "role_builder")).toBe(true);
  });

  it("чужой (не участник) тему задачи убрать не может", () => {
    const chat = {
      created_by: "owner",
      task_id: "task-1",
      parent_chat_id: "group-1",
      members,
    };
    expect(canArchiveChat(chat, "stranger")).toBe(false);
  });

  it("личную переписку убирает только создатель", () => {
    const chat = { created_by: "owner", task_id: null, members };
    expect(canArchiveChat(chat, "owner")).toBe(true);
    expect(canArchiveChat(chat, "role_builder")).toBe(false);
  });

  it("общую комнату не убирает никто", () => {
    const chat = {
      created_by: "owner",
      task_id: null,
      room_kind: "common",
      members,
    };
    expect(canArchiveChat(chat, "owner")).toBe(false);
  });

  it("без своего id кнопки нет", () => {
    const chat = { created_by: "owner", task_id: null, members };
    expect(canArchiveChat(chat, undefined)).toBe(false);
  });
});
