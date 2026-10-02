import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureRoleHome } from "../src/runtime/roleHome.js";
import { createTaskResourceLoader, discoverChatResources, chatInstructionArgs } from "../src/runtime/instructionResources.js";
import { composeLayer, LAYER_CATALOG, applyOverride } from "../src/lib/roleContextResolver.js";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

migrate(); runMigrations();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-resources-test-"));
process.env.TASKFLOW_ROLES_DIR = path.join(root, "roles");
const project = path.join(root, "project");
fs.mkdirSync(project);
const builder = ensureRoleHome("builder");
const designer = ensureRoleHome("designer");
const skillFile = path.join(builder.skills, "build", "SKILL.md");
fs.mkdirSync(path.dirname(skillFile));
fs.writeFileSync(skillFile, "---\nname: build\ndescription: Build the project\n---\nUse scripts/build.py relative to this skill.\n");
fs.mkdirSync(path.join(designer.skills, "paint"));
fs.writeFileSync(path.join(designer.skills, "paint", "SKILL.md"), "---\nname: paint\ndescription: Paint a picture\n---\nPaint.\n");
fs.writeFileSync(builder.agents, "Только инструкции разработчика");
fs.writeFileSync(designer.agents, "Только инструкции дизайнера");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("инструментарий роли в обоих видах запуска", () => {
  it("chat discovery выбирает только роль, не подмешивает навыки проекта и другой роли", async () => {
    fs.mkdirSync(path.join(project, ".pi", "skills"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "skills", "intruder.md"), "---\nname: intruder\ndescription: Wrong skill\n---\nWrong.\n");
    const resources = await discoverChatResources("builder");
    expect(resources.skills.map(s => s.name)).toEqual(["build"]);
    expect(resources.agentsFiles.map(f => f.content)).toEqual(["Только инструкции разработчика"]);
    const designerResources = await discoverChatResources("designer");
    expect(designerResources.skills.map(s => s.name)).toEqual(["paint"]);
    const builderLayers = LAYER_CATALOG.filter(s => s.originRef === designer.agents);
    expect(builderLayers.every(s => composeLayer("builder", s.key) === null)).toBe(true);
  });

  it("task loader использует те же AGENTS и skills, сохраняя cwd проекта", async () => {
    const loader = await createTaskResourceLoader("builder", project, "Системная инструкция");
    expect(loader.getSystemPrompt()).toContain("Системная инструкция");
    expect(loader.getSystemPrompt()).toContain(builder.skills);
    expect(loader.getSkills().skills.map(s => s.filePath)).toEqual([skillFile]);
    expect(loader.getAgentsFiles().agentsFiles.map(f => f.path)).toEqual([builder.agents]);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(fs.existsSync(path.join(project, "skills"))).toBe(false);
  });

  it("chat tool write работает в workspace роли, prompt сообщает абсолютный путь навыков", async () => {
    const configPath = path.join(root, "chat.json");
    const args = await chatInstructionArgs("builder", configPath);
    const prompt = fs.readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8");
    expect(prompt).toContain(builder.skills);
    expect(prompt).toContain(builder.scripts);
    expect(prompt).toContain("Только инструкции разработчика");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-extensions");
    const extension = args[args.indexOf("--extension") + 1];
    const tools: any[] = [];
    (await import("file://" + extension)).default({ registerTool: (tool: any) => tools.push(tool) });
    await tools.find(t => t.name === "write").execute("probe", { path: "probe.txt", content: "role workspace" });
    expect(fs.readFileSync(path.join(builder.workspace, "probe.txt"), "utf8")).toBe("role workspace");
    expect(fs.existsSync(path.join(process.cwd(), "probe.txt"))).toBe(false);
  });

  it("глобальный SYSTEM.md не заменяет базовую инструкцию чата при отсутствии SYSTEM.md роли", async () => {
    const globalDir = path.join(root, "global-agent");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "SYSTEM.md"), "GLOBAL_SYSTEM_INTRUDER");
    const args = await chatInstructionArgs("builder", path.join(root, "global-probe.json"));
    const index = args.indexOf("--system-prompt");
    const loader = new DefaultResourceLoader({
      cwd: builder.workspace, agentDir: globalDir, settingsManager: SettingsManager.inMemory(),
      noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      systemPrompt: index >= 0 ? args[index + 1] : undefined,
      appendSystemPrompt: [args[args.indexOf("--append-system-prompt") + 1]],
    });
    await loader.reload();
    expect(loader.getSystemPrompt()).not.toContain("GLOBAL_SYSTEM_INTRUDER");
    expect(loader.getSystemPrompt()).toContain("You are an expert coding assistant");
  });

  it("effective override навыка применяется к SDK задачи, snapshot удаляется после завершения", async () => {
    await discoverChatResources("builder");
    const key = LAYER_CATALOG.find(s => s.originRef === skillFile)!.key;
    const owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
    const text = "---\nname: build\ndescription: Updated build instructions\n---\nEffective body.\n";
    applyOverride({ scope: "role", roleKey: "builder", layer: key, text, action: "set", expectedVersion: 0, sourceKind: "file", sourceRef: skillFile, createdBy: owner });
    const loader = await createTaskResourceLoader("builder", project, "Инструкция");
    try {
      const skill = loader.getSkills().skills[0];
      expect(skill.description).toBe("Updated build instructions");
      expect(fs.readFileSync(skill.filePath, "utf8")).toContain("Effective body.");
      expect(fs.readFileSync(skill.filePath, "utf8")).toContain(path.dirname(skillFile));
      expect(fs.readFileSync(skillFile, "utf8")).toContain("Build the project");
      loader.disposeResources();
      expect(fs.existsSync(skill.filePath)).toBe(false);
    } finally {
      loader.disposeResources();
      db.prepare("DELETE FROM role_context_overrides WHERE layer=?").run(key);
      db.prepare("DELETE FROM role_context_overrides_history WHERE layer=?").run(key);
    }
  });

  it("удалённый навык исчезает из discovery и каталога контекста", async () => {
    await discoverChatResources("builder");
    const key = LAYER_CATALOG.find(s => s.originRef === skillFile)!.key;
    fs.unlinkSync(skillFile);
    const resources = await discoverChatResources("builder");
    expect(resources.skills).toEqual([]);
    expect(composeLayer("builder", key)).toBeNull();
  });
});
