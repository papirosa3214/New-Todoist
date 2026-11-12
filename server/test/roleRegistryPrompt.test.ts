// Единый реестр правил в сборке инструкций ролей: канал, исключения, выключатель, нет второго AGENTS.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import db from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { setSetting } from "../src/lib/serverSettings.js";
import { loadRoleRules, rulesFor, renderRules, deriveChannels } from "../src/lib/roleRules.js";
import { roleInstructionText, roleHome, ensureRoleHome } from "../src/runtime/roleHome.js";
import { buildRegistryRules } from "../src/runtime/roleRegistryPrompt.js";
import { genderInstruction, behaviorInstruction } from "../src/runtime/roleBehavior.js";
import { chatSystemPrompt, chatInstructionArgs, createTaskResourceLoader } from "../src/runtime/instructionResources.js";
import { singleChatSystemPrompt } from "../src/runtime/secretaryChatPrompt.js";

migrate(); runMigrations();
const FRAME = /ЛИЧНОСТЬ РОЛИ — кто ты/g;
const once = (t: string) => (t.match(FRAME) ?? []).length;
const MARKER = "МАРКЕР-AGENTS-ЭТОГО-ТЕСТА-8841";
let dir: string; const prevRoles = process.env.TASKFLOW_ROLES_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "regprompt-")); process.env.TASKFLOW_ROLES_DIR = dir;
  setSetting("role_registry_enabled", true, null);
  for (const role of ["builder", "secretary", "researcher"]) { ensureRoleHome(role); fs.writeFileSync(roleHome(role).agents, "# AGENTS\n" + MARKER + "\n"); }
});
afterEach(() => {
  setSetting("role_registry_enabled", true, null);
  if (prevRoles === undefined) delete process.env.TASKFLOW_ROLES_DIR; else process.env.TASKFLOW_ROLES_DIR = prevRoles;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("реестр: выбор и рендер", () => {
  it("channels записаны в json у каждого правила и выводятся консервативно", () => {
    const rules = loadRoleRules();
    expect(rules.length).toBeGreaterThan(500);
    expect(rules.every((r) => r.channels && r.channels.length > 0)).toBe(true);
    expect(deriveChannels("везде, где работает роль")).toEqual(["chat", "card", "voice"]);
    expect(deriveChannels("только голос")).toEqual(["voice"]);
    expect(deriveChannels("работа по карточке")).toEqual(["card"]);
    expect(deriveChannels("непонятно")).toEqual(["chat", "card", "voice"]);
  });
  it("в сборку идут только нужные категории; код-тексты и data не попадают", () => {
    const got = rulesFor("builder", "card");
    const cats = new Set(got.map((r) => r.category));
    for (const c of cats) expect(["общий шаблон v2", "общий шаблон", "личные инструкции", "характер", "новое 06.11.2026", "данные (подстановка), не правило"]).toContain(c);
    expect(got.some((r) => r.category.startsWith("текст из кода"))).toBe(false);
    expect(got.filter((r) => r.kind === "data").every((r) => /^\{\{[A-Z]+\}\}$/.test(r.text.trim()))).toBe(true);
    expect(got.every((r) => r.roles === "all" || r.roles.includes("builder"))).toBe(true);
  });
  it("плейсхолдеры подставлены, заголовки разделов сохранены, enabled=false выключает правило", () => {
    const text = buildRegistryRules("builder", "card").text;
    expect(text).not.toMatch(/\{\{[A-Z]+\}\}/);
    expect(text).toContain("Ты — ");
    expect(text).toContain(roleHome("builder").dir);
    expect(text).toMatch(/^# Системная инструкция роли/m);
    const one = rulesFor("builder", "card")[2];
    expect(renderRules([{ ...one, enabled: false } as any].filter((r) => r.enabled !== false))).toBe("");
  });
});

describe("реестр: подключение", () => {
  it("карточка и голос: из реестра, без AGENTS.md/SYSTEM.md, рамка характера один раз, со строкой о роде", () => {
    const card = roleInstructionText("builder");
    expect(card).toBe(buildRegistryRules("builder", "card").text + "\n\n" + genderInstruction("builder"));
    expect(card).not.toContain(MARKER);
    expect(once(card)).toBe(1); // рамка характера — строка реестра R491, не подмешивается кодом второй раз
    expect(card).toContain("Пол и грамматический род");
    const voice = roleInstructionText("secretary", { channel: "voice" });
    expect(voice).toBe(buildRegistryRules("secretary", "voice").text + "\n\n" + genderInstruction("secretary"));
    expect(voice).not.toContain(MARKER);
  });
  it("текстовый чат builder: системный текст = реестр, AGENTS.md второй раз не приходит", async () => {
    const cwd = roleHome("builder").workspace;
    const prompt = await chatSystemPrompt("builder", "work", cwd);
    const rules = buildRegistryRules("builder", "chat").text;
    expect(prompt.startsWith(rules)).toBe(true);
    expect(prompt).not.toContain(MARKER);
    expect(once(prompt)).toBe(1);
    expect(prompt).toContain("Пол и грамматический род");
    const args = await chatInstructionArgs("builder", path.join(dir, "run.json"), "work", cwd);
    expect(fs.readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8")).toBe(rules);
    expect(fs.readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8")).not.toContain(MARKER);
  });
  it("карточный загрузчик ресурсов не добавляет AGENTS.md вторым слоем", async () => {
    const loader = await createTaskResourceLoader("builder", roleHome("builder").workspace, roleInstructionText("builder"));
    expect(loader.getAgentsFiles().agentsFiles).toHaveLength(0);
    expect(loader.getSystemPrompt() ?? "").not.toContain(MARKER);
  });
  it("исключение: текстовый чат researcher остаётся на коротком файле", async () => {
    expect(await chatSystemPrompt("researcher", "work", roleHome("researcher").workspace)).toBe(singleChatSystemPrompt("researcher"));
  });
  // Владелец 11.11.2026: «давай присоединяй её уже к реестру».
  it("текстовый чат secretary собирается из реестра правил, а не из secretary-chat-system.md", async () => {
    const prompt = await chatSystemPrompt("secretary", "work", roleHome("secretary").workspace);
    expect(prompt.startsWith(buildRegistryRules("secretary", "chat").text)).toBe(true);
    expect(prompt).not.toContain("# Системная инструкция: Помощник владельца (secretary)");
  });
  it("выключатель false → прежний путь (SYSTEM.md + AGENTS.md + behavior)", async () => {
    setSetting("role_registry_enabled", false, null);
    const card = roleInstructionText("builder");
    expect(card).toContain(MARKER);
    expect(card).toContain("ЛИЧНОСТЬ РОЛИ — кто ты");
    const prompt = await chatSystemPrompt("builder", "work", roleHome("builder").workspace);
    expect(prompt).toContain(MARKER);
    expect(behaviorInstruction("builder")).toContain("ЛИЧНОСТЬ РОЛИ");
  });
  it("журнал: роль, канал, id правил, хэш, время", () => {
    const b = buildRegistryRules("builder", "voice");
    const row = db.prepare("SELECT * FROM role_rules_log WHERE role='builder' AND channel='voice' AND hash=?").get(b.hash) as any;
    expect(row).toBeTruthy();
    expect(JSON.parse(row.ids_json)).toEqual(b.ids);
    expect(row.last_at).toBeTruthy();
    buildRegistryRules("builder", "voice");
    expect((db.prepare("SELECT uses FROM role_rules_log WHERE hash=? AND role='builder' AND channel='voice'").get(b.hash) as any).uses).toBeGreaterThanOrEqual(2);
  });
});
