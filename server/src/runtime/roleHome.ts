import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Постоянный инструментарий роли, отдельно от живого API и проектов задач. */
export function roleHome(role: string) {
  // В старом реестре встречаются дефисы; новые ключи API используют underscore.
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(role)) throw new Error("недопустимый ключ роли");
  const root = path.resolve(process.env.TASKFLOW_ROLES_DIR || path.join(os.homedir(), "taskflow", "roles"));
  const dir = path.join(root, role);
  return {
    dir,
    agents: path.join(dir, "AGENTS.md"),
    skills: path.join(dir, "skills"),
    scripts: path.join(dir, "scripts"),
    workspace: path.join(dir, "workspace"),
    extensions: path.join(dir, "extensions"),
    prompts: path.join(dir, "prompts"),
    sessions: path.join(dir, "sessions"),
  };
}

export function roleHomeInstruction(role: string): string {
  const home = roleHome(role);
  return [
    `Постоянная папка роли ${role}: ${home.dir}.`,
    `Инструкции роли: ${home.agents}.`,
    `Создавай и изменяй навыки роли в ${home.skills}/<имя-навыка>/SKILL.md. Скрипты и файлы навыка храни рядом с его SKILL.md.`,
    `Общие скрипты этой роли храни в ${home.scripts}. Указывай абсолютный путь, когда работаешь из проекта задачи.`,
    `Рабочие файлы чата храни в ${home.workspace}. В задаче работай в указанной папке проекта; инструментарий роли остаётся в ${home.dir}.`,
    "Не создавай инструментарий роли в исходниках API или в глобальной папке Pi. Доступ к TaskFlow и выбор модели настраивает сервер.",
  ].join("\n");
}

function writeOnce(file: string, text: string): void {
  try { fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** Wrapper лежит у роли; реализация серверного протокола обновляется с сервером. */
function scriptWrapper(name: string): string {
  const source = path.resolve(process.cwd(), "scripts", name);
  return "#!/usr/bin/env python3\n" +
    "# Серверный инструмент TaskFlow. Пользовательские скрипты хранятся рядом.\n" +
    "import runpy, sys\n" +
    `sys.path.insert(0, ${JSON.stringify(path.dirname(source))})\n` +
    `runpy.run_path(${JSON.stringify(source)}, run_name="__main__")\n`;
}

/** Без перезаписи существующих файлов; подходит и для новых пользовательских ролей. */
export function ensureRoleHome(role: string) {
  const home = roleHome(role);
  for (const directory of [home.dir, home.skills, home.scripts, home.workspace, home.extensions, home.prompts, home.sessions]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeOnce(home.agents, `# Роль ${role} в TaskFlow\n\n${roleHomeInstruction(role)}\n`);
  writeOnce(path.join(home.scripts, "mcp_server.py"), scriptWrapper("mcp_server.py"));
  if (role === "researcher") writeOnce(path.join(home.scripts, "research_server.py"), scriptWrapper("research_server.py"));
  return home;
}

function filesUnder(source: string, target: string): string[] {
  if (!fs.statSync(source).isDirectory()) return [target];
  return fs.readdirSync(source).filter(n => !n.startsWith(".")).flatMap(n => filesUnder(path.join(source, n), path.join(target, n)));
}

/** Явный однократный импорт: оригиналы остаются, существующие навыки не смешиваются. */
export function importRoleResources(role: string, legacyDir: string, dryRun = false): string[] {
  const home = dryRun ? roleHome(role) : ensureRoleHome(role);
  const written: string[] = [];
  for (const name of ["skills", "scripts", "extensions", "prompts"] as const) {
    const sourceDir = path.join(legacyDir, name);
    if (!fs.existsSync(sourceDir)) continue;
    for (const entry of fs.readdirSync(sourceDir).filter(n => !n.startsWith("."))) {
      const source = path.join(sourceDir, entry);
      const target = path.join(home[name], entry);
      // Не дополняем существующий навык старыми скриптами: он уже может быть изменён владельцем.
      if (fs.existsSync(target)) continue;
      written.push(...filesUnder(source, target));
      if (!dryRun) fs.cpSync(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
    }
  }
  const legacyAgents = path.join(legacyDir, "AGENTS.md");
  const marker = "legacy-import:" + crypto.createHash("sha256").update(path.resolve(legacyDir)).digest("hex");
  if (fs.existsSync(legacyAgents) && (!fs.existsSync(home.agents) || !fs.readFileSync(home.agents, "utf8").includes(marker))) {
    written.push(home.agents);
    if (!dryRun) fs.appendFileSync(home.agents, `\n<!-- ${marker} -->\n\n## Перенесённые инструкции\n\n${fs.readFileSync(legacyAgents, "utf8")}\n`);
  }
  return written;
}

/** Pi восстанавливает cwd из header сессии. Копируем историю с новым cwd, сохраняя ID и оригинал. */
export async function prepareChatSessionDirectory(role: string, chatId: string, sessionId?: string | null, legacyCwd = process.cwd(), legacySessionDir?: string): Promise<string> {
  const home = ensureRoleHome(role);
  const directory = path.join(home.sessions, crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 24));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!sessionId) return directory;
  const existing = (await SessionManager.list(home.workspace, directory)).find(s => s.id === sessionId);
  if (existing) return directory;
  const legacy = (await SessionManager.list(legacyCwd, legacySessionDir)).find(s => s.id === sessionId);
  if (!legacy) return directory;
  const text = fs.readFileSync(legacy.path, "utf8");
  const boundary = text.indexOf("\n");
  const header = JSON.parse(boundary === -1 ? text : text.slice(0, boundary));
  if (header.type !== "session" || header.id !== sessionId) throw new Error("история чата не соответствует session ID");
  const migrated = JSON.stringify({ ...header, cwd: home.workspace }) + (boundary === -1 ? "\n" : text.slice(boundary));
  writeOnce(path.join(directory, path.basename(legacy.path)), migrated);
  return directory;
}
