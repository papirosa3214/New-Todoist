// Контракт восьми новых типов виджетов (карточка 3e27dafe, регресс D1).
//
// D1: проза инструкции роли описывала heatmap как «weeks, cells: date, value,
// max» — max уезжал внутрь ячеек. Роль, собравшая блок по инструкции, получала
// от своего же валидатора «нет обязательных полей ['max']» и «cells[i]: лишние
// поля ['max']», а клиент не получал шкалу плотности. Прозу на тот момент не
// проверял ни один тест.
//
// Здесь три проверки:
//   1. строка инструкции разбирается ровно в поля каталога — для всех восьми;
//   2. пример, собранный по каталогу, принимает словарь валидатора помощника владельца
//      (файл лежит вне git, поэтому проверка условная);
//   3. max внутри ячейки heatmap словарь отвергает — регресс на сам дефект.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_WIDGET_TYPE_SPECS,
  BASE_WIDGET_TYPE_SPECS,
  NEW_WIDGET_STATES,
  NEW_WIDGET_TONES,
  NEW_WIDGET_TYPE_SPECS,
  NEW_WIDGET_TYPES,
  newWidgetTypeLine,
  validateWidgetBlock,
  widgetExample,
  type NewWidgetTypeSpec,
} from "../src/lib/widgetContract.js";
import { NEW_WIDGET_TYPES as FLAG_TYPES, newWidgetTypesEnabled } from "../src/lib/widgetFeatureFlag.js";
import { CANONICAL_WIDGET_TYPES } from "../src/lib/widgetNormalize.js";

// Проза собирается при импорте instructionDefaults, поэтому флаг поднимаем
// до импортов — иначе перечень типов в инструкции будет пустым.
vi.hoisted(() => {
  process.env.TASKFLOW_WIDGET_NEW_TYPES = "1";
});

const VALIDATOR =
  process.env.TASKFLOW_SECRETARY_VALIDATOR ??
  "/home/maksim/taskflow/roles/secretary/skills/widget-renderer/scripts/validate_widget.py";

interface ParsedTypeLine {
  type: string;
  memberFields: string;
  memberRepeated: boolean;
  memberRequired: string[];
  memberOptional: string[];
  rootRequired: string[];
  rootOptional: string[];
  hint: string;
}

/** Разбор строки вида «type (cells[]: date, value; в корне: weeks, max) — подпись;». */
function parseTypeLine(line: string): ParsedTypeLine {
  const match = /^([a-z_]+) \((.+)\) — (.+);$/.exec(line);
  if (!match) throw new Error(`строка не разбирается: ${line}`);
  const [, type, inner, hint] = match;
  const cut = inner.indexOf("; в корне: ");
  if (cut < 0) throw new Error(`в строке нет раздела «в корне»: ${line}`);
  const memberPart = inner.slice(0, cut).trim();
  const rootPart = inner.slice(cut + "; в корне: ".length).trim();

  const label = /^(.+?)\[\]: (.+)$/.exec(memberPart) ?? /^(.+?): (.+)$/.exec(memberPart);
  if (!label) throw new Error(`не разбирается перечень элементов: ${line}`);
  const split = (part: string) =>
    part.split(", ").map((f) => (f.endsWith("?") ? f.slice(0, -1) : f));
  const optionalOf = (part: string) =>
    part.split(", ").filter((f) => f.endsWith("?")).map((f) => f.slice(0, -1));

  return {
    type,
    memberFields: label[1],
    memberRepeated: memberPart.startsWith(`${label[1]}[]:`),
    memberRequired: split(label[2]).filter((f) => !optionalOf(label[2]).includes(f)),
    memberOptional: optionalOf(label[2]),
    rootRequired: split(rootPart).filter((f) => !optionalOf(rootPart).includes(f)),
    rootOptional: optionalOf(rootPart),
    hint,
  };
}

const SPECS_BY_TYPE = new Map(NEW_WIDGET_TYPE_SPECS.map((s) => [s.type, s]));

describe("контракт восьми новых типов виджетов", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("имён типов восемь, и они те же в нормализаторе, флаге и каталоге", () => {
    expect(NEW_WIDGET_TYPES).toHaveLength(8);
    expect([...FLAG_TYPES]).toEqual([...NEW_WIDGET_TYPES]);
    for (const type of NEW_WIDGET_TYPES) {
      expect(CANONICAL_WIDGET_TYPES).toContain(type);
      expect(SPECS_BY_TYPE.has(type)).toBe(true);
    }
  });

  it("строка инструкции разбирается ровно в поля контракта — для всех восьми", async () => {
    const { INSTRUCTION_DEFAULTS } = await import("../src/runtime/instructionDefaults.js");
    const wrapper = String(INSTRUCTION_DEFAULTS["chat.wrapper"]);
    expect(newWidgetTypesEnabled()).toBe(true);

    const lines = wrapper
      .split("\n")
      .filter((line) => NEW_WIDGET_TYPES.some((t) => line.startsWith(`${t} (`)));
    expect(lines).toHaveLength(8);

    for (const line of lines) {
      const parsed = parseTypeLine(line);
      const spec = SPECS_BY_TYPE.get(parsed.type);
      expect(spec, `строка без записи в каталоге: ${line}`).toBeDefined();
      if (!spec) continue;

      // Элементы блока.
      expect(parsed.memberFields, `элементы в строке: ${line}`).toBe(spec.member.fields);
      expect(parsed.memberRepeated, `массив или объект в строке: ${line}`).toBe(spec.member.repeated);
      expect([...parsed.memberRequired].sort(), `обязательные поля элемента: ${line}`).toEqual(
        [...spec.member.required].sort(),
      );
      expect([...parsed.memberOptional].sort(), `необязательные поля элемента: ${line}`).toEqual(
        [...spec.member.optional].sort(),
      );

      // Поля блока: элемент в перечень не повторяется, необязательные помечены «?».
      const memberNames = new Set(spec.member.fields.split("/"));
      expect([...parsed.rootRequired].sort(), `обязательные поля блока: ${line}`).toEqual(
        spec.required.filter((f) => !memberNames.has(f)).sort() as string[],
      );
      expect([...parsed.rootOptional].sort(), `необязательные поля блока: ${line}`).toEqual(
        spec.optional.filter((f) => !memberNames.has(f)).sort() as string[],
      );

      // Подпись помогает выбрать тип, а не теряется при разборе.
      expect(parsed.hint).toBe(spec.hint);
    }

    // Отдельно heatmap: max — поле блока, в ячейке только дата и значение.
    const heat = parseTypeLine(lines.find((l) => l.startsWith("heatmap ("))!);
    expect(heat.memberRequired).toEqual(["date", "value"]);
    expect(heat.memberOptional).toEqual([]);
    expect(heat.rootRequired).toEqual(["weeks", "max"]);
    expect(lines.find((l) => l.startsWith("heatmap ("))).not.toContain("value, max");

    // compare: verdict — поле блока, а не поля сторон.
    const cmp = parseTypeLine(lines.find((l) => l.startsWith("compare ("))!);
    expect(cmp.memberRequired).toEqual(["label", "value"]);
    expect(cmp.rootOptional).toContain("verdict");
  });

  it("списки тонов и состояний в прозе совпадают с контрактом", async () => {
    const { INSTRUCTION_DEFAULTS } = await import("../src/runtime/instructionDefaults.js");
    const wrapper = String(INSTRUCTION_DEFAULTS["chat.wrapper"]);
    const toneLine = wrapper.split("\n").find((l) => l.startsWith("tone — "))!;
    const stateLine = wrapper.split("\n").find((l) => l.startsWith("state — "))!;
    const listed = (line: string, prefix: string) =>
      line
        .slice(prefix.length)
        .replace(/\.$/, "")
        .split(", ")
        .filter(Boolean);
    expect(listed(toneLine, "tone — из списка: ")).toEqual([...NEW_WIDGET_TONES]);
    expect(listed(stateLine, "state — из списка: ")).toEqual([...NEW_WIDGET_STATES]);
  });

  it("при выключенном флаге перечня типов в инструкции нет", async () => {
    vi.stubEnv("TASKFLOW_WIDGET_NEW_TYPES", "");
    vi.resetModules();
    const { INSTRUCTION_DEFAULTS: off } = await import("../src/runtime/instructionDefaults.js");
    const wrapper = String(off["chat.wrapper"]);
    for (const type of NEW_WIDGET_TYPES) expect(wrapper).not.toContain(`${type} (`);
  });

  // Карточка cea8d997: проверка и инструкция ролям собираются из одного
  // каталога. Шесть базовых типов раньше были прозой в инструкции, а словарь
  // валидатора лежал вне git — это и есть источник расхождения D1.
  it("строки базовых типов в инструкции собираются из каталога", async () => {
    const { INSTRUCTION_DEFAULTS } = await import("../src/runtime/instructionDefaults.js");
    const wrapper = String(INSTRUCTION_DEFAULTS["chat.wrapper"]);
    const lines = wrapper.split("\n").filter((line) => /^([a-z_]+) \(/.exec(line));
    expect(lines.length).toBeGreaterThanOrEqual(BASE_WIDGET_TYPE_SPECS.length);
    for (const spec of BASE_WIDGET_TYPE_SPECS) {
      expect(lines, `нет строки для базового типа ${spec.type}`).toContain(newWidgetTypeLine(spec));
    }
  });

  it("пример из каталога проходит проверку — для каждого типа", () => {
    for (const spec of ALL_WIDGET_TYPE_SPECS) {
      const example = JSON.parse(widgetExample(spec.type));
      expect(validateWidgetBlock(example, spec.type), `${spec.type}: пример не проходит`).toEqual([]);
    }
  });
});

/** Значения-примеры по имени поля: такие значения словарь валидатора принимает. */
const SAMPLE_VALUES: Record<string, unknown> = {
  max: 9,
  value: 7,
  count: 2,
  weeks: 12,
  first_weekday: 1,
  overall: 62,
  share: 50,
  tone: "over",
  state: "done",
  date: "2026-10-14",
  now: "2026-10-14",
  today: "2026-10-14",
  month: "2026-10",
  label: "Задача",
  title: "Проверка контракта",
  note: "заметка",
  meta: "3 бага",
  unit: "задач",
  subject: "Предмет",
  verdict: "Дешевле слева",
  summary: "2 из 3",
  icon: "check",
  link: "https://example.com",
};

function sampleValue(field: string): unknown {
  return field in SAMPLE_VALUES ? SAMPLE_VALUES[field] : "текст";
}

/** Минимальный блок типа, собранный по каталогу: все поля контракта, примеры значений. */
function sampleBlock(spec: NewWidgetTypeSpec): Record<string, unknown> {
  const memberFields = spec.member.fields.split("/");
  const element: Record<string, unknown> = {};
  for (const field of [...spec.member.required, ...spec.member.optional]) {
    element[field] = sampleValue(field);
  }
  const block: Record<string, unknown> = { type: spec.type };
  for (const field of [...spec.required, ...spec.optional]) {
    if (memberNames(spec).has(field)) continue;
    block[field] = sampleValue(field);
  }
  for (const field of memberFields) block[field] = element;
  return block;
}

function memberNames(spec: NewWidgetTypeSpec): Set<string> {
  return new Set(spec.member.fields.split("/"));
}

function validateWithSecretary(block: Record<string, unknown>): { code: number; out: string } {
  const payload = "```widget\n" + JSON.stringify(block) + "\n```\n";
  try {
    const out = execFileSync("python3", [VALIDATOR], { input: payload, encoding: "utf8" });
    return { code: 0, out: out.trim() };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

// Словарь валидатора помощника владельца лежит вне git. Если его нет на машине — эту
// часть проверки пропускаем, а не выдаём за пройденную.
describe.runIf(existsSync(VALIDATOR))("каталог и словарь валидатора помощника владельца", () => {
  it.each(NEW_WIDGET_TYPE_SPECS.map((s) => [s.type, s] as const))(
    "пример по контракту (%s) словарь принимает без ошибок",
    (_type, spec) => {
      const res = validateWithSecretary(sampleBlock(spec));
      // Валидатор печатает счётчики, ошибки идут со строки «  - ».
      expect(`${spec.type}\n${res.out}`).toBe(`${spec.type}\nпроверено: 1, ок: 1, ошибок: 0`);
    },
  );

  it("max внутри ячейки heatmap словарь отвергает — регресс на D1", () => {
    const bad = {
      type: "heatmap",
      weeks: 12,
      cells: [{ date: "2026-10-14", value: 7, max: 9 }],
    };
    const res = validateWithSecretary(bad);
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("max");
  });
});