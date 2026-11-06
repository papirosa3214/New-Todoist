// Правила из кода берутся из реестра по условию; содержание и порядок — те же, что в литералах кода.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { INSTRUCTION_DEFAULTS, planRoleHelpPolicy } from "../src/runtime/instructionDefaults.js";
import { chatModeInstruction } from "../src/runtime/chatWorkMode.js";
import { chatExecutionInstruction } from "../src/runtime/chatExecutionMode.js";
import { roleToolInstruction } from "../src/runtime/roleToolCatalog.js";
import { universalInstruction } from "../src/runtime/universalTaskflow.js";
import { hasRegistrySite, loadRoleRules, registryText } from "../src/lib/roleRules.js";

migrate(); runMigrations();
const prev = process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED;
afterEach(() => { if (prev === undefined) delete process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED; else process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = prev; });
const norm = (t: string) => t.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
const both = <T>(fn: () => T): { on: T; off: T } => {
  process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "true"; const on = fn();
  process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED = "false"; const off = fn();
  return { on, off };
};

describe("правила из кода в реестре", () => {
  it("в реестре все 162 строки из кода: 151 правило, 3 смешанных (данные отдельно), 8 данных; составы 16 шаблонов", () => {
    const all = loadRoleRules();
    const v3 = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cache/role-registry/v3/code-rules.json"), "utf8")) as Array<{ id: string; class: string }>;
    expect(v3).toHaveLength(162);
    for (const x of v3) {
      const row = all.find((r) => r.id === x.id)!;
      expect(row.category, x.id).toBe("из кода");
      expect(row.condition && row.site, x.id).toBeTruthy();
      expect(row.kind === "data").toBe(x.class === "data");
      expect(!!row.data_part).toBe(x.class === "mixed" || x.class === "data");
    }
    expect(all.filter((r) => r.kind === "compose")).toHaveLength(16);
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
    for (const [name, fn] of [["tools", roleToolInstruction], ["universal", universalInstruction], ["planHelp", planRoleHelpPolicy]] as const) {
      const { on, off } = both(fn);
      expect(norm(on), name).toBe(norm(off));
    }
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
});
