// Падение хода в чате у ролей researcher и secretary (31.10.2026):
// «Cannot read properties of null (reading 'effective')». Причина: слой
// навыка Исследователя подключён и Помощнице (карточка e11eae7a), ключ слоя —
// хеш пути файла, а фильтр ролей — нет. Раньше побеждала первая регистрация,
// и вторая роль получала composeLayer = null, а код брал .effective без
// проверки. Здесь: слой виден обеим ролям, а доступ к тексту null-safe.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { chatInstructionArgs } from "../src/runtime/instructionResources.js";
import { registerInstructionBlock, composeLayer, LAYER_CATALOG } from "../src/lib/roleContextResolver.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

migrate();
runMigrations();

describe("слой инструкции: роли и null-safe доступ", () => {
  let rolesDir: string;
  let previousRolesDir: string | undefined;

  beforeAll(() => {
    previousRolesDir = process.env.TASKFLOW_ROLES_DIR;
    rolesDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-roles-"));
    process.env.TASKFLOW_ROLES_DIR = rolesDir;
    // Навык Исследователя: Помощница подключает навыки исследователя.
    const skill = path.join(rolesDir, "researcher", "skills", "demo-skill");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Демо-навык\n---\n\nТекст навыка.\n",
    );
  });

  afterAll(() => {
    if (previousRolesDir === undefined) delete process.env.TASKFLOW_ROLES_DIR;
    else process.env.TASKFLOW_ROLES_DIR = previousRolesDir;
    fs.rmSync(rolesDir, { recursive: true, force: true });
  });

  it("один слой, зарегистрированный двумя ролями, виден обеим", () => {
    const key = "resource.test-shared-layer";
    const origin = path.join(rolesDir, "shared.md");
    fs.writeFileSync(origin, "текст слоя");
    registerInstructionBlock(
      {
        key,
        title: "Общий слой",
        group: "Контекст",
        scope: "role",
        roles: ["secretary"],
        modes: ["chat"],
        sourceKind: "file",
        originRef: origin,
        readOnly: true,
      },
      "текст слоя",
    );
    registerInstructionBlock(
      {
        key,
        title: "Общий слой",
        group: "Контекст",
        scope: "role",
        roles: ["researcher"],
        modes: ["chat"],
        sourceKind: "file",
        originRef: origin,
        readOnly: true,
      },
      "текст слоя",
    );
    expect(composeLayer("secretary", key)?.effective).toBe("текст слоя");
    expect(composeLayer("researcher", key)?.effective).toBe("текст слоя");
    // Чужая роль слой по-прежнему не получает.
    expect(composeLayer("builder", key)).toBeNull();
  });

  it("ход в чате у Помощницы и Исследователя не падает на слое навыка", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-chat-args-"));
    try {
      // Помощница подключает навыки Исследователя — слой регистрируется с
      // фильтром ролей. Исследователь подключается следом: раньше его слой
      // отдавал null, и падение было «Cannot read properties of null».
      await chatInstructionArgs("secretary", path.join(dir, "secretary.json"));
      const researcherArgs = await chatInstructionArgs(
        "researcher",
        path.join(dir, "researcher.json"),
      );
      expect(researcherArgs.length).toBeGreaterThan(0);
      // Навык попадает в снимок навыков, а не в основной промпт.
      const skillsDir = path.join(dir, "researcher.json.skills");
      const snapshots = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
      expect(snapshots.length).toBeGreaterThan(0);
      const snapshot = fs.readFileSync(path.join(skillsDir, snapshots[0]), "utf8");
      expect(snapshot).toContain("Текст навыка.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("инструменты роли собираются, даже если слой описания недоступен", () => {
    const tools = taskflowTools("secretary", null, undefined, undefined, true, {
      chatId: "",
      messageId: "",
    });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools as any[]) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("каталог слоёв не теряет общий навык после регистрации другой роли", () => {
    const key = "resource.test-shared-layer";
    expect(LAYER_CATALOG.some((s) => s.key === key)).toBe(true);
  });
});
