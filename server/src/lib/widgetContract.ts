// Контракт полей восьми новых типов виджетов (галерея компоновок карточки
// 3e27dafe, 14.10.2026). Это единственный список полей на сервере: из него
// собираются и строки инструкции роли, и перечень типов для нормализатора и
// фиче-флага. Раньше эти три вещи жили отдельно, и они разошлись.
//
// Откуда поля:
//   - документ галереи docs/2026-10-14-widget-gallery-layouts-and-types.md,
//     раздел 5 («Восемь новых типов») — по одному типу на подраздел;
//   - словарь SCHEMA валидатора секретаря
//     (roles/secretary/skills/widget-renderer/scripts/validate_widget.py,
//     файл вне git) — его блок принимает и отвергает.
//
// Почему каталог в git, а не только словарь валидатора: словарь лежит вне
// git и не поедет со сборкой, а прозу инструкции читает роль. Расхождение
// между ними уже было — дефект D1: heatmap описывался как
// «weeks, cells: date, value, max», то есть max уходил внутрь ячеек, а
// max обязан быть в корне блока. Роль, собравшая блок по инструкции, получала
// от своего же валидатора две ошибки, а клиент не получал шкалу плотности.
// Теперь проза собирается отсюда, а тест проверяет, что собранная строка
// разбирается ровно в поля этого каталога.

export interface NewWidgetMemberSpec {
  /** Имя поля (массив) или полей через «/» (объекты compare). */
  fields: string;
  /** Поля элемента: обязательные и необязательные. */
  required: readonly string[];
  optional: readonly string[];
  /** true — поле повторяется (массив), false — объект-сторона. */
  repeated: boolean;
}

export interface NewWidgetTypeSpec {
  type: string;
  /** Поля блока кроме type: обязательные. */
  required: readonly string[];
  /** Необязательные поля блока. */
  optional: readonly string[];
  /** Элементы блока: массив (cells/items/links/…) или стороны compare. */
  member: NewWidgetMemberSpec;
  /** Когда роль берёт этот тип — эта часть строки инструкции. */
  hint: string;
}

/** Смысловые тона элемента: визуальный язык §1.4 и словарь валидатора TONES. */
export const NEW_WIDGET_TONES = [
  "over",
  "block",
  "inprog",
  "review",
  "done",
  "free",
  "noasg",
  "future",
] as const;

/** Состояния элемента: те же тона, но без noasg — у элемента нет «не назначено». */
export const NEW_WIDGET_STATES = [
  "done",
  "inprog",
  "over",
  "future",
  "block",
  "review",
  "free",
] as const;

export const NEW_WIDGET_TYPE_SPECS: readonly NewWidgetTypeSpec[] = [
  {
    type: "status_board",
    required: ["groups"],
    optional: ["title", "note"],
    member: {
      fields: "groups",
      required: ["label", "value", "tone"],
      optional: ["share", "icon"],
      repeated: true,
    },
    hint: "сводка по статусам",
  },
  {
    type: "bars_list",
    required: ["items"],
    optional: ["title", "unit", "note"],
    member: {
      fields: "items",
      required: ["label", "value", "max", "tone"],
      optional: ["meta"],
      repeated: true,
    },
    hint: "список, где у строки своя доля",
  },
  {
    type: "chain",
    required: ["links"],
    optional: ["title", "summary"],
    member: {
      fields: "links",
      required: ["label", "state"],
      optional: ["meta"],
      repeated: true,
    },
    hint: "цепочка шагов, где видно, где остановка",
  },
  {
    type: "ladder",
    required: ["steps"],
    optional: ["title", "overall"],
    member: {
      fields: "steps",
      required: ["label", "value", "state"],
      optional: ["note"],
      repeated: true,
    },
    hint: "этапы разной величины",
  },
  {
    type: "timeline",
    required: ["items"],
    optional: ["title", "now", "past"],
    member: {
      fields: "items",
      required: ["date", "label", "state"],
      optional: ["meta"],
      repeated: true,
    },
    hint: "что за чем и когда",
  },
  {
    type: "calendar_grid",
    required: ["month", "cells"],
    optional: ["title", "first_weekday", "today"],
    member: {
      fields: "cells",
      required: ["date", "count"],
      optional: ["tone"],
      repeated: true,
    },
    hint: "что в какой день",
  },
  {
    type: "heatmap",
    // max — поле блока, а не ячейки: это шкала плотности, по ней клиент
    // красит пять ступеней заливки. В ячейке только дата и значение.
    required: ["weeks", "cells", "max"],
    optional: ["title", "first_weekday", "unit"],
    member: {
      fields: "cells",
      required: ["date", "value"],
      optional: [],
      repeated: true,
    },
    hint: "когда было busiest",
  },
  {
    type: "compare",
    required: ["left", "right"],
    optional: ["title", "subject", "unit", "verdict"],
    member: {
      fields: "left/right",
      required: ["label", "value"],
      optional: ["link"],
      repeated: false,
    },
    hint: "ровно два значения",
  },
];

/** Имена восьми новых типов — для нормализатора и фиче-флага. */
export const NEW_WIDGET_TYPES: readonly string[] = NEW_WIDGET_TYPE_SPECS.map(
  (spec) => spec.type,
);

function memberFieldList(spec: NewWidgetTypeSpec): string {
  const { fields, required, optional, repeated } = spec.member;
  const label = repeated ? `${fields}[]` : fields;
  const parts = [...required, ...optional.map((f) => `${f}?`)];
  return `${label}: ${parts.join(", ")}`;
}

function rootFieldList(spec: NewWidgetTypeSpec): string {
  const memberNames = new Set(spec.member.fields.split("/"));
  const required = spec.required.filter((f) => !memberNames.has(f));
  const optional = spec.optional.filter((f) => !memberNames.has(f));
  return [...required, ...optional.map((f) => `${f}?`)].join(", ");
}

/**
 * Строка инструкции роли про один тип. Формат разбирается тестом
 * widgetContract.test.ts и пересказывает роли поля блока ровно так, как их
 * ждёт словарь валидатора: элементы — с пометкой `[]` у массива, поля блока —
 * отдельно, необязательные — со знаком «?».
 */
export function newWidgetTypeLine(spec: NewWidgetTypeSpec): string {
  return `${spec.type} (${memberFieldList(spec)}; в корне: ${rootFieldList(spec)}) — ${spec.hint};`;
}

/** Все строки новых типов — по одной на тип, в порядке каталога. */
export function newWidgetTypeLines(): string[] {
  return NEW_WIDGET_TYPE_SPECS.map(newWidgetTypeLine);
}