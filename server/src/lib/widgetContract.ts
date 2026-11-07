// Контракт полей восьми новых типов виджетов (галерея компоновок карточки
// 3e27dafe, 14.10.2026). Это единственный список полей на сервере: из него
// собираются и строки инструкции роли, и перечень типов для нормализатора и
// фиче-флага. Раньше эти три вещи жили отдельно, и они разошлись.
//
// Откуда поля:
//   - документ галереи docs/2026-10-14-widget-gallery-layouts-and-types.md,
//     раздел 5 («Восемь новых типов») — по одному типу на подраздел;
//   - словарь SCHEMA валидатора помощника владельца
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
  /**
   * Тип table: элементы строк — массивы строк, а не объекты. Общая модель
   * «элемент = объект» для него не годится, поэтому у таблицы своя форма
   * проверки: columns — список названий, rows — список строк той же длины.
   */
  rowsAreArrays?: boolean;
  /** Тип weather: блок собирает только инструмент taskflow_weather. */
  toolOnly?: boolean;
  /** Поля элемента, значения которых ограничены списком (tone, trend, kind). */
  enums?: Record<string, readonly string[]>;
}

/** Типы и поля шести базовых блоков — раньше они жили прозой в инструкции
 *  и в словаре валидатора помощника владельца вне git. Карточка cea8d997
 *  требует одного источника формата: и проверка, и автозамена, и строка
 *  инструкции ролям собираются отсюда. */
export const BASE_WIDGET_TYPE_SPECS: readonly NewWidgetTypeSpec[] = [
  {
    type: "table",
    required: ["columns", "rows"],
    optional: ["title"],
    member: { fields: "rows", required: [], optional: [], repeated: true },
    rowsAreArrays: true,
    hint: "сравнение по строкам",
  },
  {
    type: "metrics",
    required: ["items"],
    optional: ["title"],
    member: { fields: "items", required: ["label", "value"], optional: ["delta", "trend"], repeated: true },
    enums: { trend: ["up", "down", "flat"] },
    hint: "несколько чисел рядом",
  },
  {
    type: "progress",
    required: ["items"],
    optional: ["title"],
    member: { fields: "items", required: ["label", "value"], optional: ["note"], repeated: true },
    hint: "доля выполнения по строкам",
  },
  {
    type: "checklist",
    required: ["items"],
    optional: ["title"],
    member: { fields: "items", required: ["text"], optional: ["done"], repeated: true },
    hint: "список пунктов с галочками",
  },
  {
    type: "card",
    required: [],
    optional: ["title", "subtitle", "body", "rows", "link"],
    member: { fields: "rows", required: ["label", "value"], optional: [], repeated: true },
    hint: "карточка с пар подпись-значение",
  },
  {
    type: "chart",
    required: ["points"],
    optional: ["title", "kind", "unit"],
    member: { fields: "points", required: ["x", "y"], optional: [], repeated: true },
    enums: { kind: ["bar", "line"] },
    hint: "значения по точкам или датам",
  },
  {
    type: "weather",
    required: ["location", "temperature", "condition", "icon"],
    optional: ["feels_like", "humidity", "wind", "is_day", "high", "low", "forecast", "updated_at"],
    member: { fields: "forecast", required: ["day", "icon", "high", "low"], optional: [], repeated: true },
    toolOnly: true,
    hint: "только готовый блок из taskflow_weather",
  },
];

/** Допустимые значения перечисляемого поля блока (kind, trend, tone, state). */
export function widgetEnumValues(spec: NewWidgetTypeSpec, field: string): readonly string[] | null {
  if (spec.enums && spec.enums[field]) return spec.enums[field];
  if (field === "tone") return NEW_WIDGET_TONES;
  if (field === "state") return NEW_WIDGET_STATES;
  if (field === "trend") return ["up", "down", "flat"];
  if (field === "kind" && spec.type === "chart") return ["bar", "line"];
  return null;
}

export interface WidgetBlockProblem {
  /** Что не так — одной строкой, по-человечески. */
  message: string;
  /** Путь до места в блоке: block.rows[2], block.cells[0].value. */
  path: string;
}

/**
 * Проверка одного блока по каталогу. Возвращает список претензий; пустой
 * список — блок верный. Проверка намеренно строгая к лишним полям: роль,
 * которая прислала «max» внутрь ячейки heatmap, должна получить отказ с
 * образцом, а не тихо исправленный на сервере блок.
 */
export function validateWidgetBlock(json: unknown, path = "block"): WidgetBlockProblem[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return [{ path, message: "блок должен быть объектом JSON" }];
  }
  const obj = json as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  const spec = type ? WIDGET_SPEC_BY_TYPE.get(type) : undefined;
  if (!spec) {
    return [
      {
        path: path + ".type",
        message: type
          ? `неизвестный тип «${type}»; допустимые: ${ALL_WIDGET_TYPES.join(", ")}`
          : `нет поля type; допустимые типы: ${ALL_WIDGET_TYPES.join(", ")}`,
      },
    ];
  }

  const problems: WidgetBlockProblem[] = [];
  const memberNames = new Set(spec.member.fields.split("/"));
  const rootRequired = spec.required.filter((field) => !memberNames.has(field));
  const rootOptional = spec.optional.filter((field) => !memberNames.has(field));
  const allowed = new Set(["type", ...rootRequired, ...rootOptional, ...memberNames]);

  for (const field of rootRequired) {
    if (!(field in obj) || obj[field] == null) problems.push({ path: `${path}.${field}`, message: `нет обязательного поля «${field}»` });
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) problems.push({ path: `${path}.${key}`, message: `поле «${key}» не входит в тип ${spec.type}` });
  }
  for (const [field, values] of Object.entries(spec.enums ?? {})) {
    if (field in obj && obj[field] != null && !values.includes(String(obj[field]))) {
      problems.push({ path: `${path}.${field}`, message: `«${String(obj[field])}» не в списке: ${values.join(", ")}` });
    }
  }

  if (spec.rowsAreArrays) {
    const columns = obj.columns;
    const rows = obj.rows;
    if (!Array.isArray(columns) || columns.length === 0) {
      problems.push({ path: `${path}.columns`, message: "columns: нужен непустой список названий колонок" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      problems.push({ path: `${path}.rows`, message: "rows: нужен непустой список строк" });
    }
    if (Array.isArray(columns) && Array.isArray(rows)) {
      const width = columns.length;
      rows.forEach((row, index) => {
        if (!Array.isArray(row) || row.length !== width || row.some((cell) => typeof cell !== "string")) {
          problems.push({ path: `${path}.rows[${index}]`, message: `строка должна содержать ${width} строк текста — по одной на колонку` });
        }
      });
    }
    return problems;
  }

  for (const memberField of spec.member.fields.split("/")) {
    const value = obj[memberField];
    // Обязательное поле данных не может отсутствовать: блок без cells/items/
    // rows рисовать нечего, и клиент показал бы пустоту. Раньше этот случай
    // молча проходил (значение null просто пропускалось), и проверка формата
    // (карточка cea8d997) такой блок пропускала тоже.
    if (value == null) {
      if (spec.required.includes(memberField)) {
        problems.push({ path: `${path}.${memberField}`, message: `нет обязательного поля «${memberField}»` });
      }
      continue;
    }
    if (spec.member.repeated && !Array.isArray(value)) {
      problems.push({ path: `${path}.${memberField}`, message: `«${memberField}» должен быть списком` });
      continue;
    }
    if (!Array.isArray(value)) {
      // Сторона compare (left/right) — объект: проверяем его поля так же.
      const sidePath = `${path}.${memberField}`;
      if (!value || typeof value !== "object") {
        problems.push({ path: sidePath, message: `«${memberField}» должен быть объектом` });
        continue;
      }
      const side = value as Record<string, unknown>;
      for (const field of spec.member.required) {
        if (!(field in side) || side[field] == null) {
          problems.push({ path: `${sidePath}.${field}`, message: `нет обязательного поля «${field}»` });
        }
      }
      for (const key of Object.keys(side)) {
        if (!spec.member.required.includes(key) && !spec.member.optional.includes(key)) {
          problems.push({ path: `${sidePath}.${key}`, message: `лишнее поле «${key}»` });
        }
      }
      continue;
    }
    if (value.length === 0) {
      problems.push({ path: `${path}.${memberField}`, message: `«${memberField}» не может быть пустым` });
      continue;
    }
    value.forEach((element, index) => {
      const elementPath = `${path}.${memberField}[${index}]`;
      if (!element || typeof element !== "object" || Array.isArray(element)) {
        problems.push({ path: elementPath, message: "элемент должен быть объектом" });
        return;
      }
      const record = element as Record<string, unknown>;
      for (const field of spec.member.required) {
        if (!(field in record) || record[field] == null) problems.push({ path: `${elementPath}.${field}`, message: `нет обязательного поля «${field}»` });
      }
      const elementAllowed = new Set([...spec.member.required, ...spec.member.optional]);
      for (const key of Object.keys(record)) {
        if (!elementAllowed.has(key)) problems.push({ path: `${elementPath}.${key}`, message: `лишнее поле «${key}»` });
      }
      for (const key of Object.keys(record)) {
        const values = widgetEnumValues(spec, key);
        if (values && record[key] != null && !values.includes(String(record[key]))) {
          problems.push({ path: `${elementPath}.${key}`, message: `«${String(record[key])}» не в списке: ${values.join(", ")}` });
        }
      }
    });
  }
  return problems;
}

/** Пример блока по каталогу: ровно те поля, которые ждёт проверка. */
export function widgetExample(type: string): string {
  const spec = WIDGET_SPEC_BY_TYPE.get(type);
  if (!spec) return "";
  // Погоду собирает только taskflow_weather: образец показывает ровно то,
  // что вернёт инструмент, иначе роль напишет блок руками и получит пустую
  // погоду на телефоне.
  if (spec.toolOnly) {
    return JSON.stringify(
      {
        type: "weather",
        location: "Москва",
        temperature: 12,
        condition: "ясно",
        icon: "sun",
        forecast: [{ day: "пн", icon: "sun", high: 15, low: 8 }],
      },
      null,
      2,
    );
  }
  const sampleValue = (field: string): unknown => {
    const values = widgetEnumValues(spec, field);
    if (values && values.length) return values[0];
    switch (field) {
      case "value":
      case "y":
        return 12;
      case "x":
        return "01.10";
      case "done":
      case "is_day":
        return true;
      case "delta":
        return "+2";
      default:
        return field;
    }
  };
  const memberFields = spec.member.fields.split("/");
  const memberNames = new Set(memberFields);
  const block: Record<string, unknown> = { type: spec.type };
  if (spec.rowsAreArrays) {
    block.columns = ["Проверка", "Результат"];
    block.rows = [["tsc", "чисто"]];
    if (spec.optional.includes("title")) block.title = "Проверки";
    return JSON.stringify(block, null, 2);
  }
  for (const field of [...spec.required, ...spec.optional]) {
    if (!memberNames.has(field)) block[field] = sampleValue(field);
  }
  if (spec.member.repeated) {
    const element: Record<string, unknown> = {};
    for (const field of [...spec.member.required, ...spec.member.optional]) element[field] = sampleValue(field);
    for (const field of memberFields) block[field] = [element];
  } else {
    // compare: две стороны-объекта (left/right), а не массив.
    for (const field of memberFields) {
      const side: Record<string, unknown> = {};
      for (const memberField of [...spec.member.required, ...spec.member.optional]) {
        side[memberField] = sampleValue(memberField);
      }
      block[field] = side;
    }
  }
  return JSON.stringify(block, null, 2);
}

/** Образец блока вместе с обрамлением ```widget — его роль получает в ошибке. */
export function widgetExampleFence(type: string): string {
  const example = widgetExample(type);
  return example ? "```widget\n" + example + "\n```" : "";
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

/** Все типы блоков: базовые и восемь новых. Это перечень, по которому живут
 *  нормализатор, валидатор, автозамена и инструкция ролей. Объявляется ниже
 *  NEW_WIDGET_TYPE_SPECS — тот должен быть готов раньше. */
export const ALL_WIDGET_TYPE_SPECS: readonly NewWidgetTypeSpec[] = [
  ...BASE_WIDGET_TYPE_SPECS,
  ...NEW_WIDGET_TYPE_SPECS,
];

/** Каталог по имени типа — для валидатора и примера в ошибке. */
export const WIDGET_SPEC_BY_TYPE: ReadonlyMap<string, NewWidgetTypeSpec> = new Map(
  ALL_WIDGET_TYPE_SPECS.map((spec) => [spec.type, spec]),
);

/** Имена всех типов блоков. */
export const ALL_WIDGET_TYPES: readonly string[] = ALL_WIDGET_TYPE_SPECS.map((spec) => spec.type);

function rootFieldList(spec: NewWidgetTypeSpec): string {
  const memberNames = new Set(spec.member.fields.split("/"));
  const required = spec.required.filter((f) => !memberNames.has(f));
  const optional = spec.optional.filter((f) => !memberNames.has(f));
  return [
    ...required.map((f) => f + enumSuffix(spec, f)),
    ...optional.map((f) => `${f}?${enumSuffix(spec, f)}`),
  ].join(", ");
}

/**
 * Перечисляемое поле блока или элемента: к имени добавляется список
 * допустимых значений. Список берётся из полей самого типа (spec.enums):
 * у восьми новых типов tone и state перечислены общей строкой инструкции,
 * поэтому в их строках перечислений нет — иначе строка перестала бы
 * разбираться тестом контракта в прежнем виде.
 */
function enumSuffix(spec: NewWidgetTypeSpec, field: string): string {
  const values = spec.enums?.[field];
  return values ? ` (${values.join("|")})` : "";
}

function memberFieldList(spec: NewWidgetTypeSpec): string {
  const { fields, required, optional, repeated } = spec.member;
  // Таблица: элемент — строка текста по одной ячейке на колонку, а не объект.
  if (spec.rowsAreArrays) return `${fields}[][]: строки по числу колонок из columns`;
  const label = repeated ? `${fields}[]` : fields;
  const parts = [...required.map((f) => f + enumSuffix(spec, f)), ...optional.map((f) => `${f}?${enumSuffix(spec, f)}`)];
  return `${label}: ${parts.join(", ")}`;
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

/**
 * Строка инструкции роли для всех типов блоков — по одной на тип, из того же
 * каталога, по которому идёт проверка. Раньше шесть базовых типов были
 * прозой в instructionDefaults, а словарь валидатора помощника владельца лежал
 * вне git: эти три вещи расходились (дефект D1, карточка 3e27dafe). Теперь
 * базовые строки собираются здесь же, поэтому расходиться больше нечему.
 *
 * `includeNew` — перечислять ли восемь новых типов. Их по-прежнему можно
 * показывать роли только когда клиент их рисует (lib/widgetFeatureFlag.ts);
 * сам сервер их принимает всегда.
 */
export function widgetTypeLines(options: { includeNew?: boolean } = {}): string[] {
  const { includeNew = true } = options;
  const specs = includeNew ? ALL_WIDGET_TYPE_SPECS : BASE_WIDGET_TYPE_SPECS;
  return specs.map(newWidgetTypeLine);
}