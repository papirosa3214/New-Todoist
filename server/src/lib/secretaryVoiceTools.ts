// Инструменты голосового Секретаря: одна задача целиком и загрузка ролей.
// Только чтение фактической БД; формулировки готовы к озвучиванию.
import db from "../db.js";
import { isOwner } from "../access.js";
import { roleTitle } from "../roleRouting.js";
import { integrationResponsibility } from "./integrationResponsibility.js";

/** Обязательная часть инструкции звонка: дописывается к редактируемому характеру,
 *  чтобы правка характера не лишала Секретаря знания о своих инструментах. */
export const VOICE_TOOLS_GUIDE = [
  "ИНСТРУМЕНТЫ TASKFLOW — обязательная часть, от характера не зависит.",
  "Тебя слушают: без эмодзи и markdown, технические id вслух не произноси.",
  "create_task — создать задачу: передай полный текст поручения со сроками, временем, приоритетом, метками и деталями; поля и роли сам не разбирай. После ответа озвучь сохранённое; если есть questions — задай их и скажи, что карточка осталась черновиком.",
  "task_summary — списки и счёт задач: по ролям, статусам, срокам, зависшие, просроченные, завершённые за период. Просят прислать в чат — send_to_chat=true.",
  "task_details — всё об одной задаче: состояние, кто что сделал по шагам плана, вердикт проверки, интеграция, последние комментарии. Зови, когда спрашивают про конкретную задачу: кто её делал, проверена ли, что осталось, почему стоит. Передай название или слова из него.",
  "role_load — чем сейчас занята каждая роль, что ждёт в очереди и что заблокировано. Зови на вопросы о загрузке ролей: кто свободен, кто чем занят, кто завис.",
  "Не говори «исполнитель не назначен», если у задачи есть команда по плану: назови роли. Статусы, причины и даты не придумывай: нет в ответе инструмента — так и скажи.",
  "Для краткого ответа бери spoken_text; подробности — из остальных полей.",
  "Остальные инструменты taskflow_* — те же, что у тебя в чате. Команда и кто на связи — taskflow_agents. База знаний — твоя зона как библиотекаря: taskflow_kb_search ищет по смыслу во всей документации, taskflow_library и taskflow_docs показывают папки, taskflow_doc_read читает заметку целиком, taskflow_recall — память команды. Ищи сам и настойчиво: не нашёл с первого запроса — переформулируй, прежде чем сказать, что данных нет.",
  "Написать роли или в группу — taskflow_chat_send (to — имя или ключ роли). Ответ роли приходит не сразу: скажи, что передал, а когда спросят — прочитай taskflow_chat_read и перескажи ответ. Написать владельцу в его чат — send_to_owner_chat: туда же шли всё, что он просит прислать текстом.",
  "Отправлять письма на почту ты пока не умеешь: почта не подключена. Скажи это прямо и предложи прислать в чат.",
].join("\n");

const STOP = new Set(["задача", "задачи", "задачу", "задаче", "покажи", "расскажи", "скажи", "посмотри", "найди", "статус", "состояние", "что", "как", "там", "про", "для", "или", "это", "эта", "этой", "кто", "где", "когда", "почему", "последняя", "последнюю", "последней"]);
const clean = (value: string) => value.replace(/\\/g, "").toLowerCase();
const clip = (value: string | null | undefined, max: number) => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};
const STEP_STATE: Record<string, string> = { in_progress: "в работе", blocked: "заблокирован", todo: "в очереди" };

function describeTask(id: string) {
  const task = db.prepare(`SELECT t.id,t.title,t.status,t.agent_state,t.assignee_id,t.due_date,t.completed_at,t.blocked_reason,u.name AS assignee_name,p.name AS project
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(id) as any;
  const steps = (db.prepare(`SELECT s.title,s.done,s.agent_state,s.result,n.role_key,n.instructions FROM subtasks s
    JOIN task_collaboration_plans p ON p.id=s.collaboration_plan_id AND p.status='approved'
    JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.task_id=? AND n.skipped_at IS NULL ORDER BY s.position`).all(id) as any[]).map((s) => ({
      role: roleTitle(s.role_key), title: clip(s.title, 140),
      state: s.done ? "сделан" : STEP_STATE[s.agent_state] ?? "ждёт предыдущих шагов",
      result: clip(s.result, 220) || null, integration: String(s.instructions ?? "").startsWith("[taskflow:integration]"),
    }));
  const review = db.prepare(`SELECT r.verdict,r.findings,r.created_at,u.name FROM reviews r LEFT JOIN users u ON u.id=r.reviewer_id
    WHERE r.task_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(id) as any;
  const responsibility = integrationResponsibility(id);
  const integrationStep = steps.find((s) => s.integration);
  const integration = responsibility.mode === "not_required" ? "не требуется"
    : `ответственный — ${responsibility.owner_title ?? "не назначен"}; ` + (integrationStep ? `шаг интеграции ${integrationStep.state}` : "шага интеграции в плане нет");
  const comments = (db.prepare(`SELECT COALESCE(u.name,c.user_id) AS author,c.text FROM comments c LEFT JOIN users u ON u.id=c.user_id
    WHERE c.task_id=? ORDER BY c.created_at DESC,c.rowid DESC LIMIT 3`).all(id) as any[]).map((c) => ({ author: c.author, text: clip(c.text, 220) }));
  const team = [...new Set(steps.map((s) => s.role))];
  const verdict = review ? (review.verdict === "approved" ? "принята" : review.verdict === "changes_requested" ? "возвращена на доработку" : "остановлена") : null;
  const state = task.status === "completed" ? "завершена"
    : task.agent_state === "review" ? (verdict === "принята" ? "проверена и ждёт приёмки владельца" : "на проверке")
    : task.agent_state === "in_progress" ? "в работе"
    : task.agent_state === "blocked" ? `заблокирована${task.blocked_reason ? ": " + clip(task.blocked_reason, 160) : ""}`
    : steps.length || task.assignee_id ? "назначена, работа не начата" : "не назначена";
  const executors = task.assignee_name ? task.assignee_name : team.length ? `команда по плану: ${team.join(", ")}` : "не назначен";
  const done = steps.filter((s) => s.state === "сделан").length;
  const current = steps.find((s) => s.state === "в работе");
  const spoken = [`Задача «${clean(task.title) === task.title.toLowerCase() ? task.title : task.title.replace(/\\/g, "")}»: ${state}.`, `Исполнитель — ${executors}.`,
    steps.length ? `Шагов плана ${steps.length}, сделано ${done}${current ? `; сейчас работает ${current.role}` : ""}.` : "",
    review ? `Последняя проверка: ${review.name ?? "проверяющий"} — ${verdict}.` : "Проверки ещё не было.", `Интеграция: ${integration}.`].filter(Boolean).join(" ");
  return { id: task.id, title: task.title.replace(/\\/g, ""), project: task.project ?? null, state, executors, due_date: task.due_date, completed_at: task.completed_at,
    steps: steps.map(({ integration: _i, ...step }) => step),
    review: review ? { reviewer: review.name, verdict, findings: clip(review.findings, 300), at: review.created_at } : null,
    integration, last_comments: comments, spoken_text: spoken };
}

/** Найти задачу по словам из названия (или id) и вернуть её целиком. */
export function lookupTaskDetails(ownerId: string, text: string) {
  if (!isOwner(ownerId)) throw new Error("только владелец");
  const query = clean(text);
  const tasks = db.prepare("SELECT id,title,updated_at FROM tasks WHERE archived_at IS NULL").all() as Array<{ id: string; title: string; updated_at: string | null }>;
  const stems = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)))];
  const scored = tasks.map((t) => {
    const title = clean(t.title);
    return { ...t, score: query.includes(t.id) ? 100 : stems.filter((s) => title.includes(s)).length };
  }).filter((t) => t.score > 0).sort((a, b) => b.score - a.score || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  if (!scored.length) return { found: false, spoken_text: "Задачу с таким названием не нашёл. Назови её точнее или попроси сводку." };
  const best = scored[0];
  const others = scored.slice(1, 4).filter((t) => t.score === best.score).map((t) => t.title.replace(/\\/g, ""));
  return { found: true, task: describeTask(best.id), other_matches: others };
}

/** Чем занята каждая роль прямо сейчас: в работе, в очереди, заблокировано. */
export function roleLoadNow(ownerId: string) {
  if (!isOwner(ownerId)) throw new Error("только владелец");
  const roles = db.prepare("SELECT id,name,role_key FROM users WHERE type='ai' AND role_key IS NOT NULL AND COALESCE(archived,0)=0 ORDER BY name").all() as Array<{ id: string; name: string; role_key: string }>;
  const rows = roles.map((role) => {
    const steps = db.prepare(`SELECT s.title AS step,s.agent_state,t.title AS task,
        CAST((julianday('now')-julianday(s.agent_heartbeat_at))*1440 AS INTEGER) AS silent_min
      FROM subtasks s JOIN tasks t ON t.id=s.task_id
      WHERE s.agent_id=? AND s.done=0 AND s.agent_state IN ('in_progress','blocked','todo') AND t.archived_at IS NULL AND t.status='active'
      ORDER BY s.agent_heartbeat_at DESC`).all(role.id) as any[];
    const cards = db.prepare(`SELECT t.title AS task,t.agent_state FROM tasks t WHERE t.assignee_id=? AND t.status='active' AND t.archived_at IS NULL
      AND t.agent_state IN ('in_progress','blocked') AND NOT EXISTS(SELECT 1 FROM subtasks s WHERE s.task_id=t.id AND s.agent_id=? AND s.done=0 AND s.agent_state IS NOT NULL)`).all(role.id, role.id) as any[];
    const item = (r: any) => ({ task: clip(String(r.task).replace(/\\/g, ""), 120), step: r.step ? clip(r.step, 120) : null,
      ...(r.agent_state === "in_progress" && r.silent_min != null && r.silent_min >= 10 ? { no_signal_minutes: r.silent_min } : {}) });
    const all = [...steps, ...cards];
    const started24h = (db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE executor_id=? AND started_at>=datetime('now','-1 day')").get(role.id) as { n: number }).n;
    return { role: role.name, working: all.filter((r) => r.agent_state === "in_progress").map(item), queued: all.filter((r) => r.agent_state === "todo").map(item),
      blocked: all.filter((r) => r.agent_state === "blocked").map(item), started_last_24h: started24h };
  });
  const busy = rows.filter((r) => r.working.length);
  const free = rows.filter((r) => !r.working.length && !r.queued.length).map((r) => r.role);
  const spoken = [busy.length ? "Сейчас работают: " + busy.map((r) => `${r.role} — «${r.working[0].task}»${r.working[0].no_signal_minutes ? `, без сигнала ${r.working[0].no_signal_minutes} минут` : ""}`).join("; ") + "." : "Сейчас никто не работает.",
    rows.some((r) => r.queued.length) ? "В очереди: " + rows.filter((r) => r.queued.length).map((r) => `${r.role} — ${r.queued.length}`).join(", ") + "." : "",
    rows.some((r) => r.blocked.length) ? "Заблокировано: " + rows.filter((r) => r.blocked.length).map((r) => `${r.role} — ${r.blocked.length}`).join(", ") + "." : "",
    free.length ? "Свободны: " + free.join(", ") + "." : ""].filter(Boolean).join(" ");
  return { roles: rows, spoken_text: spoken };
}

// ── Общие инструменты Секретаря для звонка ──────────────────────────────
// Те же инструменты, что у Секретаря в чате и в работе: звонок вызывает их
// через мост от имени роли secretary, отдельных голосовых копий нет.
const VOICE_SHARED_TOOLS = ["taskflow_task", "taskflow_my_tasks", "taskflow_projects", "taskflow_project_tasks", "taskflow_status", "taskflow_agents",
  "taskflow_chat_send", "taskflow_chat_read", "taskflow_chat_reply", "taskflow_comment",
  "taskflow_kb_search", "taskflow_library", "taskflow_docs", "taskflow_doc_read", "taskflow_doc_write", "taskflow_recall", "taskflow_remember",
  "taskflow_weather", "taskflow_my_stats", "taskflow_runtime"];

async function sharedTools(): Promise<any[]> {
  const [{ taskflowTools }, { chatTools }] = await Promise.all([import("../runtime/inProcessRun.js"), import("../runtime/chatTools.js")]);
  const byName = new Map<string, any>();
  for (const tool of [...chatTools("secretary"), ...taskflowTools("secretary", null)] as any[])
    if (VOICE_SHARED_TOOLS.includes(tool.name) && !byName.has(tool.name)) byName.set(tool.name, tool);
  return VOICE_SHARED_TOOLS.filter((name) => byName.has(name)).map((name) => byName.get(name));
}
/** Схема параметров в виде, который принимает голосовая модель: только простые поля. */
function plainSchema(node: any): any {
  if (!node || typeof node !== "object") return { type: "string" };
  const variant = Array.isArray(node.anyOf) ? node.anyOf.find((v: any) => v?.type && v.type !== "null") : null;
  if (variant) return { ...plainSchema(variant), ...(node.description ? { description: node.description } : {}) };
  const type = Array.isArray(node.type) ? node.type.find((t: string) => t !== "null") : node.type;
  const out: any = { type: typeof type === "string" ? type : "string" };
  if (node.description) out.description = String(node.description);
  if (Array.isArray(node.enum)) out.enum = node.enum;
  if (out.type === "object") {
    out.properties = Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, value]) => [key, plainSchema(value)]));
    if (Array.isArray(node.required) && node.required.length) out.required = node.required;
  }
  if (out.type === "array") out.items = plainSchema(node.items);
  return out;
}
export async function voiceToolManifest() {
  return (await sharedTools()).map((tool) => ({ name: tool.name, description: clip(String(tool.description ?? tool.name), 900), parameters: plainSchema(tool.parameters) }));
}
export async function runVoiceTool(ownerId: string, name: string, args: unknown) {
  if (!isOwner(ownerId)) throw new Error("только владелец");
  const tool = (await sharedTools()).find((t) => t.name === name);
  if (!tool) throw new Error("неизвестный инструмент: " + name);
  try {
    const result = await tool.execute("voice", args && typeof args === "object" ? args : {});
    const text = (result?.content ?? []).map((part: any) => part?.text ?? "").join("\n");
    return { ok: true, result: text.length > 12000 ? text.slice(0, 12000) + "\n…обрезано" : text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
