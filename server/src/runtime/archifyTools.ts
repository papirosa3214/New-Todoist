// Схемы по коду для ролей (владелец 09.11.2026): движок Archify 3.0.1, которым
// агенты пользуются на маке, теперь стоит и на .110 (`~/apps/archify`).
//
// Ролям он не нужен в каждом запросе — четыре операции `archify_*` подключены
// к загрузчику по требованию (`ON_DEMAND_PREFIXES` в roleToolCatalog.ts).
//
// Archify не строит схему по коду сам: он проверяет и рисует JSON-IR, а
// исходники читает роль. Порядок «сначала исходники, потом схема» задан
// правилом в `scripts/role-rules.json`, а не здесь.
//
// Куда ложится готовый файл — решение владельца: схема по проекту идёт в
// папку артефактов этого проекта (`docs/artifacts/diagrams`), любая другая —
// в серверную папку артефактов (`~/artifacts/diagrams`). Файл обязателен
// всегда, а в чате он ещё и уходит вложением.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { ToolError } from "./inProcessRun.js";
import type { Tool } from "./universalTaskflow.js";

export const ARCHIFY_PREFIX = "archify_";

/** Имя операции в наборе роли. Префикс — то, по чему загрузчик держит
 *  операции Archify вне каждого запроса: без него четыре схемы описаний
 *  висели бы в контексте всех ролей постоянно. */
export const archifyToolName = (command: string): string => ARCHIFY_PREFIX + command;

const ARCHIFY_TIMEOUT_MS = 180_000;
/** Потолок вывода: сообщение валидатора бывает длинным, но не бесконечным. */
const OUTPUT_LIMIT = 8_000;
const DIAGRAM_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
const S = (description?: string) => Type.Optional(Type.String(description ? { description } : {}));

export function archifyDir(): string {
  return process.env.TASKFLOW_ARCHIFY_DIR
    ? path.resolve(process.env.TASKFLOW_ARCHIFY_DIR)
    : path.join(os.homedir(), "apps", "archify");
}

function archifyBin(): string {
  return path.join(archifyDir(), "bin", "archify.mjs");
}

export function artifactsRoot(): string {
  return process.env.TASKFLOW_ARTIFACTS_DIR
    ? path.resolve(process.env.TASKFLOW_ARTIFACTS_DIR)
    : path.join(os.homedir(), "artifacts");
}

/** Папка, куда ложится готовый HTML. */
export function diagramTargetDir(projectDir?: string): string {
  return projectDir
    ? path.join(projectDir, "docs", "artifacts", "diagrams")
    : path.join(artifactsRoot(), "diagrams");
}

const projectsRoot = (): string => path.join(os.homedir(), "Проекты");

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** `project` — папка проекта, в который ляжет схема. Только внутри ~/Проекты:
 *  роль не должна писать файлы по произвольному пути. */
export function resolveProjectDir(value?: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw || /^(нет|нету|none|-|—)$/i.test(raw)) return undefined;
  const root = projectsRoot();
  const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!inside(root, dir)) {
    throw new ToolError(`project: «${raw}» вне папки проектов. Назови папку внутри ${root} или не передавай project — тогда схема ляжет в серверные артефакты.`);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new ToolError(`project: папки «${raw}» нет в ${root}. Проверь имя через taskflow_host_bash (ls) и повтори.`);
  }
  return dir;
}

function runArchify(args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number, output: string) => {
      if (settled) return;
      settled = true;
      resolve({ code, output: output.slice(0, OUTPUT_LIMIT) });
    };
    const child = spawn(process.execPath, [archifyBin(), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ARCHIFY_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      if (out.length < OUTPUT_LIMIT * 4) out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (err.length < OUTPUT_LIMIT * 4) err += String(chunk);
    });
    child.on("error", (error) => done(1, `не удалось запустить archify: ${error.message}`));
    child.on("close", (code) => done(code ?? 1, [out.trim(), err.trim()].filter(Boolean).join("\n")));
  });
}

/** JSON-IR приходит и объектом, и строкой: модель охотнее отдаёт объект, а
 *  CLI ждёт файл — значит разбираем здесь, до записи во временный файл. */
function candidateText(json: unknown): string {
  if (typeof json === "string") {
    try {
      JSON.parse(json);
    } catch {
      throw new ToolError("json: строка не разобралась как JSON. Передай JSON-IR объектом или строкой с валидным JSON.");
    }
    return json;
  }
  if (json && typeof json === "object") return JSON.stringify(json, null, 2);
  throw new ToolError("json: нужен JSON-IR схемы (объект) — схему полей отдаёт archify_guide.");
}

async function withCandidate<T>(text: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archify-"));
  try {
    const file = path.join(dir, "candidate.json");
    fs.writeFileSync(file, text, "utf8");
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function safeFileName(value: string | undefined, type: string): string {
  const base = String(value ?? "").trim().replace(/\.html?$/i, "");
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (cleaned) return `${cleaned}.html`;
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  return `${type}-${stamp}.html`;
}

/** Вложение в чат делается здесь, а не моделью: готовый HTML весит сотни
 *  килобайт, и передавать его содержимое через аргументы инструмента нельзя. */
async function attachToChat(role: string, chatId: string, messageId: string | undefined, file: string, caption: string): Promise<string | null> {
  // Серверные зависимости подтягиваются только на вложении: без этого модуль
  // схем тянет за собой весь сервер и не грузится в юнит-тесте.
  const [{ default: db }, { saveUploadedFile }, { roleUserId }, { asRole }] = await Promise.all([
    import("../db.js"),
    import("../routes/attachments.js"),
    import("../roleRouting.js"),
    import("./inProcessRun.js"),
  ]);
  const body = fs.readFileSync(file);
  const name = path.basename(file);
  const attachmentId = saveUploadedFile({ body, name, mime: "text/html" }, (saved) =>
    db.prepare(`INSERT INTO attachments
       (id, task_id, comment_id, chat_message_id, kind, user_id, file_name, mime, size, stored_name)
       VALUES (?, NULL, NULL, NULL, 'comment', ?, ?, ?, ?, ?)`)
      .run(saved.id, roleUserId(role), saved.fileName, saved.mime, saved.size, saved.storedName));
  const response = await asRole(role, "POST", `/api/chats/${chatId}/messages`, {
    text: caption.trim() || `Схема: ${name}`,
    attachment_ids: [attachmentId],
    reply_to_message_id: messageId,
    work_mode: "work",
  });
  return response?.message?.id ?? response?.id ?? null;
}

export type ArchifyOptions = {
  role: string;
  chatId?: string;
  messageId?: string;
};

/** Четыре операции. Пустой набор — если Archify не установлен: роль не должна
 *  видеть инструмент, который заведомо упадёт. */
export function createArchifyTools(options: ArchifyOptions): Tool[] {
  if (!fs.existsSync(archifyBin())) {
    console.warn(`[archify] нет ${archifyBin()} — инструменты схем ролям не подключены`);
    return [];
  }
  const cwd = archifyDir();

  const guide: Tool = {
    name: archifyToolName("guide"),
    description:
      "Правила Archify и схема JSON-IR для типа схемы: architecture (устройство системы), workflow (процесс), sequence (обмен сообщениями), dataflow (данные), lifecycle (состояния). Зови первым, до archify_render — без схемы IR модель сочиняет поля наугад. Схему по коду строй по прочитанным исходникам, а не по памяти.",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ enum: [...DIAGRAM_TYPES], description: "тип схемы; без него — architecture" })),
      question: S("что именно подсказать: например «какие поля обязательны»"),
    }),
    execute: async (_id, args: { type?: string; question?: string }) => {
      const target = args?.type ?? "architecture";
      const question = String(args?.question ?? "").trim();
      const result = await runArchify(["guide", question ? `${target} ${question}` : target, "--json"], cwd);
      return { content: [{ type: "text", text: result.output || "(пусто)" }], details: { operation: archifyToolName("guide"), exit: result.code } };
    },
  };

  const validate: Tool = {
    name: archifyToolName("validate"),
    description:
      "Проверить JSON-IR схемы без рисования: вернёт ok и точные нарушения полей. Дешевле, чем render: правь кандидата по списку ошибок и повторяй.",
    parameters: Type.Object({
      type: Type.String({ enum: [...DIAGRAM_TYPES], description: "тип схемы" }),
      json: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], { description: "JSON-IR схемы объектом или строкой" }),
    }),
    execute: async (_id, args: { type: string; json: unknown }) => {
      const text = candidateText(args?.json);
      const result = await withCandidate(text, (file) => runArchify(["validate", String(args.type), file, "--json"], cwd));
      return { content: [{ type: "text", text: result.output || "(пусто)" }], details: { operation: archifyToolName("validate"), exit: result.code } };
    },
  };

  const render: Tool = {
    name: archifyToolName("render"),
    description:
      "Нарисовать схему (диаграмму) из JSON-IR в самостоятельный HTML-файл и приложить его вложением в чат. Нужны type и json (JSON-IR из archify_guide). project — папка проекта: схема ляжет в её docs/artifacts/diagrams; без project — в серверную папку артефактов. Файл сохраняется всегда, даже когда вложить некуда.",
    parameters: Type.Object({
      type: Type.String({ enum: [...DIAGRAM_TYPES], description: "тип схемы" }),
      json: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], { description: "JSON-IR схемы объектом или строкой" }),
      file_name: S("имя файла без пути, например taskflow-chat-flow"),
      project: S("папка проекта внутри ~/Проекты, если схема про этот проект"),
      caption: S("подпись к вложению в чат"),
      quality: Type.Optional(Type.String({ enum: ["standard", "showcase"], description: "standard — читаемо и плотно, showcase — просторнее; по умолчанию standard" })),
    }),
    execute: async (_id, args: { type: string; json: unknown; file_name?: string; project?: string; caption?: string; quality?: string }) => {
      const type = String(args?.type);
      const text = candidateText(args?.json);
      const projectDir = resolveProjectDir(args?.project);
      const targetDir = diagramTargetDir(projectDir);
      fs.mkdirSync(targetDir, { recursive: true });
      const file = path.join(targetDir, safeFileName(args?.file_name, type));
      const quality = args?.quality === "showcase" ? "showcase" : "standard";
      const result = await withCandidate(text, (candidate) =>
        runArchify(["render", type, candidate, file, "--quality", quality], cwd),
      );
      if (result.code !== 0 || !fs.existsSync(file)) {
        throw new ToolError(`ARCHIFY_RENDER_FAILED: схема не построилась. ${result.output}\nПоправь JSON-IR по списку нарушений (подсказки даёт archify_guide) и повтори.`);
      }
      const bytes = fs.statSync(file).size;
      let messageId: string | null = null;
      let attachNote = "Вложения нет: работа идёт по карточке, а не в чате. Путь к файлу — в ответе.";
      if (options.chatId) {
        try {
          messageId = await attachToChat(options.role, options.chatId, options.messageId, file, String(args?.caption ?? ""));
          attachNote = "Файл приложен вложением в этот чат.";
        } catch (error) {
          attachNote = `Файл сохранён, но приложить не удалось: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
        }
      }
      return {
        content: [{ type: "text", text: `Схема готова: ${file} (${Math.round(bytes / 1024)} КБ). ${attachNote}` }],
        details: { operation: archifyToolName("render"), file, bytes, message_id: messageId, project: projectDir ?? null },
      };
    },
  };

  const check: Tool = {
    name: archifyToolName("check"),
    description:
      "Проверить готовый HTML-файл схемы: провенанс (из какого JSON-IR собран) и целостность. Для уже сохранённых схем, когда нужно убедиться, что файл настоящий, а не пустая заготовка.",
    parameters: Type.Object({
      path: Type.String({ description: "путь к HTML схемы, созданному archify_render" }),
    }),
    execute: async (_id, args: { path: string }) => {
      const target = path.resolve(String(args?.path ?? ""));
      const allowed = [artifactsRoot(), projectsRoot()].some((root) => inside(root, target));
      if (!allowed) {
        throw new ToolError(`path: проверять можно только файлы в ${artifactsRoot()} и ${projectsRoot()}.`);
      }
      if (!fs.existsSync(target)) throw new ToolError(`path: файла «${target}» нет. Сначала archify_render.`);
      const result = await runArchify(["check", target, "--json"], cwd);
      return { content: [{ type: "text", text: result.output || "(пусто)" }], details: { operation: archifyToolName("check"), exit: result.code } };
    },
  };

  return [guide, validate, render, check];
}
