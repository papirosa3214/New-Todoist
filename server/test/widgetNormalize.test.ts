// Нормализация ```widget-блоков (владелец 02.10.2026: «виджет не разработан»).
// Проверяем, что схема Секретаря (без type, checklists/check вместо
// checklist/done, data/label вместо points/x) приводится к канону, и что
// канонический JSON не трогается.
import { describe, expect, it } from "vitest";
import {
  CANONICAL_WIDGET_TYPES,
  canonicalizeWidget,
  normalizeWidgetBlocks,
  widgetTypeOf,
} from "../src/lib/widgetNormalize.js";

// Канонические примеры восьми новых типов — из документа галереи
// docs/2026-10-14-widget-gallery-layouts-and-types.md, раздел 5.
const NEW_TYPE_SAMPLES: Record<string, Record<string, unknown>> = {
  status_board: {
    type: "status_board",
    title: "Сводка по задачам · 14.10",
    note: "из 58 всего",
    groups: [
      { label: "Завершено", value: 21, share: 36, tone: "done", icon: "check" },
      { label: "В работе", value: 12, share: 21, tone: "inprog", icon: "activity" },
      { label: "Просрочено", value: 7, share: 12, tone: "over", icon: "calendarSmall" },
    ],
  },
  calendar_grid: {
    type: "calendar_grid",
    title: "Дедлайны · октябрь",
    month: "2026-10",
    first_weekday: 1,
    today: "2026-10-14",
    cells: [
      { date: "2026-10-03", count: 2, tone: "done" },
      { date: "2026-10-14", count: 1, tone: "inprog" },
      { date: "2026-10-17", count: 3, tone: "over" },
    ],
  },
  timeline: {
    type: "timeline",
    title: "Горизонт дедлайнов",
    now: "2026-10-14",
    past: [{ label: "Релиз v2.3", date: "2026-10-01", state: "done" }],
    items: [
      { date: "2026-10-17", label: "Счёт поставщику", state: "over", meta: "−3 дня" },
      { date: "2026-10-24", label: "Релиз v2.4", state: "inprog" },
      { date: "2026-11-02", label: "Отчёт по кварталу", state: "future" },
    ],
  },
  ladder: {
    type: "ladder",
    title: "Релиз v2.4",
    overall: 62,
    steps: [
      { label: "Дизайн", value: 100, state: "done", note: "готово 12.10" },
      { label: "Сервер", value: 65, state: "inprog", note: "2 бага" },
      { label: "Клиент", value: 20, state: "free", note: "ждёт контракта" },
    ],
  },
  heatmap: {
    type: "heatmap",
    title: "Активность · 12 недель",
    weeks: 12,
    first_weekday: 1,
    max: 9,
    unit: "задач",
    cells: [
      { date: "2026-10-12", value: 7 },
      { date: "2026-10-13", value: 2 },
      { date: "2026-10-14", value: 9 },
    ],
  },
  compare: {
    type: "compare",
    title: "Наушники · где дешевле",
    subject: "Sony WH-1000XM5",
    unit: "₽",
    left: { label: "DNS", value: 29490, link: "https://dns.example/p/1" },
    right: { label: "OZON", value: 38990 },
    verdict: "Дешевле в DNS на 9 500 ₽",
  },
  chain: {
    type: "chain",
    title: "Поездка · готовность",
    summary: "3 из 5 готово",
    links: [
      { label: "Билеты", state: "done" },
      { label: "Отель", state: "done" },
      { label: "Виза", state: "block", meta: "нужен паспорт" },
      { label: "Вещи", state: "inprog" },
      { label: "Выезд", state: "future" },
    ],
  },
  bars_list: {
    type: "bars_list",
    title: "Просрочки по проектам",
    unit: "задач",
    note: "на 14:32",
    items: [
      { label: "TaskFlow", value: 3, max: 12, tone: "over", meta: "старейшая −11 дней" },
      { label: "Финансы", value: 1, max: 8, tone: "over" },
      { label: "Новый год", value: 1, max: 14, tone: "inprog" },
    ],
  },
};

const OLD_TYPES = ["metrics", "progress", "checklist", "card", "chart", "weather"];

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

  // Галерея компоновок, 14.10.2026: восемь новых типов плюс шесть старых.
  describe("восемь новых типов", () => {
    it("все восемь объявлены каноническими", () => {
      for (const type of Object.keys(NEW_TYPE_SAMPLES)) {
        expect(CANONICAL_WIDGET_TYPES).toContain(type);
        expect(widgetTypeOf(NEW_TYPE_SAMPLES[type])).toBe(type);
      }
      // Шесть старых на месте — регресс не потерян.
      for (const type of OLD_TYPES) {
        expect(CANONICAL_WIDGET_TYPES).toContain(type);
      }
      expect(CANONICAL_WIDGET_TYPES).toHaveLength(14);
    });

    it("каждый новый тип проходит насквозь байт в байт", () => {
      for (const [type, sample] of Object.entries(NEW_TYPE_SAMPLES)) {
        expect(canonicalizeWidget(sample)).toEqual(sample);
        const text = "```widget\n" + JSON.stringify(sample) + "\n```";
        const out = normalizeWidgetBlocks(text);
        const json = out.replace(/^```widget\n/, "").replace(/\n```$/, "");
        expect(JSON.parse(json)).toEqual(sample);
      }
    });

    it("незарегистрированный тип с корневым chart/metrics/checklists теряет имя типа — это ловушка", () => {
      // Ловушка касается только имён, которых нет в CANONICAL_TYPES:
      // нормализатор считает такой блок старым форматом секретаря и ищет
      // в корне metrics/chart/checklists. Пока это так, регистрация типа на
      // сервере — обязательный шаг, а не украшение.
      const heatCells = canonicalizeWidget({ type: "heat_cells", chart: { kind: "bar", points: [] } });
      expect(heatCells).toMatchObject({ type: "chart" });
      const stepsLadder = canonicalizeWidget({ type: "steps_ladder", metrics: [{ label: "a", value: 1 }] });
      expect(stepsLadder).toMatchObject({ type: "metrics" });
      const unknown = canonicalizeWidget({
        type: "steps_ladder",
        checklists: [{ title: "a", items: [{ text: "x", done: true }] }],
      });
      expect(unknown).toMatchObject({ type: "checklist" });
    });

    it("зарегистрированный тип с лишним корневым ключем не переписывается", () => {
      // Обратная сторона той же правки: раз heatmap/ladder/chain в списке,
      // нормализатор отдаёт блок как есть и лишний корень остаётся в теле.
      // Это безопаснее потери типа: клиент рисует heatmap, а неизвестный
      // ключ игнорирует. Отслеживаем поведение явно — перепишут
      // нормализатор, тест об этом скажет.
      const withChart = canonicalizeWidget({ type: "heatmap", chart: { kind: "bar", points: [] } });
      expect(withChart).toMatchObject({ type: "heatmap" });
      const withMetrics = canonicalizeWidget({ type: "ladder", metrics: [{ label: "a", value: 1 }] });
      expect(withMetrics).toMatchObject({ type: "ladder" });
    });

    it("восемь компоновок поверх старых типов — обычные канонические блоки", () => {
      // K1 metrics с тоном и иконкой, K2 checklist со строкой статуса и
      // прогрессом, K3 chart bar → горизонтальные полосы, K4 progress с вехой,
      // K5 card с лентой статуса, K6 metrics одной лентой. Это правки клиента:
      // сервер такие поля не знает и не должен их выбрасывать.
      const k1 = {
        type: "metrics",
        title: "Активность ролей · неделя",
        tone: "categorical",
        items: [
          { label: "Разработчик", value: "18", icon: "bot", tone: "blue", delta: "+4", trend: "up" },
        ],
      };
      const k2 = {
        type: "checklist",
        title: "Просрочки",
        items: [
          { text: "Счёт поставщику", done: false, state: "over", overdue_days: 3 },
          { text: "Оплатить подписку", done: false, state: "free", progress: 40 },
        ],
      };
      const k6 = {
        type: "metrics",
        title: "Неделя",
        layout: "ribbon",
        items: [{ label: "Задач", value: "12", delta: "+3", trend: "up" }],
      };
      for (const block of [k1, k2, k6]) {
        expect(canonicalizeWidget(block)).toEqual(block);
      }
    });
  });
});
