import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRoleHome, roleHome, importRoleResources, prepareChatSessionDirectory } from "../src/runtime/roleHome.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-home-test-"));
const previous = process.env.TASKFLOW_ROLES_DIR;
process.env.TASKFLOW_ROLES_DIR = root;
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("постоянная папка роли", () => {
  it("разделяет роли и создаёт инструментарий для нового ключа без списка в коде", () => {
    const builder = ensureRoleHome("builder");
    const custom = ensureRoleHome("custom_role");
    expect(builder.dir).toBe(path.join(root, "builder"));
    expect(custom.workspace).toBe(path.join(root, "custom_role", "workspace"));
    for (const directory of [builder.skills, builder.scripts, builder.workspace]) {
      expect(fs.statSync(directory).isDirectory()).toBe(true);
    }
    expect(fs.readFileSync(builder.agents, "utf8")).toContain("builder");
    expect(fs.readFileSync(builder.agents, "utf8")).toContain(builder.skills);
    expect(fs.readFileSync(builder.agents, "utf8")).toContain(builder.scripts);
  });

  it("не перезаписывает инструкции и скрипты при следующем запуске", () => {
    const home = ensureRoleHome("builder");
    fs.writeFileSync(home.agents, "Мои инструкции");
    fs.writeFileSync(path.join(home.scripts, "mcp_server.py"), "# мой скрипт");
    fs.writeFileSync(path.join(home.skills, "mine.md"), "мой навык");
    ensureRoleHome("builder");
    expect(fs.readFileSync(home.agents, "utf8")).toBe("Мои инструкции");
    expect(fs.readFileSync(path.join(home.scripts, "mcp_server.py"), "utf8")).toBe("# мой скрипт");
    expect(fs.readFileSync(path.join(home.skills, "mine.md"), "utf8")).toBe("мой навык");
  });

  it("сохраняет совместимость со старыми ключами ролей с дефисом", () => {
    expect(ensureRoleHome("builder-legacy").dir).toBe(path.join(root, "builder-legacy"));
  });

  it.each(["../api", "a/b", "/tmp/api", "..", "", "builder/../../api"])("не разрешает путь вместо ключа: %s", (key) => {
    expect(() => roleHome(key)).toThrow(/ключ роли/);
  });

  it("импорт сохраняет относительные скрипты навыка и не затирает локальные изменения", () => {
    const legacy = path.join(root, "old-agent");
    fs.mkdirSync(path.join(legacy, "skills", "mine", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "skills", "mine", "SKILL.md"), "старый навык");
    fs.writeFileSync(path.join(legacy, "skills", "mine", "scripts", "run.py"), "print(1)");
    fs.writeFileSync(path.join(legacy, "AGENTS.md"), "Прежние правила");
    const home = ensureRoleHome("builder");
    importRoleResources("builder", legacy);
    expect(fs.readFileSync(path.join(home.skills, "mine", "scripts", "run.py"), "utf8")).toBe("print(1)");
    const agents = fs.readFileSync(home.agents, "utf8");
    expect(agents).toContain("Прежние правила");
    fs.writeFileSync(path.join(home.skills, "mine", "SKILL.md"), "новый навык");
    importRoleResources("builder", legacy);
    expect(fs.readFileSync(path.join(home.skills, "mine", "SKILL.md"), "utf8")).toBe("новый навык");
    expect(fs.readFileSync(home.agents, "utf8")).toBe(agents);
    expect(fs.readFileSync(path.join(legacy, "skills", "mine", "SKILL.md"), "utf8")).toBe("старый навык");
  });

  it("dry-run импорта не создаёт папку роли", () => {
    const legacy = path.join(root, "old-agent");
    fs.mkdirSync(path.join(legacy, "skills"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "skills", "mine.md"), "старый навык");
    const files = importRoleResources("analyst", legacy, true);
    expect(files).toContain(path.join(roleHome("analyst").skills, "mine.md"));
    expect(fs.existsSync(roleHome("analyst").dir)).toBe(false);
  });

  it("продолжение старого чата сохраняет ID и историю, но меняет cwd на workspace роли", async () => {
    const legacyCwd = path.join(root, "old-api");
    const legacySessions = path.join(root, "old-sessions");
    fs.mkdirSync(legacyCwd, { recursive: true });
    fs.mkdirSync(legacySessions, { recursive: true });
    const id = crypto.randomUUID();
    const legacyFile = path.join(legacySessions, `2026-10-01T00-00-00Z_${id}.jsonl`);
    const history = JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: "2026-10-01T00:00:01Z", message: { role: "user", content: "История чата", timestamp: Date.now() } }) + "\n";
    const original = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00Z", cwd: legacyCwd }) + "\n" + history;
    fs.writeFileSync(legacyFile, original);
    const directory = await prepareChatSessionDirectory("architect", "chat-one", id, legacyCwd, legacySessions);
    const sessions = await SessionManager.list(roleHome("architect").workspace, directory);
    expect(sessions.map(s => s.id)).toEqual([id]);
    const migrated = fs.readFileSync(sessions[0].path, "utf8");
    expect(JSON.parse(migrated.split("\n")[0]).cwd).toBe(roleHome("architect").workspace);
    expect(migrated.slice(migrated.indexOf("\n") + 1)).toBe(history);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(original);
    expect(await prepareChatSessionDirectory("architect", "chat-one", id, legacyCwd, legacySessions)).toBe(directory);
    expect(fs.readdirSync(directory)).toHaveLength(1);
    expect(await prepareChatSessionDirectory("architect", "chat-two")).not.toBe(directory);
  });
});
