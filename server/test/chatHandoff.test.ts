import { describe, expect, it } from "vitest";
import { reportSections, HANDOFF_SECTIONS } from "../src/lib/chatHandoff.js";

describe("Сдача этапа в чате: выжимка отчёта", () => {
  it("берёт только Результат и Что сделано, в исходном порядке", () => {
    const md = "## Результат\n\nАрхив работает.\n\n## Что сделано\n\n- Перенос\n- Восстановление\n\n## Проверки\n\nТри задачи.\n\n## Материалы\n\nКоммит.";
    expect(reportSections(md, HANDOFF_SECTIONS)).toBe("## Результат\n\nАрхив работает.\n\n## Что сделано\n\n- Перенос\n- Восстановление");
  });
  it("без нужных разделов — пусто", () => {
    expect(reportSections("Просто текст\n\n## Проверки\n\nок", HANDOFF_SECTIONS)).toBe("");
  });
});
