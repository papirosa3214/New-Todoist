// Владелец 28.10.2026: «Почему раздел быстрых ответов перестал нормально
// отрисовываться? Он просто как текст идёт». Причина — строка `БЫСТРО:`
// в отчёте роли лежит внутри `report.sections`, а разбор смотрел только
// блоки `type: "text"`. Теперь она вынимается из отчёта так же, как из текста.
import { expect, it } from "vitest";
import { extractQuickReplies, pullQuickReplies } from "../src/lib/quickReplies.js";

it("обычный блок текста: строка убирается, варианты разобраны", () => {
  const { output, replies } = pullQuickReplies([{ type: "text", text: "Вопрос?\nБЫСТРО: Да | Нет" }]);
  expect(replies).toEqual(["Да", "Нет"]);
  expect((output[0] as { text: string }).text).toBe("Вопрос?");
});

it("БЫСТРО внутри отчёта: кнопки есть, строка из «Ограничений» вырезана", () => {
  const { output, replies } = pullQuickReplies([
    { type: "text", text: "Короткий итог." },
    {
      type: "report",
      report_kind: "final",
      sections: {
        result: [{ type: "text", text: "Сделано." }],
        work: [],
        checks: [],
        limitations: [{ type: "text", text: "Сборка не гонялась.\n\nБЫСТРО: Да | Нет | Позже" }],
        materials: [],
      },
    },
  ]);
  expect(replies).toEqual(["Да", "Нет", "Позже"]);
  const report = output[1] as { sections: { limitations: { text: string }[] } };
  expect(report.sections.limitations[0].text).toBe("Сборка не гонялась.");
  expect(JSON.stringify(output)).not.toContain("БЫСТРО:");
});

it("пустой после вырезания текстовый блок исчезает, а не висит пустой строкой", () => {
  const { output } = pullQuickReplies([
    { type: "report", report_kind: "final", sections: { result: [], work: [], checks: [], limitations: [], materials: [] } },
    { type: "text", text: "БЫСТРО: Один | Два" },
  ]);
  expect(output).toHaveLength(1);
});

it("ответ без развилки не получает кнопок", () => {
  expect(pullQuickReplies([{ type: "text", text: "Просто текст." }]).replies).toBeNull();
  expect(extractQuickReplies("Просто текст.").replies).toBeNull();
});
