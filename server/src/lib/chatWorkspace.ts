// Рабочая папка чата. LOCK-CHAT-WORKSPACE-20261027.
//
// Владелец 27.10.2026: в чате с Помощником владельца выбрать рабочую папку,
// «как во всех других системах». Выбор — из папок проектов (`~/Проекты/*`),
// ручного пути нет. Репозиторий самого сервера — только копией на ветке
// `roles/chat-<id>`: живое дерево не правится, вливает ветку навык по
// команде владельца.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../db.js";
import { liveServerRepo, roleWorkspace } from "../runtime/roleWorkspace.js";

export interface ChatWorkspaceOption {
  name: string;
  /** Папка — git-репозиторий. */
  git: boolean;
  /** Репозиторий сервера: роль работает в копии, не в живом дереве. */
  copy: boolean;
}

export interface ChatWorkspaceDir {
  cwd: string;
  name: string;
  /** Ветка копии; null — роль работает прямо в папке проекта. */
  branch: string | null;
}

export function projectsRoot(): string {
  return process.env.TASKFLOW_PROJECTS_ROOT || path.join(os.homedir(), "Проекты");
}

function same(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

export function listChatWorkspaces(live: string = liveServerRepo()): ChatWorkspaceOption[] {
  const root = projectsRoot();
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
    .filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((name) => {
      const dir = path.join(root, name);
      return { name, git: fs.existsSync(path.join(dir, ".git")), copy: same(dir, live) };
    });
}

export interface ChatFolderEntry {
  name: string;
  /** Путь от корня проектов: его и сохраняет выбор. */
  path: string;
  git: boolean;
}

export interface ChatFolderListing {
  /** "" — корень проектов. */
  path: string;
  /** Куда «наверх»; null — уже в корне. */
  parent: string | null;
  entries: ChatFolderEntry[];
}

const SKIPPED = new Set(["node_modules"]);

/** Путь от корня проектов без `..`, скрытых и служебных папок; иначе null. */
function cleanRelative(rel: string): string[] | null {
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part.startsWith(".") || part.startsWith("_") || SKIPPED.has(part))) return null;
  return parts;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Обзор папок для шторки (владелец 27.10.2026: «как обычный состав папок —
 * заходить в папку и выходить наверх»). Только внутри корня проектов.
 */
export function browseChatWorkspace(rel: string, live: string = liveServerRepo()): ChatFolderListing | null {
  const parts = cleanRelative(rel);
  if (!parts) return null;
  if (parts.length === 0) {
    return {
      path: "",
      parent: null,
      entries: listChatWorkspaces(live).map((option) => ({ name: option.name, path: option.name, git: option.git })),
    };
  }
  const dir = path.join(projectsRoot(), ...parts);
  if (!isDirectory(dir)) return null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const entries = names
    .filter((name) => cleanRelative(name)?.length === 1 && isDirectory(path.join(dir, name)))
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((name) => ({ name, path: [...parts, name].join("/"), git: fs.existsSync(path.join(dir, name, ".git")) }));
  return { path: parts.join("/"), parent: parts.slice(0, -1).join("/"), entries };
}

export function validChatWorkspace(name: string, live: string = liveServerRepo()): boolean {
  const parts = cleanRelative(name);
  if (!parts?.length) return false;
  if (!listChatWorkspaces(live).some((option) => option.name === parts[0])) return false;
  return isDirectory(path.join(projectsRoot(), ...parts));
}

export function chatIdOfCopy(chatId: string): string {
  return `chat-${chatId}`;
}

/** Папка хода роли для выбранного в чате проекта; null — по умолчанию. */
export function chatWorkspaceDir(
  chatId: string,
  name: string | null | undefined,
  live: string = liveServerRepo(),
): ChatWorkspaceDir | null {
  if (!name || !validChatWorkspace(name, live)) return null;
  const [top, ...sub] = cleanRelative(name)!;
  const option = listChatWorkspaces(live).find((item) => item.name === top);
  if (!option) return null;
  if (!option.copy) return { cwd: path.join(projectsRoot(), top, ...sub), name, branch: null };
  // Внутри репозитория сервера — та же вложенная папка, но в копии.
  const copyId = chatIdOfCopy(chatId);
  const base = roleWorkspace(copyId, live, live);
  const nested = path.join(base, ...sub);
  return { cwd: isDirectory(nested) ? nested : base, name, branch: `roles/${copyId}` };
}

/** Выбор, сохранённый за чатом (колонка `chats.workspace`). */
export function chatWorkspaceName(chatId: string): string | null {
  try {
    const row = db.prepare("SELECT workspace FROM chats WHERE id = ?").get(chatId) as
      | { workspace: string | null }
      | undefined;
    return row?.workspace ?? null;
  } catch {
    return null; // миграция ещё не прошла
  }
}

/** Чат, откуда пришло обращение к коллеге (`steps.coordination_origin`). */
function coordinationOriginChat(messageId: string | undefined): string | null {
  if (!messageId) return null;
  try {
    const row = db
      .prepare("SELECT json_extract(steps,'$.coordination_origin.chat_id') AS origin FROM chat_messages WHERE id = ? AND json_valid(steps)")
      .get(messageId) as { origin: string | null } | undefined;
    return row?.origin ?? null;
  } catch {
    return null;
  }
}

/**
 * Папка хода для чата; при сбое копии — null (ход идёт в папке роли).
 * Коллега, которого привлекли из чата с выбранной папкой, работает в той
 * же папке и той же копии, что и привлёкшая его роль (владелец 27.10.2026).
 */
export function resolveChatWorkspace(chatId: string | undefined, messageId?: string): ChatWorkspaceDir | null {
  if (!chatId) return null;
  try {
    const own = chatWorkspaceName(chatId);
    if (own) return chatWorkspaceDir(chatId, own);
    const origin = coordinationOriginChat(messageId);
    const inherited = origin ? chatWorkspaceName(origin) : null;
    return origin && inherited ? chatWorkspaceDir(origin, inherited) : null;
  } catch (error) {
    console.warn("[chat-workspace] папка чата недоступна:", error instanceof Error ? error.message : error);
    return null;
  }
}
