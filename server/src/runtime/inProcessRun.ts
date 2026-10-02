import { instructionResources, createTaskResourceLoader } from "./instructionResources.js";
import { ensureRoleHome } from "./roleHome.js";
import { connectRoleComposio } from "./composioRuntime.js";
import { INSTRUCTION_DEFAULTS } from "./instructionDefaults.js";
import { renderInstruction, effectiveRules, registerInstructionBlock, instructionManifest } from "../lib/roleContextResolver.js";
import { isOwner } from "../access.js";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import db from "../db.js";
import { AGENT_RULES, logEvent } from "../agentState.js";
import { loadRoleRouting, providerOfModel, rolePromptText, roleTitle, roleUserId, ROLE_NAMES } from "../roleRouting.js";
import { composeLayer } from "../lib/roleContextResolver.js";
import { getModelRuntime } from "./PiRuntimeAdapter.js";
import { enqueueRoleRunJob } from "./roleRunQueue.js";
import { buildInProcessTaskContext } from "./taskContextBridge.js";
import { buildDependencyContext } from "./dependencyContext.js";
import { buildCollaborationPlanContext } from "./collaborationPlanContext.js";
import { roleWorkspace } from "./roleWorkspace.js";
import { recordTaskDocument } from "../lib/taskOutcome.js";

/**
 * Агент — часть TaskFlow, как профили у Гермеса (владелец 23.09.2026:
 * «делай как у Гермеса, без ключей»).
 *
 * Роль запускается ВНУТРИ сервера движком Pi (createAgentSession). Её
 * действия в трекере — не сетевые запросы с ключом, а внутренние вызовы
 * маршрутов сервера (app.inject) от имени учётки роли: права, лента и
 * правила те же, что для любого клиента, а наружу ничего не выдаётся.
 * Файлы, команды и правки кода — встроенные инструменты Pi.
 */

let app: FastifyInstance | null = null;

/** Подключается при старте сервера (index.ts). */
export function setInProcessApp(instance: FastifyInstance): void {
  app = instance;
}

type Json = Record<string, unknown>;

class ToolError extends Error {}

/** Внутренний вызов маршрута от имени роли. Подпись живёт в памяти сервера
 *  на один вызов: наружу не уходит, храниться нигде не нужно. */
async function asRole(
  role: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<any> {
  if (!app) throw new ToolError("сервер ещё не поднят");
  const token = app.jwt.sign({ id: roleUserId(role) }, { expiresIn: "5m" });
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as any } : {}),
  });
  const raw = res.body;
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { text: raw };
  }
  if (res.statusCode >= 400) {
    throw new ToolError(`${method} ${url} → ${res.statusCode}: ${data?.error ?? raw.slice(0, 200)}`);
  }
  return data;
}

function unwrap(d: any): any {
  return d && typeof d === "object" && "task" in d ? d.task : d;
}

function short(t: any): Json {
  return {
    id: t?.id,
    название: t?.title,
    статус: t?.status,
    работа: t?.agent_state ?? "не взята",
  };
}

const STEP_STATE_RU: Record<string, string> = {
  in_progress: "в работе",
  blocked: "заблокирован",
  review: "на проверке",
};

function asText(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: {},
  };
}

/** Живая строка «чем занят агент» в карточке. Мягко: сбой не роняет инструмент. */
async function activity(role: string, taskId: string, kind: string, target: string): Promise<void> {
  try {
    await asRole(role, "POST", `/api/tasks/${taskId}/activity`, { kind, target });
  } catch {
    // активность — не работа
  }
}

const execFileAsync = promisify(execFile);

/**
 * Пять специальных инструментов роли researcher (web_search, web_get, ocr,
 * youtube, local_model) — реализованы в `scripts/mcp_server.py`, отданы
 * через `scripts/research_server.py`. Раньше цепляли их через отдельный
 * внешний MCP-профиль (`~/.pi/agent/taskflow-profiles/researcher.json`,
 * схема «внешний Pi-процесс говорит по MCP через stdio») — эта схема
 * умерла молча 23.09.2026, когда роли переехали исполняться внутри
 * сервера: `resourceLoader.getExtensions()` ниже всегда пуст, внешние MCP
 * вообще не подключаются. Владелец 30.09.2026, вспомнил и попросил
 * восстановить — но уже под сегодняшнюю схему: разовый процесс на вызов
 * (`research_server.py --call <name>`, аргументы JSON на stdin, результат
 * JSON на stdout), не полноценный MCP-хендшейк с долгоживущим процессом.
 * Реализации остаются одним кодом в mcp_server.py — не копируем в TS.
 */
const RESEARCH_TOOL_TIMEOUT_MS = 90_000; // web_get/youtube/ocr реально не мгновенные

/**
 * Прокси НЕ читаем из `researcher.json` и не зашиваем сюда сами — владелец
 * 30.09.2026: это была бы ровно ещё одна копия того же порта, что уже
 * захардкожен в `.bashrc` (`HTTP_PROXY=http://127.0.0.1:10811`, xray-claude)
 * — вторая точка, которую при смене сети забудут поправить, тот же класс
 * бага, что уже усыпил весь этот тулинг 23.09.2026. Наследуем process.env
 * как есть: если `taskflow-server.service` получит HTTP(S)_PROXY/NO_PROXY
 * из ЕДИНОГО systemd-уровневого источника (см. итог разговора) — все
 * дочерние процессы, в том числе этот, подхватят его сами, без своей копии.
 */
async function callResearchTool(name: string, args: unknown): Promise<unknown> {
  let stdout: string;
  try {
    // execFile (промисифицированный) не понимает опцию input, как
    // execFileSync — аргументы пишем в stdin самого child вручную, до
    // ожидания результата (PromiseWithChild даёт доступ к процессу через
    // .child, не дожидаясь await).
    const home = ensureRoleHome("researcher");
    const pending = execFileAsync("python3", [path.join(home.scripts, "research_server.py"), "--call", name], {
      cwd: home.workspace,
      timeout: RESEARCH_TOOL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        // Ролевой ключ — НЕ общий TASKFLOW_AGENT_TOKEN (он сознательно
        // отозван, см. CLAUDE.md §5.1), а свой, для собственных запросов
        // роли к API (например, скачать вложение задачи под ocr).
        TASKFLOW_VAULT_KEY: "TASKFLOW_AGENT_TOKEN_RESEARCHER",
      },
    });
    pending.child.stdin?.end(JSON.stringify(args ?? {}));
    const result = await pending;
    stdout = result.stdout;
  } catch (err: any) {
    // execFile бросает и на ненулевой exit code — наш --call всегда пишет
    // JSON в stdout ДО exit(1), так что содержательная ошибка обычно там же.
    stdout = err?.stdout ?? "";
    if (!stdout) throw new ToolError(`research-инструмент ${name} не запустился: ${err?.message ?? String(err)}`);
  }
  let parsed: { result?: unknown; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ToolError(`research-инструмент ${name} вернул не JSON: ${stdout.slice(0, 500)}`);
  }
  if (parsed.error) throw new ToolError(parsed.error);
  return parsed.result;
}

/** Инструменты трекера для роли — те же имена и смысл, что в mcp_server.py,
 *  чтобы инструкции ролей не переписывать. Владелец 29.09.2026 (DESIGN.md
 *  «Роли плана — это подзадачи»): узел collaboration plan получает ТОТ ЖЕ
 *  полный набор, что и обычный запуск роли, без урезанного изолированного
 *  списка, который раньше был у slot'ов (`taskflow_slot_result`) — решение
 *  №2, «не вижу смысла что-то выдумывать, обычные тулы подзадачи более
 *  чем достаточно». */
/** `taskId` — карточка текущего хода: записанные `doc_write` документы
 *  привязываются к ней и попадают в её «Итог» (01.10.2026). */
export function taskflowTools(role: string, model: string | null, taskId?: string) {
  const T = (
    name: string,
    description: string,
    parameters: any,
    run: (p: any) => Promise<unknown>,
  ) => {
    const key = "tool.runtime." + name;
    registerInstructionBlock({key,title:name,group:"Возможности",scope:"command",modes:["work","resume","reply","review","subtask"],sourceKind:"code",originRef:"inProcessRun.ts:taskflowTools:"+name,readOnly:false,
      ...(["web_search","web_get","ocr","youtube","local_model","taskflow_report"].includes(name)?{roles:["researcher"]}:{})},description);
    return defineTool({
      name,
      label: name,
      description: composeLayer(role,key)!.effective,
      parameters,
      execute: async (_id: string, params: any) => {
        try {
          return asText(await run(params));
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : `сбой инструмента ${name}: ${String(e)}`;
          throw new Error(msg);
        }
      },
    } as any);
  };
  const Id = Type.Object({ id: Type.String() });

  const tools = [
    T("taskflow_my_tasks", "Мои задачи (назначенные на эту роль). state: free | in_progress | review | blocked.",
      Type.Object({ state: Type.Optional(Type.String()), include_completed: Type.Optional(Type.Boolean()) }),
      async (p) => {
        const me = roleUserId(role);
        let tasks = (await asRole(role, "GET", "/api/tasks?include_children=true")) as any[];
        tasks = tasks.filter((t) => t.assignee_id === me);
        if (p.include_completed !== true) tasks = tasks.filter((t) => t.status === "active");
        if (p.state === "free") tasks = tasks.filter((t) => !t.agent_state);
        else if (p.state) tasks = tasks.filter((t) => t.agent_state === p.state);
        return { всего: tasks.length, задачи: tasks.map(short) };
      }),
    T("taskflow_task", "Карточка задачи целиком: описание, шаги, лента.", Id, async (p) => {
      const d = await asRole(role, "GET", `/api/tasks/${p.id}`);
      const task = unwrap(d);
      void activity(role, p.id, "read", "карточке задачи");
      const feed = [
        ...(d.comments ?? []).map((c: any) => ({ когда: c.created_at, кто: c.user_name, комментарий: c.text })),
        ...(d.events ?? []).map((e: any) => ({
          когда: e.created_at, кто: e.actor_name ?? "Система", событие: e.kind, поле: e.field, стало: e.to_value,
        })),
      ].sort((a, b) => String(a.когда).localeCompare(String(b.когда)));
      return {
        ...short(task),
        описание: task.description,
        шаги: (d.subtasks ?? task.subtasks ?? []).map((s: any) => ({
          id: s.id, сделан: !!s.done, состояние: STEP_STATE_RU[s.agent_state ?? s.state] ?? "не в работе", название: s.title,
        })),
        лента: feed,
      };
    }),
    T("taskflow_claim", "Взять задачу в работу.", Id, async (p) => {
      const resp = await asRole(role, "POST", `/api/tasks/${p.id}/claim`, { model, runner: "Pi" });
      void activity(role, p.id, "edit", "статус: взял задачу в работу");
      return { "взято в работу": short(unwrap(resp)), правила: resp.rules ?? undefined };
    }),
    T("taskflow_heartbeat", "Продлить аренду задачи. Сервер продлевает её и сам, пока идёт запуск.", Id, async (p) => {
      await asRole(role, "POST", `/api/tasks/${p.id}/heartbeat`, {});
      return { "аренда продлена": p.id };
    }),
    T("taskflow_state", "Сменить состояние работы: review — сдать на проверку, blocked — упёрся и жду владельца, in_progress — вернуться. Для review и blocked комментарий обязателен.",
      Type.Object({ id: Type.String(), state: Type.String(), comment: Type.Optional(Type.String()) }),
      async (p) => {
        const body: Json = { state: p.state };
        if (p.comment) body.comment = p.comment;
        const resp = await asRole(role, "POST", `/api/tasks/${p.id}/state`, body);
        return { "состояние изменено": short(unwrap(resp)) };
      }),
    T("taskflow_review", "Вердикт по сданной задаче: approved или changes_requested (с комментарием). Только для проверяющего.",
      Type.Object({ id: Type.String(), verdict: Type.String(), findings: Type.Optional(Type.String()) }),
      async (p) => {
        const versions = await asRole(role, "GET", `/api/tasks/${p.id}/versions`);
        const current = (versions.versions ?? []).find((v: any) => v.is_current);
        if (!current) throw new ToolError("у задачи нет актуальной версии результата — проверять нечего");
        const findings = (p.findings ?? "").trim();
        const body: Json = {
          task_id: p.id, version_id: current.id, artifact_hash: current.artifact_hash,
          criteria_version: "1", task_revision: current.task_revision, verdict: p.verdict,
        };
        if (findings) body.findings = findings;
        if (p.verdict === "changes_requested") {
          if (!findings) throw new ToolError("для возврата нужен комментарий: что доработать");
          await asRole(role, "POST", "/api/reviews", body);
          await asRole(role, "POST", `/api/tasks/${p.id}/state`, { state: "in_progress", comment: findings });
          return { вердикт: "возвращено на доработку", комментарий: findings };
        }
        const resp = await asRole(role, "POST", "/api/reviews", body);
        return { вердикт: resp.verdict, комментарий: resp.findings };
      }),
    T("taskflow_comment", "Комментарий в ленту задачи.",
      Type.Object({ id: Type.String(), text: Type.String() }),
      async (p) => {
        await asRole(role, "POST", `/api/tasks/${p.id}/comments`, { text: p.text });
        void activity(role, p.id, "edit", "ленту задачи: оставил комментарий");
        return { "комментарий добавлен": p.id };
      }),
    T("taskflow_subtask_add", "Добавить шаг в задачу.",
      Type.Object({ task_id: Type.String(), title: Type.String(), after_id: Type.Optional(Type.String()) }),
      async (p) => {
        const body: Json = { title: p.title };
        if (p.after_id) body.after_id = p.after_id;
        const s = await asRole(role, "POST", `/api/tasks/${p.task_id}/subtasks`, body);
        return { "шаг добавлен": s.title, id: s.id };
      }),
    T("taskflow_subtask_work", "Состояние шага: in_progress перед началом, blocked с причиной; result — итог.",
      Type.Object({ id: Type.String(), state: Type.Optional(Type.String()), result: Type.Optional(Type.String()) }),
      async (p) => {
        const body: Json = {};
        if (p.state !== undefined) body.state = p.state;
        if (p.result !== undefined) body.result = p.result;
        const row = await asRole(role, "POST", `/api/subtasks/${p.id}/work`, body);
        if (p.state === "in_progress" && row.task_id) void activity(role, row.task_id, "edit", `шаг «${row.title ?? ""}»: начал`);
        return { подзадача: row.title, состояние: STEP_STATE_RU[row.state] ?? "не в работе", итог: row.result ?? "—" };
      }),
    T("taskflow_subtask_done", "Закрыть шаг с итогом (result — одно-два предложения). Если шаг — узел плана с контрактом на структурный артефакт (feature_spec и т.п.), передай artifact вместо простого закрытия галочкой: summary, payload (объект с required_fields) и evidence.",
      Type.Object({
        id: Type.String(),
        result: Type.Optional(Type.String()),
        done: Type.Optional(Type.Boolean()),
        artifact: Type.Optional(Type.Object({ summary: Type.String(), payload: Type.Any(), evidence: Type.Optional(Type.Array(Type.Any())) })),
      }),
      async (p) => {
        if (p.artifact) {
          const row = await asRole(role, "POST", `/api/subtasks/${p.id}/artifact`, p.artifact);
          void activity(role, row.subtask?.task_id ?? "", "edit", `шаг «${row.subtask?.title ?? ""}»: сдал артефакт`);
          return { "артефакт сдан": p.id, версия: row.artifact?.version_no };
        }
        const done = p.done ?? true;
        const body: Json = { done };
        if (p.result) body.result = p.result;
        const row = await asRole(role, "PATCH", `/api/subtasks/${p.id}`, body);
        if (done && row.task_id) void activity(role, row.task_id, "edit", `шаг «${row.title ?? ""}»: закрыл`);
        return { [done ? "шаг отмечен" : "отметка снята"]: p.id };
      }),
    T("taskflow_rules", "Правила ведения учёта.", Type.Object({}), async () => ({ правила: effectiveRules(role) })),
    T("taskflow_projects", "Проекты.", Type.Object({}), async () => ({
      проекты: ((await asRole(role, "GET", "/api/projects")) as any[]).map((p) => ({
        id: p.id, название: p.name, документация: p.notes_folder_id ? "есть" : "не заведена",
      })),
    })),
    T("taskflow_docs", "Документация проекта: список заметок.",
      Type.Object({ project_id: Type.String() }),
      async (p) => {
        const d = await asRole(role, "GET", `/api/projects/${p.project_id}/docs`);
        if (!d.folder) return { документация: "папка не заведена" };
        return {
          папка: d.folder.name,
          заметки: (d.notes ?? []).map((n: any) => ({ id: n.id, название: n.title || "без названия", начало: n.preview })),
        };
      }),
    T("taskflow_doc_read", "Прочитать заметку документации целиком.", Id, async (p) => {
      const n = await asRole(role, "GET", `/api/notes/${p.id}?format=markdown`);
      return { название: n.title || "без названия", текст: n.markdown ?? "" };
    }),
    T("taskflow_doc_write", "Записать в документацию проекта: новая заметка (project_id) или дописать в существующую (id).",
      Type.Object({ markdown: Type.String(), id: Type.Optional(Type.String()), project_id: Type.Optional(Type.String()) }),
      async (p) => {
        if (!String(p.markdown).trim()) throw new ToolError("нечего записывать: markdown пуст");
        if (p.id) {
          const cur = await asRole(role, "GET", `/api/notes/${p.id}?format=markdown`);
          const merged = `${String(cur.markdown ?? "").trimEnd()}\n\n${p.markdown}`.trim();
          const n = await asRole(role, "PATCH", `/api/notes/${p.id}`, { markdown: merged });
          if (taskId) recordTaskDocument(taskId, n.id, roleUserId(role));
          return { готово: "заметка обновлена", id: n.id };
        }
        if (!p.project_id) throw new ToolError("нужен project_id или id заметки");
        const d = await asRole(role, "GET", `/api/projects/${p.project_id}/docs`);
        if (!d.folder) throw new ToolError("у проекта нет папки документации");
        const n = await asRole(role, "POST", "/api/notes", { markdown: p.markdown, folder_id: d.folder.id });
        if (taskId) recordTaskDocument(taskId, n.id, roleUserId(role));
        return { готово: "заметка создана", id: n.id };
      }),
    T("taskflow_kb_search", "Поиск по документации проектов.",
      Type.Object({ query: Type.String(), top_k: Type.Optional(Type.Number()) }),
      async (p) => {
        const d = await asRole(role, "GET", `/api/knowledge/search?q=${encodeURIComponent(p.query)}&top_k=${p.top_k ?? 5}`);
        return { запрос: p.query, куски: (d.results ?? []).map((r: any) => ({ текст: String(r.text ?? "").slice(0, 1500), id_заметки: r.doc_id })) };
      }),
  ];

  // Пять специальных инструментов Исследователя — см. callResearchTool выше.
  // Только для этой роли: другим они не нужны и не были для них заведены
  // (researcher.json, сервер research — владелец 21.09.2026: «это НЕ общие
  // инструменты TaskFlow»).
  if (role === "researcher") {
    tools.push(
      T("web_search", "Найти в интернете: сначала Tavily, при недоступности — Brave. Возвращает список результатов со ссылками и выжимками. Текст страницы потом бери через web_get.",
        Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("web_search", p)),
      T("web_get", "Скачать страницу и вернуть её основное содержимое чистым markdown — без меню, рекламы и скриптов. Для PDF и сканов — ocr.",
        Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("web_get", p)),
      T("ocr", "Распознать текст из изображения или PDF (в том числе скан без текстового слоя), русский+английский. Источник — attachment_id вложения задачи или path файла на машине.",
        Type.Object({ attachment_id: Type.Optional(Type.String()), path: Type.Optional(Type.String()), langs: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("ocr", p)),
      T("youtube", "Транскрипт видео YouTube в текст (сначала ручные субтитры, иначе авто). Источник-видео для исследования.",
        Type.Object({ url: Type.String(), langs: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("youtube", p)),
      T("local_model", "ЛОКАЛЬНАЯ модель на сервере (Ollama, бесплатно, без интернета). Этап «синтез»: отдай собранные фрагменты и задание — вернёт связный черновик или сводку.",
        Type.Object({ prompt: Type.String(), system: Type.Optional(Type.String()), max_tokens: Type.Optional(Type.Number()), num_ctx: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("local_model", p)),
      T("taskflow_report", "Собрать отчёт по задаче: markdown → HTML и PDF, зеркало в документации проекта и секция «Отчёты» карточки.",
        Type.Object({ task_id: Type.String(), title: Type.Optional(Type.String()), markdown: Type.String() }),
        async (p) => asRole(role,"POST",`/api/tasks/${p.task_id}/reports`,{title:p.title ?? "Отчёт",markdown:p.markdown})),
    );
  }

  return tools;
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const HEARTBEAT_MS = 90_000;

/** Что агент роли получает на заходе внутри сервера — для экрана «Команда». */
export function inProcessToolNames(): string[] {
  return [...BUILTIN_TOOLS, ...taskflowTools("", null).map((t) => t.name)];
}

function rolePrompt(role: string): string {
  return rolePromptText(role) ?? "";
}

function taskForLaunchContext(taskId: string): Record<string, unknown> {
  const task = db.prepare(
    "SELECT id, title, description, project_id, priority, due_date FROM tasks WHERE id = ?",
  ).get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("карточка больше не существует");
  const comments = db.prepare(`
    SELECT COALESCE(u.name, c.user_id) AS author, c.text, c.created_at
      FROM comments c
 LEFT JOIN users u ON u.id = c.user_id
     WHERE c.task_id = ?
  ORDER BY c.created_at DESC, c.rowid DESC
     LIMIT 10
  `).all(taskId);
  return { ...task, comments };
}

/** Задание по умолчанию — когда вызывающий не собрал своё (ручной запуск). */
export function defaultTaskPrompt(taskId: string, role: string): string {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return renderInstruction(role, "task.start", { roleTitle: roleTitle(role), taskId, title: task?.title ?? "", rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

/**
 * Задание для роли, запущенной на конкретном узле collaboration plan
 * (владелец 29.09.2026, DESIGN.md «Роли плана — это подзадачи»). В отличие
 * от бывших slot-запусков — инструменты и видимость карточки ПОЛНЫЕ, те же,
 * что у обычного запуска: изоляция была осознанно снята (решение №2).
 * `taskflow_claim` здесь не нужен — узел плана уже назначен этой роли
 * (`agent_id`) и уже in_progress, работа начинается сразу с самого шага.
 */
function planSubtaskPrompt(taskId: string, role: string, subtaskId: string): string {
  const subtask = db.prepare("SELECT title FROM subtasks WHERE id = ?").get(subtaskId) as { title?: string } | undefined;
  return renderInstruction(role, "task.plan", { roleTitle: roleTitle(role), taskId, subtaskId, subtaskTitle: subtask?.title ?? "", rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

// ── Папка проекта, справка, продолжение разговора (этап C3) ──────────────

const PROJECTS_CONFIG = path.join(process.cwd(), "scripts", "task-context-projects.json");
const RUNS_BASE = process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(), ".local", "state", "taskflow-runs");
export { LOCAL_EXECUTION_POLICY } from "./instructionDefaults.js";
const LOCAL_EXECUTION_POLICY = INSTRUCTION_DEFAULTS.local_policy;

/** Репозиторий проекта карточки — из того же файла, что читал будильник
 *  (scripts/task-context-projects.json); не сопоставлен — репозиторий TaskFlow. */
function projectRepo(taskId: string): string {
  const fallback = path.resolve(process.cwd(), "..");
  try {
    const projectId = (db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as
      | { project_id?: string | null }
      | undefined)?.project_id;
    const map = JSON.parse(fs.readFileSync(PROJECTS_CONFIG, "utf8")).projects ?? {};
    const repo = projectId ? map[projectId] : undefined;
    return repo && fs.existsSync(repo) ? repo : fallback;
  } catch {
    return fallback;
  }
}

/** Справка для агента: ветка и незакоммиченные файлы — только чтение git. */
function repoNote(cwd: string): string {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
    const dirty = execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8", timeout: 5000 })
      .split("\n").filter((l) => l.trim()).slice(0, 20);
    return [
      `Рабочая папка: ${cwd}, ветка ${branch}.`,
      dirty.length ? `Незакоммиченные файлы (чужая работа — не трогай без нужды):\n${dirty.join("\n")}` : "Незакоммиченных файлов нет.",
    ].join("\n");
  } catch {
    return `Рабочая папка: ${cwd}.`;
  }
}

/** Разговор агента хранится на пару «задача + роль» и продолжается при
 *  следующем заходе — после ответа владельца, паузы или повтора. */
function sessionDir(taskId: string, role: string, subtaskId?: string): string {
  return path.join(RUNS_BASE, "sessions", `${taskId}-${role}-${subtaskId ?? "main"}`);
}

function hasSession(taskId: string, role: string, subtaskId?: string): boolean {
  try {
    return fs.readdirSync(sessionDir(taskId, role, subtaskId)).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

function resumePrompt(taskId: string, role = "builder"): string {
  return renderInstruction(role, "task.resume", { taskId });
}

/** Сколько раз подряд агент вышел посреди работы — для повторного захода. */
const chainCount = new Map<string, number>();
const MAX_CHAIN = 3;

function progressMark(taskId: string): string {
  const steps = (db.prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND done = 1").get(taskId) as { n: number }).n;
  const comments = (db.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(taskId) as { n: number }).n;
  return `${steps}:${comments}`;
}

type ActiveInProcessRun = { runId: string; taskId: string; role: string; subtaskId?: string; abort: () => Promise<void> };
const activeRuns = new Map<string, ActiveInProcessRun>();

export function activeInProcessRun(taskId: string, subtaskId?: string): ActiveInProcessRun | undefined {
  return [...activeRuns.values()].find((r) => r.taskId === taskId && r.subtaskId === subtaskId);
}

/** Для тестов: дождаться окончания всех фоновых запусков. */
const pending = new Set<Promise<void>>();
export async function _settleInProcessRunsForTests(): Promise<void> {
  await Promise.all([...pending]);
}

/**
 * Запустить роль на задаче внутри сервера. Возвращается сразу; работа идёт
 * в фоне. Аренду держит сервер, пока агент работает; действия встроенных
 * инструментов (чтение, правка, команды) видны в карточке. Сбой — карточка
 * заблокирована с причиной.
 */
export async function runRoleInProcess(input: {
  taskId: string;
  role: string;
  prompt?: string;
  cwd?: string;
  model?: string;
  /** work — работа по задаче (с повторами), reply — только ответ владельцу,
   *  review — вердикт Критика. */
  mode?: "work" | "reply" | "review";
  /** Автоматический worker пишет следующий after_run в durable queue.
   *  Прямой ручной/тестовый запуск сохраняет немедленный handoff. */
  durableHandoff?: boolean;
  /** Число уже выполненных C3 continuation-заходов durable chain. */
  chainDepth?: number;
  /** Узел collaboration plan — запуск роли на конкретной подзадаче плана,
   *  а не на задаче целиком (изолированный сеанс/сессия на этот узел). */
  subtaskId?: string;
}): Promise<{ runId: string; completion: Promise<void> }> {
  const { taskId, role } = input;
  if (!ROLE_NAMES.includes(role)) throw new Error(`роли «${role}» нет или она отключена`);
  if (activeInProcessRun(taskId, input.subtaskId)) throw new Error("по этому окну агент уже работает");

  const routing = loadRoleRouting();
  const modelId = input.model || routing.models[role];
  const runtime: any = await getModelRuntime();
  const model =
    runtime.getModel?.(providerOfModel(modelId), modelId) ??
    ((await runtime.getAvailable?.()) ?? []).find((m: any) => m.id === modelId);
  if (!model) throw new Error(`модель «${modelId}» недоступна`);

  // Репозиторий самого сервера — только в отдельной копии: сохранение файла
  // в живой перезапустило бы сервер вместе с этим ходом (roleWorkspace.ts).
  const cwd = input.cwd ?? roleWorkspace(taskId, projectRepo(taskId));
  const mode = input.mode ?? (role === "critic_verifier" ? "review" : "work");
  const resumed = hasSession(taskId, role, input.subtaskId);
  const dependencyContext = buildDependencyContext(taskId);
  if (dependencyContext.status === "ok" && dependencyContext.dependencies.length) {
    logEvent({
      taskId,
      actorId: null,
      kind: "dependency_context_used",
      field: "dependencies",
      toValue: JSON.stringify({ version: dependencyContext.version, dependencies: dependencyContext.dependencies.map((d) => d.task_id) }),
    });
  }
  const collaborationContext = input.subtaskId ? buildCollaborationPlanContext(input.subtaskId) : undefined;
  if (collaborationContext && collaborationContext.status === "ok") {
    logEvent({
      taskId,
      actorId: null,
      kind: "collaboration_context_used",
      field: collaborationContext.slot_key ?? input.subtaskId ?? "",
      toValue: JSON.stringify({
        plan_id: collaborationContext.plan_id,
        revision: collaborationContext.revision,
        artifacts: collaborationContext.predecessor_artifacts.map((a) => a.slot_key + ":" + a.artifact_key),
      }),
    });
  }
  const launchContext = await buildInProcessTaskContext({
    task: taskForLaunchContext(taskId),
    actor: { id: roleUserId(role), name: roleTitle(role) },
    dependency_context: dependencyContext,
    collaboration_context: collaborationContext,
  });
  if (mode === "work" && !resumed) {
    try {
      await asRole(role, "POST", `/api/tasks/${taskId}/comments`, { text: launchContext.summary });
    } catch (error) {
      console.warn(`контекст для ${taskId} собран, но сводка не записана:`, error);
    }
  }
  fs.mkdirSync(sessionDir(taskId, role, input.subtaskId), { recursive: true });
  const systemPrompt = [
    composeLayer(role, "role.prompt")?.effective
      || rolePrompt(role)
      || `Ты — ${roleTitle(role)} в трекере TaskFlow.`,
    composeLayer(role, "local_policy")?.effective ?? LOCAL_EXECUTION_POLICY,
  ].join("\n\n");
  const resourceLoader = await createTaskResourceLoader(role, cwd, systemPrompt);

  // Снимок фактического system prompt, который модель получит в этом запуске.
// Записывается в tasks.composed_prompt_snapshot — это «что видела модель»,
// доступное владельцу и iOS для прозрачности (дизайн §8).
try {
  db.prepare(
    "UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?",
  ).run(systemPrompt, taskId);
} catch {
  // колонка появится только после миграции 081; до неё молча.
}

  const composio = await connectRoleComposio(role, mode, input.subtaskId ?? taskId);
  const customTools = [...taskflowTools(role, model.id ?? modelId, taskId), ...composio.tools];
  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader,
    tools: [...new Map([...createCodingTools(cwd),...createReadOnlyTools(cwd)].map(t=>[t.name,t])).values()].filter(t=>BUILTIN_TOOLS.includes(t.name)).map(t=>({...t,description:composeLayer(role,"tool.builtin."+t.name)?.effective ?? t.description})),
    customTools,
    sessionManager: SessionManager.continueRecent(cwd, sessionDir(taskId, role, input.subtaskId)),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
  } as any).catch(async error => { resourceLoader.disposeResources(); await composio.close(); throw error; });

  const runId = `inproc_${crypto.randomUUID()}`;
  db.prepare("UPDATE tasks SET composed_prompt_snapshot=? WHERE id=?").run((session as any).systemPrompt ?? systemPrompt, taskId);
  logEvent({taskId,actorId:roleUserId(role),kind:"instruction_snapshot",field:runId,toValue:JSON.stringify({mode: input.subtaskId ? "subtask" : mode, resumed, manifest:instructionManifest(role,input.subtaskId ? "subtask" : (resumed ? "resume" : mode === "work" ? "work" : mode))})});
  const before = progressMark(taskId);
  activeRuns.set(runId, { runId, taskId, role, subtaskId: input.subtaskId, abort: () => session.abort() });

  // Действия встроенных инструментов — строкой в карточке, как раньше делало
  // расширение Pi taskflow-activity.ts.
  const KIND: Record<string, string> = {
    read: "read", grep: "read", find: "read", ls: "read", edit: "edit", write: "edit", bash: "bash",
  };
  session.subscribe((event: any) => {
    if (event?.type !== "tool_execution_start" || !KIND[event.toolName]) return;
    const a = event.args ?? {};
    const target = String(a.path ?? a.file_path ?? a.command ?? a.pattern ?? event.toolName).slice(0, 200);
    void activity(role, taskId, KIND[event.toolName], target);
  });

  const beat = setInterval(() => {
    void asRole(role, "POST", `/api/tasks/${taskId}/heartbeat`, {}).catch(() => {});
  }, HEARTBEAT_MS);

  let runFailure: Error | null = null;
  const work = (async () => {
    try {
      const task = input.prompt ?? (input.subtaskId
        ? planSubtaskPrompt(taskId, role, input.subtaskId)
        : (resumed ? resumePrompt(taskId, role) : defaultTaskPrompt(taskId, role)));
      const prompt = `${task}\n\n${launchContext.prompt}`;
      await session.prompt(mode === "work" ? `${prompt}\n\n${repoNote(cwd)}\n${renderInstruction(role, "task.documentation", {})}` : prompt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      runFailure = error instanceof Error ? error : new Error(reason);
      try {
        await asRole(role, "POST", `/api/tasks/${taskId}/state`, {
          state: "blocked",
          comment: `Запуск прервался: ${reason.slice(0, 300)}`,
        });
      } catch {
        // карточку могли и не взять — тогда блокировать нечего
      }
    } finally {
      clearInterval(beat);
      activeRuns.delete(runId);
      session.dispose();
      resourceLoader.disposeResources();
      await composio.close().catch(() => {});
      // Сдал на проверку — дальше Критик (если включена автопроверка).
      // После самого Критика не будим: при сбое он будил бы себя по кругу.
      if (mode === "work" && !input.subtaskId) {
        void continueOrHandOff(
          taskId,
          role,
          before,
          input.durableHandoff ?? false,
          input.chainDepth ?? 0,
          runId,
        );
      }
    }
  })();
  pending.add(work);
  void work.finally(() => pending.delete(work));

  const completion = work.then(() => {
    if (runFailure) throw runFailure;
  });
  // Прямые ручные вызовы исторически не обязаны await completion. Worker
  // await-ит её и видит reject; этот handler предотвращает unhandled rejection
  // у совместимых fire-and-forget callers, не меняя исходную Promise.
  void completion.catch(() => {});
  return { runId, completion };
}

// ── Кто и когда будит роль (этап C2, 23.09.2026) ───────────────────────────
//
// Те же решения, что принимал будильник (trigger.py → decide), но в сервере:
// он и так видит каждое изменение карточки. Будильник с флагом
// TASKFLOW_ROLES_IN_SERVER=1 карточки ролей больше не берёт.

export type KickReason = "assigned" | "commented" | "review" | "after_run";

export function reviewPromptFor(taskId: string): string {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return renderInstruction("critic_verifier", "task.review", { roleTitle: roleTitle("critic_verifier"), taskId, title: task?.title ?? "", rules: effectiveRules("critic_verifier").map(r => `- ${r}`).join("\n") });
}

function replyPrompt(taskId: string, role: string): string {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return renderInstruction(role, "task.reply", { roleTitle: roleTitle(role), taskId, title: task?.title ?? "", rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

function reviewerPending(taskId: string): boolean {
  const reviewerFirst = (
    db.prepare("SELECT reviewer_first_default FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as
      | { reviewer_first_default?: number }
      | undefined
  )?.reviewer_first_default;
  if ((reviewerFirst ?? 1) !== 1) return false;
  const current = db
    .prepare("SELECT id FROM artifact_versions WHERE task_id = ? ORDER BY version_no DESC LIMIT 1")
    .get(taskId) as { id?: string } | undefined;
  if (!current?.id) return true;
  const verdict = db
    .prepare("SELECT 1 FROM reviews WHERE task_id = ? AND version_id = ? LIMIT 1")
    .get(taskId, current.id);
  return !verdict;
}

/**
 * Разбудить роль по карточке, если есть повод. Никогда не бросает: это
 * следствие чужого действия, а не его часть. Работает, только когда
 * включена «Система» (тот же выключатель, что и раздача).
 */
export type KickRoleTaskResult =
  | { outcome: "started"; runId: string; completion: Promise<void> }
  | { outcome: "skipped"; reason: string }
  | { outcome: "deferred"; reason: string; delaySeconds: number };

/**
 * Проверить актуальное состояние карточки и начать run. В отличие от
 * kickRoleTask, ошибки не проглатываются: durable worker обязан записать
 * retry/dead, а не считать технический сбой успешной обработкой job.
 */
export async function kickRoleTaskStrict(
  taskId: string,
  reason: KickReason,
  actorId?: string | null,
  options?: { durableHandoff?: boolean; chainDepth?: number; manualStart?: boolean },
): Promise<KickRoleTaskResult> {
  // В тестах живых агентов не зовём — только там, где тест это разрешил явно.
  if (process.env.VITEST && process.env.TASKFLOW_KICK_IN_TESTS !== "1") {
    return {
      outcome: "deferred",
      reason: "role runs are disabled in tests",
      delaySeconds: 30,
    };
  }
  const { unitState } = await import("../routes/agent-service.js");
  const explicitOwnerStart = options?.manualStart === true && reason === "assigned" && Boolean(actorId && isOwner(actorId));
  if (!(await unitState()).active && !explicitOwnerStart) {
    return {
      outcome: "deferred",
      reason: "autonomous system is disabled",
      delaySeconds: 30,
    };
  }
  if (activeInProcessRun(taskId)) {
    return {
      outcome: "deferred",
      reason: "task already has an active in-process run",
      delaySeconds: 5,
    };
  }
  const task = db
    .prepare("SELECT id, status, assignee_id, agent_state, ready_for_pickup FROM tasks WHERE id = ?")
    .get(taskId) as
    | { id: string; status: string; assignee_id: string | null; agent_state: string | null; ready_for_pickup: number | null }
    | undefined;
  if (!task || task.status !== "active") {
    return { outcome: "skipped", reason: "task is absent or no longer active" };
  }
  const assignee = task.assignee_id ?? "";
  const role = assignee.startsWith("role_") ? assignee.slice("role_".length) : "";

  // Сдано на проверку — Критик, если автопроверка включена и вердикта ещё нет.
  if (task.agent_state === "review" && (reason === "review" || reason === "after_run")) {
    if (ROLE_NAMES.includes("critic_verifier") && reviewerPending(taskId)) {
      const run = await runRoleInProcess({
        taskId,
        role: "critic_verifier",
        prompt: reviewPromptFor(taskId),
        mode: "review",
      });
      logEvent({ taskId, actorId: null, kind: "reviewer_sent", toValue: roleTitle("critic_verifier") });
      return { outcome: "started", ...run };
    }
    return { outcome: "skipped", reason: "reviewer is disabled or verdict already exists" };
  }
  if (!role || !ROLE_NAMES.includes(role)) {
    return { outcome: "skipped", reason: "task has no enabled role assignee" };
  }

  if (reason === "after_run" && task.agent_state === "in_progress") {
    const chainDepth = options?.chainDepth ?? 0;
    if (chainDepth > MAX_CHAIN) {
      return { outcome: "skipped", reason: "continuation chain limit reached" };
    }
    const run = await runRoleInProcess({
      taskId,
      role,
      prompt: resumePrompt(taskId, role),
      durableHandoff: options?.durableHandoff ?? false,
      chainDepth,
    });
    return { outcome: "started", ...run };
  }

  // Владелец написал по сданной карточке — роль только отвечает.
  if (task.agent_state === "review" && reason === "commented" && actorId && actorId !== assignee) {
    const run = await runRoleInProcess({ taskId, role, prompt: replyPrompt(taskId, role), mode: "reply" });
    return { outcome: "started", ...run };
  }
  if (task.agent_state === "blocked") {
    return { outcome: "skipped", reason: "task is blocked and awaits owner action" };
  }
  // Работа не начата (или снята с агента после ответа владельцу) — выполнить.
  if (!task.agent_state && (task.ready_for_pickup ?? 0) === 1 && reason !== "after_run") {
    chainCount.delete(taskId);
    const run = await runRoleInProcess({
      taskId,
      role,
      durableHandoff: options?.durableHandoff ?? false,
    });
    return { outcome: "started", ...run };
  }
  return { outcome: "skipped", reason: "job is stale for the current task state" };
}

export async function kickRoleTask(taskId: string, reason: KickReason, actorId?: string | null): Promise<void> {
  try {
    await kickRoleTaskStrict(taskId, reason, actorId);
  } catch (err) {
    console.warn(`роль по карточке ${taskId} не разбужена:`, err);
  }
}

/**
 * Карточки на ревью, которые Критик так и не посмотрел, потому что в
 * момент их сдачи роль `critic_verifier` была выключена: `kickRoleTaskStrict`
 * тогда возвращает терминальный "skipped" (не "deferred" — это не про
 * выключенную «Систему», attempts не сохраняются), и job в очереди больше
 * не перезапускается сам. Включение роли обратно должно значить «пошёл
 * смотреть», а не «жди следующего повода» — владелец 30.09.2026, тот же
 * принцип, что у тумблера «Система» (`sweepStragglers` в agent-service.ts).
 * Безопасно звать и для карточек, которым ревью не нужно прямо сейчас —
 * kickRoleTaskStrict сам проверяет reviewerPending и no-op'ает.
 */
export async function sweepPendingReviews(actorId: string): Promise<void> {
  const pending = db
    .prepare(`SELECT id FROM tasks WHERE status = 'active' AND agent_state = 'review' ORDER BY updated_at ASC`)
    .all() as Array<{ id: string }>;
  for (const { id } of pending) {
    await kickRoleTaskStrict(id, "review", actorId);
  }
}

/**
 * После захода по работе: сдал — дальше Критик (kickRoleTask); вышел посреди
 * работы, но продвинулся — ещё заход, до трёх подряд, в том же разговоре.
 * Без продвижения не зовём: крутиться впустую нельзя.
 */
async function continueOrHandOff(
  taskId: string,
  role: string,
  before: string,
  durableHandoff: boolean,
  chainDepth: number,
  runId: string,
): Promise<void> {
  const task = db.prepare("SELECT status, agent_state FROM tasks WHERE id = ?").get(taskId) as
    | { status: string; agent_state: string | null }
    | undefined;
  if (task?.status === "active" && task.agent_state === "in_progress") {
    const n = durableHandoff
      ? chainDepth + 1
      : (chainCount.get(taskId) ?? 0) + 1;
    if (n <= MAX_CHAIN && progressMark(taskId) !== before) {
      if (durableHandoff) {
        enqueueRoleRunJob({
          taskId,
          reason: "after_run",
          dedupeKey: `after-run:${runId}`,
          chainDepth: n,
        });
        return;
      }
      chainCount.set(taskId, n);
      try {
        await runRoleInProcess({ taskId, role, prompt: resumePrompt(taskId, role) });
      } catch (err) {
        console.warn(`повторный заход по ${taskId} не начат:`, err);
      }
    }
    return;
  }
  chainCount.delete(taskId);
  if (!durableHandoff) await kickRoleTask(taskId, "after_run");
}
