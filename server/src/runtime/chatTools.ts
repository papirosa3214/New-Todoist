import { agentMessagingTools } from "./agentMessaging.js";
import { orchestratorTools } from "./orchestratorTools.js";
// Инструменты роли в чате — внутри сервера (владелец 02.10.2026: «у нас всё
// должно быть на сервере», чаты легли на `Unknown option: --mcp-config`).
//
// Раньше чат поднимал отдельный процесс Pi, а тот — `mcp_server.py`, который
// ходил в API сервера по HTTP. Теперь те же инструменты — прямые вызовы
// маршрутов сервера от имени учётки роли (`asRole`, app.inject): права,
// лента и правила те же, процессов и MCP нет. Поведение и тексты ответов
// перенесены из `scripts/mcp_server.py` один в один.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { asRole, asText, short, ToolError, unwrap, PLAN_REQUEST_DESCRIPTION, PLAN_REQUEST_PARAMETERS, requestPlanStep } from "./inProcessRun.js";
import { composeLayer, registerInstructionBlock } from "../lib/roleContextResolver.js";
import db from "../db.js";
import { restartSlotFromOwnerChat } from "./slotRestart.js";
import { collectTaskSummary, parseSummaryRequest } from "../lib/secretaryTaskSummary.js";


function qs(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  return q.toString();
}

function asTasks(payload: any): any[] {
  return Array.isArray(payload) ? payload : (payload?.tasks ?? []);
}

/** Набор инструментов чата для роли. Описания — из реестра инструкций
 *  (`tool.runtime.<имя>`), владелец правит их на экране «Команда». */
export function chatTools(role: string, ownerContext?: {chatId:string;messageId:string}) {
  const T = (name: string, description: string, parameters: any, run: (p: any) => Promise<unknown>) => {
    const key = "tool.runtime." + name;
    registerInstructionBlock({
      key, title: name, group: "Возможности", scope: "command",
      modes: ["work", "resume", "reply", "review", "subtask"],
      sourceKind: "code", originRef: "chatTools.ts:" + name, readOnly: false,
    }, description);
    return defineTool({
      name,
      label: name,
      description: composeLayer(role, key)?.effective ?? description,
      parameters,
      execute: async (_id: string, params: any) => {
        try {
          return asText(await run(params ?? {}));
        } catch (e) {
          throw new Error(e instanceof ToolError ? e.message : `сбой инструмента ${name}: ${String(e)}`);
        }
      },
    } as any);
  };
  const S = (description?: string) => Type.Optional(Type.String(description ? { description } : {}));
  const None = Type.Object({});

  return [
    ...orchestratorTools(role, T),
    ...agentMessagingTools(role, {chatId: ownerContext?.chatId,messageId:ownerContext?.messageId}),
    T("taskflow_runtime", "Что реально доступно сейчас в runtime Pi: подключённые провайдеры и их доступные модели. Только факт, без всего каталога.",
      None, async () => {
        const providers = ((await asRole(role, "GET", "/api/runtime/providers"))?.providers ?? []) as any[];
        const connected = new Set(providers.filter((p) => p.status === "connected").map((p) => String(p.provider)));
        const models = ((await asRole(role, "GET", "/api/runtime/models"))?.models ?? []) as any[];
        const byProvider: Record<string, string[]> = {};
        for (const m of models) {
          const prov = String(m.provider);
          if (m.available && connected.has(prov)) (byProvider[prov] ??= []).push(m.id);
        }
        return { подключены: byProvider };
      }),
    T("taskflow_status", "Что сейчас происходит: работает ли служба, какие задачи агенты делают прямо сейчас (с временем последнего сигнала), что брошено, что ждёт проверки. Начинать проверку состояния — отсюда.",
      None, async () => {
        const agents = (await asRole(role, "GET", "/api/agents")) as any[];
        const tasks = asTasks(await asRole(role, "GET", "/api/tasks")).filter((t) => t.status === "active");
        // 10.10.2026: колонка users.status застарела и навсегда offline.
        // Живой признак работы агента — поле online из отпечатка активности
        // (/api/agents -> activeAgent.ts). Читать status здесь значило вечно
        // показывать «никого» и никого не будить.
        const online = agents.filter((a) => a.type === "ai" && a.online === true).map((a) => a.name);
        return {
          "служба на дежурстве": online.length > 0,
          "агенты на связи": online.length ? online : "никого",
          "в работе": tasks.filter((t) => t.agent_state === "in_progress" && !t.agent_stale).map(short),
          "брошено (взяли и молчат)": tasks.filter((t) => t.agent_state === "in_progress" && t.agent_stale).map(short),
          "ждут проверки владельца": tasks.filter((t) => t.agent_state === "review").map(short),
          "упёрлись, нужен владелец": tasks.filter((t) => t.agent_state === "blocked").map(short),
        };
      }),
    T("taskflow_agents", "Кто есть в команде и кто сейчас на связи.", None, async () => ({
      участники: ((await asRole(role, "GET", "/api/agents")) as any[]).map((a) => ({
        // 10.10.2026: online, не status — см. taskflow_status выше.
        id: a.id, имя: a.name, тип: a.type === "ai" ? "агент" : "человек", "на связи": a.online === true,
      })),
    })),
    T("taskflow_rule_publish",
      "Опубликовать новую версию правила в манифест. Только владелец или оркестратор (для других ролей сервер вернёт 403). rule_id — латиница/точки/подчёркивания/дефисы (3..64), version — целое ≥ 1, content — непустой Markdown до 64 КБ, role_scope — массив ключей ролей или '*' (по умолчанию). Идемпотентен по (rule_id, version): повтор того же объявления вернёт existed=true. Старая active-версия того же rule_id переводится в superseded, в журнале task_events появится rule_superseded.",
      Type.Object({
        rule_id: Type.String({ description: "латиница, нижний регистр, точки/подчёркивания/дефисы; 3..64 символа" }),
        version: Type.Integer({ minimum: 1, maximum: 9999 }),
        content: Type.String({ description: "полный текст правила в Markdown, до 64 КБ" }),
        role_scope: Type.Optional(Type.Array(Type.String(), { description: "массив ключей ролей; '*' для широковещательной рассылки" })),
      }), async (p) => {
        const body: Record<string, unknown> = {
          rule_id: p.rule_id,
          version: p.version,
          content: p.content,
        };
        if (p.role_scope && p.role_scope.length) body.role_scope = p.role_scope;
        const resp = await asRole(role, "POST", "/api/agent/rules/publish", body);
        return {
          итог: resp?.existed ? "уже было опубликовано" : "опубликовано",
          ref: resp?.ref,
          в_чате: resp?.chat_message_id,
        };
      }),
    T("taskflow_rule_acknowledge",
      "Подтвердить активную версию правила от имени своей роли. Сервер записывает факт подтверждения, пишет в чат строку kind='rule_acknowledged' и убирает правило из блока rules.pending_acknowledgement следующего snapshot. Идемпотентен: повтор того же (rule_id, version) вернёт тот же acknowledged_at без новой строки. На superseded-версии — 409 rule_version_superseded.",
      Type.Object({
        rule_id: Type.String(),
        version: Type.Integer({ minimum: 1, maximum: 9999 }),
        session_id: S("текущая сессия шага — для трассировки и без неё"),
      }), async (p) => {
        const body: Record<string, unknown> = {
          rule_id: p.rule_id,
          version: p.version,
          role: role,
        };
        if (p.session_id) body.session_id = p.session_id;
        const resp = await asRole(role, "POST", "/api/agent/rules/acknowledge", body);
        return {
          ref: resp?.ref,
          acknowledged_at: resp?.acknowledged_at,
          в_чате: resp?.chat_message_id,
        };
      }),
    T("taskflow_chat_typing",
      "Зажечь в чате отметку «печатает…» — ПЕРЕД тем, как сочинять ответ. Одного вызова хватает на весь ответ. state='stop' — передумал отвечать.",
      Type.Object({ state: S("stop — снять отметку") }), async (p) => {
        const resp = await asRole(role, "POST", "/api/chat/typing", p.state === "stop" ? { state: "stop" } : {});
        return {
          печатает: resp?.["печатает"],
          "гаснет через": resp?.["печатает"] ? `${Math.floor((resp?.["гаснет_через_мс"] ?? 0) / 1000)} с` : "—",
        };
      }),
    T("taskflow_project_tasks",
      "Задачи проекта — не только назначенные на агента. Сортировка по сроку: что горит, то сверху. project — название, либо project_id.",
      Type.Object({
        project: S("название проекта"),
        project_id: S(),
        state: S("free | in_progress | review | blocked"),
        include_completed: Type.Optional(Type.Boolean()),
      }), async (p) => {
        let pid: string | undefined = p.project_id;
        const want = String(p.project ?? "").trim().toLowerCase();
        if (!pid && want) {
          pid = ((await asRole(role, "GET", "/api/projects")) as any[]).find((x) => String(x.name ?? "").trim().toLowerCase() === want)?.id;
          if (!pid) return { ошибка: `проект «${p.project}» не найден`, подсказка: "список проектов — taskflow_projects" };
        }
        if (!pid) return { ошибка: "нужен project_id или project (название)" };
        let tasks = asTasks(await asRole(role, "GET", "/api/tasks")).filter((t) => t.project_id === pid);
        if (p.include_completed !== true) tasks = tasks.filter((t) => t.status === "active");
        if (p.state === "free") tasks = tasks.filter((t) => !t.agent_state);
        else if (p.state) tasks = tasks.filter((t) => t.agent_state === p.state);
        tasks.sort((a, b) => (a.due_date == null ? 1 : 0) - (b.due_date == null ? 1 : 0) || String(a.due_date ?? "").localeCompare(String(b.due_date ?? "")));
        return { всего: tasks.length, задачи: tasks.map(short) };
      }),
    T("taskflow_create_project",
      "Завести проект под задачу и сразу с папкой документации.",
      Type.Object({ name: Type.String(), color: S(), with_docs: Type.Optional(Type.Boolean()) }), async (p) => {
        const body: Record<string, unknown> = { name: p.name, with_docs: p.with_docs ?? true };
        if (p.color) body.color = p.color;
        const created = unwrap(await asRole(role, "POST", "/api/projects", body));
        return {
          "проект создан": { id: created?.id, название: created?.name, "папка документации": body.with_docs ? "заведена" : "нет" },
          дальше: "id подставлять в taskflow_create_task(project_id=...) и taskflow_doc_write(project_id=...)",
        };
      }),
    T("taskflow_create_task",
      "Завести задачу. Для плана ролей передай preparation и card.subtasks из taskflow_structure_dictation; план сохраняется черновиком без запуска.",
      Type.Object({
        title: Type.String(),
        description: S(),
        project_id: S(),
        assignee_id: S(),
        due_date: S("ГГГГ-ММ-ДД"),
        priority: Type.Optional(Type.Integer({ description: "1 срочный … 4 низкий" })),
        preparation: Type.Optional(Type.Any()),
        subtasks: Type.Optional(Type.Array(Type.String())),
      }), async (p) => {
        const body: Record<string, unknown> = { title: p.title };
        for (const k of ["description", "project_id", "assignee_id", "due_date", "priority", "preparation"]) if (p[k] != null) body[k] = p[k];
        if (p.subtasks?.length) body.subtasks = p.subtasks;
        return { "задача создана": short(unwrap(await asRole(role, "POST", "/api/tasks", body))) };
      }),
    T("taskflow_suggest_subtasks",
      "Умная разбивка на подзадачи — тот же инструмент, что у владельца в форме задачи. id существующей задачи ЛИБО title черновика. Ничего не сохраняет.",
      Type.Object({ id: S(), title: S(), description: S(), provider: S() }), async (p) => {
        const body: Record<string, unknown> = {};
        if (p.provider) body.provider = p.provider;
        if (p.title) body.title = p.title;
        if (p.description != null) body.description = p.description;
        let resp: any;
        if (p.id) resp = await asRole(role, "POST", `/api/tasks/${p.id}/suggest-subtasks`, body);
        else {
          if (!p.title) throw new ToolError("нужен либо id существующей задачи, либо title черновика");
          resp = await asRole(role, "POST", "/api/ai/suggest-subtasks", body);
        }
        return { подзадачи: resp?.subtasks ?? [] };
      }),
    T("taskflow_structure_dictation",
      "Единая серверная подготовка поручения: intent, card и preparation. Ничего не создаёт и не запускает. card=null — вопрос/уточнение, карточку не заводить.",
      Type.Object({ text: Type.String(), context: S(), source_record_id: S(), provider: S() }), async (p) => {
        const text = String(p.text ?? "").trim();
        if (!text) throw new ToolError("text не может быть пустым");
        const body: Record<string, unknown> = { text };
        for (const k of ["provider", "context", "source_record_id"]) if (p[k] != null) body[k] = p[k];
        const result = await asRole(role, "POST", "/api/task-preparation/prepare", body);
        const card = result?.card;
        if (!card) return result;
        return { ...result, название: card.title, описание: card.description, подзадачи: card.subtasks, срок: card.dueDate, приоритет: card.priority, preparation: card.preparation };
      }),
    T("taskflow_my_stats",
      "Мои выполненные задачи по периодам — счётчик и названия последних за неделю и за месяц, без полных карточек.",
      None, async () => asRole(role, "GET", "/api/tasks/my-stats")),
    T("taskflow_task_summary",
      "Сводка задач владельца по фактам БД: что зависло, просрочено, в работе, на проверке. Исполнитель, период и раздел разбираются из вопроса владельца.",
      Type.Object({ query: Type.String({ description: "Вопрос владельца, например «что зависло у QA за неделю»" }) }), async (p) => {
        const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
        if (!owner) throw new ToolError("владелец трекера не найден");
        const filter = await parseSummaryRequest(String(p.query ?? ""));
        if (!filter.is_summary || filter.question) return { нужно_уточнить: filter.question ?? "Какую сводку задач собрать?" };
        const summary = collectTaskSummary(owner.id, filter);
        return { текст: summary.text };
      }),
    T("taskflow_remember",
      "Запомнить устойчивое знание для себя и команды. kind: lesson | fact | preference. scope: role (по умолчанию) | team | project. Одна запись — одна мысль; похожая обновится, а не задвоится.",
      Type.Object({ text: Type.String(), kind: S(), scope: S(), title: S(), project_id: S(), source_ref: S() }), async (p) => {
        const text = String(p.text ?? "").trim();
        if (!text) throw new ToolError("text — что запомнить, одной мыслью");
        const body: Record<string, unknown> = { text };
        for (const k of ["scope", "kind", "title", "project_id", "source_ref"]) if (p[k]) body[k] = p[k];
        const resp = await asRole(role, "POST", "/api/memories", body);
        return { итог: resp?.updated ? "обновил похожую запись" : "запомнил", id: resp?.memory?.id, область: resp?.memory?.scope };
      }),
    T("taskflow_recall",
      "Вспомнить, что известно по теме: общая память команды, твоя и проектная, включая файлы владельца.",
      Type.Object({ query: Type.String(), project_id: S() }), async (p) => {
        const query = String(p.query ?? "").trim();
        if (!query) throw new ToolError("query — о чём вспомнить");
        const items = ((await asRole(role, "GET", "/api/memories/recall?" + qs({ q: query, project_id: p.project_id })))?.items ?? []) as any[];
        if (!items.length) return { найдено: 0, подсказка: "ничего не помним — разберёшься, запиши через taskflow_remember" };
        const where: Record<string, string> = { team: "общее", role: "твоё", project: "проект" };
        return {
          найдено: items.length,
          записи: items.map((m) => ({
            id: m.id, откуда: where[m.scope] ?? m.scope, вид: m.kind, заголовок: m.title,
            текст: String(m.text ?? "").slice(0, 1500), записал: m.source === "owner" ? "владелец" : "роль",
          })),
        };
      }),
    T("taskflow_consult",
      "Посоветоваться с более сильной моделью: перед важным или необратимым решением, когда застрял, когда требования противоречат. В чате — до трёх раз в час. Совет — не приказ.",
      Type.Object({ question: Type.String(), context: Type.Optional(Type.Any()), task_id: S(), subtask_id: S() }), async (p) => {
        const question = String(p.question ?? "").trim();
        if (!question) throw new ToolError("question не может быть пустым");
        const body: Record<string, unknown> = { question };
        for (const k of ["context", "task_id", "subtask_id"]) if (p[k]) body[k] = p[k];
        const resp = await asRole(role, "POST", "/api/consult", body);
        return { совет: resp?.answer, модель: resp?.model };
      }),
    ...(ownerContext ? [T("taskflow_slot_restart",
      "По прямой просьбе владельца заменить зависшего исполнителя свежим агентом ТОЙ ЖЕ роли в существующем слоте и запустить. Не добавляет узлы и не меняет связи. Перед вызовом прочитай карточку; укажи точный subtask_id и неизменную роль. Если слотов несколько — уточни у владельца. Не вызывай для обычного сообщения, консультации или простого назначения. Сохраняет историю и передаёт снимок работы в новую сессию.",
      Type.Object({subtask_id:Type.String(),role:Type.String(),reason:Type.String()}),p=>restartSlotFromOwnerChat(ownerContext.chatId,ownerContext.messageId,p))] : []),
    T("taskflow_plan_request", PLAN_REQUEST_DESCRIPTION, PLAN_REQUEST_PARAMETERS, p => requestPlanStep(role,p)),
    T("taskflow_weather",
      "Погода сейчас и на 4 дня для города — готовый блок виджета для ответа в чате. Блок из поля «виджет» вставить в ответ как есть, цифры не выдумывать.",
      Type.Object({ city: Type.String({ description: "Город, например «Москва»" }) }), async (p) => {
        const city = String(p.city ?? "").trim();
        if (!city) throw new ToolError("city не может быть пустым");
        const resp = await asRole(role, "GET", "/api/widgets/weather?" + qs({ city }));
        return {
          виджет: "```widget\n" + JSON.stringify(resp?.widget ?? {}) + "\n```",
          "как использовать": "Вставь блок виджета в ответ как есть и добавь одну-две фразы от себя.",
        };
      }),
  ];
}
