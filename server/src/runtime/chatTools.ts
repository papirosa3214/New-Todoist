import {appleReminderTools} from "./appleReminderTools.js";
import {secretaryRoutineTools} from "./secretaryRoutineTools.js";
import {prepareReportMaterial} from "./chatPreparedMaterials.js";
// Инструменты роли в чате — внутри сервера (владелец 02.10.2026: «у нас всё
// должно быть на сервере», чаты легли на `Unknown option: --mcp-config`).
//
// Раньше чат поднимал отдельный процесс Pi, а тот — `mcp_server.py`, который
// ходил в API сервера по HTTP. Теперь те же инструменты — прямые вызовы
// маршрутов сервера от имени учётки роли (`asRole`, app.inject): права,
// лента и правила те же, процессов и MCP нет. Поведение и тексты ответов
// перенесены из `scripts/mcp_server.py` один в один.
import crypto from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { asRole, asText, short, ToolError, unwrap } from "./inProcessRun.js";
import { composeLayer, registerInstructionBlock } from "../lib/roleContextResolver.js";
import db from "../db.js";
import { restartSlotFromOwnerChat } from "./slotRestart.js";
import { proposeWork } from "./chatWork.js";
import { collectTaskSummary, parseSummaryRequest } from "../lib/secretaryTaskSummary.js";
import { buildChatFile, chatFileName, CHAT_FILE_FORMATS, ChatFileError } from "../lib/chatFileExport.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import {
  createQuestionRow,
  QuestionValidationError,
  renderAnswerText,
  renderQuestionText,
  validateQuestionPayload,
  type QuestionPayload,
} from "../lib/chatQuestions.js";
import { broadcastToUsers } from "../ws.js";
import { liveInterruptEvent, liveResumeEvent, waitForAnswer } from "../lib/questionWait.js";
import { saveUploadedFile, UploadRejected } from "../routes/attachments.js";
import { roleUserId } from "../roleRouting.js";


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
  const T = (name: string, description: string, parameters: any, run: (p: any, signal?: AbortSignal) => Promise<unknown>) => {
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
      execute: async (_id: string, params: any, signal?: AbortSignal) => {
        try {
          return asText(await run(params ?? {}, signal));
        } catch (e) {
          throw new Error(e instanceof ToolError ? e.message : `сбой инструмента ${name}: ${String(e)}`);
        }
      },
    } as any);
  };
  const S = (description?: string) => Type.Optional(Type.String(description ? { description } : {}));
  const None = Type.Object({});

  return [
    ...secretaryRoutineTools(role,T),
    ...appleReminderTools(role,T),
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
    ...(ownerContext ? [T("taskflow_chat_share_material",
      "Отправить владельцу документ Библиотеки/базы знаний для чтения ВНУТРИ TaskFlow, без системного просмотрщика iPhone. note_id — существующая заметка (taskflow_doc_write/taskflow_kb_search/taskflow_docs). Сначала сохрани готовый материал через taskflow_doc_write, если заметки ещё нет. Инструмент проверит документ; в активном ходе сервер сохранит ссылку для итогового отчёта без отдельной карточки. Вне активного хода отправит карточку «Открыть в TaskFlow». Не копирует заметку и не прикладывает файл. Для скачивания отдельного файла используй taskflow_chat_attach_file. В итоговом artifacts/sections.materials используй возвращённый material целиком; не подставляй пути сервера или голый ID вместо ссылки.",
      Type.Object({note_id:Type.String(),caption:S("краткое пояснение к материалу")}),
      async p=>{
        const note=await asRole(role,"GET",`/api/notes/${encodeURIComponent(p.note_id)}?format=markdown`);
        const material={kind:"document",title:note.title || "Документ",ref:`note://${note.id}`};
        if(prepareReportMaterial(ownerContext.chatId,roleUserId(role),ownerContext.messageId,material))
          return {material,message_id:null,delivery:"report",итог:"Материал подготовлен к итоговому ответу. Сервер добавит ссылку один раз; отдельная карточка не отправляется."};
        const card={type:"card",title:material.title,subtitle:String(p.caption??"Документ Библиотеки TaskFlow"),link:{title:"Открыть в TaskFlow",url:material.ref}};
        const response=await asRole(role,"POST",`/api/chats/${ownerContext.chatId}/messages`,{
          text:"```widget\n"+JSON.stringify(card)+"\n```",reply_to_message_id:ownerContext.messageId,work_mode:"work",
        });
        return {material,message_id:response?.message?.id??response?.id,итог:"Карточка документа уже отправлена в этот чат. Открывается оригинал внутри TaskFlow; файл не создавался."};
      })] : []),
    // Файл в чат — настоящим вложением, а не ссылкой (владелец 14.10.2026).
    ...(ownerContext ? [T("taskflow_chat_attach_file",
      "Приложить файл к ответу в этом чате — владелец скачает его из сообщения. Для чтения документа внутри TaskFlow используй taskflow_chat_share_material; этот инструмент — для скачивания файла. Ссылки на файлы не выдумывай. format: md, txt, csv, json, html — содержимое как есть; pdf, docx, odt — content пишешь в Markdown, сервер соберёт документ; xlsx, ods — content в CSV (запятая, первая строка — заголовки). caption — подпись к файлу, по желанию.",
      Type.Object({ file_name: Type.String(), format: Type.String({ enum: [...CHAT_FILE_FORMATS] }), content: Type.String(), caption: S("подпись к файлу") }),
      async (p) => {
        const format = String(p.format).toLowerCase().replace(/^\./, "") as any;
        let built;
        try { built = await buildChatFile(String(p.content ?? ""), format); }
        catch (e) { throw new ToolError(e instanceof ChatFileError ? e.message : `не удалось собрать файл: ${String(e)}`); }
        const fileName = chatFileName(p.file_name, format);
        let attachmentId: string;
        try {
          attachmentId = saveUploadedFile({ body: built.body, name: fileName, mime: built.mime }, (f) =>
            db.prepare(`INSERT INTO attachments
               (id, task_id, comment_id, chat_message_id, kind, user_id, file_name, mime, size, stored_name)
               VALUES (?, NULL, NULL, NULL, 'comment', ?, ?, ?, ?, ?)`)
              .run(f.id, roleUserId(role), f.fileName, f.mime, f.size, f.storedName));
        } catch (e) { throw new ToolError(e instanceof UploadRejected ? e.message : String(e)); }
        const resp = await asRole(role, "POST", `/api/chats/${ownerContext.chatId}/messages`, {
          text: String(p.caption ?? "").trim(), attachment_ids: [attachmentId], reply_to_message_id: ownerContext.messageId, work_mode: "work",
        });
        return { файл: fileName, размер_байт: built.body.length, сообщение: resp?.message?.id ?? resp?.id, итог: "Файл уже в чате. В ответе не давай на него ссылок — просто скажи, что приложил." };
      })] : []),
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
    ...(ownerContext ? [T("taskflow_work_start",
      "Для разовой проверки уже готового результата передай profile=result_review (только критик, без Git) или profile=code_review (критик, а после одобрения результат сам идёт в очередь слияния). steps тогда не передавай. title, description с исходным поручением/материалами и project_id обязательны. Оба шаблона завершаются одним вердиктом без автоматической доработки. Даже при идущей работе это новое предложение с кнопкой владельца, оно не запускается само. Не навязывай проверку обычному разговору. Без profile — прежний режим командной работы. Запустить работу прямо из разговора с владельцем. Когда вы с владельцем решили, что нужно сделать, не уходи из чата и не описывай план словами: вызови этот инструмент — сервер заведёт ОДНУ рабочую карточку разговора (без дочерних), положит в неё шаги по ролям и сам отправит её в чат готовой карточкой с кнопкой «Запустить». По нажатию владельца исполнители начнут работать. Если работа по этому разговору уже идёт, новые шаги добавляются в ту же карточку и стартуют сами — кнопка не нужна. steps: role — ключ роли-исполнителя; result — какой результат от неё нужен; key — короткий ключ шага латиницей; after — ключи шагов, которых этот ждёт. Шаги без after идут параллельно, с after — последовательно. Сам работу исполнителя не делай: ты ведёшь разговор и раздаёшь шаги.",
      Type.Object({
        title: S("Название работы — так будет называться карточка. Для добавления шагов в идущую работу не нужно"),
        description: S("Суть и границы работы из разговора"),
        project_id: S(),
        profile: S("Разовая проверка: result_review | code_review; без profile — обычная команда"),
        steps: Type.Optional(Type.Array(Type.Object({
          key: S("короткий ключ латиницей, например build"),
          role: Type.String({ description: "ключ роли: researcher, analyst, architect, designer, builder, qa" }),
          result: Type.String({ description: "какой результат нужен от роли" }),
          after: Type.Optional(Type.Array(Type.String(), { description: "ключи шагов, которых этот ждёт" })),
          report: S("Заполняй ТОЛЬКО если владелец в разговоре сам попросил сообщить о выполнении или что-то прислать: что именно исполнитель должен прислать в этот чат, когда закончит (например: «отчёт одним абзацем и ссылку на документ»). Без такой просьбы не указывай — исполнитель сдаёт работу обычным порядком"),
        }))),
      }), async (p) => proposeWork(role, ownerContext.chatId, p, ownerContext.messageId))] : []),
    ...(ownerContext ? ([
      ["taskflow_review_result","result_review","Разовая проверка готового результата критиком. Git-интеграция не требуется."],
      ["taskflow_review_code","code_review","Разовое ревью готовых изменений кода; только после одобрения подключается архитектор для интеграции."],
    ] as const).map(([name,profile,description])=>T(name,description+" Не выполняет работу заново и не создаёт автоматических циклов доработки. По умолчанию launch_mode=propose: владелец получает существующую карточку с кнопкой Запустить. Если владелец заранее явно разрешил этот вызов — launch_mode=authorized, authorization_message_id и точная authorization_quote из его сообщения в этом чате; повторный вопрос не нужен. Разрешение критика не расширяй до интеграции. project_id, title и description с исходным поручением и материалами обязательны. Любой вердикт, включая отрицательный и blocked, сохраняется и возвращается в исходный чат, сервер будит запросившую роль; обсуждай его с владельцем, не запускай доработку автоматически. Новая проверка — новое поручение.",Type.Object({title:Type.String(),description:Type.String(),project_id:Type.String(),launch_mode:S("propose | authorized"),authorization_message_id:S("Сообщение владельца с разрешением"),authorization_quote:S("Точная цитата разрешения")}),async p=>proposeWork(role,ownerContext.chatId,{...p,profile},ownerContext.messageId))) : []),
    T("taskflow_create_task",
      "Завести задачу. Для плана ролей передай preparation и card.subtasks из taskflow_structure_dictation; план сохраняется черновиком без запуска.",
      Type.Object({
        title: Type.String(),
        description: S(),
        project_id: S(),
        assignee_id: S(),
        due_date: S("ГГГГ-ММ-ДД"),
        priority: Type.Optional(Type.Integer({ description: "1 срочный … 4 низкий" })),
        label_ids: Type.Optional(Type.Array(Type.String(), { description: "id меток из taskflow_labels" })),
        preparation: Type.Optional(Type.Any()),
        subtasks: Type.Optional(Type.Array(Type.String())),
      }), async (p) => {
        const body: Record<string, unknown> = { title: p.title };
        for (const k of ["description", "project_id", "assignee_id", "due_date", "priority", "preparation"]) if (p[k] != null) body[k] = p[k];
        if (p.subtasks?.length) body.subtasks = p.subtasks;
        // Метки — личная оснастка владельца: другим ролям инструмент не
        // достаётся (roleToolScope), и в create_task метку принимает только
        // Помощник владельца.
        if (p.label_ids?.length && role === "secretary") body.label_ids = p.label_ids;
        return { "задача создана": short(unwrap(await asRole(role, "POST", "/api/tasks", body))) };
      }),
    T("taskflow_set_task_labels",
      "Поставить метки на существующую задачу: PATCH /api/tasks/:id с полным списком label_ids (заменяет прежние). Список пустой — снять все метки.",
      Type.Object({
        id: S("id задачи"),
        label_ids: Type.Optional(Type.Array(Type.String(), { description: "id меток из taskflow_labels" })),
      }), async (p) => {
        if (!p.id) throw new ToolError("нужен id задачи");
        const body = { label_ids: Array.isArray(p.label_ids) ? p.label_ids : [] };
        return { "метки обновлены": short(unwrap(await asRole(role, "PATCH", `/api/tasks/${p.id}`, body))) };
      }),
    T("taskflow_labels",
      "Список меток, доступных владельцу (GET /api/labels) — id и название. Нужен, чтобы поставить метку на задачу.",
      None, async () => {
        const labels = (await asRole(role, "GET", "/api/labels")) as any[];
        const rows = Array.isArray(labels) ? labels : [];
        return { метки: rows.map((l: any) => ({ id: l.id, name: l.name, color: l.color })) };
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
      "Запомнить устойчивое знание для себя и команды. kind: lesson | fact | preference. scope: role (по умолчанию — память твоей роли, ключ сервер подставляет сам) | team | project. Обычной роли role_key указывать не нужно: она пишет в память своей роли, ключ берётся из учётки, в чужую память роли писать нельзя. Оркестратору role_key нужен, только когда он пишет в память конкретной роли. Одна запись — одна мысль; похожая обновится, а не задвоится.",
      Type.Object({ text: Type.String(), kind: S(), scope: S(), title: S(), project_id: S(), source_ref: S(), task_id: S(), role_key: S("ключ роли для записи в память роли — обычной роли не нужен, оркестратору нужен, когда пишет в память конкретной роли") }), async (p) => {
        const text = String(p.text ?? "").trim();
        if (!text) throw new ToolError("text — что запомнить, одной мыслью");
        const body: Record<string, unknown> = { text };
        for (const k of ["scope", "kind", "title", "project_id", "source_ref", "role_key"]) if (p[k]) body[k] = p[k];
        // Разбор отказов 20.10.2026: проект сервер знает и сам — по задаче
        // (task_id или source_ref, если это id задачи).
        if (body.scope === "project" && !body.project_id) {
          for (const ref of [p.task_id, p.source_ref]) {
            const row = ref ? (db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(String(ref)) as { project_id: string | null } | undefined) : undefined;
            if (row?.project_id) { body.project_id = row.project_id; break; }
          }
        }
        const resp = await asRole(role, "POST", "/api/memories", body);
        return { итог: resp?.updated ? "обновил похожую запись" : "запомнил", id: resp?.memory?.id, область: resp?.memory?.scope };
      }),
    T("taskflow_recall",
      "Вспомнить, что известно по теме: общая память команды, твоя и проектная, включая файлы владельца. По умолчанию — с телами. mode=index — только id/вид/заголовок; mode=detail — тела по ids.",
      Type.Object({ query: S("о чём вспомнить"), project_id: S(), mode: S("full | index | detail"), ids: S("через запятую, для detail") }), async (p) => {
        const mode = String(p.mode ?? "full").trim() || "full";
        const query = String(p.query ?? "").trim();
        const ids = String(p.ids ?? "").trim();
        if (!query && mode !== "detail") throw new ToolError("query — о чём вспомнить");
        if (mode === "detail" && !ids) throw new ToolError("detail — укажи ids");
        const items = ((await asRole(role, "GET", "/api/memories/recall?" + qs({ q: query, project_id: p.project_id, mode, ids })))?.items ?? []) as any[];
        if (!items.length) return { найдено: 0, подсказка: "ничего не помним — разберёшься, запиши через taskflow_remember" };
        const where: Record<string, string> = { team: "общее", role: "твоё", project: "проект" };
        return {
          найдено: items.length,
          записи: items.map((m) => ({
            id: m.id, откуда: where[m.scope] ?? m.scope, вид: m.kind, заголовок: m.title,
            ...(mode === "index" ? {} : { текст: String(m.text ?? "").slice(0, 1500) }),
            записал: String(m.author ?? "") || (m.source === "owner" ? "владелец" : "роль"),
          })),
        };
      }),
    ...(ownerContext ? [T("taskflow_slot_restart",
      "По прямой просьбе владельца заменить зависшего исполнителя свежим агентом ТОЙ ЖЕ роли в существующем слоте и запустить. Не добавляет узлы и не меняет связи. Перед вызовом прочитай карточку; укажи точный subtask_id и неизменную роль. Если слотов несколько — уточни у владельца. Не вызывай для обычного сообщения, консультации или простого назначения. Сохраняет историю и передаёт снимок работы в новую сессию.",
      Type.Object({subtask_id:Type.String(),role:Type.String(),reason:Type.String()}),p=>restartSlotFromOwnerChat(ownerContext.chatId,ownerContext.messageId,p))] : []),
    // Уточнение у владельца (26.10.2026). С 27.10.2026 ход ждёт ответа
    // (пауза, как interrupt в AG-UI): вопрос записывается в БД и показывается
    // в чате, в поток хода уходит chats:live:interrupt, ответ владельца
    // возвращается результатом этого же вызова. Ход оборван или пауза вышла
    // по таймауту — ответ поднимет новый ход роли, как раньше.
    ...(ownerContext ? [T("taskflow_ask_user_question",
      "Задать владельцу уточняющий вопрос с вариантами ответа. Вопросов — от одного до четырёх, у каждого от двух до четырёх вариантов с коротким пояснением (description). header — короткая метка до 16 символов, label варианта — до 60. Свои варианты не называй «Other», «Type something.», «Next» — свой ответ владелец вводит сам. multiSelect — можно ли выбрать несколько вариантов. Инструмент показывает вопрос владельцу и ждёт его ответа: результат вызова — выбранные варианты, после него продолжай работу с того же места. Вопрос не повторяй. Если в результате статус «open» — владелец не ответил вовремя: заверши ход, ответ придёт отдельным сообщением и сервер поднимет новый ход роли.",
      Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ description: "текст вопроса" }),
          header: S("короткая метка вопроса, до 16 символов"),
          options: Type.Array(Type.Object({
            label: Type.String({ description: "метка варианта, до 60 символов" }),
            description: S("что выбор значит"),
          }), { minItems: 2, maxItems: 4 }),
          multiSelect: Type.Optional(Type.Boolean()),
        }), { minItems: 1, maxItems: 4 }),
        note: S("пояснение для владельца, необязательно"),
      }), async (p, signal) => {
        let payload: QuestionPayload;
        try {
          payload = validateQuestionPayload(p);
        } catch (error) {
          if (error instanceof QuestionValidationError) throw new ToolError(`${error.code}: ${error.message}`);
          throw error;
        }
        const roleId = roleUserId(role);
        const вопрос = createQuestionRow({ chatId: ownerContext.chatId, roleId, payload });
        const messageId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, reply_to_message_id)
           VALUES (?, ?, ?, 'chat', ?, ?)`,
        ).run(messageId, roleId, renderQuestionText(payload), ownerContext.chatId, ownerContext.messageId);
        db.prepare("UPDATE chat_questions SET message_id = ? WHERE id = ?").run(messageId, вопрос.id);
        db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(ownerContext.chatId);
        const участники = (db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(ownerContext.chatId) as Array<{ member_id: string }>)
          .map((row) => row.member_id);
        broadcastToUsers(участники, { type: "chat:new", message: loadChatMessage(messageId) });
        const ждём = waitForAnswer(вопрос.id, { signal });
        broadcastToUsers(участники, liveInterruptEvent({ chatId: ownerContext.chatId, userId: roleId, questionId: вопрос.id, messageId, payload }));
        const ответ = await ждём;
        broadcastToUsers(участники, liveResumeEvent({ chatId: ownerContext.chatId, userId: roleId, questionId: вопрос.id, outcome: ответ ? "answered" : "expired" }));
        if (ответ) {
          return {
            вопрос: вопрос.id,
            статус: "answered",
            ответ,
            текст: renderAnswerText(payload, ответ),
            итог: "Владелец ответил. Продолжай работу с этим ответом.",
          };
        }
        return {
          вопрос: вопрос.id,
          статус: "open",
          сообщение: messageId,
          итог: "Владелец не ответил за полчаса. Можешь решить сам на своём уровне или с Оркестратором/Помощником — реши и продолжай. Вопрос серьёзный и решить его может только владелец — заверши ход и скажи, что ждёшь его ответа: вопрос остаётся у него, ответ поднимет новый ход роли.",
        };
      })] : []),
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
