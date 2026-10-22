// Операции pi, выполняемые на удалённой машине (правка 4 плана
// taskflow-mac-host).
//
// Ключевая находка, из-за которой эта правка небольшая: у движка pi у каждого
// инструмента есть ПОДКЛЮЧАЕМЫЕ операции. В типах пакета сказано прямо —
// «Override these to delegate command execution to remote systems (for example
// SSH)». Значит подменяется только то, где команда исполняется; сами
// инструменты, их схемы и системные промпты ролей остаются как есть.
//
// ФОРМЫ ОТВЕТОВ взяты из кода хоста, а не придуманы. Два открытия, из-за
// которых первый черновик был бы неверным:
//
//   * bash НЕ возвращает вывод — он приходит кадрами op_chunk, а op_result
//     несёт только код возврата и счётчики. Черновик ждал stdout и получил бы
//     пустую строку;
//   * данные остальных операций лежат в поле data, а не в stdout. Без
//     проноса data в протоколе ls и read доезжали как «успех с пустым
//     stdout».
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  ReadOperations,
  WriteOperations,
  EditOperations,
  GrepOperations,
  FindOperations,
  LsOperations,
} from "@earendil-works/pi-coding-agent";
import { runOperation } from "../host/gateway.js";

const hostInvocation = new AsyncLocalStorage<{ signal?: AbortSignal }>();
const hostCall: typeof runOperation = (machine, op, args, options = {}) => {
  const signal = options.signal ?? hostInvocation.getStore()?.signal;
  signal?.throwIfAborted();
  return runOperation(machine, op, args, { ...options, signal });
};

async function hostIsDirectory(machineId: string, target: string): Promise<boolean> {
  const listing = await hostCall(machineId, "ls", { path: target });
  if (listing.ok) return true;
  // ls is a directory operation, not stat. File metadata is in its parent.
  const parent = await hostCall(machineId, "ls", { path: path.posix.dirname(target) });
  const entries = payload<{entries?: Array<{name: string; type: string}>}>("stat", parent);
  const entry = entries.entries?.find(e => e.name === path.posix.basename(target));
  if (!entry) throw fail("stat", listing as any);
  return entry.type === "dir";
}

/** Предел одной команды bash на хосте, если роль не указала свой. */
export const BASH_DEFAULT_TIMEOUT_MS = 40 * 60_000;

type Resultado = {
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  error?: unknown;
  code?: unknown;
  data?: unknown;
};

function fail(op: string, r: { error?: unknown; code?: unknown }): Error {
  const сообщение = String(r.error ?? "хост не объяснил причину");
  return new Error(`${op}: ${сообщение}${r.code ? ` (${String(r.code)})` : ""}`);
}

/** Данные операции с проверкой формы — вместо «как получится». */
function payload<T>(op: string, r: Resultado): T {
  if (!r.ok) throw fail(op, r);
  return (r.data ?? {}) as T;
}

/**
 * bash — единственный метод интерфейса. Поток перенаправляется в onData
 * вызывающего, и роль видит живой вывод, как на .110. Отказ хоста — это не
 * поломка шлюза: команда с ненулевым кодом для роли такой же результат, как
 * локально, поэтому текст уходит в поток, а не бросается наружу.
 */
export function hostBashOperations(machineId: string, defaultCwd: string): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      let былВывод = false;
      // Сборка и UI-тесты iOS идут дольше 10 минут — прежнего предела хоста
      // (владелец 20.10.2026: роли обрывались на полпути и жгли круги). Время
      // берётся из запроса роли, без него — BASH_DEFAULT_TIMEOUT_MS; хост
      // принимает предел из сообщения и из аргументов, берёт меньший.
      const timeoutMs = options.timeout ? Math.ceil(options.timeout * 1000) : BASH_DEFAULT_TIMEOUT_MS;
      const результат = (await hostCall(
        machineId,
        "bash",
        { command, cwd: cwd || defaultCwd, timeoutMs },
        {
          timeoutMs: timeoutMs + 30_000,
          signal: options.signal,
          onChunk: (chunk: { data: string }) => {
            былВывод = true;
            options.onData(Buffer.from(chunk.data));
          },
        },
      )) as unknown as Resultado;

      if (!результат.ok) {
        options.onData(Buffer.from(`${String(результат.error ?? "хост вернул отказ")}\n`));
        return { exitCode: результат.exitCode ?? null };
      }
      // Команда без вывода (cd, export) не должна выглядеть как авария:
      // без этого pi решит, что вывод не пришёл вовсе.
      if (!былВывод) options.onData(Buffer.from("\n"));
      return { exitCode: результат.exitCode ?? 0 };
    },
  };
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

async function hostTest(machineId: string, absolutePath: string, flag: "-r" | "-w"): Promise<void> {
  const q = "'" + absolutePath.replaceAll("'", "'\\''") + "'";
  const r = (await hostCall(machineId, "bash", { command: `test -f ${q} && test ${flag} ${q}` })) as unknown as Resultado;
  if (!r.ok || (r.exitCode ?? 1) !== 0) {
    throw Object.assign(new Error(`нет доступа к файлу (${flag === "-w" ? "запись" : "чтение"}): ${absolutePath}`), { code: "ENOENT" });
  }
}

export function hostReadOperations(machineId: string): ReadOperations {
  return {
    // Целиком и байтами (encoding base64): инструмент read сам режет текст по
    // строкам и показывает картинки. Прежний текстовый режим ломал
    // изображения и отдавал только первые 2000 строк (16.10.2026).
    readFile: async (absolutePath) => {
      const r = (await hostCall(machineId, "read", { path: absolutePath, encoding: "base64" })) as unknown as Resultado;
      const data = payload<{ content?: string; encoding?: string }>("read", r);
      return Buffer.from(data.content ?? "", data.encoding === "base64" ? "base64" : "utf8");
    },
    detectImageMimeType: async (absolutePath) => IMAGE_TYPES[absolutePath.toLowerCase().split(".").pop() ?? ""] ?? null,
    // Проверка доступа — test -r, а не ls: ls на файл отвечает «не папка»,
    // и read у роли отвергал ЛЮБОЙ файл (тестировщик caecdeee, 16.10.2026).
    access: (absolutePath) => hostTest(machineId, absolutePath, "-r"),
  };
}

export function hostWriteOperations(machineId: string): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const r = (await hostCall(machineId, "write", {
        path: absolutePath, content,
      })) as unknown as Resultado;
      if (!r.ok) throw fail("write", r);
    },
    // Host write atomically creates every missing parent directory itself.
    // SDK calls mkdir immediately before writeFile; defer this step to write.
    mkdir: async () => {},
  };
}

export function hostEditOperations(machineId: string): EditOperations {
  const чтение = hostReadOperations(machineId);
  const запись = hostWriteOperations(machineId);
  return {
    readFile: чтение.readFile,
    writeFile: запись.writeFile,
    access: (absolutePath) => hostTest(machineId, absolutePath, "-w"),
  };
}

export function hostGrepOperations(machineId: string): GrepOperations {
  return {
    isDirectory: (absolutePath) => hostIsDirectory(machineId, absolutePath),
    readFile: async (absolutePath) => {
      const r = (await hostCall(machineId, "read", { path: absolutePath })) as unknown as Resultado;
      const data = payload<{ content?: string }>("grep", r);
      return data.content ?? "";
    },
  };
}

export function hostFindOperations(machineId: string): FindOperations {
  return {
    exists: async (absolutePath) => {
      const r = (await hostCall(machineId, "ls", { path: absolutePath })) as unknown as Resultado;
      return Boolean(r.ok);
    },
    glob: async (pattern, cwd, options) => {
      const r = (await hostCall(machineId, "find", {
        path: cwd, limit: 5000,
      })) as unknown as Resultado;
      const data = payload<{ entries?: Array<string | {path: string; type: string}>; truncated?: boolean }>("find", r);
      const matches = (data.entries ?? []).filter(e => typeof e === "string" || e.type === "file")
        .map(e => typeof e === "string" ? e : e.path)
        .filter(file => {
          const relative = path.posix.relative(cwd, file);
          return path.matchesGlob(relative, pattern) || (!pattern.includes("/") && path.matchesGlob(path.posix.basename(file), pattern));
        });
      if (data.truncated && matches.length < options.limit) throw new Error("find: хост обрезал обход; сузь папку поиска");
      return matches.slice(0, options.limit);
    },
  };
}

export function hostLsOperations(machineId: string): LsOperations {
  const читает = async (absolutePath: string) =>
    (await hostCall(machineId, "ls", { path: absolutePath })) as unknown as Resultado;

  return {
    exists: async (absolutePath) => {
      const r = await читает(absolutePath);
      return Boolean(r.ok);
    },
    stat: async (absolutePath) => {
      const directory = await hostIsDirectory(machineId, absolutePath);
      return { isDirectory: () => directory };
    },
    readdir: async (absolutePath) => {
      const r = await читает(absolutePath);
      const data = payload<{ entries?: Array<{ name: string }> }>("ls", r);
      return (data.entries ?? []).map((e) => e.name);
    },
  };
}

/** Набор операций по машине — подставляется в createCodingTools. */
export function hostOperations(machineId: string, cwd: string) {
  return {
    bash: hostBashOperations(machineId, cwd),
    read: hostReadOperations(machineId),
    write: hostWriteOperations(machineId),
    edit: hostEditOperations(machineId),
    grep: hostGrepOperations(machineId),
    find: hostFindOperations(machineId),
    ls: hostLsOperations(machineId),
  };
}
/** SDK grep still spawns local rg even with custom GrepOperations. Replace
 * its execution in both host entrypoints; other SDK tools keep their normal
 * behavior with a per-invocation cancellation signal for every host call. */
export function withHostToolExecution(machineId: string | null, cwd: string, tools: any[]): any[] {
  if (!machineId) return tools;
  return tools.map(tool => ({ ...tool, execute: (id: string, args: any, signal?: AbortSignal, onUpdate?: any) => {
    signal?.throwIfAborted();
    return hostInvocation.run({signal}, () => tool.name === "grep"
      ? remoteGrep(machineId, cwd, args)
      : tool.execute(id, args, signal, onUpdate));
  }}));
}

async function remoteGrep(machineId: string, cwd: string, args: any) {
  const target = path.posix.resolve(cwd, args.path || ".");
  const directory = await hostIsDirectory(machineId, target);
  const limit = Math.max(1, Math.min(2000, Math.floor(args.limit ?? 100)));
  const pattern = args.literal ? String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : String(args.pattern);
  const regexp = new RegExp(pattern, args.ignoreCase ? "i" : "");
  const cache = new Map<string, string[]>();
  const lines = async (file: string) => {
    if (!cache.has(file)) cache.set(file, (await hostReadOperations(machineId).readFile(file)).toString("utf8").replace(/\r\n/g,"\n").split("\n"));
    return cache.get(file)!;
  };
  let matches: Array<{path: string; line: number; text: string}>;
  let truncated = false;
  if (directory) {
    const result = await hostCall(machineId, "grep", {path: target, pattern, ignoreCase: Boolean(args.ignoreCase), glob: args.glob && !args.glob.includes("/") ? "**/" + args.glob : args.glob, maxMatches: limit});
    const data = payload<{matches: typeof matches; truncated?: boolean; unreadable?: string[]}>("grep", result);
    matches = data.matches ?? [];
    truncated = Boolean(data.truncated);
    if (data.unreadable?.length) throw new Error("grep: недоступны пути: " + data.unreadable.join("; "));
  } else {
    matches = (await lines(target)).flatMap((line, index) => regexp.test(line) ? [{path: target, line: index + 1, text: line}] : []);
    truncated = matches.length > limit;
    matches = matches.slice(0, limit);
  }
  const context = Math.max(0, Math.floor(args.context ?? 0));
  const output: string[] = [];
  const emitted = new Set<string>();
  for (const match of matches) {
    const label = directory ? path.posix.relative(target, match.path) : path.posix.basename(target);
    const content = context ? await lines(match.path) : [];
    const first = Math.max(1, match.line - context), last = context ? Math.min(content.length, match.line + context) : match.line;
    for (let n = first; n <= last; n++) {
      const key = match.path + ":" + n;
      if (emitted.has(key)) continue;
      emitted.add(key);
      output.push(`${label}:${n}: ${context ? content[n-1] : match.text}`);
    }
  }
  const bounded = truncateHead(output.join("\n") || "No matches found");
  const notices = [truncated ? `Match limit ${limit} reached; narrow the search` : "", bounded.truncated ? "Output truncated" : ""].filter(Boolean);
  return {content:[{type:"text",text:bounded.content + (notices.length ? "\n["+notices.join("; ")+"]" : "")}],details:{...(truncated?{matchLimitReached:limit}:{}),...(bounded.truncated?{truncation:bounded}:{})}};
}
