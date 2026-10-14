// Нормализация ```widget-блоков в ответах ролей (владелец 02.10.2026:
// «виджет не разработан»).
//
// Каноническая схема, которую рисует клиент (iOS ChatWidgetView):
//   {"type":"metrics"|"progress"|"checklist"|"card"|"chart"|"weather", …}
// Тип обязателен; поля под каждый тип — в инструкции ролей
// (chat.wrapper в instructionDefaults.ts).
//
// С 14.10.2026 добавлены восемь новых типов (галерея компоновок,
// docs/2026-10-14-widget-gallery-layouts-and-types.md): status_board,
// calendar_grid, timeline, ladder, heatmap, compare, chain, bars_list.
// Восемь компоновок K1–K6 поверх старых шести — это правка клиента, здесь
// они проходят тем же путём, что и раньше: сервер знает тип и не трогает
// тело блока.
//
// ВАЖНО (факт, проверено тестом widgetNewTypesPreserved): тип, которого нет
// в CANONICAL_TYPES, нормализатор не «не знает» — он считает его старым
// форматом помощника владельца и ищет в корне ключи metrics/chart/checklists. Если
// новый тип содержит такой корень, имя типа теряется молча, блок уезжает в
// чужую схему, а клиент рисует «виджет не разработан». Поэтому новый тип
// обязан быть в CANONICAL_TYPES (сервер) и в SCHEMA валидатора помощника владельца
// (roles/secretary/skills/widget-renderer/scripts/validate_widget.py).
//
// Раньше роль могла отправить блок без `type` и с альтернативными
// именами полей (Помощник владельца использовал `metrics`/`chart`/`checklists`
// с `color` вместо `delta`+`trend`, `data:[{label,value,color}]` вместо
// `points:[{x,y}]`, `checked` вместо `done`). Клиент такого не знает и
// падает в «виджет не разработан». Сервер при сохранении ответа роли в
// чат приводит оба варианта к каноническому виду; неизвестный или
// битый JSON оставляем как есть — лучше показать как есть, чем сожрать
// ответ.
//
// Экспортируется:
//   - normalizeWidgetBlocks(text) — пройти по всем ```widget …``` в тексте
//   - canonicalizeWidget(json)   — привести один JSON-объект (или null,
//     если распознать не удалось)
//   - widgetTypeOf(json)         — определить «настоящий» тип виджета
//     (для превью в списке чатов)

import { NEW_WIDGET_TYPES } from "./widgetContract.js";

const WIDGET_BLOCK = /```widget[^\n]*\n([\s\S]*?)(?:```|$)/g;

const CANONICAL_TYPES = new Set([
  "metrics",
  "progress",
  "checklist",
  "card",
  "chart",
  "weather",
  // Восемь новых типов, 14.10.2026: имена берутся из того же каталога, из
  // которого собирается проза инструкции роли (lib/widgetContract.ts), чтобы
  // нормализатор и инструкция не могли разойтись. Контракт полей — раздел 5
  // документа галереи; клиент рисует их по реестру type → компонент.
  ...NEW_WIDGET_TYPES,
]);

/** Все типы, которые сервер считает каноническими. Инструкция ролей и тесты
 *  сверяются с этим списком; пополнять здесь — единственный способ добавить
 *  тип на сервере. */
export const CANONICAL_WIDGET_TYPES = [...CANONICAL_TYPES] as const;

/** Какой тип виджета описывает этот JSON, если узнаём. null — не похож на
 *  виджет или не удаётся привести к канону. */
export function widgetTypeOf(json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;

  // 1) Уже канонический — отдаём как есть.
  if (typeof obj.type === "string" && CANONICAL_TYPES.has(obj.type)) {
    return obj.type;
  }

  // 2) Помощник владельца-формат: один объект с metrics/chart/checklists.
  if (Array.isArray(obj.metrics) || obj.chart || Array.isArray(obj.checklists)) {
    if (Array.isArray(obj.metrics)) return "metrics";
    if (obj.chart) return "chart";
    if (Array.isArray(obj.checklists)) return "checklist";
  }

  return null;
}

/** Привести один виджет к канонической форме. Вернёт null, если это не
 *  виджет или привести нельзя (поле зовём «битый» — наверх передаём
 *  исходный текст блока). */
export function canonicalizeWidget(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = { ...(json as Record<string, unknown>) };

  // Уже канонический — не трогаем.
  if (typeof obj.type === "string" && CANONICAL_TYPES.has(obj.type)) {
    return obj;
  }

  // Помощник владельца-формат: один блок, тип выводим из того, что заполнено.
  // Если заполнено сразу несколько секций (metrics+chart+checklists) — это
  // композит; раскладываем в несколько виджетов через _composite, иначе
  // клиент iOS нарисует только первую секцию.
  const composite: Array<Record<string, unknown>> = [];
  if (Array.isArray(obj.metrics)) {
    composite.push(buildMetricsWidget(obj, obj.metrics));
    delete obj.metrics;
  }
  if (obj.chart && typeof obj.chart === "object") {
    composite.push(buildChartWidget(obj, obj.chart as Record<string, unknown>));
    delete obj.chart;
  }
  if (Array.isArray(obj.checklists)) {
    const checklists = obj.checklists as Array<Record<string, unknown>>;
    for (const c of checklists) {
      if (c && typeof c === "object") {
        const w = buildChecklistWidget(obj, c);
        if (w) composite.push(w);
      }
    }
    delete obj.checklists;
  }
  if (composite.length === 0) return null;
  if (composite.length === 1) return composite[0];
  return { _composite: composite };
}

function buildMetricsWidget(
  base: Record<string, unknown>,
  metrics: unknown,
): Record<string, unknown> {
  return {
    ...base,
    items: normalizeMetricsItems(metrics),
    type: "metrics",
  };
}

function buildChartWidget(
  base: Record<string, unknown>,
  chart: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...chart };
  if (typeof merged.kind !== "string" && typeof merged.type === "string") {
    merged.kind = merged.type;
  }
  delete merged.type;
  if (Array.isArray(merged.data)) {
    merged.points = normalizeChartPoints(merged.data);
    delete merged.data;
  }
  return { ...base, ...merged, type: "chart" };
}

function buildChecklistWidget(
  base: Record<string, unknown>,
  c: Record<string, unknown>,
): Record<string, unknown> | null {
  const normalized = normalizeChecklist(c);
  if (!normalized) return null;
  return { ...base, ...normalized, type: "checklist" };
}

function normalizeMetricsItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it === "object")
    .map((it) => {
      const o = { ...(it as Record<string, unknown>) };
      // value остаётся как есть; color → не часть канона, но клиенту
      // не мешает — оставляем в payload на случай, если iOS начнёт
      // его уважать; delta/trend добавляем из value, если их нет.
      if (o.delta == null && typeof o.value !== "undefined") {
        o.delta = typeof o.value === "number" ? String(o.value) : String(o.value ?? "");
      }
      if (o.trend == null) o.trend = "flat";
      return o;
    });
}

function normalizeChartPoints(data: unknown): unknown[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      const o = p as Record<string, unknown>;
      const point: Record<string, unknown> = {};
      point.x = o.label ?? o.x;
      point.y = o.value ?? o.y;
      if (o.color != null) point.color = o.color;
      return point;
    });
}

function normalizeChecklist(c: Record<string, unknown>): Record<string, unknown> | null {
  if (!c || typeof c !== "object") return null;
  const out: Record<string, unknown> = { ...c };
  if (Array.isArray(out.items)) {
    out.items = (out.items as Array<Record<string, unknown>>)
      .filter((it) => it && typeof it === "object")
      .map((it) => {
        const i = { ...it };
        if (typeof i.checked === "boolean" && typeof i.done !== "boolean") {
          i.done = i.checked;
        }
        delete i.checked;
        return i;
      });
  }
  return out;
}

/** Пройти по всем ```widget-блокам в тексте и заменить их JSON на
 *  канонический. Блоки, которые не удаётся распознать, остаются как
 *  есть — чтобы не сожрать ответ роли. */
export function normalizeWidgetBlocks(text: string): string {
  return text.replace(WIDGET_BLOCK, (block, rawJson: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson.trim());
    } catch {
      return block; // битый JSON — не трогаем
    }

    const canonical = canonicalizeWidget(parsed);
    if (!canonical) return block;

    // Композит из нескольких секций — раскладываем в несколько блоков.
    if (Array.isArray(canonical._composite)) {
      const parts = canonical._composite as Array<Record<string, unknown>>;
      return parts
        .map((p) => "```widget\n" + JSON.stringify(p, null, 2) + "\n```")
        .join("\n");
    }

    return "```widget\n" + JSON.stringify(canonical, null, 2) + "\n```";
  });
}
