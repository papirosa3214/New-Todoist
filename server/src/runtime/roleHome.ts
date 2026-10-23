import {behaviorInstruction} from './roleBehavior.js';
import { roleBlockLines } from "../lib/roleContractV1.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
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
    role: path.join(dir, "ROLE.md"),
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
    `Перед тем как создать или изменить навык, прочитай ${path.join(path.dirname(home.dir), "SKILL-FORMAT.md")}: по имени и описанию из шапки SKILL.md оценщик JEV решает, давать ли навык в работу, — без внятного описания навык не попадёт туда, где нужен.`,
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
 *  командной работы не расходились по текстам.
 *
 *  TASKFLOW_ROLE_SYSTEM_PROMPT — явный путь к канону: нужен проверкам
 *  (временный файл) и нестандартным раскладкам. По умолчанию канон лежит
 *  рядом с сервером, в cwd процесса. */
export function systemPromptSourceFile(): string {
  const explicit = process.env.TASKFLOW_ROLE_SYSTEM_PROMPT;
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), "scripts", "role-system-prompt.md");
}

/** Кэш канона в процессе сервера. Правка канона не должна требовать рестарта:
 *  файл перечитывается, когда изменился (mtime и размер), а между изменениями
 *  содержимое не читается заново — ensureRoleHome зовётся несколько раз на
 *  каждый ход роли, и чтение файла на каждом вызове съедало бюджет хода
 *  (тесты чата ждут порядка 120 мс на завершение первого хода).
 *
 *  В кэше — только успешно прочитанный текст: если файл стал недоступен,
 *  канон не выбрасывается молча (иначе мигающая ошибка правки уронила бы
 *  SYSTEM.md роли на запасную рамку), а запасная рамка остаётся для случая,
 *  когда канон не прочитан ни разу. */
type CanonCache = { file: string; mtimeMs: number; size: number; text: string };
let canonCache: CanonCache | undefined;

/** Прочитать канон с кэшем по mtime/размеру. null — файл недоступен. */
function readCanon(file: string): string | null {
  let mtimeMs = 0;
  let size = 0;
  let available = true;
  try {
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    available = false;
  }
  const cached = canonCache;
  if (cached && cached.file === file) {
    // Файл пропал после успешного чтения — держим прежний текст.
    if (!available) return cached.text;
    if (cached.mtimeMs === mtimeMs && cached.size === size) return cached.text;
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    canonCache = { file, mtimeMs, size, text };
    return text;
  } catch {
    // Недоступный файл — прежнее поведение: запасная рамка. Успешное чтение
    // не запоминаем, чтобы файл, появившийся или ставший доступным позже,
    // подхватился сразу.
    if (canonCache?.file === file) canonCache = undefined;
    return null;
  }
}

/** Подстановка личности роли и её папки в канон. Если файл канона недоступен
 *  (запуск не из server/) — короткая запасная рамка, роль всё равно знает, кто
 *  она и где её инструментарий. */
/** Вид хода: инструкция чата и инструкция карточки — разные каноны. */
export type RunKind = "chat" | "task";

const ADDENDUM_FILES: Record<RunKind, string> = {
  chat: "role-chat-prompt.md",
  task: "role-task-prompt.md",
};

export function promptAddendumSourceFile(kind: RunKind): string {
  return path.resolve(process.cwd(), "scripts", ADDENDUM_FILES[kind]);
}

/**
 * Дополнение к общему канону по виду работы (владелец 23.10.2026: «если
 * задача — инструкция в рамках задачи, если чат — в рамках чата»).
 * Чатовый ход получает цикл чата и обычный текстовый ответ, карточный —
 * контракт ответа, сдачу шага и правила claim/heartbeat/review. Общая часть
 * (кто ты, папка, координация, знания, границы) остаётся одной на всех.
 */
export function renderPromptAddendum(
  kind: RunKind,
  role: string,
  home: ReturnType<typeof roleHome>,
): string {
  const canon = readCanon(promptAddendumSourceFile(kind));
  if (canon === null) return "";
  const identity = `Ты — ${roleTitle(role)} в трекере TaskFlow (ключ роли: ${role}).`;
  const folder = [
    `- папка роли: ${home.dir}`,
    `- инструкция роли (AGENTS.md): ${home.agents}`,
    `- навыки: ${home.skills}/<имя-навыка>/SKILL.md, скрипты и файлы навыка — рядом с его SKILL.md`,
    `- скрипты роли: ${home.scripts} (указывай абсолютный путь)`,
    `- рабочие файлы чата: ${home.workspace}`,
  ].join("\n");
  return canon
    .split("{{IDENTITY}}").join(identity)
    .split("{{FOLDER}}").join(folder)
    .split("{{BLOCKS}}").join(roleBlockLines());
}

export function renderSystemPrompt(role: string, home: ReturnType<typeof roleHome>): string {
  const identity = `Ты — ${roleTitle(role)} в трекере TaskFlow (ключ роли: ${role}).`;
  const folder = [
    `- папка роли: ${home.dir}`,
    `- инструкция роли (AGENTS.md): ${home.agents}`,
    `- навыки: ${home.skills}/<имя-навыка>/SKILL.md, скрипты и файлы навыка — рядом с его SKILL.md`,
    `- скрипты роли: ${home.scripts} (указывай абсолютный путь)`,
    `- рабочие файлы чата: ${home.workspace}`,
  ].join("\n");
  // Канон кэшируется по mtime/размеру: правка файла видна сразу, без
  // рестарта сервера, но между правками содержимое не читается заново.
  const canon = readCanon(systemPromptSourceFile());
  let template = canon ?? "";
  if (canon === null) {
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
  return template.split("{{IDENTITY}}").join(identity).split("{{FOLDER}}").join(folder).split("{{BLOCKS}}").join(roleBlockLines());
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
  writeOnce(home.role, `# Личность роли ${role}\n\nТы — ${roleTitle(role)}. Общайся ясно и уважительно.\n`);
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

/** Инструкция роли — один источник (владелец 20.10.2026): общий шаблон
 *  scripts/role-system-prompt.md (SYSTEM.md, со списком блоков из схемы) и
 *  AGENTS.md в папке роли. roles.prompt в БД и scripts/role-prompts больше не
 *  читаются. withAgents=false — когда AGENTS.md подключает загрузчик ресурсов. */
export function roleInstructionText(role: string, options: { withAgents?: boolean } = {}): string {
  const home = ensureRoleHome(role, { refreshSystem: true });
  const system = fs.readFileSync(home.system, "utf8").trim();
  if (options.withAgents === false) return [system,behaviorInstruction(role)].join("\n\n");
  const agents = fs.existsSync(home.agents) ? fs.readFileSync(home.agents, "utf8").trim() : "";
  return [system, agents, behaviorInstruction(role)].filter(Boolean).join("\n\n");
}

/** Своё у роли — текст AGENTS.md (то, что показывает и правит редактор). */
export function roleAgentsText(role: string): string {
  const home = roleHome(role);
  return fs.existsSync(home.agents) ? fs.readFileSync(home.agents, "utf8").replace(/\n$/, "") : "";
}

/** Правка из редактора инструкций пишет прямо в AGENTS.md роли и коммитит
 *  её в git репозитория ролей (если он есть). Сбой git не отменяет запись. */
export function writeRoleAgents(role: string, text: string, author: string): void {
  const home = ensureRoleHome(role);
  fs.writeFileSync(home.agents, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
  const root = path.dirname(home.dir);
  if (!fs.existsSync(path.join(root, ".git"))) return;
  const rel = path.relative(root, home.agents);
  execFile("git", ["-C", root, "add", "--", rel], (error) => {
    if (error) return;
    execFile("git", ["-C", root, "commit", "-q", "-m", `${role}: правка инструкции из приложения (${author})`, "--", rel], () => {});
  });
}
