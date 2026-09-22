import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import db from "../db.js";
import { AGENT_RULES } from "../agentState.js";
import { loadRoleRouting, providerOfModel, roleTitle, roleUserId, ROLE_NAMES } from "../roleRouting.js";
import { getModelRuntime } from "./PiRuntimeAdapter.js";

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

/** Инструменты трекера для роли — те же имена и смысл, что в mcp_server.py,
 *  чтобы инструкции ролей не переписывать. */
export function taskflowTools(role: string, model: string | null) {
  const T = (
    name: string,
    description: string,
    parameters: any,
    run: (p: any) => Promise<unknown>,
  ) =>
    defineTool({
      name,
      label: name,
      description,
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
  const Id = Type.Object({ id: Type.String() });

  return [
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
    T("taskflow_subtask_done", "Закрыть шаг с итогом (result — одно-два предложения).",
      Type.Object({ id: Type.String(), result: Type.Optional(Type.String()), done: Type.Optional(Type.Boolean()) }),
      async (p) => {
        const done = p.done ?? true;
        const body: Json = { done };
        if (p.result) body.result = p.result;
        const row = await asRole(role, "PATCH", `/api/subtasks/${p.id}`, body);
        if (done && row.task_id) void activity(role, row.task_id, "edit", `шаг «${row.title ?? ""}»: закрыл`);
        return { [done ? "шаг отмечен" : "отметка снята"]: p.id };
      }),
    T("taskflow_rules", "Правила ведения учёта.", Type.Object({}), async () => ({ правила: AGENT_RULES })),
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
          return { готово: "заметка обновлена", id: n.id };
        }
        if (!p.project_id) throw new ToolError("нужен project_id или id заметки");
        const d = await asRole(role, "GET", `/api/projects/${p.project_id}/docs`);
        if (!d.folder) throw new ToolError("у проекта нет папки документации");
        const n = await asRole(role, "POST", "/api/notes", { markdown: p.markdown, folder_id: d.folder.id });
        return { готово: "заметка создана", id: n.id };
      }),
    T("taskflow_kb_search", "Поиск по документации проектов.",
      Type.Object({ query: Type.String(), top_k: Type.Optional(Type.Number()) }),
      async (p) => {
        const d = await asRole(role, "GET", `/api/knowledge/search?q=${encodeURIComponent(p.query)}&top_k=${p.top_k ?? 5}`);
        return { запрос: p.query, куски: (d.results ?? []).map((r: any) => ({ текст: String(r.text ?? "").slice(0, 1500), id_заметки: r.doc_id })) };
      }),
  ];
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ROLE_PROMPTS_DIR = path.join(process.cwd(), "scripts", "role-prompts");
const HEARTBEAT_MS = 90_000;

function rolePrompt(role: string): string {
  try {
    return fs.readFileSync(path.join(ROLE_PROMPTS_DIR, `${role}.md`), "utf8");
  } catch {
    return "";
  }
}

/** Задание по умолчанию — когда вызывающий не собрал своё (ручной запуск). */
export function defaultTaskPrompt(taskId: string, role: string): string {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return [
    `Ты — ${roleTitle(role)} в трекере TaskFlow. Тебе назначена задача ${taskId}: «${task?.title ?? ""}».`,
    "Прочитай карточку (taskflow_task), возьми её в работу (taskflow_claim),",
    "веди шаги (taskflow_subtask_work, taskflow_subtask_done с result), а когда всё сделано —",
    "сдай на проверку (taskflow_state state=review с коротким итогом). Упёрся — taskflow_state state=blocked с причиной.",
    "",
    "Правила:",
    ...AGENT_RULES.map((r) => `- ${r}`),
  ].join("\n");
}

type ActiveInProcessRun = { runId: string; taskId: string; role: string; abort: () => Promise<void> };
const activeRuns = new Map<string, ActiveInProcessRun>();

export function activeInProcessRun(taskId: string): ActiveInProcessRun | undefined {
  return [...activeRuns.values()].find((r) => r.taskId === taskId);
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
}): Promise<{ runId: string }> {
  const { taskId, role } = input;
  if (!ROLE_NAMES.includes(role)) throw new Error(`роли «${role}» нет или она отключена`);
  if (activeInProcessRun(taskId)) throw new Error("по этой задаче агент уже работает");

  const routing = loadRoleRouting();
  const modelId = input.model || routing.models[role];
  const runtime: any = await getModelRuntime();
  const model =
    runtime.getModel?.(providerOfModel(modelId), modelId) ??
    ((await runtime.getAvailable?.()) ?? []).find((m: any) => m.id === modelId);
  if (!model) throw new Error(`модель «${modelId}» недоступна`);

  const cwd = input.cwd ?? path.resolve(process.cwd(), "..");
  const systemPrompt = rolePrompt(role) || `Ты — ${roleTitle(role)} в трекере TaskFlow.`;
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader;

  const customTools = taskflowTools(role, model.id ?? modelId);
  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader,
    tools: [...BUILTIN_TOOLS, ...customTools.map((t: any) => t.name)],
    customTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
  } as any);

  const runId = `inproc_${crypto.randomUUID()}`;
  activeRuns.set(runId, { runId, taskId, role, abort: () => session.abort() });

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

  const work = (async () => {
    try {
      await session.prompt(input.prompt ?? defaultTaskPrompt(taskId, role));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
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
    }
  })();
  pending.add(work);
  void work.finally(() => pending.delete(work));

  return { runId };
}
