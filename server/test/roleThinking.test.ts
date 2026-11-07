import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveThinkingLevel } from "../src/runtime/PiRuntimeAdapter.js";

// Политика уровня размышлений по ролям — конфиг боевого сервера
// (scripts/role-thinking.json). Тест сверяется с НИМ, а не с зашитым
// значением: уровень меняет владелец руками (30.10.2026 — мысли роли
// builder выключены; 31.10.2026 — все роли на minimax переведены на
// минимальный размер рассуждений), и тест должен проверять «сервер берёт
// уровень из политики», а не «у всех ролей максимум». Так же починено в
// test/runtime/thinkingLevel.test.ts (ca13945a).
const roleThinking = JSON.parse(
  readFileSync(new URL("../scripts/role-thinking.json", import.meta.url), "utf8"),
) as { default: string; roles: Record<string, string> };

// Уровни, которые сервер вообще понимает (совпадают с THINKING_LEVELS).
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ROLES = [
  "analyst", "architect", "builder", "claude_code", "code_orchestrator",
  "critic_verifier", "designer", "infra_engineer", "qa", "researcher",
  "secretary", "new_role",
];

const model = { reasoning: true, thinkingLevelMap: { max: "max" } };

describe("owner role thinking policy", () => {
  it.each(ROLES)("%s: уровень роли берётся из политики (scripts/role-thinking.json)", (role) => {
    const policy = roleThinking.roles[role] ?? roleThinking.default;
    expect(LEVELS).toContain(policy);
    // Сервер отдаёт ровно уровень из политики роли.
    expect(resolveThinkingLevel(model, role)).toBe(policy);
  });

  it("builder: мысли роли выключены по решению владельца (30.10.2026)", () => {
    expect(roleThinking.roles.builder).toBe("off");
    expect(resolveThinkingLevel(model, "builder")).toBe("off");
  });

  it("уровень роли никогда не выше политики, даже на слабой модели", () => {
    for (const role of ROLES) {
      const policy = roleThinking.roles[role] ?? roleThinking.default;
      const level = resolveThinkingLevel({ reasoning: true }, role);
      expect(LEVELS.indexOf(level)).toBeLessThanOrEqual(LEVELS.indexOf(policy));
    }
  });

  it("MiniMax-M3.1-Flash: минимальный уровень модели — 'minimal' (effort low)", () => {
    // Реальная карта модели: off скрыт (thinkingLevelMap.off = null),
    // max поддержан, промежуточные уровни доступны.
    const minimax = { reasoning: true, thinkingLevelMap: { off: null, max: "max" } } as any;
    expect(resolveThinkingLevel(minimax, "critic_verifier")).toBe("minimal");
    // Политика builder — "off", но модель off не умеет: сервер отдаёт "off",
    // SDK добирает ближайший поддержанный уровень сам.
    expect(resolveThinkingLevel(minimax, "builder")).toBe("off");
  });

  it("keeps non-reasoning fallback off", () => {
    expect(resolveThinkingLevel({ reasoning: false }, "architect")).toBe("off");
  });
});
