import { describe, expect, it } from "vitest";
import { resolveReviewTaskId } from "../src/lib/reviewTaskId.js";
describe("review target", () => {
 it("uses the current card", () => expect(resolveReviewTaskId("task","task","critic")).toBe("task"));
 it("resolves an own slot to its card before requesting versions", () =>
  expect(resolveReviewTaskId("slot","task","critic",{task_id:"task",agent_id:"critic"})).toBe("task"));
 it("rejects another card, another actor and unknown IDs", () => {
  expect(()=>resolveReviewTaskId("slot","task","critic",{task_id:"other",agent_id:"critic"})).toThrow("id задачи task");
  expect(()=>resolveReviewTaskId("slot","task","critic",{task_id:"task",agent_id:"builder"})).toThrow();
  expect(()=>resolveReviewTaskId("unknown","task","critic")).toThrow();
 });
});
