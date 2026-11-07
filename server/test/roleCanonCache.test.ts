// Канон системной инструкции (scripts/role-system-prompt.md) не должен
// требовать рестарта сервера.
//
// 21.10.2026: шаблон кэшировался в модульной переменной один раз на процесс,
// поэтому правка канона не доезжала до ролей, а ensureRoleHome(refreshSystem)
// перезаписывал SYSTEM.md старым текстом. Теперь файл перечитывается, когда
// изменился (mtime/размер), а между изменениями не читается заново.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRoleHome, roleHome } from "../src/runtime/roleHome.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "role-canon-"));
const rolesDir = path.join(tmp, "roles");
fs.mkdirSync(rolesDir, { recursive: true });
// Папка ролей из общей подготовки прогона: setup.ts убирает её после всех
// тестов, поэтому её нужно вернуть на место, а не удалять.
const previousRolesDir = process.env.TASKFLOW_ROLES_DIR;

/** Отдельный файл на тест: кэш канона в модуле помнит путь, поэтому тесты
 *  не должны делить один и тот же файл. */
function canonFile(name: string): string {
  return path.join(tmp, `${name}.md`);
}

function writeCanon(file: string, text: string, mtime?: Date): void {
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

function systemText(role = "builder"): string {
  return fs.readFileSync(roleHome(role).system, "utf8");
}

beforeEach(() => {
  process.env.TASKFLOW_ROLES_DIR = rolesDir;
});

afterEach(() => {
  if (previousRolesDir === undefined) delete process.env.TASKFLOW_ROLES_DIR;
  else process.env.TASKFLOW_ROLES_DIR = previousRolesDir;
  delete process.env.TASKFLOW_ROLE_SYSTEM_PROMPT;
  vi.restoreAllMocks();
});

describe("канон системной инструкции", () => {
  it("новая редакция канона доезжает до SYSTEM.md роли без рестарта сервера", () => {
    const file = canonFile("canon-edit");
    process.env.TASKFLOW_ROLE_SYSTEM_PROMPT = file;

    writeCanon(file, "# Канон\n\nправило первое");
    ensureRoleHome("builder", { refreshSystem: true });
    expect(systemText()).toContain("правило первое");

    // Правка канона: содержимое и mtime.
    const later = new Date(Date.now() + 10_000);
    writeCanon(file, "# Канон\n\nправило второе", later);
    ensureRoleHome("builder", { refreshSystem: true });

    const updated = systemText();
    expect(updated).toContain("правило второе");
    expect(updated).not.toContain("правило первое");
  });

  it("изменился только mtime — канон всё равно перечитывается", () => {
    const file = canonFile("canon-mtime");
    process.env.TASKFLOW_ROLE_SYSTEM_PROMPT = file;

    writeCanon(file, "канон А");
    ensureRoleHome("builder", { refreshSystem: true });
    expect(systemText()).toContain("канон А");

    const later = new Date(Date.now() + 10_000);
    writeCanon(file, "канон Б", later); // размер прежний, изменилось время
    ensureRoleHome("builder", { refreshSystem: true });

    const updated = systemText();
    expect(updated).toContain("канон Б");
    expect(updated).not.toContain("канон А");
  });

  it("пока файл не менялся, канон не читается заново", () => {
    const file = canonFile("canon-cache");
    process.env.TASKFLOW_ROLE_SYSTEM_PROMPT = file;

    writeCanon(file, "стабильная редакция канона");
    ensureRoleHome("builder", { refreshSystem: true });

    const spy = vi.spyOn(fs, "readFileSync");
    ensureRoleHome("builder", { refreshSystem: true });
    ensureRoleHome("builder", { refreshSystem: true });
    const reads = spy.mock.calls.filter(call => call[0] === file).length;
    expect(reads).toBe(0);
  });

  it("недоступный канон — запасная рамка, как раньше", () => {
    const file = canonFile("canon-missing");
    process.env.TASKFLOW_ROLE_SYSTEM_PROMPT = file; // файл не создан

    ensureRoleHome("builder", { refreshSystem: true });
    expect(systemText()).toContain("недоступен");
  });
});
