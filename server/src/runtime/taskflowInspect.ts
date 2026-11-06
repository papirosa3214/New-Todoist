// taskflow_inspect — запуск команд ТОЛЬКО НА ЧТЕНИЕ по белому списку (решение
// владельца 06.11.2026). Строка команды разбирается здесь, без shell: сервер
// запускает процессы напрямую, на Mac команда уходит с каждым словом в кавычках.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "typebox";
import { runOperation, isMachineOnline } from "../host/gateway.js";
import { listMachines } from "../host/machines.js";
import { roleHome } from "./roleHome.js";
import type { Tool } from "./universalTaskflow.js";

export type ParsedInspect = { ok: true; stages: string[][] } | { ok: false; reason: string };
export const INSPECT_TIMEOUT_MS = 60_000;
export const INSPECT_DEFAULT_LINES = 80;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

const deny = (reason: string): ParsedInspect => ({ ok: false, reason });

/** Разбор строки в этапы конвейера: кавычки учитываются, управляющие символы вне кавычек отклоняются. */
export function tokenizePipeline(command: string): { ok: true; stages: string[][] } | { ok: false; reason: string } {
  if (!command || !command.trim()) return { ok: false, reason: "пустая команда" };
  if (command.includes("`") || command.includes("$(")) return { ok: false, reason: "подстановка команд (`...` или $() запрещена" };
  const stages: string[][] = [[]];
  let cur = "", has = false, quote: "'" | '"' | null = null;
  const push = () => { if (has) stages[stages.length - 1].push(cur); cur = ""; has = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\n" || ch === "\r") return { ok: false, reason: "перевод строки вне кавычек" };
    if (ch === "\\") { return { ok: false, reason: "обратный слэш вне кавычек не поддерживается" }; }
    if (ch === " " || ch === "\t") { push(); continue; }
    if (ch === "|") {
      if (command[i + 1] === "|") return { ok: false, reason: "оператор || запрещён" };
      push();
      if (!stages[stages.length - 1].length) return { ok: false, reason: "пустая команда в конвейере" };
      stages.push([]);
      continue;
    }
    if (ch === ";") return { ok: false, reason: "оператор ; запрещён" };
    if (ch === "&") return { ok: false, reason: "операторы & и && запрещены" };
    if (ch === ">" || ch === "<") return { ok: false, reason: "перенаправление ввода/вывода запрещено" };
    cur += ch; has = true;
  }
  if (quote) return { ok: false, reason: "незакрытая кавычка" };
  push();
  if (stages.some(s => !s.length)) return { ok: false, reason: "пустая команда в конвейере" };
  return { ok: true, stages };
}

const has = (a: string[], f: string[]) => a.some(x => f.some(y => x === y || (y.startsWith("--") && x.startsWith(y + "="))));
const hasPrefix = (a: string[], p: string[]) => a.some(x => p.some(y => x.startsWith(y)));

const GIT_SUB = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "remote"]);
const SYSTEMCTL_SUB = new Set(["status", "is-active", "show", "list-units"]);

/** Проверка одного этапа. Возвращает причину отказа или null. */
export function stageDenial(tokens: string[]): string | null {
  const [cmd, ...a] = tokens;
  if (cmd.includes("/")) return "команда должна называться по имени, без пути: " + cmd;
  if (a.some(x => /environ/.test(x))) return "чтение environ запрещено";
  switch (cmd) {
    case "git": {
      const sub = a[0];
      if (!sub || sub.startsWith("-")) return "git: до подкоманды параметры не допускаются";
      if (!GIT_SUB.has(sub)) return "git " + sub + " не входит в список чтения (status/log/diff/show/branch/rev-parse/ls-files/blame/remote -v)";
      const rest = a.slice(1);
      if (hasPrefix(rest, ["--output", "--ext-diff", "--textconv", "--exec"])) return "git: параметр записи или запуска программ запрещён";
      if (sub === "remote") return rest.length === 1 && rest[0] === "-v" ? null : "git remote допустим только как «git remote -v»";
      if (sub === "branch") {
        const bad = ["-d", "-D", "-m", "-M", "-c", "-C", "-u", "--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description", "--force", "-f", "--track", "-t"];
        if (has(rest, bad)) return "git branch: изменяющий параметр запрещён";
        const valueFlags = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--format", "--sort", "--points-at", "--column"]);
        const listing = has(rest, ["-l", "--list"]);
        for (let i = 0; i < rest.length; i++) {
          if (rest[i].startsWith("-")) continue;
          if (valueFlags.has(rest[i - 1] ?? "")) continue;
          if (!listing) return "git branch с именем создаёт ветку; для шаблона добавь --list";
        }
      }
      return null;
    }
    case "rg": return hasPrefix(a, ["--pre", "--hostname-bin"]) ? "rg: --pre/--hostname-bin запускают программы" : null;
    case "grep": case "ls": case "cat": case "head": case "wc": case "cut": case "stat": case "du": case "df":
    case "pgrep": case "uptime": case "free": return null;
    case "find": {
      const bad = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
      return a.some(x => bad.includes(x)) ? "find: -delete/-exec/-execdir/-fprint запрещены" : null;
    }
    case "tail": return a.some(x => x === "-f" || x === "-F" || x.startsWith("--follow") || /^-[a-zA-Z0-9]*[fF]/.test(x)) ? "tail -f запрещён" : null;
    case "sort": return a.some(x => x === "-o" || x.startsWith("--output") || x.startsWith("--compress-program") || /^-[a-zA-Z]*o/.test(x)) ? "sort: запись в файл запрещена" : null;
    case "uniq": return a.filter(x => !x.startsWith("-") && !/^\d+$/.test(x)).length > 1 ? "uniq: второй файл — это запись" : null;
    case "jq": return a.some(x => /\benv\b|\$ENV|\$__prog_args|input_filename/.test(x)) ? "jq: чтение окружения запрещено" : null;
    case "file": return has(a, ["-C", "--compile"]) ? "file -C пишет файл" : null;
    case "ps": return a.some((x, i) => i === 0 && /^[a-zA-Z]+$/.test(x) && /[eE]/.test(x)) ? "ps: стиль с «e» показывает окружение процессов" : null;
    case "nvidia-smi": {
      const ok = /^(-q|-L|-i|-d|-x|-m|-s|-u|-h|--help|--query-[a-z-]+(=.*)?|--format=.*|--id=.*|--display=.*|-lms|--list-gpus)$/;
      for (let i = 0; i < a.length; i++) {
        if (a[i].startsWith("-")) { if (!ok.test(a[i])) return "nvidia-smi: параметр не входит в список чтения: " + a[i]; }
        else if (!["topo", "pmon", "dmon", "nvlink"].includes(a[i]) && !/^-(i|d|s|u|m)$/.test(a[i - 1] ?? "") && !(a[i - 1] ?? "").startsWith("--")) return "nvidia-smi: неожиданный аргумент " + a[i];
      }
      return null;
    }
    case "systemctl": {
      const bad = a.filter(x => x === "--host" || x.startsWith("--host=") || x === "-H" || x === "-M" || x.startsWith("--machine"));
      if (bad.length) return "systemctl: удалённые параметры запрещены";
      const sub = a.find((x, i) => !x.startsWith("-") && !/^(-n|--lines|-t|--type|-p|--property|-o|--output|--state|-s|--signal)$/.test(a[i - 1] ?? ""));
      if (!sub) return "systemctl: не указана подкоманда";
      return SYSTEMCTL_SUB.has(sub) ? null : "systemctl " + sub + " не входит в список чтения (status/is-active/show/list-units)";
    }
    case "journalctl": return a.some(x => /^(--vacuum|--rotate|--flush|--sync|--relinquish|--smart-relinquish|--setup-keys|--update-catalog|--follow)/.test(x) || x === "-f" || /^-[a-zA-Z0-9]*f/.test(x) && !x.startsWith("--")) ? "journalctl: изменяющий параметр или -f запрещён" : null;
    case "sqlite3": {
      if (!a.includes("-readonly")) return "sqlite3 только с флагом -readonly";
      if (hasPrefix(a, ["-init", "-cmd"]) ) return "sqlite3: -init/-cmd запрещены";
      for (const x of a) {
        if (/(^|\s|;)\.(output|once|shell|system|import|save|backup|read|load|cd|open|log|excel|www|clone|recover|restore|connection|auth|trace|testcase|archive|expert|sha3sum|dbconfig)\b/i.test(x)) return "sqlite3: точечная команда записи/запуска запрещена";
        if (/\battach\b/i.test(x)) return "sqlite3: ATTACH запрещён";
        if (/\b(vacuum|writefile|load_extension|edit)\b/i.test(x)) return "sqlite3: VACUUM/writefile/load_extension запрещены";
        if (/\n\s*\./.test(x)) return "sqlite3: точечные команды после перевода строки запрещены";
      }
      return null;
    }
    case "curl": return curlDenial(a);
    case "xcodebuild": {
      if (!has(a, ["-list", "-showBuildSettings"])) return "xcodebuild только с -list или -showBuildSettings";
      const actions = ["build", "test", "clean", "archive", "install", "installsrc", "analyze", "build-for-testing", "test-without-building", "docbuild", "exportArchive", "-exportArchive", "-resolvePackageDependencies"];
      return a.some(x => actions.includes(x)) ? "xcodebuild: действие запрещено" : null;
    }
    case "ss": return has(a, ["-K", "--kill"]) ? "ss -K закрывает соединения" : null;
    case "ip": {
      const pos = a.filter(x => !x.startsWith("-"));
      if (!["addr", "address", "a"].includes(pos[0] ?? "")) return "ip: только «ip addr»";
      return pos.some(x => ["add", "del", "delete", "flush", "change", "replace", "save", "restore"].includes(x)) ? "ip addr: изменяющая подкоманда запрещена" : null;
    }
    case "ping": {
      if (has(a, ["-f", "-b", "-l"])) return "ping: параметр -f/-b/-l запрещён";
      const i = a.findIndex(x => x === "-c" || /^-c\d+$/.test(x));
      if (i < 0) return "ping только с -c N";
      const n = Number(a[i] === "-c" ? a[i + 1] : a[i].slice(2));
      return Number.isInteger(n) && n >= 1 && n <= 20 ? null : "ping -c: число от 1 до 20";
    }
    default: return "команда «" + cmd + "» не в белом списке";
  }
}

function curlDenial(a: string[]): string | null {
  const longBad = ["--data", "--form", "--json", "--upload", "--output", "--remote-name", "--dump-header", "--cookie-jar", "--config", "--trace", "--stderr", "--libcurl", "--create-dirs", "--post", "--append"];
  const noArg = new Set(["X", "H", "A", "e", "u", "x", "m", "w", "E", "b", "C", "y", "Y", "z", "r", "t", "U", "P", "Q"]);
  const badShort = new Set(["d", "F", "T", "o", "O", "K", "D", "c", "J", "a"]);
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t.startsWith("--")) {
      if (longBad.some(b => t.startsWith(b))) return "curl: параметр записи или отправки запрещён: " + t.split("=")[0];
      if (t === "--request" || t.startsWith("--request=")) {
        const v = t.includes("=") ? t.split("=")[1] : a[i + 1];
        if (String(v).toUpperCase() !== "GET") return "curl: допустим только GET";
      }
      continue;
    }
    if (!t.startsWith("-") || t === "-") continue;
    for (let j = 1; j < t.length; j++) {
      const ch = t[j];
      if (badShort.has(ch)) return "curl: параметр -" + ch + " запрещён";
      if (ch === "X") {
        const v = t.slice(j + 1) || a[i + 1] || "";
        if (v.toUpperCase() !== "GET") return "curl: допустим только GET";
        break;
      }
      if (noArg.has(ch)) break;
    }
  }
  return null;
}

export function parseInspectCommand(command: string): ParsedInspect {
  const tk = tokenizePipeline(command);
  if (!tk.ok) return deny(tk.reason);
  for (const stage of tk.stages) {
    const why = stageDenial(stage);
    if (why) return deny(why);
  }
  return { ok: true, stages: tk.stages };
}

/** Голова + хвост; полный вывод остаётся в файле. */
export function truncateOutput(text: string, maxLines: number): { text: string; truncated: boolean; total: number } {
  const lines = text.replace(/\n$/, "").split("\n").map(l => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
  const total = text === "" ? 0 : lines.length;
  if (total <= maxLines) return { text: lines.join("\n"), truncated: false, total };
  const head = Math.ceil(maxLines / 2), tail = Math.floor(maxLines / 2);
  const cut = total - head - tail;
  return { text: [...lines.slice(0, head), `… пропущено строк: ${cut} …`, ...(tail ? lines.slice(-tail) : [])].join("\n"), truncated: true, total };
}

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const CLEAN_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "USER", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "TERM"];

/** Запуск этапов на сервере без shell; stdout этапа питает stdin следующего. */
export function runStagesLocal(stages: string[][], cwd: string, timeoutMs = INSPECT_TIMEOUT_MS): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of CLEAN_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
    const procs: ChildProcess[] = [];
    const chunks: Buffer[] = [];
    let size = 0, timedOut = false, finished = 0, lastCode: number | null = null;
    const killAll = () => procs.forEach(p => { try { p.kill("SIGKILL"); } catch { /* уже завершён */ } });
    const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
    const collect = (b: Buffer) => { if (size < MAX_CAPTURE_BYTES) { chunks.push(b); size += b.length; } else killAll(); };
    const done = () => { if (++finished === procs.length) { clearTimeout(timer); resolve({ output: Buffer.concat(chunks).toString("utf8"), code: lastCode, timedOut }); } };
    stages.forEach(([cmd, ...args], i) => {
      const p = spawn(cmd, args, { cwd, env, stdio: [i === 0 ? "ignore" : "pipe", "pipe", "pipe"] });
      procs.push(p);
      if (i > 0) { procs[i - 1].stdout!.pipe(p.stdin!); p.stdin!.on("error", () => {}); }
      if (i === stages.length - 1) p.stdout!.on("data", collect);
      p.stderr!.on("data", collect);
      p.on("error", e => { collect(Buffer.from(`${cmd}: ${e.message}\n`)); lastCode = 127; done(); });
      p.on("close", code => { if (i === stages.length - 1) lastCode = code; done(); });
    });
  });
}

function pickMac(): string {
  const m = listMachines().filter(x => !x.revoked_at && isMachineOnline(x.id));
  if (!m.length) throw new Error("Mac (host) сейчас офлайн. Повтори позже или используй target=server");
  return m[0].id;
}

export function createInspectTool(role: string): Tool {
  return {
    name: "taskflow_inspect",
    description:
      "Запустить команду ТОЛЬКО НА ЧТЕНИЕ (белый список: git status/log/diff/show/branch/rev-parse/ls-files/blame/remote -v, rg, grep, find, ls, cat, head, tail, wc, sort, uniq, cut, jq, stat, file, du, df, ps, pgrep, uptime, free, nvidia-smi, systemctl status/is-active/show/list-units, journalctl, sqlite3 -readonly, curl GET, xcodebuild -list/-showBuildSettings, ss, ip addr, ping -c N). " +
      "Допустим конвейер «|» между такими командами; нет shell: ; && || > < `...` $() и подстановки не работают. Вывод обрезается до max_lines (голова+хвост), полный — в файле, путь в ответе. Таймаут 60 с. " +
      "target: server (.110, по умолчанию) или mac.",
    parameters: Type.Object({
      command: Type.String({ description: "Команда или конвейер из команд чтения" }),
      target: Type.Optional(Type.Union([Type.Literal("server"), Type.Literal("mac")], { description: "server (.110) или mac" })),
      cwd: Type.Optional(Type.String({ description: "Рабочая папка (абсолютный путь)" })),
      max_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Сколько строк вернуть, по умолчанию 80" })),
    }),
    execute: async (_id: string, p: { command: string; target?: "server" | "mac"; cwd?: string; max_lines?: number }, signal?: AbortSignal) => {
      const parsed = parseInspectCommand(p.command);
      if (!parsed.ok) throw new Error("команда не входит в список чтения: " + parsed.reason);
      const maxLines = p.max_lines ?? INSPECT_DEFAULT_LINES;
      const target = p.target ?? "server";
      const workspace = roleHome(role).workspace;
      fs.mkdirSync(workspace, { recursive: true });
      let output: string, status: string;
      if (target === "mac") {
        const machine = pickMac();
        const cmd = parsed.stages.map(s => s.map(shq).join(" ")).join(" | ");
        const r = (await runOperation(machine, "bash", { command: cmd, ...(p.cwd ? { cwd: p.cwd } : {}), timeoutMs: INSPECT_TIMEOUT_MS }, { signal, timeoutMs: INSPECT_TIMEOUT_MS + 10_000 })) as any;
        output = [r?.stdout, r?.stderr, r?.ok === false ? r?.error : ""].filter(Boolean).join("");
        status = r?.ok === false && !r?.stdout ? "ошибка host" : "код " + (r?.exitCode ?? 0);
      } else {
        const cwd = p.cwd ?? workspace;
        if (!path.isAbsolute(cwd)) throw new Error("cwd должен быть абсолютным путём");
        const r = await runStagesLocal(parsed.stages, cwd);
        output = r.output;
        status = r.timedOut ? "таймаут 60 с" : "код " + r.code;
      }
      const cut = truncateOutput(output, maxLines);
      let note = "";
      if (cut.truncated || output.length > 20_000) {
        const file = path.join(workspace, `inspect-${Date.now()}.txt`);
        fs.writeFileSync(file, output, { mode: 0o600 });
        note = `\n[полный вывод (${cut.total} строк): ${file}]`;
      }
      return { content: [{ type: "text" as const, text: `[${target}, ${status}]\n${cut.text}${note}` }], details: {} };
    },
  };
}
