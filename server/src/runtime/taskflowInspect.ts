// taskflow_inspect — запуск команд ТОЛЬКО НА ЧТЕНИЕ по белому списку (решение
// владельца 06.11.2026). Строка команды разбирается здесь, без shell: сервер
// запускает процессы напрямую, на Mac команда уходит с каждым словом в кавычках.
import fs from "node:fs";
import os from "node:os";
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
    case "sed": {
      const sp = splitSedArgs(a);
      if (sp.error) return sp.error;
      for (const prog of sp.programs) { const why = sedScriptDenial(prog); if (why) return why; }
      return null;
    }
    case "awk": case "gawk": {
      const sp = splitAwkArgs(a);
      if (sp.error) return sp.error;
      for (const prog of sp.programs) { const why = awkProgramDenial(prog); if (why) return why; }
      return null;
    }
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


// ---- sed и awk только на чтение ----
type Split = { programs: string[]; fileIdx: number[]; error?: string };
const SED_LONG = /^--(quiet|silent|regexp-extended|separate|null-data|unbuffered|posix|debug|sandbox|follow-symlinks|binary)$/;

/** Разбор аргументов sed: тексты скриптов и индексы файлов. */
export function splitSedArgs(a: string[]): Split {
  const programs: string[] = []; const fileIdx: number[] = []; let hasE = false; let scriptTaken = false;
  const bad = (m: string): Split => ({ programs, fileIdx, error: m });
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--") { for (let k = i + 1; k < a.length; k++) { if (!hasE && !scriptTaken) { programs.push(a[k]); scriptTaken = true; } else fileIdx.push(k); } break; }
    if (t.startsWith("--")) {
      if (/^--in-place/.test(t)) return bad("sed --in-place пишет в файл");
      if (t === "--expression" || t.startsWith("--expression=")) { hasE = true; const v = t.includes("=") ? t.slice(t.indexOf("=") + 1) : a[++i]; if (v === undefined) return bad("sed: нет скрипта"); programs.push(v); continue; }
      if (/^--line-length(=|$)/.test(t)) { if (!t.includes("=")) i++; continue; }
      if (/^--file/.test(t)) return bad("sed -f/--file: скрипт из файла не проверить");
      if (!SED_LONG.test(t)) return bad("sed: параметр не входит в список чтения: " + t);
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const c = t[j];
        if (c === "i") return bad("sed -i (в любой форме) пишет в файл");
        if (c === "f") return bad("sed -f: скрипт из файла не проверить");
        if (c === "e") { hasE = true; const rest = t.slice(j + 1); const v = rest || a[++i]; if (v === undefined) return bad("sed: нет скрипта"); programs.push(v); break; }
        if (c === "l") { if (j === t.length - 1) i++; break; }
        if (!"nErszub".includes(c)) return bad("sed: параметр -" + c + " не входит в список чтения");
      }
      continue;
    }
    if (!hasE && !scriptTaken) { programs.push(t); scriptTaken = true; } else fileIdx.push(i);
  }
  if (!programs.length) return bad("sed: нет скрипта");
  return { programs, fileIdx };
}

/** Проверка скрипта sed: запрещены w/W (запись), e (выполнение), r/R (чтение файла мимо проверки секретов), флаги s///w и s///e. */
export function sedScriptDenial(script: string): string | null {
  let i = 0; const n = script.length;
  const readDelimited = (d: string): boolean => { // до неэкранированного d
    while (i < n) { const c = script[i++]; if (c === "\\") { i++; continue; } if (c === d) return true; }
    return false;
  };
  while (i < n) {
    const c = script[i];
    if (/[\s;{}!]/.test(c)) { i++; continue; }
    // адрес
    if (/[0-9$+~,]/.test(c)) { i++; continue; }
    if (c === "/" || c === "\\") {
      let d = "/"; i++; if (c === "\\") d = script[i++] ?? "/";
      if (!readDelimited(d)) return "sed: незакрытый адрес";
      while (i < n && /[IM]/.test(script[i])) i++;
      continue;
    }
    i++;
    if (c === "#") { while (i < n && script[i] !== "\n") i++; continue; }
    if (c === "s") {
      const d = script[i++]; if (!d || d === "\n" || d === "\\") return "sed: некорректная команда s";
      if (!readDelimited(d) || !readDelimited(d)) return "sed: незакрытая команда s";
      let flags = "";
      while (i < n && !/[\s;}]/.test(script[i])) flags += script[i++];
      if (/[we]/i.test(flags.replace(/[0-9gpiImM]/g, "").replace(/[IM]/g, "")) || /[we]/.test(flags)) return "sed: флаг w/e в команде s (запись или выполнение)";
      continue;
    }
    if (c === "y") { const d = script[i++]; if (!d || !readDelimited(d) || !readDelimited(d)) return "sed: некорректная команда y"; continue; }
    if ("wWeErR".includes(c)) return "sed: команда «" + c + "» пишет в файл, читает файл или выполняет команду";
    if ("aic".includes(c)) { while (i < n && script[i] !== "\n") i++; continue; }
    if (":btT".includes(c)) { while (i < n && !/[;\n}]/.test(script[i])) i++; continue; }
    if ("lLqQ".includes(c)) { while (i < n && /[0-9\s]/.test(script[i])) i++; continue; }
    if ("pdDnNgGhHxP=zF".includes(c)) continue;
    return "sed: команда «" + c + "» не входит в список чтения";
  }
  return null;
}

/** Разбор аргументов awk: тексты программы и индексы файлов. */
export function splitAwkArgs(a: string[]): Split {
  const programs: string[] = []; const fileIdx: number[] = []; let hasE = false; let taken = false;
  const bad = (m: string): Split => ({ programs, fileIdx, error: m });
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "--") { for (let k = i + 1; k < a.length; k++) { if (!hasE && !taken) { programs.push(a[k]); taken = true; } else fileIdx.push(k); } break; }
    if (t.startsWith("--")) {
      if (/^--source(=|$)/.test(t)) { hasE = true; const v = t.includes("=") ? t.slice(t.indexOf("=") + 1) : a[++i]; if (v === undefined) return bad("awk: нет программы"); programs.push(v); continue; }
      if (/^--(field-separator|assign)(=|$)/.test(t)) { if (!t.includes("=")) i++; continue; }
      if (/^--(posix|traditional|re-interval|characters-as-bytes)$/.test(t)) continue;
      return bad("awk: параметр не входит в список чтения: " + t);
    }
    if (t.startsWith("-") && t.length > 1) {
      const c = t[1];
      if (c === "F" || c === "v") { if (t.length === 2) i++; continue; }
      if (c === "e") { hasE = true; const v = t.length > 2 ? t.slice(2) : a[++i]; if (v === undefined) return bad("awk: нет программы"); programs.push(v); continue; }
      if (c === "b" || c === "c" || c === "P" || c === "r") { if (t.length === 2) continue; }
      return bad("awk: параметр " + t + " не входит в список чтения (запрещены -f, -i, -l, -E)");
    }
    if (!hasE && !taken) { programs.push(t); taken = true; } else fileIdx.push(i);
  }
  if (!programs.length) return bad("awk: нет программы");
  return { programs, fileIdx };
}

export function awkProgramDenial(program: string): string | null {
  if (/\bsystem\s*\(/.test(program)) return "awk: system() запрещена";
  if (/\bENVIRON\b/.test(program)) return "awk: ENVIRON запрещён";
  if (/\|\s*getline\b/.test(program) || /\bgetline\b[^;}\n]*</.test(program)) return "awk: getline из команды или файла запрещён";
  // Перенаправление — только > / >> / | в операторе print/printf на нулевой скобочной глубине: сравнения ($3 > 100) проходят.
  const n = program.length; let i = 0;
  const skipString = (q: string) => { i++; while (i < n && program[i] !== q) { if (program[i] === "\\") i++; i++; } i++; };
  while (i < n) {
    const c = program[i];
    if (c === '"') { skipString('"'); continue; }
    if (c === "/" && /[(,;{!~=\s]|^/.test(program[i - 1] ?? "") ) { // регулярное выражение
      i++; while (i < n && program[i] !== "/" && program[i] !== "\n") { if (program[i] === "\\") i++; i++; } i++; continue;
    }
    if (c === "#") { while (i < n && program[i] !== "\n") i++; continue; }
    const m = /^(print|printf)\b/.exec(program.slice(i));
    if (m && !/[\w$]/.test(program[i - 1] ?? "")) {
      i += m[0].length; let depth = 0;
      while (i < n) {
        const d = program[i];
        if (d === '"') { skipString('"'); continue; }
        if (d === "(" || d === "[") depth++;
        else if (d === ")" || d === "]") depth--;
        else if (depth <= 0 && (d === ";" || d === "}" || d === "\n")) break;
        else if (depth <= 0 && (d === ">" || d === "|")) return "awk: перенаправление вывода после print/printf запрещено";
        i++;
      }
      continue;
    }
    i++;
  }
  return null;
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

// ---- Секреты: пути, которые не читает ни одна команда списка (владелец 06.11.2026) ----

/** Причина отказа для пути или null. Проверка по имени и составляющим пути, без обращения к диску. */
export function secretPathReason(raw: string): string | null {
  if (!raw) return null;
  const norm = path.posix.normalize(raw.replace(/^~(?=\/|$)/, os.homedir()));
  const parts = norm.split("/").filter(Boolean);
  const base = (parts.at(-1) ?? "").toLowerCase();
  const lowParts = parts.map(x => x.toLowerCase());
  for (const dir of [".ssh", ".gnupg", ".aws"]) if (lowParts.includes(dir)) return "каталог с секретами " + dir;
  const gh = lowParts.indexOf("gh");
  if (gh > 0 && lowParts[gh - 1] === ".config") return "каталог с секретами .config/gh";
  if (/^\/proc\/[^/]+\/environ$/.test(norm) || (base === "environ" && lowParts[0] === "proc")) return "окружение процесса (/proc/*/environ)";
  if (base.startsWith(".env")) return "файл .env*";
  if (/\.(pem|key|age|p12|pfx)$/.test(base)) return "ключ или сертификат (" + path.posix.extname(base) + ")";
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(base)) return "приватный ключ ssh";
  if ([".netrc", ".npmrc", ".pypirc", ".git-credentials"].includes(base)) return "файл учётных данных " + base;
  if (base.startsWith("credentials") || base.startsWith("secrets")) return "файл credentials*/secrets*";
  if (base.startsWith("age-key") || base.startsWith("vault")) return "хранилище секретов (vault)";
  if (base.includes("token")) return "файл с token в имени";
  return null;
}

/** Исключающие glob для рекурсивного поиска rg/grep: добавляются автоматически. */
export const SECRET_EXCLUDE_GLOBS = [
  ".env*", "*.pem", "*.key", "*.age", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", ".ssh", ".gnupg", ".aws",
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials*", "secrets*", "*token*", "age-key*", "vault*",
];

const GLOB_CHARS = /[*?[]/;
export const GLOB_LIMIT = 500;

function globSegmentRegex(seg: string): RegExp {
  let r = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") r += "[^/]*";
    else if (c === "?") r += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) { r += "\\["; continue; }
      let cls = seg.slice(i + 1, end);
      if (cls[0] === "!") cls = "^" + cls.slice(1);
      r += "[" + cls.replace(/\\/g, "\\\\") + "]"; i = end;
    } else r += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp("^" + r + "$");
}

/** Раскрытие *, ?, [..] по файловой системе; сегменты без шаблона не читаются. Больше GLOB_LIMIT — ошибка. */
export function expandGlob(pattern: string, cwd: string): string[] {
  const abs = pattern.startsWith("/");
  const segs = pattern.split("/").filter(x => x !== "");
  let cur: string[] = [abs ? "/" : ""];
  for (const seg of segs) {
    const next: string[] = [];
    if (!GLOB_CHARS.test(seg)) { for (const c of cur) next.push(c === "" ? seg : path.posix.join(c, seg)); }
    else {
      const re = globSegmentRegex(seg);
      for (const c of cur) {
        let names: string[] = [];
        try { names = fs.readdirSync(path.resolve(cwd, c || ".")); } catch { continue; }
        for (const n of names.sort()) {
          if (n.startsWith(".") && !seg.startsWith(".")) continue;
          if (re.test(n)) { next.push(c === "" ? n : path.posix.join(c, n)); if (next.length > GLOB_LIMIT) throw new Error("шаблон " + pattern + " даёт больше " + GLOB_LIMIT + " совпадений; сузь его"); }
        }
      }
    }
    cur = next;
    if (!cur.length) return [];
  }
  return cur.filter(c => { try { fs.lstatSync(path.resolve(cwd, c)); return true; } catch { return false; } });
}

const VALUE_FLAGS = new Set(["-g", "--glob", "--iglob", "-t", "-T", "--type", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "-j", "-M", "--max-columns", "-E", "--encoding", "--max-depth", "-d", "--sort", "--sortr", "-r", "--replace", "--color", "--context-separator", "--include", "--exclude", "--exclude-dir", "--label", "-D", "--threads", "--max-filesize", "--regexp", "-e"]);
const SHORT_VALUE_FLAGS = new Set(["-d", "-t", "-n", "-c", "-f", "-k", "-s", "-w", "-m", "-N", "-B", "-e", "-o"]);

/** Индексы аргументов, которые команда читает как пути (значения шаблонов и программ сюда не входят). */
export function pathArgIndexes(cmd: string, a: string[], cwd?: string): number[] {
  const out: number[] = [];
  const exists = (t: string) => { if (!cwd) return false; try { fs.lstatSync(path.resolve(cwd, t)); return true; } catch { return false; } };
  switch (cmd) {
    case "rg": case "grep": {
      let patternSeen = a.some(x => x === "-e" || x === "--regexp" || x.startsWith("--regexp=") || x === "-f" || x === "--file" || x.startsWith("--file="));
      for (let i = 0; i < a.length; i++) {
        const t = a[i];
        if (t === "--") { for (let k = i + 1; k < a.length; k++) { if (!patternSeen) patternSeen = true; else out.push(k); } break; }
        if (t === "-f" || t === "--file" || t === "--ignore-file") { if (a[i + 1] !== undefined) out.push(i + 1); i++; continue; }
        if (t.startsWith("--file=") || t.startsWith("--ignore-file=")) { out.push(i); continue; }
        if (t.startsWith("-")) { if (VALUE_FLAGS.has(t)) i++; continue; }
        if (!patternSeen) { patternSeen = true; continue; }
        out.push(i);
      }
      return out;
    }
    case "find": for (let i = 0; i < a.length; i++) { if (a[i].startsWith("-") || a[i] === "(" || a[i] === "!") break; out.push(i); } return out;
    case "git": {
      const sub = a[0];
      if (sub === "branch" || sub === "remote" || sub === "rev-parse") return out;
      const dd = a.indexOf("--");
      a.forEach((t, i) => { if (i === 0 || t.startsWith("-")) return; if ((dd >= 0 && i > dd) || t.includes(":") || t.includes("/") || t.startsWith(".") || exists(t)) out.push(i); });
      if (dd >= 0) a.forEach((_, i) => { if (i > dd && !out.includes(i)) out.push(i); });
      return out;
    }
    case "jq": {
      let prog = false;
      for (let i = 0; i < a.length; i++) {
        const t = a[i];
        if (t === "--arg" || t === "--argjson") { i += 2; continue; }
        if (t === "--slurpfile" || t === "--rawfile") { if (a[i + 2] !== undefined) out.push(i + 2); i += 2; continue; }
        if (t === "-f" || t === "--from-file") { if (a[i + 1] !== undefined) out.push(i + 1); prog = true; i++; continue; }
        if (t.startsWith("-")) continue;
        if (!prog) { prog = true; continue; }
        out.push(i);
      }
      return out;
    }
    case "sqlite3": {
      for (let i = 0; i < a.length; i++) {
        if (["-separator", "-newline", "-nullvalue", "-vfs", "-mmap", "-key"].includes(a[i])) { i++; continue; }
        if (a[i].startsWith("-")) continue;
        out.push(i); break;
      }
      return out;
    }
    case "sed": return splitSedArgs(a).fileIdx;
    case "awk": case "gawk": return splitAwkArgs(a).fileIdx;
    case "cat": case "head": case "tail": case "wc": case "sort": case "uniq": case "cut": case "stat": case "file": case "du": case "df": case "ls":
      a.forEach((t, i) => { if (t.startsWith("-")) return; if (SHORT_VALUE_FLAGS.has(a[i - 1] ?? "")) return; out.push(i); });
      return out;
    default: return out;
  }
}

function realOrSelf(abs: string): string | null {
  try { return fs.realpathSync(abs); } catch { return null; }
}

/** Проверка одного пути: лексически, с ~, и по realpath (обход через симлинк). */
export function pathDenial(token: string, cwd?: string): string | null {
  if (/^file:/i.test(token)) return "URL file:// запрещён";
  const lex = secretPathReason(token);
  if (lex) return lex + ": " + token;
  if (cwd) {
    const abs = path.resolve(cwd, token.replace(/^~(?=\/|$)/, os.homedir()));
    const abl = secretPathReason(abs);
    if (abl) return abl + ": " + token;
    const real = realOrSelf(abs);
    if (real && real !== abs) { const r = secretPathReason(real); if (r) return r + " (через симлинк " + token + " → " + real + ")"; }
  }
  return null;
}

export type ParseOptions = { cwd?: string; expand?: boolean };

/** Добавить исключающие glob секретов в rg/grep (до «--», если он есть). */
function withExcludes(cmd: string, a: string[]): string[] {
  const extra: string[] = [];
  if (cmd === "rg") for (const g of SECRET_EXCLUDE_GLOBS) extra.push("--glob", "!" + g);
  else for (const g of SECRET_EXCLUDE_GLOBS) extra.push("--exclude=" + g, "--exclude-dir=" + g);
  const dd = a.indexOf("--");
  return dd < 0 ? [...a, ...extra] : [...a.slice(0, dd), ...extra, ...a.slice(dd)];
}

export function parseInspectCommand(command: string, opts: ParseOptions = {}): ParsedInspect {
  const tk = tokenizePipeline(command);
  if (!tk.ok) return deny(tk.reason);
  const { cwd, expand } = opts;
  if (cwd) { const c = pathDenial(cwd, cwd); if (c) return deny("рабочая папка: " + c); }
  const stages: string[][] = [];
  for (const stage of tk.stages) {
    const why = stageDenial(stage);
    if (why) return deny(why);
    const [cmd, ...orig] = stage;
    if ((cmd === "rg" && orig.some(x => x === "-L" || x === "--follow")) ) return deny("rg --follow запрещён: симлинки могут вести к секретам");
    if (cmd === "grep" && orig.some(x => x === "-R" || x === "--dereference-recursive")) return deny("grep -R запрещён: симлинки могут вести к секретам");
    if (orig.some(x => /^file:/i.test(x))) return deny("URL file:// запрещён");
    let args = orig;
    const idx = pathArgIndexes(cmd, args, cwd);
    const rebuilt: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (!idx.includes(i)) { rebuilt.push(args[i]); continue; }
      let t = args[i];
      const flagEq = /^(--[a-z-]+)=(.*)$/.exec(t);
      const value = flagEq ? flagEq[2] : t;
      let list = [value];
      if (expand && cwd && GLOB_CHARS.test(value)) {
        let m: string[];
        try { m = expandGlob(value, cwd); } catch (e: any) { return deny(e.message); }
        if (m.length) list = m;
      }
      for (const v of list) { const d = pathDenial(v, cwd); if (d) return deny("путь с секретами: " + d); }
      if (flagEq) rebuilt.push(t); else rebuilt.push(...list);
    }
    // git: токен «ревизия:путь» проверяется по части после двоеточия
    if (cmd === "git") for (const t of rebuilt) if (!t.startsWith("-") && t.includes(":")) { const d = pathDenial(t.slice(t.indexOf(":") + 1), cwd); if (d) return deny("путь с секретами: " + d); }
    args = rebuilt;
    if (cmd === "rg" || cmd === "grep") args = withExcludes(cmd, args);
    // GNU sed на сервере: --sandbox вторым рубежом отклоняет e/w/r (на Mac sed BSD, там опции нет).
    if (cmd === "sed" && expand) args = ["--sandbox", ...args];
    // gawk на сервере: --sandbox сам запрещает system, перенаправления и getline из файлов и команд.
    if (cmd === "gawk" && expand) args = ["--sandbox", ...args];
    stages.push([cmd, ...args]);
  }
  return { ok: true, stages };
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

/** Машина для target=mac. Признака «основной» у машин нет, поэтому без host работает только единственная онлайн-машина; иначе ошибка со списком. */
export function pickMac(host?: string): string {
  const all = listMachines().filter(x => !x.revoked_at);
  const online = all.filter(x => isMachineOnline(x.id));
  if (host) {
    const m = all.find(x => x.id === host || x.name.toLowerCase() === host.toLowerCase());
    if (!m) throw new Error("Машина «" + host + "» не найдена. Доступные: " + (all.map(x => x.name).join(", ") || "нет"));
    if (!isMachineOnline(m.id)) throw new Error("Машина «" + m.name + "» офлайн. Онлайн: " + (online.map(x => x.name).join(", ") || "нет"));
    return m.id;
  }
  if (online.length === 1) return online[0].id;
  if (!online.length) throw new Error("Нет ни одной онлайн-машины. Повтори позже или используй target=server");
  throw new Error("Онлайн несколько машин: " + online.map(x => x.name).join(", ") + ". Укажи параметр host");
}

export function createInspectTool(role: string): Tool {
  return {
    name: "taskflow_inspect",
    description:
      "Запустить команду ТОЛЬКО НА ЧТЕНИЕ (белый список: git status/log/diff/show/branch/rev-parse/ls-files/blame/remote -v, rg, grep, find, ls, cat, head, tail, wc, sort, uniq, cut, jq, stat, file, du, df, ps, pgrep, uptime, free, nvidia-smi, systemctl status/is-active/show/list-units, journalctl, sqlite3 -readonly, curl GET, xcodebuild -list/-showBuildSettings, ss, ip addr, ping -c N, sed и awk только на чтение). " +
      "Допустим конвейер «|» между такими командами; нет shell: ; && || > < `...` $() и подстановки не работают. Вывод обрезается до max_lines (голова+хвост), полный — в файле, путь в ответе. Таймаут 60 с. " +
      "target: server (.110, по умолчанию) или mac.",
    parameters: Type.Object({
      command: Type.String({ description: "Команда или конвейер из команд чтения" }),
      target: Type.Optional(Type.Union([Type.Literal("server"), Type.Literal("mac")], { description: "server (.110) или mac" })),
      host: Type.Optional(Type.String({ description: "Имя машины для target=mac (из taskflow_hosts); можно опустить, если онлайн одна машина" })),
      cwd: Type.Optional(Type.String({ description: "Рабочая папка (абсолютный путь)" })),
      max_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Сколько строк вернуть, по умолчанию 80" })),
    }),
    execute: async (_id: string, p: { command: string; target?: "server" | "mac"; host?: string; cwd?: string; max_lines?: number }, signal?: AbortSignal) => {
      const maxLines = p.max_lines ?? INSPECT_DEFAULT_LINES;
      const target = p.target ?? "server";
      const workspace = roleHome(role).workspace;
      fs.mkdirSync(workspace, { recursive: true });
      const serverCwd = p.cwd ?? workspace;
      if (target === "server" && !path.isAbsolute(serverCwd)) throw new Error("cwd должен быть абсолютным путём");
      const parsed = parseInspectCommand(p.command, target === "server" ? { cwd: serverCwd, expand: true } : { cwd: p.cwd });
      if (!parsed.ok) throw new Error("команда не входит в список чтения: " + parsed.reason);
      let output: string, status: string;
      if (target === "mac") {
        const machine = pickMac(p.host);
        const cmd = parsed.stages.map(s => s.map(shq).join(" ")).join(" | ");
        const r = (await runOperation(machine, "bash", { command: cmd, ...(p.cwd ? { cwd: p.cwd } : {}), timeoutMs: INSPECT_TIMEOUT_MS }, { signal, timeoutMs: INSPECT_TIMEOUT_MS + 10_000 })) as any;
        output = [r?.stdout, r?.stderr, r?.ok === false ? r?.error : ""].filter(Boolean).join("");
        status = r?.ok === false && !r?.stdout ? "ошибка host" : "код " + (r?.exitCode ?? 0);
      } else {
        const r = await runStagesLocal(parsed.stages, serverCwd);
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
