import { describe, expect, it } from "vitest";
import { INSTRUCTION_DEFAULTS } from "../src/runtime/instructionDefaults.js";
import { validateStructuredRoleContractV1 } from "../src/lib/roleContractV1.js";

// Владелец 23.10.2026: «идеальный вид отчёта о проделанной работе, когда
// отчёт идёт через чат». Формат — блок report с пятью секциями и ссылками
// note://<uuid> в materials. Инструкция ролям (chat.wrapper) обязана называть
// этот формат и предупреждать про id вида report_*/review_*, которые iOS не
// разбирает.

describe("инструкция ролям о отчёте в чате", () => {
  const wrapper = String(INSTRUCTION_DEFAULTS["chat.wrapper"]);

  it("называет блок report и ровно пять его секций", () => {
    expect(wrapper).toContain("ОТЧЁТ О РАБОТЕ");
    expect(wrapper).toContain("report_kind final");
    expect(wrapper).toContain("result, work, checks, limitations, materials");
    expect(wrapper).toContain("passed|failed|blocked|skipped|not_run");
  });

  it("требует ссылку note:// и предупреждает про нечитаемый iOS id отчётов", () => {
    expect(wrapper).toContain("note://<id заметки>");
    expect(wrapper).toContain("report_05ebcca7");
    expect(wrapper).toContain("taskflow_doc_write");
  });

  it("поясняет, что отчёт о работе идёт блоком report, а не виджетом card", () => {
    expect(wrapper).toContain("materials");
    expect(wrapper).toMatch(/виджет\s+card/);
  });

  it("отчёт в блоке report проходит валидацию контракта ответа", () => {
    const envelope = {
      schema_version: 1,
      ok: true,
      output: [
        {
          type: "report",
          report_kind: "final",
          sections: {
            result: [{ type: "text", text: "Готово" }],
            work: [{ type: "list", items: ["Сделано"] }],
            checks: [{ label: "Проверка", status: "passed" }],
            limitations: [{ type: "text", text: "Живая проверка не проводилась" }],
            materials: [
              { kind: "document", title: "Отчёт", ref: "note://eefd13a2-c809-4840-a4c3-17f8051b818d" },
            ],
          },
        },
      ],
      artifacts: [],
      plan_artifact: null,
      error: null,
      next_hint: null,
    };
    expect(validateStructuredRoleContractV1(envelope).valid).toBe(true);
  });
});
