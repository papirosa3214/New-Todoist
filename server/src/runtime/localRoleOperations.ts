// Операции роли на .110 с изоляцией (16.10.2026, решение владельца).
//
// Раньше роль на .110 работала от пользователя maksim без всякой изоляции:
// bash видел ~/.ssh (и ходил по ssh на мак с полным доступом), vault, чужие
// .env, а read/write брали любой абсолютный путь. Теперь:
//
//   * bash исполняется от отдельного пользователя tfrole через
//     `sudo -n -u tfrole /bin/bash -c …` (sudoers: только /bin/bash, без пароля).
//     У tfrole нет ключей ssh и доступа к vault; окружение сервера с секретами
//     sudo сбрасывает, PATH и HOME задаём явно;
//   * файловые инструменты (read/write/edit/ls/find/grep) идут через node от
//     maksim, поэтому их держит проверка пути: писать — только рабочая копия
//     задачи и временный каталог, читать — ещё каталог навыков ролей.
//
// Отключение (откат без пересборки клиента): TASKFLOW_ROLE_ISOLATION=off.
import fs from "node:fs";
import crypto from "node:crypto";
import { RoleProcessLease, cleanupRoleProcesses } from "./roleProcessLease.js";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createLocalBashOperations,
  type BashOperations,
  type ReadOperations,
  type WriteOperations,
  type EditOperations,
  type GrepOperations,
  type FindOperations,
  type LsOperations,
} from "@earendil-works/pi-coding-agent";

export const ROLE_USER = process.env.TASKFLOW_ROLE_USER || "tfrole";
const ROLE_HOME = `/home/${ROLE_USER}`;

/**
 * Прокси для bash роли (владелец 28.10.2026): sudo сбрасывает окружение, и
 * роль ходила в сеть без прокси — Anthropic отвечал 403, Telegram молчал.
 * Вход 127.0.0.1:10818 шлюза xray-claude сам решает: закрытое из РФ (AI,
 * Telegram, соцсети, YouTube) — через Happ, остальное напрямую, без потери
 * скорости. Пустой TASKFLOW_ROLE_PROXY выключает.
 */
export function roleProxyExports(env: NodeJS.ProcessEnv = process.env): string {
  const proxy = (env.TASKFLOW_ROLE_PROXY ?? "http://127.0.0.1:10818").replaceAll("'", "");
  if (!proxy) return "";
  const local = "localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,.local";
  return ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"].map(k => `${k}='${proxy}'`)
    .concat([`no_proxy='${local}'`, `NO_PROXY='${local}'`, "NODE_USE_ENV_PROXY=1"]).join(" ");
}

export function roleIsolationEnabled(): boolean {
  return process.env.TASKFLOW_ROLE_ISOLATION !== "off";
}

function rolesDir(): string {
  return path.resolve(process.env.TASKFLOW_ROLES_DIR || path.join(os.homedir(), "taskflow", "roles"));
}

/** Реальный путь: для несуществующего файла — реальный путь ближайшего предка. */
function real(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

export function roleRoots(cwd: string): { write: string[]; read: string[] } {
  const write = [real(cwd), real(os.tmpdir())];
  return { write, read: [...write, real(rolesDir())] };
}

export function guardPath(p: string, roots: string[], mode: "чтение" | "запись"): string {
  const r = real(p);
  if (!roots.some((root) => inside(r, root))) {
    throw new Error(
      `${mode} вне рабочей копии роли запрещено: ${p}. Доступны: ${roots.join(", ")}. ` +
        "Нужен другой каталог — сообщи владельцу точный путь.",
    );
  }
  return r;
}

const q = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";

export function isolatedBashOperations(cwd: string, lease?: RoleProcessLease): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec: async (command, runCwd, options) => {
      const dir = guardPath(runCwd || cwd, roleRoots(cwd).write, "запись");
      // PATH сервера несёт nvm/node; секретов в нём нет, остальное окружение
      // sudo отбрасывает (env_reset) — роль не видит токены процесса сервера.
      const pathVar = (options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin").replaceAll("'", "");
      const processLease = lease ?? new RoleProcessLease(ROLE_USER);
      processLease.ensure();
      const commandId = crypto.randomUUID();
      const inner = `export HOME=${q(ROLE_HOME)} PATH=${q(pathVar)} ${roleProxyExports()} TF_PROCESS_LEASE=${q(processLease.id)} TF_PROCESS_COMMAND=${q(commandId)}; umask 002; cd ${q(dir)} && exec /bin/bash -c ${q(command)}`;
      const wrapped = `sudo -n -u ${ROLE_USER} /bin/bash -c ${q(inner)}`;
      let cleanup: Promise<void> | undefined;
      const stop = () => {
        cleanup ??= cleanupRoleProcesses(ROLE_USER, "command", commandId).catch(error => {
          console.warn("[roleProcesses] command cleanup failed; external guard will retry", String(error));
        });
      };
      options.signal?.addEventListener("abort", stop, {once:true});
      const timer = options.timeout === undefined ? undefined : setTimeout(stop, options.timeout * 1000);
      try {
        const result = await local.exec(wrapped, dir, options);
        if(result.exitCode !== 0)stop();
        return result;
      } catch(error) { stop(); throw error; }
      finally {
        if(timer)clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        if(cleanup)await cleanup;
        if(!lease)await processLease.dispose();
      }
    },
  };
}

/**
 * Доступ tfrole к рабочей копии. git создаёт копию с umask 022, и ACL-маска
 * r-x срезала бы запись tfrole; setfacl -m пересчитывает маску. maksim в
 * default-ACL — чтобы сервер мог править файлы, созданные ролью.
 */
export function grantRoleAccess(dir: string): void {
  const acl = `u:${ROLE_USER}:rwX,d:u:${ROLE_USER}:rwX,u:${os.userInfo().username}:rwX,d:u:${os.userInfo().username}:rwX`;
  try {
    execFileSync("setfacl", ["-R", "-m", acl, dir], { stdio: "ignore", timeout: 60_000 });
  } catch (error) {
    console.warn("[roleIsolation] setfacl не прошёл:", dir, error instanceof Error ? error.message : error);
  }
}

export function isolatedLocalOperations(cwd: string, lease?: RoleProcessLease) {
  grantRoleAccess(cwd);
  const roots = roleRoots(cwd);
  const R = (p: string) => guardPath(p, roots.read, "чтение");
  const W = (p: string) => guardPath(p, roots.write, "запись");
  const read: ReadOperations = {
    readFile: async (p) => fsp.readFile(R(p)),
    access: async (p) => fsp.access(R(p), fs.constants.R_OK),
  };
  const write: WriteOperations = {
    writeFile: async (p, content) => fsp.writeFile(W(p), content, "utf8"),
    mkdir: async (dir) => void (await fsp.mkdir(W(dir), { recursive: true })),
  };
  const edit: EditOperations = {
    readFile: async (p) => fsp.readFile(W(p)),
    writeFile: async (p, content) => fsp.writeFile(W(p), content, "utf8"),
    access: async (p) => fsp.access(W(p), fs.constants.R_OK | fs.constants.W_OK),
  };
  const ls: LsOperations = {
    exists: (p) => fs.existsSync(R(p)),
    stat: async (p) => fsp.stat(R(p)),
    readdir: async (p) => fsp.readdir(R(p)),
  };
  const grep: GrepOperations = {
    isDirectory: async (p) => (await fsp.stat(R(p))).isDirectory(),
    readFile: async (p) => fsp.readFile(R(p), "utf8"),
  };
  const find: FindOperations = {
    exists: (p) => fs.existsSync(R(p)),
    glob: async (pattern, base, options) => {
      const dir = R(base);
      const out: string[] = [];
      for await (const f of fsp.glob(pattern, { cwd: dir, exclude: (n: string) => options.ignore.some((i) => n.includes(i.replaceAll("*", ""))) } as any)) {
        out.push(path.join(dir, String(f)));
        if (out.length >= options.limit) break;
      }
      return out;
    },
  };
  return { bash: isolatedBashOperations(cwd, lease), read, write, edit, ls, grep, find };
}
