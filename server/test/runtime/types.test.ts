import { describe, it, expect } from "vitest";
import {
  RUNTIME_ID_PI,
  isRuntimeId,
  isAgentProfile,
  isModel,
  isProviderConnection,
  isAgentRun,
} from "../../src/runtime/types.js";

describe("runtime facade types", () => {
  it("RUNTIME_ID_PI is 'runtime:pi'", () => {
    expect(RUNTIME_ID_PI).toBe("runtime:pi");
  });

  it("isRuntimeId accepts the only known runtime", () => {
    expect(isRuntimeId("runtime:pi")).toBe(true);
    expect(isRuntimeId("runtime:claude_code")).toBe(false);
    expect(isRuntimeId("pi")).toBe(false);
    expect(isRuntimeId(null)).toBe(false);
    expect(isRuntimeId({})).toBe(false);
  });

  it("isAgentProfile accepts a well-formed profile", () => {
    const profile = {
      id: "architect",
      role: "architect",
      title: "Архитектор",
      account_id: "role_architect",
      runtime_id: RUNTIME_ID_PI,
      prompt: { source: "scripts/role-prompts/architect.md", size: 1024 },
      skills: [{ name: "architecture", description: null }],
      tools: ["taskflow_doc_write"],
      permissions: null,
      modelPolicy: { primary: "MiniMax-M3", fallbacks: [] },
      status: "ready",
    };
    expect(isAgentProfile(profile)).toBe(true);
    expect(isAgentProfile({ ...profile, runtime_id: "runtime:other" })).toBe(false);
    expect(isAgentProfile(null)).toBe(false);
  });

  it("isModel accepts a well-formed model", () => {
    expect(
      isModel({ id: "MiniMax-M3", provider: "minimax", runtime_id: RUNTIME_ID_PI, available: true })
    ).toBe(true);
    expect(
      isModel({ id: "MiniMax-M3", provider: "minimax", runtime_id: "runtime:other", available: true })
    ).toBe(false);
  });

  it("isProviderConnection accepts a well-formed connection", () => {
    expect(
      isProviderConnection({
        id: "anthropic",
        runtime_id: RUNTIME_ID_PI,
        status: "connected",
        managedBy: "pi",
        lastCheckedAt: null,
      })
    ).toBe(true);
    expect(
      isProviderConnection({
        id: "anthropic",
        runtime_id: RUNTIME_ID_PI,
        status: "connected",
        managedBy: "taskflow", // НЕ 'pi' — не должно пройти
        lastCheckedAt: null,
      })
    ).toBe(false);
  });

  it("isAgentRun accepts a well-formed run", () => {
    expect(
      isAgentRun({
        id: "run-1",
        task_id: "task-1",
        agent_id: "architect",
        runtime_id: RUNTIME_ID_PI,
        provider: null,
        model: null,
        session_id: null,
        status: "queued",
        started_at: "2026-09-18T00:00:00Z",
        finished_at: null,
        stop_reason: null,
      })
    ).toBe(true);
  });
});
