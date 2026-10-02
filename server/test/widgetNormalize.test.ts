// Нормализация ```widget-блоков (владелец 02.10.2026: «виджет не разработан»).
// Проверяем, что схема Секретаря (без type, checklists/check вместо
// checklist/done, data/label вместо points/x) приводится к канону, и что
// канонический JSON не трогается.
import { describe, expect, it } from "vitest";
import {
  canonicalizeWidget,
  normalizeWidgetBlocks,
  widgetTypeOf,
} from "../src/lib/widgetNormalize.js";

describe("widgetNormalize", () => {
  describe("widgetTypeOf", () => {
    it("канонический metrics", () => {
      expect(widgetTypeOf({ type: "metrics", items: [] })).toBe("metrics");
    });
    it("секретарский формат с metrics → metrics", () => {
      expect(widgetTypeOf({ title: "x", metrics: [] })).toBe("metrics");
    });
    it("секретарский формат с chart → chart", () => {
      expect(widgetTypeOf({ chart: { type: "bar", data: [] } })).toBe("chart");
    });
    it("секретарский формат с checklists → checklist", () => {
      expect(widgetTypeOf({ checklists: [{ title: "a", items: [] }] })).toBe(
        "checklist",
      );
    });
    it("не виджет — null", () => {
      expect(widgetTypeOf({ foo: "bar" })).toBeNull();
      expect(widgetTypeOf(null)).toBeNull();
      expect(widgetTypeOf("string")).toBeNull();
    });
  });

  describe("canonicalizeWidget", () => {
    it("канонический metrics — без изменений", () => {
      const c = { type: "metrics", title: "Итоги", items: [{ label: "Задач", value: 12 }] };
      expect(canonicalizeWidget(c)).toEqual(c);
    });

    it("секретарь-формат metrics с color", () => {
      const in_ = {
        title: "Сводка",
        metrics: [
          { label: "В работе", value: 7, color: "red" },
          { label: "Готово", value: 12, color: "green" },
        ],
      };
      const out = canonicalizeWidget(in_);
      expect(out).toBeTruthy();
      expect(out!.type).toBe("metrics");
      expect(out!.title).toBe("Сводка");
      expect(Array.isArray(out!.items)).toBe(true);
      const items = out!.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ label: "В работе", value: 7, color: "red" });
      // delta и trend подставлены по умолчанию, чтобы клиент с каноном
      // не падал в дефолт.
      expect(typeof items[0].delta).toBe("string");
      expect(items[0].trend).toBe("flat");
    });

    it("секретарь-формат chart: type→kind, data→points", () => {
      const in_ = {
        title: "По неделям",
        chart: {
          type: "bar",
          data: [
            { label: "Пн", value: 3, color: "blue" },
            { label: "Вт", value: 5 },
          ],
        },
      };
      const out = canonicalizeWidget(in_);
      expect(out).toBeTruthy();
      expect(out!.type).toBe("chart");
      expect(out!.kind).toBe("bar");
      expect(Array.isArray(out!.points)).toBe(true);
      const points = out!.points as Array<Record<string, unknown>>;
      expect(points[0]).toEqual({ x: "Пн", y: 3, color: "blue" });
      expect(points[1]).toEqual({ x: "Вт", y: 5 });
    });

    it("секретарь-формат checklist (ед.): checklists → checklist, checked → done", () => {
      const in_ = {
        title: "Главное",
        checklists: [
          {
            title: "План",
            items: [
              { text: "Сделать", checked: true },
              { text: "Проверить", checked: false },
            ],
          },
        ],
      };
      const out = canonicalizeWidget(in_);
      // Только checklists без metrics/chart — один виджет checklist.
      expect(out).toBeTruthy();
      expect(out!.type).toBe("checklist");
      expect(out!.title).toBe("План"); // подняли title чек-листа
      const items = out!.items as Array<Record<string, unknown>>;
      expect(items[0]).toEqual({ text: "Сделать", done: true });
      expect(items[1]).toEqual({ text: "Проверить", done: false });
    });

    it("секретарь-формат checklists (мн.): композит из нескольких checklist", () => {
      const in_ = {
        title: "Сводка",
        checklists: [
          { title: "A", items: [{ text: "a1", checked: false }] },
          { title: "B", items: [{ text: "b1", checked: true }] },
        ],
      };
      const out = canonicalizeWidget(in_);
      expect(out).toBeTruthy();
      expect(Array.isArray(out!._composite)).toBe(true);
      const parts = out!._composite as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ type: "checklist", title: "A" });
      expect(parts[1]).toMatchObject({ type: "checklist", title: "B" });
    });

    it("композит: metrics+chart+checklists → 3 виджета", () => {
      const in_ = {
        title: "Сводка",
        metrics: [{ label: "В работе", value: 5 }],
        chart: { type: "bar", data: [{ label: "Пн", value: 3 }] },
        checklists: [{ title: "План", items: [{ text: "X", checked: true }] }],
      };
      const out = canonicalizeWidget(in_);
      expect(Array.isArray(out!._composite)).toBe(true);
      const parts = out!._composite as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(3);
      expect(parts.map((p) => p.type)).toEqual([
        "metrics",
        "chart",
        "checklist",
      ]);
      expect(parts[0]).toMatchObject({ title: "Сводка", type: "metrics" });
      expect(parts[1]).toMatchObject({ type: "chart", kind: "bar" });
      expect(parts[2]).toMatchObject({ type: "checklist", title: "План" });
    });

    it("weather не трогаем", () => {
      const w = { type: "weather", location: "Москва", temperature: 10 };
      expect(canonicalizeWidget(w)).toEqual(w);
    });

    it("неизвестная форма → null", () => {
      expect(canonicalizeWidget({ foo: "bar" })).toBeNull();
      expect(canonicalizeWidget("string")).toBeNull();
    });
  });

  describe("normalizeWidgetBlocks", () => {
    it("приводит секретарь-формат в тексте", () => {
      const text = [
        "Вот сводка:",
        "```widget",
        JSON.stringify({
          title: "Сводка задач",
          metrics: [{ label: "В работе", value: 5, color: "red" }],
          chart: { type: "bar", data: [{ label: "Пн", value: 3 }] },
          checklists: [{ title: "Что сделать", items: [{ text: "X", checked: true }] }],
        }),
        "```",
        "Готово.",
      ].join("\n");

      const out = normalizeWidgetBlocks(text);
      // Должно стать три виджета: metrics, chart, checklist.
      const matches = [...out.matchAll(/```widget\n([\s\S]*?)\n```/g)];
      expect(matches).toHaveLength(3);
      const metrics = JSON.parse(matches[0][1]);
      const chart = JSON.parse(matches[1][1]);
      const checklist = JSON.parse(matches[2][1]);
      expect(metrics.type).toBe("metrics");
      expect(metrics.items[0].label).toBe("В работе");
      expect(chart.type).toBe("chart");
      expect(chart.kind).toBe("bar");
      expect(chart.points[0]).toEqual({ x: "Пн", y: 3 });
      expect(checklist.type).toBe("checklist");
      expect(checklist.title).toBe("Что сделать");
      expect(checklist.items[0]).toEqual({ text: "X", done: true });
    });

    it("канонический блок оставляет как есть", () => {
      const text = "```widget\n{\"type\":\"metrics\",\"items\":[]}\n```";
      expect(normalizeWidgetBlocks(text)).toContain('"type": "metrics"');
    });

    it("битый JSON не трогает", () => {
      const text = "```widget\n{это не json}\n```";
      expect(normalizeWidgetBlocks(text)).toBe(text);
    });

    it("weather проходит насквозь", () => {
      const text = '```widget\n{"type":"weather","temperature":5}\n```';
      const out = normalizeWidgetBlocks(text);
      expect(out).toContain('"temperature": 5');
      expect(out).toContain('"type": "weather"');
    });
  });
});
