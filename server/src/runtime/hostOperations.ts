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
      const результат = (await runOperation(
        machineId,
        "bash",
        { command, cwd: cwd || defaultCwd },
        {
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

export function hostReadOperations(machineId: string): ReadOperations {
  return {
    // Целиком и байтами (encoding base64): инструмент read сам режет текст по
    // строкам и показывает картинки. Прежний текстовый режим ломал
    // изображения и отдавал только первые 2000 строк (16.10.2026).
    readFile: async (absolutePath) => {
      const r = (await runOperation(machineId, "read", { path: absolutePath, encoding: "base64" })) as unknown as Resultado;
      const data = payload<{ content?: string; encoding?: string }>("read", r);
      return Buffer.from(data.content ?? "", data.encoding === "base64" ? "base64" : "utf8");
    },
    detectImageMimeType: async (absolutePath) => IMAGE_TYPES[absolutePath.toLowerCase().split(".").pop() ?? ""] ?? null,
    access: async (absolutePath) => {
      const r = (await runOperation(machineId, "ls", { path: absolutePath })) as unknown as Resultado;
      if (!r.ok) throw fail("access", r);
    },
  };
}

export function hostWriteOperations(machineId: string): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const r = (await runOperation(machineId, "write", {
        path: absolutePath, content,
      })) as unknown as Resultado;
      if (!r.ok) throw fail("write", r);
    },
    mkdir: async (dir) => {
      // Отдельной операции mkdir у хоста нет, а роль создаёт вложенные папки.
      // Хост сам создаёт недостающие папки перед записью (write.ts, missingDirs),
      // поэтому mkdir — это запись служебного файла, а не новая операция в
      // протоколе.
      const r = (await runOperation(machineId, "write", {
        path: dir, content: "",
      })) as unknown as Resultado;
      if (!r.ok) throw fail("mkdir", r);
    },
  };
}

export function hostEditOperations(machineId: string): EditOperations {
  const чтение = hostReadOperations(machineId);
  const запись = hostWriteOperations(machineId);
  return {
    readFile: чтение.readFile,
    writeFile: запись.writeFile,
    access: чтение.access,
  };
}

export function hostGrepOperations(machineId: string): GrepOperations {
  return {
    isDirectory: async (absolutePath) => {
      const r = (await runOperation(machineId, "ls", { path: absolutePath })) as unknown as Resultado;
      const data = payload<{ entries?: unknown[] }>("grep", r);
      // Признак папки у ls — наличие entries: у файла их нет.
      return Array.isArray(data.entries);
    },
    readFile: async (absolutePath) => {
      const r = (await runOperation(machineId, "read", { path: absolutePath })) as unknown as Resultado;
      const data = payload<{ content?: string }>("grep", r);
      return data.content ?? "";
    },
  };
}

export function hostFindOperations(machineId: string): FindOperations {
  return {
    exists: async (absolutePath) => {
      const r = (await runOperation(machineId, "ls", { path: absolutePath })) as unknown as Resultado;
      return Boolean(r.ok);
    },
    glob: async (pattern, cwd, options) => {
      const r = (await runOperation(machineId, "find", {
        pattern, path: cwd, limit: options.limit,
      })) as unknown as Resultado;
      const data = payload<{ entries?: string[] }>("find", r);
      return data.entries ?? [];
    },
  };
}

export function hostLsOperations(machineId: string): LsOperations {
  const читает = async (absolutePath: string) =>
    (await runOperation(machineId, "ls", { path: absolutePath })) as unknown as Resultado;

  return {
    exists: async (absolutePath) => {
      const r = await читает(absolutePath);
      return Boolean(r.ok);
    },
    stat: async (absolutePath) => {
      const r = await читает(absolutePath);
      const data = payload<{ entries?: unknown[] }>("ls", r);
      return { isDirectory: () => Array.isArray(data.entries) };
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