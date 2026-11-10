// Правила из кода берутся из реестра. Второй копии в TypeScript нет.
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { INSTRUCTION_DEFAULTS, planRoleHelpPolicy } from "../src/runtime/instructionDefaults.js";
import { chatModeInstruction } from "../src/runtime/chatWorkMode.js";
import { chatExecutionInstruction } from "../src/runtime/chatExecutionMode.js";
import { roleToolInstruction } from "../src/runtime/roleToolCatalog.js";
import { universalInstruction } from "../src/runtime/universalTaskflow.js";
import { AGENT_RULES } from "../src/agentState.js";
import { taskBriefText } from "../src/lib/taskBrief.js";
import { hasRegistrySite, loadRoleRules, registryConditionOf, registryText } from "../src/lib/roleRules.js";

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
  it("в реестре 160 строк из кода: 150 правил, 2 смешанных (данные отдельно), 8 данных; составы 16 шаблонов", () => {
    const all = loadRoleRules();
    const rows = all.filter((r) => r.category === "из кода" && r.kind !== "compose" && /^R\d+$/.test(r.id) && !["R123", "R214"].includes(r.id));
    // R124 и R217 вынесены в «новое 06.11.2026» (11f7fc7b), чтобы формат доходил до роли.
    expect(rows).toHaveLength(160);
    expect(rows.every((r) => r.condition && r.site)).toBe(true);
    expect(rows.filter((r) => r.kind === "data")).toHaveLength(8);
    expect(rows.filter((r) => r.kind === "rule" && r.data_part)).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "rule" && !r.data_part)).toHaveLength(150);
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
    expect(tb.on).toBe(registryText("карточка: все шаги", undefined, "brief:TASK_BRIEF_INSTRUCTIONS"));
    expect(registryText("карточка: все шаги", undefined, "agentState:AGENT_RULES")).toBe(AGENT_RULES.join("\n"));
  });
  it("шаблоны INSTRUCTION_DEFAULTS берутся из реестра", () => {
    const keys = Object.keys(INSTRUCTION_DEFAULTS).filter((k) => hasRegistrySite("defaults:" + k));
    expect(keys).toHaveLength(16);
    for (const key of keys) {
      const site = "defaults:" + key;
      const fromRegistry = registryText(registryConditionOf(site)!, key.startsWith("secretary.") ? "secretary" : undefined, site);
      expect(fromRegistry.length, key).toBeGreaterThan(0);
      expect(norm(INSTRUCTION_DEFAULTS[key]), key).toBe(norm(fromRegistry));
      process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "false";
      expect(norm(INSTRUCTION_DEFAULTS[key]), key).toBe(norm(fromRegistry));
      delete process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED;
    }
  });
  it("режимы чата, инструменты и политика помощи в плане берутся из реестра", () => {
    for (const mode of ["work", "plan", "deep_research", "discussion", "goal"] as const) {
      const fromRegistry = registryText("режим: " + mode, undefined, "mode:" + mode);
      expect(fromRegistry.length, mode).toBeGreaterThan(0);
      expect(norm(chatModeInstruction(mode)), mode).toBe(norm(fromRegistry));
    }
    expect(norm(universalInstruction())).toBe(norm(registryText("инструменты: всегда", undefined, "tools:UNIVERSAL_INSTRUCTION")));
    expect(norm(planRoleHelpPolicy())).toBe(norm(registryText("карточка: все шаги", undefined, "defaults:PLAN_ROLE_HELP_POLICY")));
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
  it("способ выполнения берётся из реестра и выключатель его не подменяет", () => {
    const chat = chatExecutionInstruction("chat");
    expect(chat).toBe(registryText("способ: в чате", undefined, "exec:chat"));
    expect(chat).toContain("Способ выполнения определяет задача чата");
    expect(chat).not.toContain("Только владелец выбирает");
    const card = chatExecutionInstruction("card");
    expect(card).toBe(registryText("способ: по карточке", undefined, "exec:card"));
    expect(card).toContain("У чата есть задача");
    process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "false";
    expect(chatExecutionInstruction("card")).toBe(card);
    expect(registryText("режим: plan")).not.toBe("");
  });
  it("общие блоки в шаблонах не задвоены", () => {
    const count = (t: string, m: string) => t.split(m).length - 1;
    for (const key of ["task.start", "task.plan", "task.resume", "task.reply", "chat.wrapper"]) {
      const text = INSTRUCTION_DEFAULTS[key];
      expect(count(text, "ФОРМАТ ОТВЕТА (один во всём приложении)"), key).toBeLessThanOrEqual(1);
      const slots = count(text, "{rules}") + count(text, "{roleInstruction}");
      expect(slots, key).toBeLessThanOrEqual(2);
    }
  });
  it("сжатые формулировки короче исходных и подменяют их в живом реестре", () => {
    const shrunk = live.filter((r) => r.text_before_shrink);
    expect(shrunk.length).toBeGreaterThan(0);
    expect(shrunk.every((r) => r.text.length < r.text_before_shrink.length)).toBe(true);
  });
});
