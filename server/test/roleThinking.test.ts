import { describe, expect, it } from "vitest";
import { resolveThinkingLevel } from "../src/runtime/PiRuntimeAdapter.js";

const model = { reasoning: true, thinkingLevelMap: { max: "max" } };
describe("owner role thinking policy", () => {
  it.each([
    ["architect", "max"], ["code_orchestrator", "max"],
    ["critic_verifier", "low"], ["secretary", "low"],
    // Дефолт ролей — low с 24.10.2026 (648f6eec, scripts/role-thinking.json).
    ["researcher", "low"], ["analyst", "low"], ["builder", "low"],
    ["qa", "low"], ["designer", "low"], ["infra_engineer", "low"],
    ["new_role", "low"],
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
