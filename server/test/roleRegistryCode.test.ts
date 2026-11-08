// Правила из кода берутся из реестра по условию; содержание и порядок — те же, что в литералах кода.
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { INSTRUCTION_DEFAULTS, planRoleHelpPolicy } from "../src/runtime/instructionDefaults.js";
import { chatModeInstruction } from "../src/runtime/chatWorkMode.js";
import { chatExecutionInstruction } from "../src/runtime/chatExecutionMode.js";
import { roleToolInstruction } from "../src/runtime/roleToolCatalog.js";
import { universalInstruction } from "../src/runtime/universalTaskflow.js";
import { AGENT_RULES } from "../src/agentState.js";
import { TASK_BRIEF_INSTRUCTIONS, taskBriefText } from "../src/lib/taskBrief.js";
import { hasRegistrySite, loadRoleRules, registryText } from "../src/lib/roleRules.js";

migrate(); runMigrations();
// Сверка с литералами кода идёт по тексту ДО сжатия формулировок (06.11.2026):
// живой реестр намеренно короче, исходник хранится в text_before_shrink.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const live = JSON.parse(fs.readFileSync(new URL("../scripts/role-rules.json", import.meta.url), "utf8")) as any[];
const preShrink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rules-")), "role-rules.json");
fs.writeFileSync(preShrink, JSON.stringify(live.map((r) => (r.text_before_shrink ? { ...r, text: r.text_before_shrink } : r))));
process.env.TASKFLOW_ROLE_RULES = preShrink;
const prev = process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED;
afterEach(() => { if (prev === undefined) delete process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED; else process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = prev; });
const norm = (t: string) => t.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
const both = <T>(fn: () => T): { on: T; off: T } => {
  process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "true"; const on = fn();
  process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "false"; const off = fn();
  return { on, off };
};

describe("правила из кода в реестре", () => {
  it("в реестре 162 строки из кода: 151 правило, 3 смешанных (данные отдельно), 8 данных; составы 16 шаблонов", () => {
    const all = loadRoleRules();
    const rows = all.filter((r) => r.category === "из кода" && r.kind !== "compose" && /^R\d+$/.test(r.id) && !["R123", "R214"].includes(r.id));
    expect(rows).toHaveLength(162);
    expect(rows.every((r) => r.condition && r.site)).toBe(true);
    expect(rows.filter((r) => r.kind === "data")).toHaveLength(8);
    expect(rows.filter((r) => r.kind === "rule" && r.data_part)).toHaveLength(3);
    expect(rows.filter((r) => r.kind === "rule" && !r.data_part)).toHaveLength(151);
    expect(all.filter((r) => r.kind === "compose")).toHaveLength(16);
  });
  it("AGENT_RULES и контракт постановки берутся из реестра, массив и текст те же", () => {
    const arr = both(() => [...AGENT_RULES]);
    expect(arr.on).toEqual(arr.off);
    expect(arr.on).toHaveLength(9);
    expect(Array.isArray(AGENT_RULES)).toBe(true);
    expect(JSON.parse(JSON.stringify(AGENT_RULES))).toEqual(arr.off);
    const tb = both(taskBriefText);
    expect(tb.on).toBe(tb.off);
    expect(tb.on).toBe(TASK_BRIEF_INSTRUCTIONS);
    expect(registryText("карточка: все шаги", undefined, "agentState:AGENT_RULES")).toBe(AGENT_RULES.join("\n"));
  });
  it("шаблоны INSTRUCTION_DEFAULTS: выборка из реестра = литерал кода", () => {
    const keys = Object.keys(INSTRUCTION_DEFAULTS).filter((k) => hasRegistrySite("defaults:" + k));
    expect(keys).toHaveLength(16);
    for (const key of keys) {
      const { on, off } = both(() => INSTRUCTION_DEFAULTS[key]);
      expect(norm(on), key).toBe(norm(off));
    }
  });
  it("режимы чата, инструменты и политика помощи в плане: те же тексты", () => {
    for (const mode of ["work", "plan", "deep_research", "discussion", "goal"] as const) {
      const { on, off } = both(() => chatModeInstruction(mode));
      expect(norm(on), mode).toBe(norm(off));
    }
    for (const [name, fn] of [["universal", universalInstruction], ["planHelp", planRoleHelpPolicy]] as const) {
      const { on, off } = both(fn);
      expect(norm(on), name).toBe(norm(off));
    }
  });
  // Владелец 08.11.2026: у инструкции инструментов один источник — реестр.
  // Код-запасной литерал убран, чтобы у одного правила не было второй копии;
  // выключатель реестра эту инструкцию кодом не подменяет.
  it("у инструкции инструментов один источник — реестр", async () => {
    // Место в реестре — своё: строка универсального инструмента (R271) в этот
    // блок не попадает, иначе роль получила бы её дважды за один промпт.
    expect(roleToolInstruction()).not.toContain("Каждый отказ содержит поле hint");
    const registry = registryText("инструменты: всегда", undefined, "tools:ROLE_TOOL_INSTRUCTION");
    expect(registry.length).toBeGreaterThan(100);
    expect(roleToolInstruction()).toBe(registry);
    process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "false";
    expect(roleToolInstruction()).toBe(registry);
    const mod: any = await import("../src/runtime/roleToolCatalog.js");
    expect(mod.ROLE_TOOL_INSTRUCTION).toBeUndefined();
  });
  it("способ выполнения: одна правка смысла — его определяет задача чата, остальное дословно", () => {
    const chat = both(() => chatExecutionInstruction("chat"));
    expect(chat.off).toContain("Только владелец выбирает способ выполнения");
    expect(chat.on).not.toContain("Только владелец выбирает");
    expect(chat.on).toContain("Способ выполнения определяет задача чата");
    const OLD = "Только владелец выбирает способ выполнения. Для явного поручения оформить карточку владелец выбирает «По карточке» или пишет «Оформить как карточку».";
    const NEW = "Способ выполнения определяет задача чата: у чата нет задачи — работа идёт в чате. Для явного поручения оформить карточку владелец пишет «Оформить как карточку».";
    const strip = (t: string) => t.replace(OLD, "<X>").replace(NEW, "<X>");
    expect(norm(strip(chat.on))).toBe(norm(strip(chat.off)));
    const card = both(() => chatExecutionInstruction("card"));
    expect(card.off).toContain("Владелец выбрал работу через карточку");
    expect(card.on).toContain("У чата есть задача");
    expect(norm(card.on.replace("У чата есть задача — работа идёт через карточку задачи.", ""))).toBe(norm(card.off.replace("Владелец выбрал работу через карточку задачи.", "")));
  });
  it("нет задвоений: общие блоки встречаются в шаблонах столько же раз, сколько в коде", () => {
    const count = (t: string, m: string) => t.split(m).length - 1;
    for (const key of ["task.start", "task.plan", "task.resume", "task.reply", "chat.wrapper"]) {
      const { on, off } = both(() => INSTRUCTION_DEFAULTS[key]);
      expect(count(on, "ФОРМАТ ОТВЕТА (один во всём приложении)"), key).toBe(count(off, "ФОРМАТ ОТВЕТА (один во всём приложении)"));
      expect(count(on, "{rules}") + count(on, "{roleInstruction}"), key).toBe(count(off, "{rules}") + count(off, "{roleInstruction}"));
    }
  });
  it("выключатель: при false — прежние тексты из кода", () => {
    process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "false";
    expect(chatExecutionInstruction("card")).toContain("Владелец выбрал");
    expect(registryText("режим: plan")).not.toBe("");
  });
  it("сжатые формулировки короче исходных и подменяют их в живом реестре", () => {
    const shrunk = live.filter((r) => r.text_before_shrink);
    expect(shrunk.length).toBeGreaterThan(0);
    expect(shrunk.every((r) => r.text.length < r.text_before_shrink.length)).toBe(true);
  });
});
