import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveThinkingLevel } from "../src/runtime/PiRuntimeAdapter.js";

// Политика уровня размышлений по ролям — конфиг боевого сервера
// (scripts/role-thinking.json). Тест сверяется с НИМ, а не с зашитым
// значением: уровень меняет владелец руками (30.10.2026 — мысли роли
// builder выключены), и тест должен проверять «сервер берёт уровень из
// политики», а не «у всех ролей максимум». Так же починено в
// test/runtime/thinkingLevel.test.ts (ca13945a).
const roleThinking = JSON.parse(
  readFileSync(new URL("../scripts/role-thinking.json", import.meta.url), "utf8"),
) as { default: string; roles: Record<string, string> };

const model = { reasoning: true, thinkingLevelMap: { max: "max" } };
describe("owner role thinking policy", () => {
  it.each([
    // Размышления у ролей — по политике роли (владелец 29.10.2026:
    // рекомендация MiniMax для Anthropic-совместимого API; конфиг приведён
    // к факту — scripts/role-thinking.json).
    ["architect", "max"], ["code_orchestrator", "max"],
    ["critic_verifier", "max"], ["secretary", "max"],
    ["researcher", "max"], ["analyst", "max"],
    ["qa", "max"], ["designer", "max"], ["infra_engineer", "max"],
    ["new_role", "max"],
  ])("%s gets %s on a capable model", (role, level) => {
    expect(resolveThinkingLevel(model, role)).toBe(level);
    // Политика роли — источник правды: значение сервера и конфига совпадают.
    expect(roleThinking.roles[role] ?? roleThinking.default).toBe(level);
  });
  it("builder: мысли роли выключены по решению владельца (30.10.2026)", () => {
    expect(roleThinking.roles.builder).toBe("off");
    expect(resolveThinkingLevel(model, "builder")).toBe("off");
  });
  it("clamps maximum to high on a fallback without max capability", () => {
    expect(resolveThinkingLevel({reasoning:true}, "architect")).toBe("high");
  });
  it("keeps non-reasoning fallback off", () => {
    expect(resolveThinkingLevel({reasoning:false}, "architect")).toBe("off");
  });
});
