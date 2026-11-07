import {additionalTemplate} from "../lib/collaborationTemplates.js";
// Работа по разговору: связка чата и задач.
//
// Решение владельца 12.10.2026: пока он обсуждает дело с ролью в чате, роль
// прямо оттуда запускает исполнителей — заводит рабочую карточку разговора,
// кладёт в неё шаги по ролям и отправляет её в чат готовой карточкой задачи
// с кнопкой «Запустить» (тот же механизм, что у черновика Помощника владельца:
// сообщение kind=task_proposal, кнопка → /api/task-intake/drafts/:id/start).
// По нажатию план утверждается и исполнители идут работать; дальше роль
// добавляет шаги в ту же карточку (последовательно — after, параллельно —
// без after), а разговор продолжается.
//
// Карточка одна (правило дробления того же дня): шаги — узлы её плана
// командной работы, дочерние карточки здесь не заводятся.
//
// Права: черновик плана создаётся от имени владельца без его действия — это
// только предложение. Запуск (утверждение плана) вызывает сам владелец
// кнопкой «Запустить» на карточке — см. startDraftTree в lib/ownerDraft.ts.

import * as crypto from "node:crypto";

import db from "../db.js";
import { logEvent } from "../agentState.js";
import { purgeTasks } from "../lib/taskPurge.js";
import { roleTitle, roleUserId } from "../roleRouting.js";
import { asControlActor, ToolError } from "./inProcessRun.js";

export type WorkStepInput = { key?: string; role?: string; result?: string; after?: string[]; report?: string };
/** report + message_id — просьба владельца из разговора: отбивка в чат по завершении шага (lib/chatWorkRequests.ts). */
type StoredStep = { key: string; slot: string; role_key: string; result: string; after: string[]; report?: string; message_id?: string };
type LaunchRow = {
  id: string; chat_id: string; task_id: string; plan_id: string | null; title: string;
  steps_json: string; status: "proposed" | "started" | "cancelled"; role_key: string;
  created_at: string; started_at: string | null;
};

const MAX_STEPS = 6;

function ownerId(): string {
  const row = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (!row) throw new ToolError("владелец не найден");
  return row.id;
}

function slug(raw: string, index: number): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return s || `step${index + 1}`;
}

function normalizeSteps(input: WorkStepInput[]): Array<Omit<StoredStep, "slot">> {
  if (!Array.isArray(input) || input.length === 0) throw new ToolError("steps: нужен хотя бы один шаг");
  if (input.length > MAX_STEPS) throw new ToolError(`steps: не больше ${MAX_STEPS} шагов за раз`);
  const enabled = new Set(
    (db.prepare("SELECT key FROM roles WHERE enabled = 1").all() as Array<{ key: string }>).map((r) => r.key),
  );
  const steps = input.map((s, i) => {
    const role = String(s.role ?? "").trim();
    if (!enabled.has(role)) throw new ToolError(`steps[${i}].role: нет включённой роли «${role}». Доступны: ${[...enabled].join(", ")}`);
    const result = String(s.result ?? "").trim().slice(0, 1000);
    if (!result) throw new ToolError(`steps[${i}].result: опиши, какой результат нужен от роли`);
    const report = String(s.report ?? "").trim().slice(0, 500);
    return { key: slug(String(s.key ?? ""), i), role_key: role, result, after: (s.after ?? []).map((a, j) => slug(String(a), j)), ...(report ? { report } : {}) };
  });
  const keys = steps.map((s) => s.key);
  if (new Set(keys).size !== keys.length) throw new ToolError("steps: ключи шагов должны быть разными");
  return steps;
}

function checkOrder(steps: Array<{ key: string; after: string[] }>, known: Set<string>): void {
  const local = new Set(steps.map((s) => s.key));
  for (const s of steps) for (const a of s.after) {
    if (!local.has(a) && !known.has(a)) throw new ToolError(`шаг «${s.key}» ждёт «${a}», но такого шага нет`);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (key: string): void => {
    if (done.has(key) || !local.has(key)) return;
    if (visiting.has(key)) throw new ToolError("шаги ждут друг друга по кругу");
    visiting.add(key);
    for (const a of steps.find((s) => s.key === key)!.after) visit(a);
    visiting.delete(key);
    done.add(key);
  };
  for (const s of steps) visit(s.key);
}

/** Идущая работа этого разговора: последняя запущенная карточка, если она ещё открыта. */
function runningWork(chatId: string): LaunchRow | undefined {
  return db
    .prepare(
      `SELECT l.* FROM chat_work_launches l JOIN tasks t ON t.id = l.task_id
        WHERE l.chat_id = ? AND l.status = 'started' AND NOT EXISTS (SELECT 1 FROM task_collaboration_plans p WHERE p.id=l.plan_id AND p.profile IN ('result_review','code_review')) AND t.status = 'active' AND t.archived_at IS NULL
        ORDER BY l.created_at DESC LIMIT 1`,
    )
    .get(chatId) as LaunchRow | undefined;
}

export async function proposeWork(
  role: string,
  chatId: string,
  input: { title?: string; description?: string; project_id?: string; profile?: string; launch_mode?: string; authorization_message_id?: string; authorization_quote?: string; steps?: WorkStepInput[] },
  /** Сообщение владельца, на которое исполнитель ответит, если его об этом попросили. */
  messageId?: string,
): Promise<{ launch_id: string; task_id: string; started: boolean; note: string }> {
  const owner = ownerId();
  const reviewProfile=input.profile;
  if(reviewProfile && !["result_review","code_review"].includes(reviewProfile))throw new ToolError("profile: result_review | code_review");
  if(reviewProfile && !db.prepare("SELECT 1 FROM projects WHERE id=? AND archived_at IS NULL").get(input.project_id??""))throw new ToolError("Укажи project_id существующего проекта до предложения проверки");
  const launchMode=input.launch_mode??"propose";
  if(!["propose","authorized"].includes(launchMode))throw new ToolError("launch_mode: propose | authorized");
  let authorizationQuote:string|undefined;
  if(launchMode==="authorized"){
    if(!reviewProfile)throw new ToolError("Прямой согласованный вызов доступен для разовой проверки");
    const grant=db.prepare("SELECT m.text FROM chat_messages m JOIN users u ON u.id=m.from_user_id WHERE m.id=? AND m.chat_id=? AND u.role='owner'").get(input.authorization_message_id??"",chatId) as {text:string}|undefined;
    if(!grant)throw new ToolError("Нужно сообщение владельца с предварительным разрешением в этом чате");
    const quoted=input.authorization_quote?.trim() || grant.text;
    authorizationQuote=quoted;
    if(/[?«»“”"`]/u.test(grant.text) || !grant.text.includes(quoted) || /(?:^|\s)не\s+(?:надо\s+)?(?:выз|вызыв|подключ|запуск)|не\s+разрешаю|не надо|не нужно|без критика|пока не/iu.test(grant.text) || !/(?:вызови|вызывай|подключи|подключай|запусти|запускай|разрешаю|можешь\s+(?:вызвать|подключить|запустить))/iu.test(quoted) || !/(?:критик|проверк|ревью|review)/iu.test(quoted))throw new ToolError("В сообщении владельца не подтверждён прямой вызов проверки; предложи её кнопкой");
    if(reviewProfile==="code_review" && !/(?:ревью\s+кода|интеграц|интегратор|влив|main)/iu.test(quoted))throw new ToolError("Разрешение вызвать критика не разрешает интеграцию кода: используй result_review либо предложи code_review владельцу");
  }
  if(reviewProfile && messageId){
    const prior=db.prepare("SELECT l.* FROM chat_work_launches l JOIN task_collaboration_plans p ON p.id=l.plan_id WHERE l.chat_id=? AND l.role_key=? AND p.profile=? AND l.status IN ('proposed','started') AND json_extract(l.steps_json,'$[0].message_id')=? ORDER BY l.rowid DESC LIMIT 1").get(chatId,role,reviewProfile,messageId) as LaunchRow|undefined;
    if(prior)return {launch_id:prior.id,task_id:prior.task_id,started:prior.status==="started",note:"Эта разовая проверка уже предложена или запущена; второй экземпляр не создан."};
  }
  const packet=reviewProfile?additionalTemplate(reviewProfile):null;
  const steps = normalizeSteps(packet?packet.nodes.map(n=>({key:n.slot_key,role:n.role_key,result:n.expected_result})):input.steps ?? []).map((s) => (s.report && messageId ? { ...s, message_id: messageId } : s));
  const running = reviewProfile?undefined:runningWork(chatId);

  // Работа уже идёт — шаги добавляются в ту же карточку и стартуют сами.
  if (running && running.plan_id) {
    const plan = db.prepare("SELECT version, status FROM task_collaboration_plans WHERE id = ?").get(running.plan_id) as
      | { version: number; status: string }
      | undefined;
    if (plan?.status === "approved") {
      const taken = new Set(
        (db.prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id = ?").all(running.plan_id) as Array<{ slot_key: string }>).map((r) => r.slot_key),
      );
      checkOrder(steps, taken);
      const slotOf = new Map<string, string>();
      for (const s of steps) {
        let slot = s.key;
        for (let n = 2; taken.has(slot); n++) slot = `${s.key}_${n}`;
        taken.add(slot);
        slotOf.set(s.key, slot);
      }
      const stored: StoredStep[] = steps.map((s) => ({ ...s, slot: slotOf.get(s.key)!, after: s.after.map((a) => slotOf.get(a) ?? a) }));
      await asControlActor(owner, "POST", `/api/tasks/${running.task_id}/collaboration-plans/${running.plan_id}/ops`, {
        base_version: plan.version,
        reason: `шаги из разговора с ролью ${roleTitle(role)}`,
        ops: stored.map((s) => ({ op: "add_step", slot_key: s.slot, role_key: s.role_key, expected_result: s.result, after: s.after })),
      });
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO chat_work_launches(id, chat_id, task_id, plan_id, title, steps_json, status, role_key, started_at)
         VALUES(?, ?, ?, ?, ?, ?, 'started', ?, datetime('now'))`,
      ).run(id, chatId, running.task_id, running.plan_id, running.title, JSON.stringify(stored), role);
      return {
        launch_id: id, task_id: running.task_id, started: true,
        note: "Шаги добавлены в идущую работу и стартуют сами, как только откроются. Карточка в чате уже показывает их — коротко скажи владельцу, что добавил.",
      };
    }
  }

  // Сначала все проверки: неудачный вызов не должен ничего снимать.
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new ToolError("title: назови работу — так будет называться карточка");
  checkOrder(steps, new Set());

  // Новая работа: прежнее незапущенное предложение этого разговора снимается
  // вместе со своей карточкой — она заведена этим же механизмом и не стартовала.
  const stale = db.prepare("SELECT l.id, l.task_id FROM chat_work_launches l LEFT JOIN task_collaboration_plans p ON p.id=l.plan_id WHERE l.chat_id = ? AND l.status = 'proposed' AND COALESCE(p.profile,'manual') = ?").all(chatId,reviewProfile??"manual") as Array<{ id: string; task_id: string }>;
  for (const old of stale) {
    const used = db.prepare("SELECT 1 FROM chat_work_launches WHERE task_id = ? AND status = 'started'").get(old.task_id);
    if (!used) purgeTasks([old.task_id]);
    db.prepare("UPDATE chat_work_launches SET status = 'cancelled' WHERE id = ?").run(old.id);
  }

  const stored: StoredStep[] = steps.map((s) => ({ ...s, slot: s.key, ...(reviewProfile && messageId?{message_id:messageId}: {}), ...(authorizationQuote?{authorization_message_id:input.authorization_message_id,authorization_quote:authorizationQuote}:{}) }));

  const projectId = input.project_id
    ? (db.prepare("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL").get(String(input.project_id)) as { id: string } | undefined)?.id ?? null
    : null;
  const taskId = crypto.randomUUID();
  // Прямая вставка, а не POST /api/tasks: приём новой задачи в автоматическом
  // режиме сам готовит план и запускает исполнителя — здесь план свой, а
  // запуск только по кнопке владельца.
  db.prepare(
    `INSERT INTO tasks(id, title, description, creator_id, status, project_id) VALUES(?, ?, ?, ?, 'active', ?)`,
  ).run(taskId, title, String(input.description ?? "").slice(0, 8000) || null, owner, projectId);
  try {
    logEvent({ taskId, actorId: owner, kind: "task_created", field: "task", toValue: title });
  } catch { /* лента — по возможности */ }

  // Шаги заводятся подзадачами сразу: карточка в чате показывает их до
  // запуска, а план при утверждении занимает эти же строки (source_subtask_id).
  const stepIds = new Map<string, string>();
  const addStep = db.prepare("INSERT INTO subtasks(id, task_id, title, done, position) VALUES(?, ?, ?, 0, ?)");
  if(!reviewProfile)stored.forEach((s, i) => {
    const stepId = crypto.randomUUID();
    stepIds.set(s.slot, stepId);
    addStep.run(stepId, taskId, `${roleTitle(s.role_key)}: ${s.result}`.slice(0, 200), i);
  });
  // Поле для веба: если ответственный не выводится сам, это разработчик, иначе
  // роль первого шага.
  const rolesInPlan = [...new Set(stored.map((s) => s.role_key))];
  if (rolesInPlan.length > 1 && !rolesInPlan.includes("architect") && !rolesInPlan.includes("code_orchestrator")) {
    const responsible = roleUserId(rolesInPlan.includes("builder") ? "builder" : rolesInPlan[0]);
    if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(responsible)) {
      db.prepare("UPDATE tasks SET integration_mode = 'manual', integration_owner_id = ? WHERE id = ?").run(responsible, taskId);
    }
  }

  let planId: string;
  try {
    const created = reviewProfile
      ? await asControlActor(owner,"POST",`/api/tasks/${taskId}/collaboration-plans/propose`,{profile:reviewProfile})
      : await asControlActor(owner, "POST", `/api/tasks/${taskId}/collaboration-plans`, {
      profile: "manual",
      rationale: `Работа по разговору с ролью ${roleTitle(role)}`,
      nodes: stored.map((s) => ({ slot_key: s.slot, role_key: s.role_key, expected_result: s.result, source_subtask_id: stepIds.get(s.slot) })),
      edges: stored.flatMap((s) => s.after.map((a) => ({ from_slot_key: a, to_slot_key: s.slot, start_condition: "submitted" }))),
    });
    planId = created.plan.id as string;
    // Шаг и есть работа, названная ролью в разговоре: выбор «исходная или
    // плановая работа» для таких узлов уже сделан — исходная.
    db.prepare("UPDATE task_collaboration_plan_nodes SET work_choice = 'original' WHERE plan_id = ? AND source_subtask_id IS NOT NULL").run(planId);
  } catch (error) {
    purgeTasks([taskId]);
    throw error;
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_work_launches(id, chat_id, task_id, plan_id, title, steps_json, status, role_key)
     VALUES(?, ?, ?, ?, ?, ?, 'proposed', ?)`,
  ).run(id, chatId, taskId, planId, title, JSON.stringify(stored), role);
  if(reviewProfile && launchMode==="authorized"){
    await startChatWorkCard(taskId,owner);
    return {launch_id:id,task_id:taskId,started:true,note:"Разовая проверка запущена по предварительному разрешению владельца. Любой вердикт вернётся в исходный чат и разбудит тебя. Отрицательный вердикт не запускает автоматическую доработку."};
  }
  // Карточка уходит в чат готовым сообщением — с шагами и кнопкой «Запустить».
  let shown = true;
  try {
    await asControlActor(roleUserId(role), "POST", `/api/chats/${chatId}/messages`, {
      task_id: taskId, text: title, kind: "task_proposal", work_mode: "work",
    });
  } catch (error) {
    shown = false;
    console.warn(`[chat-work] карточка ${taskId} не отправлена в чат ${chatId}:`, error);
  }
  return {
    launch_id: id, task_id: taskId, started: false,
    note: shown
      ? "Карточка с шагами уже отправлена в чат отдельным сообщением, у владельца на ней кнопка «Запустить». Не пересказывай шаги и не запускай сам — одной фразой скажи, что работа подготовлена и ждёт запуска."
      : `Карточка подготовлена, но показать её в чате не удалось. Дай владельцу ссылку tf://task/${taskId} — запуск на самой карточке.`,
  };
}

/**
 * Кнопка «Запустить» на карточке в чате: если карточка — подготовленная работа
 * по разговору, владелец этим утверждает её план и исполнители идут работать.
 * Возвращает false, если карточка не из этого механизма.
 */
export async function startChatWorkCard(taskId: string, actorId: string): Promise<boolean> {
  const row = db.prepare("SELECT * FROM chat_work_launches WHERE task_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1").get(taskId) as LaunchRow | undefined;
  if (!row || !row.plan_id) return false;
  const id = row.id;
  await asControlActor(actorId, "POST", `/api/tasks/${row.task_id}/collaboration-plans/${row.plan_id}/approve`, {});
  db.prepare("UPDATE chat_work_launches SET status = 'started', started_at = datetime('now') WHERE id = ?").run(id);
  return true;
}
