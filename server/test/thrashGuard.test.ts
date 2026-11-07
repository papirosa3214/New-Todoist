import { describe, expect, it } from "vitest";
import { ThrashGuard, isResearchTool, stepDigest } from "../src/runtime/thrashGuard.js";

// Владелец 23.10.2026: роль, которая повторяет один и тот же вызов или крутит
// только чтения без единого изменения, должна получить указание в свой же ход.

const read = (tool: string, args: unknown = {}) => ({ tool, argsDigest: stepDigest(args) });

describe("сторож топтания", () => {
  it("третий одинаковый вызов даёт указание, первые два — нет", () => {
    const guard = new ThrashGuard();
    expect(guard.observe(read("taskflow_host_bash", { command: "grep -rn Foo Sources" }))).toBeNull();
    expect(guard.observe(read("taskflow_host_bash", { command: "grep -rn Foo Sources" }))).toBeNull();
    const nudge = guard.observe(read("taskflow_host_bash", { command: "grep -rn Foo Sources" }));
    expect(nudge).toContain("один и тот же вызов");
    expect(guard.firedCount).toBe(1);
  });

  it("разные аргументы того же инструмента — не повтор", () => {
    const guard = new ThrashGuard();
    for (let i = 0; i < 6; i += 1) {
      expect(guard.observe(read("taskflow_host_bash", { command: `sed -n '${i},${i + 10}p' File.swift` }))).toBeNull();
    }
    expect(guard.firedCount).toBe(0);
  });

  it("серия только чтений без изменений даёт указание, изменение сбрасывает серию", () => {
    const guard = new ThrashGuard({ readStreakLimit: 4 });
    expect(guard.observe(read("read", { path: "a" }))).toBeNull();
    expect(guard.observe(read("grep", { q: "b" }))).toBeNull();
    expect(guard.observe(read("ls", { p: "." }))).toBeNull();
    const nudge = guard.observe(read("find", { n: "c" }));
    expect(nudge).toContain("только чтением");

    const guard2 = new ThrashGuard({ readStreakLimit: 4 });
    guard2.observe(read("read", { path: "a" }));
    guard2.observe(read("read", { path: "b" }));
    guard2.observe(read("edit", { path: "Sources/A.swift" }));
    guard2.observe(read("read", { path: "c" }));
    guard2.observe(read("read", { path: "d" }));
    expect(guard2.firedCount).toBe(0);
  });

  it("после срабатывания сторож молчит несколько шагов", () => {
    const guard = new ThrashGuard();
    for (let i = 0; i < 3; i += 1) guard.observe(read("ls", { p: "/" }));
    expect(guard.firedCount).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      expect(guard.observe(read("ls", { p: "/" }))).toBeNull();
    }
  });

  it("чтение и запись различаются по имени инструмента", () => {
    expect(isResearchTool("taskflow_host_read")).toBe(true);
    expect(isResearchTool("taskflow_host_ls")).toBe(true);
    expect(isResearchTool("taskflow_host_bash")).toBe(false);
    expect(isResearchTool("edit")).toBe(false);
    expect(isResearchTool("write")).toBe(false);
  });
});
