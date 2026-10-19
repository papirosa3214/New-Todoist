// Формат ответов ролей (карточка cea8d997) — проверки по критериям приёмки.
//
// Критерии карточки:
//   - на каждый тип блока корректный проходит, битый отклоняется с текстом
//     ошибки и образцом;
//   - текстовая таблица превращается в блок table;
//   - ряд «название: число» превращается в metrics, числа по датам — в chart;
//   - тонкие случаи остаются на модели: автозамена их не трогает;
//   - сторож пробует формат и умеет сказать, что сломалось.
import { describe, expect, it } from "vitest";
import {
  ALL_WIDGET_TYPE_SPECS,
  ALL_WIDGET_TYPES,
  NEW_WIDGET_TYPES,
  widgetExample,
  widgetTypeLines,
} from "../src/lib/widgetContract.js";
import { applyRoleFormat, checkRoleBlocks, roleFormatRefusal } from "../src/lib/roleFormat.js";
import { checkRoleFormat } from "../src/lib/roleFormatWatcher.js";

function block(type: string, json: unknown): string {
  return "```widget\n" + JSON.stringify(json) + "\n```";
}

describe("каталог формата — единственный источник", () => {
  it("в каталоге шесть базовых и восемь новых типов, без дублей", () => {
    expect(ALL_WIDGET_TYPES).toHaveLength(15);
    expect(new Set(ALL_WIDGET_TYPES).size).toBe(15);
    expect(ALL_WIDGET_TYPES).toEqual(expect.arrayContaining([...NEW_WIDGET_TYPES]));
    expect(ALL_WIDGET_TYPES).toEqual(expect.arrayContaining(["table", "metrics", "progress", "checklist", "card", "chart", "weather"]));
  });

  it("каждому типу каталога соответствует ровно одна строка инструкции", () => {
    const lines = widgetTypeLines();
    expect(lines).toHaveLength(ALL_WIDGET_TYPE_SPECS.length);
    for (const spec of ALL_WIDGET_TYPE_SPECS) {
      expect(lines.some((line) => line.startsWith(`${spec.type} (`)), `нет строки для ${spec.type}`).toBe(true);
    }
  });
});

describe("на каждый тип блока: корректный проходит, битый отклоняется", () => {
  it.each(ALL_WIDGET_TYPE_SPECS.map((spec) => [spec.type] as const))(
    "корректный пример типа %s проходит проверку",
    (type) => {
      const text = block(type, JSON.parse(widgetExample(type)));
      expect(checkRoleBlocks(text)).toEqual([]);
      expect(applyRoleFormat(text).ok).toBe(true);
    },
  );

  it.each(ALL_WIDGET_TYPE_SPECS.map((spec) => [spec.type] as const))(
    "битый блок типа %s отклоняется с текстом ошибки и образцом",
    (type) => {
      const spec = ALL_WIDGET_TYPE_SPECS.find((s) => s.type === type)!;
      const good = JSON.parse(widgetExample(type)) as Record<string, unknown>;
      const memberField = spec.member.fields.split("/")[0];
      const broken: Record<string, unknown> = { ...good };
      const missingRoot = spec.required.filter((field) => field !== memberField);
      if (missingRoot.length) {
        // Убираем обязательное поле блока.
        delete broken[missingRoot[0]];
      } else if (spec.rowsAreArrays) {
        broken.rows = [["только одна ячейка"]];
      } else if (spec.member.repeated) {
        // Убираем обязательное поле первого элемента данных.
        const element = (broken[memberField] as Record<string, unknown>[])[0];
        delete element[spec.member.required[0]];
      } else {
        // Объект-сторона (compare): убираем обязательное поле стороны.
        delete (broken[memberField] as Record<string, unknown>)[spec.member.required[0]];
      }
      const result = applyRoleFormat(block(type, broken));
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems[0].message).toMatch(/./);
      expect(result.problems[0].sample).toContain("```widget");
      expect(roleFormatRefusal(result)).toContain("Образец правильного блока");
    },
  );

  it("битый JSON отклоняется и не портит текст вокруг", () => {
    const text = "Готово.\n\n```widget\n{это не json}\n```\n\nПроверил на копии.";
    const result = applyRoleFormat(text);
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("битый JSON");
    expect(result.text).toBe(text);
  });

  it("неизвестный тип отклоняется с перечнем допустимых", () => {
    const result = applyRoleFormat(block("не_существует", { type: "не_существует" }));
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("неизвестный тип");
    expect(result.problems[0].message).toContain("heatmap");
  });

  it("лишнее поле внутри элемента отклоняется — регресс D1 (max в ячейке heatmap)", () => {
    const result = applyRoleFormat(
      block("heatmap", { type: "heatmap", weeks: 12, cells: [{ date: "2026-10-14", value: 7, max: 9 }], max: 9 }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems[0].path).toBe("widget[0].cells[0].max");
  });

  it("max обязателен в корне heatmap", () => {
    const result = applyRoleFormat(
      block("heatmap", { type: "heatmap", weeks: 12, cells: [{ date: "2026-10-14", value: 7 }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.path === "widget[0].max")).toBe(true);
  });

  it("tone вне списка отклоняется с перечнем значений", () => {
    const result = applyRoleFormat(
      block("status_board", { type: "status_board", groups: [{ label: "Готово", value: 1, tone: "зелёный" }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("не в списке");
  });

  it("строка таблицы не по числу колонок отклоняется", () => {
    const result = applyRoleFormat(
      block("table", { type: "table", columns: ["А", "Б"], rows: [["только одна"]] }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("колонку");
  });
});

describe("автозамена очевидного", () => {
  it("текстовая таблица превращается в блок table", () => {
    const text = [
      "Проверки:",
      "",
      "| Проверка | Результат |",
      "| --- | --- |",
      "| tsc | чисто |",
      "| тесты | 12/12 |",
    ].join("\n");
    const result = applyRoleFormat(text);
    expect(result.ok).toBe(true);
    expect(result.autoReplaced).toContain("table");
    expect(result.text).toContain('"type": "table"');
    expect(result.text).toContain('"Проверка"');
    expect(result.text).not.toContain("| --- |");
  });

  it("таблица сохраняет текст вокруг себя", () => {
    const text = ["Итог:", "", "| А | Б |", "| --- | --- |", "| 1 | 2 |", "", "Дальше prose."].join("\n");
    const result = applyRoleFormat(text);
    expect(result.text).toContain("Итог:");
    expect(result.text).toContain("Дальше prose.");
  });

  it("две строки чисел — не блок: подтверждения недостаточно", () => {
    const text = ["Задач: 12", "Дефектов: 0"].join("\n");
    const result = applyRoleFormat(text);
    expect(result.autoReplaced).toEqual([]);
    expect(result.text).toBe(text);
  });

  it("ряд «название: число» превращается в metrics", () => {
    const result = applyRoleFormat(["Задач: 12", "Проверок: 7", "Дефектов: 0"].join("\n"));
    expect(result.ok).toBe(true);
    expect(result.autoReplaced).toContain("metrics");
    expect(result.text).toContain('"label": "Задач"');
  });

  it("числа по датам превращаются в chart с видом line", () => {
    const result = applyRoleFormat(["2026-10-01: 4", "2026-10-02: 9", "2026-10-03: 6"].join("\n"));
    expect(result.ok).toBe(true);
    expect(result.autoReplaced).toContain("chart");
    expect(result.text).toContain('"kind": "line"');
    expect(result.text).toContain('"y": 9');
  });

  it("числа по категориям превращаются в chart с видом bar", () => {
    const result = applyRoleFormat(["пн: 4", "вт: 9", "ср: 6"].join("\n"));
    expect(result.autoReplaced).toContain("chart");
    expect(result.text).toContain('"kind": "bar"');
  });

  it("тонкий случай остаётся текстом: числа вперемешку с выводами", () => {
    const text = [
      "Работы больше недели: 4",
      "Проверок: 7",
      "Дефектов: 0",
      "Итог: почти готово.",
    ].join("\n");
    const result = applyRoleFormat(text);
    expect(result.autoReplaced).toEqual([]);
    expect(result.text).toBe(text);
  });

  it("обычный текст без чисел не меняется вовсе", () => {
    const text = "Готово. Проверил на отдельной копии: тесты зелёные.";
    const result = applyRoleFormat(text);
    expect(result.text).toBe(text);
    expect(result.autoReplaced).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("старый формат помощника владельца приводится к канону и проходит проверку", () => {
    const text = [
      "```widget",
      JSON.stringify({
        title: "Сводка",
        metrics: [{ label: "В работе", value: 5 }],
        chart: { type: "bar", data: [{ label: "Пн", value: 3 }] },
        checklists: [{ title: "Что сделать", items: [{ text: "X", checked: true }] }],
      }),
      "```",
    ].join("\n");
    const result = applyRoleFormat(text);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('"type": "metrics"');
    expect(result.text).toContain('"type": "chart"');
    expect(result.text).toContain('"type": "checklist"');
  });
});

describe("сторож формата", () => {
  it("живой прибор: все типы, автозамены и отказ с образцом проходят", () => {
    const result = checkRoleFormat();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});