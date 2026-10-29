import { describe, expect, it } from "vitest";
import { resolveThinkingLevel } from "../src/runtime/PiRuntimeAdapter.js";

const model = { reasoning: true, thinkingLevelMap: { max: "max" } };
describe("owner role thinking policy", () => {
  it.each([
    // Размышления у ролей — на максимуме (владелец 29.10.2026: рекомендация
    // MiniMax для Anthropic-совместимого API; конфиг приведён к факту —
    // scripts/role-thinking.json).
    ["architect", "max"], ["code_orchestrator", "max"],
    ["critic_verifier", "max"], ["secretary", "max"],
    ["researcher", "max"], ["analyst", "max"], ["builder", "max"],
    ["qa", "max"], ["designer", "max"], ["infra_engineer", "max"],
    ["new_role", "max"],
  ])("%s gets %s on a capable model", (role, level) => {
    expect(resolveThinkingLevel(model, role)).toBe(level);
  });
  it("clamps maximum to high on a fallback without max capability", () => {
    expect(resolveThinkingLevel({reasoning:true}, "architect")).toBe("high");
  });
  it("keeps non-reasoning fallback off", () => {
    expect(resolveThinkingLevel({reasoning:false}, "architect")).toBe("off");
  });
});
