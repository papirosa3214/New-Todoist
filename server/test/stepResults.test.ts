// Результаты шагов человеческим языком для владельца (07.10.2026).
import { describe, expect, it } from "vitest";
import { humanResultBody } from "../src/lib/stepResults.js";

describe("humanResultBody", () => {
  it("структурный результат превращается в текст с русскими заголовками, без JSON", () => {
    const body = humanResultBody("Коротко о постановке", JSON.stringify({
      scope: "Раздел «Сервер» в вебе", out_of_scope: ["iOS", "права ролей"],
      acceptance_criteria: [{ id: "AC1", text: "Параметр меняется без перезапуска" }], mystery_field: 5,
    }), null);
    expect(body).toContain("Коротко о постановке");
    expect(body).toContain("### Что входит в задачу\n\nРаздел «Сервер» в вебе");
    expect(body).toContain("### Что не входит\n\n- iOS\n- права ролей");
    expect(body).toContain("### Критерии приёмки\n\n- id: AC1; text: Параметр меняется без перезапуска");
    expect(body).toContain("### Mystery field\n\n5");
    expect(body).not.toContain("{");
  });
  it("шаг без структурного результата отдаёт свой текст; пустой — ничего", () => {
    expect(humanResultBody(null, null, "approved: всё проверено")).toBe("approved: всё проверено");
    expect(humanResultBody(null, null, null)).toBe("");
  });
});
