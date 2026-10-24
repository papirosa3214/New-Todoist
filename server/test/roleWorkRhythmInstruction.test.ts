import { describe, expect, it } from "vitest";
import { INSTRUCTION_DEFAULTS } from "../src/runtime/instructionDefaults.js";

// Владелец 24.10.2026: «какой тебе нужен инструмент, чтобы ты не путался в
// своих рассуждениях и задавал, если что, мне вопрос с вариантами ответов».
// Ответ сделан инструкцией: чек-лист — до работы и по ходу, вопрос владельцу —
// развилка последней строкой ответа, а вопросы самому себе («что же хотел
// владелец») запрещены. Правило должно быть в общей инструкции ролей, а не
// в памяти одной роли, и обязано быть в каждом режиме: чат, старт задачи,
// узел плана, продолжение.

describe("общая инструкция ролей: ритм работы", () => {
  const modes = ["chat.wrapper", "chat.followup", "task.start", "task.plan"] as const;

  it("во всех режимах есть правило про чек-лист до работы и по ходу", () => {
    for (const mode of modes) {
      const text = String(INSTRUCTION_DEFAULTS[mode]);
      expect(text, mode).toContain("РИТМ РАБОТЫ РОЛИ");
      expect(text, mode).toContain("ЧЕК-ЛИСТ — ДО РАБОТЫ И ПО ХОДУ");
      expect(text, mode).toContain("taskflow_work_plan");
      expect(text, mode).toMatch(/in_progress[\s\S]*done/);
    }
  });

  it("во всех режимах вопрос владельцу оформлен развилкой, а не остановкой", () => {
    for (const mode of modes) {
      const text = String(INSTRUCTION_DEFAULTS[mode]);
      expect(text, mode).toContain("ВОПРОС ВЛАДЕЛЬЦУ — РАЗВИЛКА, А НЕ ОСТАНОВКА");
      expect(text, mode).toContain("БЫСТРО: вариант1 | вариант2 | вариант3");
      expect(text, mode).toMatch(/делай сразу|делай по умолчанию/);
    }
  });

  it("запрещён вопрос самому себе", () => {
    for (const mode of modes) {
      const text = String(INSTRUCTION_DEFAULTS[mode]);
      expect(text, mode).toContain("НЕ СПРАШИВАЙ СЕБЯ");
      expect(text, mode).toContain("Что же хотел владелец");
    }
  });

  it("во всех режимах требуется короткий прогресс в чате, а не молчание", () => {
    for (const mode of modes) {
      const text = String(INSTRUCTION_DEFAULTS[mode]);
      expect(text, mode).toContain("ПОКАЖИ ХОД РАБОТЫ В ЧАТЕ");
      expect(text, mode).toMatch(/одно короткое сообщение/);
      expect(text, mode).toMatch(/Молчание и рассуждения вслух/);
    }
  });

  it("правило про развилку есть и в чате, где владелец ждёт кнопки", () => {
    const wrapper = String(INSTRUCTION_DEFAULTS["chat.wrapper"]);
    expect(wrapper).toContain("БЫСТРЫЕ ОТВЕТЫ ПОСЛЕДНЕЙ СТРОКОЙ");
    expect(wrapper.indexOf("БЫСТРЫЕ ОТВЕТЫ")).toBeLessThan(
      wrapper.indexOf("РИТМ РАБОТЫ РОЛИ"),
    );
  });
});
