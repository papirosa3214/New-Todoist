// Меню команд Telegram для @ckor22_bot (этап 2 плана note://a2475482).
//
// Источник истины — существующий реестр чата `listChatCommands`: меню бота не
// заводит второй список команд. Здесь только перевод реестра в формат Bot API
// (`BotCommand.command` — 1–32 символа `a-z0-9_`, `description` — 1–256;
// обрезаем, не выдумываем) и разбор выбранной команды в существующий вызов
// `/skill:` / `/mcp:`. Кэш в памяти: `listChatCommands` читает файлы навыков и
// каталог инструментов, это не бесплатно.
import { createHash } from "node:crypto";
import { listChatCommands, parseSlashInvocation, resolveSlashCommand, type ChatCommand } from "../runtime/chatCommands.js";
import { chatExecutionMode } from "../runtime/chatExecutionMode.js";

/** Роль и режим для Telegram фиксированы: меню показывает команды Помощника. */
export const TELEGRAM_COMMANDS_ROLE = "secretary";
export const TELEGRAM_COMMANDS_MODE = "work" as const;
export const TELEGRAM_CHAT_ID = "chat-secretary";

/** Telegram допускает 100 команд (Bot API 10.3); держим 60 как Hermes. */
export const TELEGRAM_COMMAND_CAP = 60;
export const TELEGRAM_COMMAND_MAX_LENGTH = 32;
export const TELEGRAM_COMMAND_DESCRIPTION_MAX = 256;

export type TelegramBotCommand = { command: string; description: string };

/**
 * Имя команды из карточки реестра: `taskflow_ask_user_question` → `ask_user_question`.
 * Допустимы только `a-z0-9_` и не длиннее 32 символов — иначе Telegram отвергнет
 * весь `setMyCommands`, а не одну команду.
 */
export function telegramCommandName(title: string): string | null {
  const normalized = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const short = normalized.replace(/^taskflow_/, "");
  const candidate = (short || normalized).slice(0, TELEGRAM_COMMAND_MAX_LENGTH).replace(/_+$/, "");
  return candidate.length >= 1 && /^[a-z0-9_]+$/.test(candidate) ? candidate : null;
}

export type TelegramCommandEntry = TelegramBotCommand & {
  /** Готовая строка вызова для реестра чата: `/skill:имя` или `/mcp:имя`. */
  invocation: string;
};

/** Реестр чата → команды Bot API с обратной связью на вызов. Без cap. */
export function toTelegramCommands(commands: ChatCommand[]): TelegramCommandEntry[] {
  const seen = new Set<string>();
  const result: TelegramCommandEntry[] = [];
  for (const item of commands) {
    const command = telegramCommandName(item.id) ?? telegramCommandName(item.title);
    if (!command || seen.has(command)) continue;
    const description = String(item.description || item.summary || item.title || command)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, TELEGRAM_COMMAND_DESCRIPTION_MAX);
    if (!description) continue;
    seen.add(command);
    result.push({ command, description, invocation: item.invocation.trim() || `/skill:${item.id}` });
  }
  return result;
}

let cache: { all: TelegramCommandEntry[]; version: string; builtAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function buildTelegramCommands(): Promise<{ all: TelegramCommandEntry[]; version: string }> {
  const registry = await listChatCommands({
    role: TELEGRAM_COMMANDS_ROLE,
    executionMode: chatExecutionMode(TELEGRAM_CHAT_ID),
    mode: TELEGRAM_COMMANDS_MODE,
    chatId: TELEGRAM_CHAT_ID,
  });
  const all = toTelegramCommands(registry);
  return { all, version: createHash("sha256").update(JSON.stringify(all)).digest("hex").slice(0, 16) };
}

/**
 * Команды для меню бота и inline-поиска.
 * `menu` уже обрезан по cap; `all` — полный список для `answerInlineQuery`.
 */
export async function telegramCommands(options: { force?: boolean } = {}): Promise<{
  menu: TelegramCommandEntry[];
  all: TelegramCommandEntry[];
  version: string;
}> {
  if (!options.force && cache && Date.now() - cache.builtAt < CACHE_TTL_MS) {
    return { menu: cache.all.slice(0, TELEGRAM_COMMAND_CAP), all: cache.all, version: cache.version };
  }
  const built = await buildTelegramCommands();
  cache = { ...built, builtAt: Date.now() };
  return { menu: built.all.slice(0, TELEGRAM_COMMAND_CAP), all: built.all, version: built.version };
}

/** Только для проверок: сбросить кэш реестра. */
export function resetTelegramCommandsCache(): void {
  cache = null;
}

/**
 * Выбор команды из меню Telegram → текст, который поймёт существующий путь.
 *
 * Gateway пересылает `/<command>` (или `/skill:имя`, `/mcp:имя`) без второй
 * маршрутизации: имя переводится в тот же явный вызов, который владелец набрал
 * бы руками, и проверяется `resolveSlashCommand` — неизвестное имя отклоняется.
 */
export async function resolveTelegramCommandText(text: string): Promise<{ ok: true; role_text: string } | { ok: false; error: string } | null> {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) return null;
  const direct = parseSlashInvocation(raw);
  if (direct) {
    const resolution = await resolveSlashCommand({
      role: TELEGRAM_COMMANDS_ROLE,
      invocation: direct,
      executionMode: chatExecutionMode(TELEGRAM_CHAT_ID),
      mode: TELEGRAM_COMMANDS_MODE,
      chatId: TELEGRAM_CHAT_ID,
    });
    return resolution.ok ? { ok: true, role_text: resolution.text } : { ok: false, error: resolution.error };
  }
  const match = /^\/([a-z0-9_]{1,32})(?:[ \t]+([\s\S]*))?$/.exec(raw);
  if (!match) return null;
  const { all } = await telegramCommands();
  const entry = all.find((item) => item.command === match[1]);
  // `/start`, `/help` и прочее вне реестра — обычный текст, а не отказ:
  // сообщение владельца не должно теряться из-за неизвестного слэша.
  if (!entry) return null;
  const invocation = parseSlashInvocation(`${entry.invocation} ${match[2] ?? ""}`);
  if (!invocation) return { ok: false, error: `Команда «${match[1]}» не разобрана в вызов` };
  const resolution = await resolveSlashCommand({
    role: TELEGRAM_COMMANDS_ROLE,
    invocation,
    executionMode: chatExecutionMode(TELEGRAM_CHAT_ID),
    mode: TELEGRAM_COMMANDS_MODE,
    chatId: TELEGRAM_CHAT_ID,
  });
  return resolution.ok ? { ok: true, role_text: resolution.text } : { ok: false, error: resolution.error };
}
