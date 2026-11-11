import { describe, expect, it } from "vitest";
import { loadRoleRules, rulesFor, renderRules } from "../src/lib/roleRules.js";

describe("доставка server+iOS: ветка и PR (11.11.2026)", () => {
  const rules = loadRoleRules();

  it("C29 включено и запрещает push в main", () => {
    const c29 = rules.find((r) => r.id === "C29");
    expect(c29?.enabled).not.toBe(false);
    expect(c29?.text).toMatch(/main не пушить/i);
    expect(c29?.text).toContain("TaskFlowNativeBuild");
    expect(c29?.roles).toContain("builder");
    expect(c29?.roles).toContain("orchestrator");
  });

  it("C27 (старый push main) выключено", () => {
    const c27 = rules.find((r) => r.id === "C27");
    expect(c27?.enabled).toBe(false);
  });

  it("R343/R347 и Mac-host для builder (R335–R342) выключены", () => {
    for (const id of ["R343", "R347", "R335", "R336", "R338"]) {
      expect(rules.find((r) => r.id === id)?.enabled).toBe(false);
    }
  });

  it("builder видит правила ветки/PR и iOS на .110 в карточке", () => {
    const text = renderRules(rulesFor("builder", "card"));
    expect(text).toMatch(/main не пушить/i);
    expect(text).toMatch(/ветк/);
    expect(text).toMatch(/Pull Request/);
    expect(text).toContain("ensure-ios-repo");
    expect(text).toMatch(/taskflow_host_\*/);
  });

  it("orchestrator видит контроль PR в карточке", () => {
    const text = renderRules(rulesFor("orchestrator", "card"));
    expect(text).toMatch(/URL PR/);
    expect(text).toMatch(/main/);
  });
});
