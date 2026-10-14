import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { roleTitle } from "../roleRouting.js";

export const DELIVERY_STANDARD_NOTE_ID = "0f503d69-bf61-4482-b285-ec388d7d1e3a";

/** Постоянный инструментарий роли, отдельно от живого API и проектов задач. */
export function roleHome(role: string) {
  // В старом реестре встречаются дефисы; новые ключи API используют underscore.
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(role)) throw new Error("недопустимый ключ роли");
  const root = path.resolve(process.env.TASKFLOW_ROLES_DIR || path.join(os.homedir(), "taskflow", "roles"));
  const dir = path.join(root, role);
  return {
    dir,
    system: path.join(dir, "SYSTEM.md"),
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
    "Повтор → навык. Перед работой поищи похожие случаи: свои навыки, taskflow_recall (память), taskflow_docs/taskflow_doc_read (документы и отчёты TaskFlow), taskflow_kb_search (база знаний), taskflow_my_tasks (свои прошлые задачи). После работы запиши себе заметку taskflow_remember: что было → причина → как сделал. "
      + "Если такая же работа или ошибка уже встречалась хотя бы раз, оформи навык или дополни существующий (как писать — навык writing-for-agents) и назови его в отчёте.",
    ...(role === "infra_engineer"
      ? ["Для инфраструктуры это обязательно: каждая починенная поломка, похожая на прошлую, становится навыком «признаки → причина → как чинить → как проверить»."]
      : []),
    `Общие скрипты этой роли храни в ${home.scripts}. Указывай абсолютный путь, когда работаешь из проекта задачи.`,
    `Рабочие файлы чата храни в ${home.workspace}. В задаче работай в указанной папке проекта; инструментарий роли остаётся в ${home.dir}.`,
    "Не создавай инструментарий роли в исходниках API или в глобальной папке Pi. Доступ к TaskFlow и выбор модели настраивает сервер.",
    "Общий обязательный стандарт: Регламент сдачи работы ролями TaskFlow — Library → Norms.",
    `Перед работой прочитай taskflow_doc_read(id="${DELIVERY_STANDARD_NOTE_ID}"); документ: https://192.168.1.110:5180/notes/${DELIVERY_STANDARD_NOTE_ID}.`,
    "Сразу сохраняй человекочитаемый отчёт в документации задачи и передавай report_markdown вместе с result. Итоговый коммит и интеграцию выполняет ответственный из карточки; включай только изменения этой карточки. Не используй git add . / git add -A / git commit -a в общем грязном каталоге, чужие изменения сохраняй. Полный порядок и материалы передачи — в регламенте.",
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

/** Канон системной инструкции — один файл на всех ролей, чтобы правила
 *  командной работы не расходились по текстам. */
export function systemPromptSourceFile(): string {
  return path.resolve(process.cwd(), "scripts", "role-system-prompt.md");
}

/** Подстановка личности роли и её папки в канон. Если файл канона недоступен
 *  (запуск не из server/) — короткая запасная рамка, роль всё равно знает, кто
 *  она и где её инструментарий. */
let systemTemplate: string | null | undefined;

export function renderSystemPrompt(role: string, home: ReturnType<typeof roleHome>): string {
  const identity = `Ты — ${roleTitle(role)} в трекере TaskFlow (ключ роли: ${role}).`;
  const folder = [
    `- папка роли: ${home.dir}`,
    `- инструкция роли (AGENTS.md): ${home.agents}`,
    `- навыки: ${home.skills}/<имя-навыка>/SKILL.md, скрипты и файлы навыка — рядом с его SKILL.md`,
    `- скрипты роли: ${home.scripts} (указывай абсолютный путь)`,
    `- рабочие файлы чата: ${home.workspace}`,
  ].join("\n");
  // Канон читается один раз за процесс: ensureRoleHome зовётся несколько раз на
  // каждый ход роли, и синхронное чтение файла на каждом вызове съедало
  // бюджет (тесты чата ждут порядка 120 мс на завершение первого хода).
  if (systemTemplate === undefined) {
    try {
      systemTemplate = fs.readFileSync(systemPromptSourceFile(), "utf8");
    } catch {
      systemTemplate = null;
    }
  }
  let template = systemTemplate ?? "";
  if (systemTemplate === null) {
    template = [
      "# Системная инструкция роли",
      "",
      "## Кто ты",
      "",
      identity,
      "",
      "Ты работаешь в трекере TaskFlow: карточки, роли, инструменты, ответственность за результат.",
      "",
      "## Твоя папка",
      "",
      folder,
      "",
      "Канон роли (scripts/role-system-prompt.md) в этом запуске недоступен.",
    ].join("\n");
  }
  return template.split("{{IDENTITY}}").join(identity).split("{{FOLDER}}").join(folder);
}

/** Без перезаписи существующих файлов; подходит и для новых пользовательских ролей.
 *  `refreshSystem` перезаписывает ТОЛЬКО SYSTEM.md из канона — он под правку
 *  владельца не отдаётся, но иначе новая редакция канона никогда бы не дошла
 *  до уже созданных ролей (writeOnce по умолчанию). */
export function ensureRoleHome(role: string, options: { refreshSystem?: boolean } = {}) {
  const home = roleHome(role);
  for (const directory of [home.dir, home.skills, home.scripts, home.workspace, home.extensions, home.prompts, home.sessions]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (options.refreshSystem) {
    fs.writeFileSync(home.system, renderSystemPrompt(role, home), { mode: 0o600 });
  } else {
    writeOnce(home.system, renderSystemPrompt(role, home));
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
