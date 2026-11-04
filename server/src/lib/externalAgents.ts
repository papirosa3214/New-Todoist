// Внешние агенты: каталог известных CLI-агентов и их поиск на машине.
//
// Владелец 19.10.2026: агенты не программируются по одному — нажал «Обновить»,
// сервер нашёл на .110 установленные бинарники и сам завёл каждого участником
// со своим именем и иконкой. Внутренние роли (Pi) это не трогает.
//
// Добавить нового агента в каталог — одна запись ниже. Запускать участника
// умеет только агент с готовым адаптером (adapter). Остальные находятся и
// показываются, но заводятся участниками, только когда появится их адаптер.
//
// Claude Code из каталога убран (владелец 04.11.2026): внешний агент не
// нужен, а с ним из чатов и боковой панели уходил краб-аватаркой. Код
// поддержки (stream-json) остался — он не оживает без записи в каталоге;
// роль и учётка участника погашены миграцией 197.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../db.js";
import { refreshRoles, roleUserId } from "../roleRouting.js";
import { AVATAR_DIR } from "../routes/avatars.js";

/** claude-stream-json — Claude Code (`-p --output-format stream-json`, по подписке);
 *  acp — агент сам говорит по Agent Client Protocol (runtime/acpAgentSession.ts). */
export type AgentAdapter = "claude-stream-json" | "acp";

export interface KnownAgent {
  /** Значение roles.runtime. */
  runtime: string;
  /** Ключ роли участника (учётка role_<key>). */
  key: string;
  title: string;
  summary: string;
  binary: string;
  adapter: AgentAdapter | null;
  /** Аргументы запуска в режиме ACP (для adapter = "acp"). */
  acpArgs?: string[];
  color: string;
  initials: string;
  /** Иконка из установки самого агента (первый существующий путь). */
  localIcons?: string[];
  /** Логотип simpleicons.org (slug), если локальной нет. */
  simpleIcon?: string;
  /** Модели для пилюли в окне ввода чата (id уходит агенту в --model). */
  models?: Array<{ id: string; title: string }>;
}

const HOME = os.homedir();

export const KNOWN_AGENTS: KnownAgent[] = [
  {
    runtime: "codex",
    key: "codex",
    title: "Codex",
    binary: "codex",
    adapter: null,
    summary: "внешний агент Codex (OpenAI) в своём окружении.",
    color: "#10A37F",
    initials: "CX",
  },
  {
    runtime: "gemini",
    key: "gemini",
    title: "Gemini CLI",
    binary: "gemini",
    adapter: "acp",
    acpArgs: ["--acp"],
    summary: "внешний агент Gemini CLI в своём окружении.",
    color: "#4285F4",
    initials: "GM",
    simpleIcon: "googlegemini",
  },
  {
    runtime: "hermes",
    key: "hermes",
    title: "Гермес",
    binary: "hermes",
    adapter: "acp",
    acpArgs: ["acp"],
    summary: "внешний агент Hermes в своём окружении.",
    color: "#8E7CC3",
    initials: "HM",
    localIcons: [
      path.join(HOME, ".hermes/hermes-agent/assets/icon-master.svg"),
    ],
  },
  {
    runtime: "opencode",
    key: "opencode",
    title: "OpenCode",
    binary: "opencode",
    adapter: "acp",
    acpArgs: ["acp"],
    summary: "внешний агент OpenCode в своём окружении.",
    color: "#211E1E",
    initials: "OC",
  },
];

/** Где искать бинарники: у systemd-сервиса PATH короткий, а агенты стоят в npm-global и ~/.local. */
const EXTRA_DIRS = [
  path.join(HOME, ".npm-global/bin"),
  path.join(HOME, ".local/bin"),
  "/usr/local/bin",
  "/usr/bin",
];

export interface DiscoveredAgent {
  runtime: string;
  key: string;
  title: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Есть адаптер — может работать участником. */
  supported: boolean;
  /** Заведён участником и включён. */
  enabled: boolean;
}

export function findBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...EXTRA_DIRS];
  for (const dir of dirs) {
    const full = path.join(dir, binary);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* дальше */
    }
  }
  return null;
}

function versionOf(full: string): string | null {
  try {
    const out = execFileSync(full, ["--version"], {
      timeout: 15_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\d+\.\d+/.test(l));
    return line ? line.slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** Путь к бинарнику участника-внешнего агента (по его runtime). */
export function agentBinary(runtime: string): string | null {
  const agent = KNOWN_AGENTS.find((a) => a.runtime === runtime);
  return agent ? findBinary(agent.binary) : null;
}

export function knownAgent(runtime: string): KnownAgent | undefined {
  return KNOWN_AGENTS.find((a) => a.runtime === runtime);
}

function badgeSvg(agent: KnownAgent): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${agent.color}"/>` +
    `<text x="32" y="41" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="24" font-weight="600" fill="#fff" text-anchor="middle">${agent.initials}</text></svg>`
  );
}

async function iconSvg(
  agent: KnownAgent,
  fetcher: typeof fetch,
): Promise<string> {
  for (const file of agent.localIcons ?? []) {
    try {
      const svg = fs.readFileSync(file, "utf8");
      if (svg.includes("<svg")) return svg;
    } catch {
      /* дальше */
    }
  }
  if (agent.simpleIcon) {
    try {
      const res = await fetcher(
        `https://cdn.simpleicons.org/${agent.simpleIcon}/${agent.color.slice(1)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      const svg = res.ok ? await res.text() : "";
      if (svg.includes("<svg")) return svg;
    } catch {
      /* сети нет — значок с буквами */
    }
  }
  return badgeSvg(agent);
}

/** Сохранить иконку под именем с хешем (аватарки кешируются навсегда) и вернуть адрес. */
function storeIcon(agent: KnownAgent, svg: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(svg)
    .digest("hex")
    .slice(0, 12);
  const name = `agent-${agent.runtime}-${hash}.svg`;
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const full = path.join(AVATAR_DIR, name);
  if (!fs.existsSync(full)) fs.writeFileSync(full, svg);
  return `/api/avatars/${name}`;
}

function participantEnabled(agent: KnownAgent): boolean {
  const row = db
    .prepare("SELECT enabled, runtime FROM roles WHERE key = ?")
    .get(agent.key) as { enabled: number; runtime: string } | undefined;
  return !!row && row.enabled === 1 && row.runtime === agent.runtime;
}

/** Только посмотреть, что установлено (без изменений). */
export function discoverExternalAgents(): DiscoveredAgent[] {
  return KNOWN_AGENTS.map((agent) => {
    const full = findBinary(agent.binary);
    return {
      runtime: agent.runtime,
      key: agent.key,
      title: agent.title,
      installed: !!full,
      path: full,
      version: full ? versionOf(full) : null,
      supported: agent.adapter !== null,
      enabled: participantEnabled(agent),
    };
  });
}

/**
 * Кнопка «Обновить»: установленный агент с адаптером заводится участником
 * (или включается снова), пропавший — отключается (не удаляется: история его
 * задач остаётся). Чужую внутреннюю роль с тем же ключом не трогаем.
 */
export async function syncExternalAgents(
  fetcher: typeof fetch = fetch,
): Promise<DiscoveredAgent[]> {
  const found = discoverExternalAgents();
  for (const item of found) {
    const agent = knownAgent(item.runtime)!;
    const role = db
      .prepare("SELECT runtime FROM roles WHERE key = ?")
      .get(agent.key) as { runtime: string } | undefined;
    if (role && role.runtime !== agent.runtime) continue;
    const userId = roleUserId(agent.key);
    if (item.installed && item.supported) {
      const avatar = storeIcon(agent, await iconSvg(agent, fetcher));
      db.transaction(() => {
        if (!role) {
          const position = (
            db
              .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roles")
              .get() as { p: number }
          ).p;
          db.prepare(
            "INSERT INTO roles (key, title, summary, enabled, position, prompt, runtime) VALUES (?, ?, ?, 1, ?, NULL, ?)",
          ).run(agent.key, agent.title, agent.summary, position, agent.runtime);
        } else {
          db.prepare("UPDATE roles SET enabled = 1 WHERE key = ?").run(
            agent.key,
          );
        }
        if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
          db.prepare(
            `INSERT INTO users (id, name, email, password_hash, role, role_key, type, is_system_bot, profile, initials, avatar_color, avatar_url)
            VALUES (?, ?, ?, '!no-login', 'agent', ?, 'ai', 1, ?, ?, ?, ?)`,
          ).run(
            userId,
            agent.title,
            `${agent.key.replace(/_/g, "-")}@taskflow.local`,
            agent.key,
            agent.key,
            agent.initials,
            agent.color,
            avatar,
          );
        } else {
          // Аватарку, поставленную владельцем руками, не трогаем — меняем только свою авто-иконку.
          db.prepare(
            "UPDATE users SET archived = 0, avatar_url = CASE WHEN avatar_url IS NULL OR avatar_url LIKE '/api/avatars/agent-%' THEN ? ELSE avatar_url END WHERE id = ?",
          ).run(avatar, userId);
        }
      })();
    } else if (role) {
      db.prepare("UPDATE roles SET enabled = 0 WHERE key = ?").run(agent.key);
    }
  }
  refreshRoles();
  return discoverExternalAgents();
}
