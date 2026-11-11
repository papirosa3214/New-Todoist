import { describe, expect, it } from "vitest";

// Текст отчёта роли собирает сервер: разметка не зависит от модели.
describe("structuredOutputText: отчёт", () => {
  it("отчёт в текстовой форме сохраняет пункты списков, проверки и ограничения (10.11.2026)", async () => {
    const { structuredOutputText } = await import("../src/lib/roleContractV1.js");
    const text = structuredOutputText([{ type: "report", report_kind: "final", sections: {
      result: [{ type: "text", text: "Итог правки." }],
      work: [{ type: "heading", level: 2, text: "Что изменилось" }, { type: "list", items: ["правка A", "правка B"] }],
      checks: [{ label: "swiftc -parse", status: "passed" }, { label: "тесты", status: "not_run" }],
      limitations: [{ type: "list", items: ["на телефоне не смотрено"] }],
      materials: [],
    } }]);
    // До правки в тексте оставались только заголовки: `list` и `checks` брали
    // несуществующее поле `text|label|title` верхнего уровня и выбрасывались.
    expect(text).toContain("Итог правки.");
    expect(text).toContain("- правка A");
    expect(text).toContain("- правка B");
    expect(text).toContain("- swiftc -parse — passed");
    expect(text).toContain("- тесты — not_run");
    expect(text).toContain("- на телефоне не смотрено");
  });
  it("отчёт: имена и пути в обратных кавычках, материалы ссылкой — не зависит от роли (владелец 11.11.2026)", async () => {
    const { structuredOutputText } = await import("../src/lib/roleContractV1.js");
    const note = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const text = structuredOutputText([{ type: "report", report_kind: "final", sections: {
      result: [{ type: "text", text: "Снёс следы в note_accesses и knowledge_index_jobs." }],
      work: [{ type: "list", items: [
        "Бэкап: /tmp/taskflow.db.bak-20261111 и ~/.pi/agent/extensions",
        "Файл hesitation-gate.ts, уже в кавычках `kb_category`, ссылка [док](https://example.com/a_b_c)",
        "Результат/Ответ/Сводка/Итог и 4,7 из 19,2 МБ",
      ] }],
      checks: [{ label: "поле kb_category пустое", status: "not_run" }],
      limitations: [],
      materials: [
        { kind: "document", title: "Оценка шлака", ref: "note://" + note },
        { kind: "document", title: "Старая ссылка", ref: note },
        { kind: "task", title: "Карточка", ref: "task://" + note },
        { kind: "web", title: "Сайт", ref: "https://example.com" },
        { kind: "document", title: "Без адреса", ref: "" },
      ],
    } }]);
    expect(text).toContain("Снёс следы в `note_accesses` и `knowledge_index_jobs`.");
    expect(text).toContain("- Бэкап: `/tmp/taskflow.db.bak-20261111` и `~/.pi/agent/extensions`");
    expect(text).toContain("- Файл `hesitation-gate.ts`, уже в кавычках `kb_category`, ссылка [док](https://example.com/a_b_c)");
    expect(text).toContain("- Результат/Ответ/Сводка/Итог и 4,7 из 19,2 МБ");
    expect(text).toContain("- поле `kb_category` пустое — not_run");
    expect(text).toContain("- [Оценка шлака](note://" + note + ")");
    expect(text).toContain("- [Старая ссылка](note://" + note + ")");
    expect(text).toContain("- [Карточка](task://" + note + ")");
    expect(text).toContain("- [Сайт](https://example.com)");
    expect(text).toContain("- Без адреса");
    expect(text).not.toContain("• ");
  });
});
