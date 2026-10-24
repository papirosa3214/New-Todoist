import {chatIntentBlockForMessage} from "../lib/jevAssist.js";
import {compactChatReportMaterials} from "../lib/chatReportMaterials.js";
import {preparedReportMaterials} from "../runtime/chatPreparedMaterials.js";
import { prepareChatValue } from "../runtime/chatPreparationDeadline.js";
import {chatExecutionMode,parseChatExecutionMode,isCardHandoffCommand} from "../runtime/chatExecutionMode.js";
import {offerChatSteering} from "../runtime/chatSteering.js";
import { ensurePersonalRoom, isDirectRoom, roomsSnapshot } from "../lib/chatRooms.js";
import { clearChatWorkPlan, isWorkPlanFinished, readChatWorkPlan, readChatWorkPlans, saveChatWorkPlan, validateWorkPlan } from "../lib/subtaskWorkPlan.js";
import {hasCoordinationCard,registerCoordinationOrigin,coordinationAnswered,coordinationCardData,updateCoordination,traceCoordination,markDeliveredToWork,markCoordinationAnswered} from "../runtime/chatCoordination.js";
import { clockLine } from "../lib/clockLine.js";
import { teamStructureText } from "../lib/teamStructure.js";
import {integrationHandoffContext,isIntegrationHandoff} from "../runtime/integrationHandoff.js";
import { branchMembership } from "../runtime/branchPlan.js";
import { shouldFanOutOwnerMessage, shouldFanOutTaskTopic, taskTopicBranchAck, branchSummaryLines, fanoutTitle, fanoutBranchAck, fanoutParentAck } from "../lib/chatOwnerFanout.js";
import { taskChatBrief } from "../lib/taskChatBrief.js";
import { startSlotConversation,cancelSlotConversationsFor,resolveTopicSlot,topicSlots } from "../runtime/slotConversation.js";
import { deliverTopicToWork, deliverChatToWork } from "../runtime/inProcessRun.js";
import { topicContext, taskTopicClosedAt, rehomeEmptyTopic } from "../lib/projectTopics.js";
import {
  archiveChat,
  archiveRight,
  chatRoomRow,
  canArchiveTaskTopic,
  cleanupCandidates,
  isTaskTopic,
  runCleanup,
} from "../lib/chatArchive.js";
import { nudgeTaskPlan } from "../runtime/taskNudge.js";
import { getProjectForWrite, getTaskForRead, isOwner } from "../access.js";
import { externalRuntime } from "../roleRouting.js";
import { parseChatWorkMode, type ChatWorkMode } from "../runtime/chatWorkMode.js";
import { renderInstruction } from "../lib/roleContextResolver.js";
// Чаты с ролями-агентами (владелец 21.09.2026, план
// docs/superpowers/plans/2026-09-21-chat-online-pi-runtime.md, этапы 1–2).
//
// Чат — отдельная сущность, которую создаёт пользователь: персональный (одна
// роль) или групповой (несколько ролей). Это НЕ старые каналы owner/agents —
// те живут как были; чаты аддитивны (миграции 053/054).
//
// Этап 2: при отправке сообщения в чат в дело вступает живая онлайн-сессия
// Пи (без задачи). Роль-адресат определяется так:
//   1) явная адресация в тексте (@architect, @qa, …) — приоритет;
//   2) в личном чате с одной ролью — она отвечает и без @ (адресация
//      неявная); в групповом и общем чате без @ никто не просыпается.
// Если адресат не определился — просто ложим сообщение в ленту, авто-ответа
// нет: молчание корректнее, чем ответ «не той» роли.
//
// Сериализация (B5, замечание Гермеса): deliverAgentReply всегда ставится в
// очередь на пару (chat_id, role_id), а не стартует параллельно. Два
// быстрых сообщения подряд на одну роль в одном чате получат ответы в том
// же порядке, в каком были присланы.
//
// Изоляция: онлайн-сессия НЕ трогает tasks/attempts/agent_state/аренду.
// Сессия живёт в chat_sessions и в памяти адаптера, и снять или сломать
// карточку через чат физически невозможно.
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { broadcastToUsers } from "../ws.js";
import {
  COMMON_CHAT_ID,
  assertCommonChatWritable,
  ensureCommonChat,
} from "../lib/chatCommon.js";
import {
  chatRunFailureText,
  liveTurnsOfChat,
  startLiveTurn,
  unwrapRoleEnvelope,
  type SavedSteps,
} from "../runtime/chatLiveTurn.js";
import { formatChatMessage, formatChatHistory, loadChatMessage } from "../lib/chatMessages.js";
import {
  ChecklistItemError,
  checklistStateOfChat,
  checklistStateOfMessage,
  setChecklistItem,
} from "../lib/chatChecklist.js";
import { normalizeRoleReplyV1, structuredOutputText } from "../lib/roleContractV1.js";
import { applyRoleFormat, roleFormatRefusal } from "../lib/roleFormat.js";
import { roleProjectContext } from "../runtime/roleProjectContext.js";
import { roleSlotSnapshotsBlock } from "../runtime/slotWorkSnapshot.js";
import { normalizeWidgetBlocks } from "../lib/widgetNormalize.js";
import {
  ROLE_NAMES,
  roleTitle as titleOfRole,
  rolePromptText,
  type RoleName,
} from "../roleRouting.js";
import {
  enqueueChatReply,
  getChatSessionId,
  recordDurableDelivery,
  pickDurableDelivery,
  completeDurableDelivery,
  bumpChatGeneration,
} from "../runtime/chatSession.js";
import {
  currentChatGeneration,
  fenceMessageDelivery,
  observeDeliveryActivity,
} from "../runtime/chatQueue.js";
import {
  cancelChatRunsFor,
  startChatRun,
} from "../runtime/PiRuntimeAdapter.js";
import {
  composeLayer,
} from "../lib/roleContextResolver.js";
import {
  LOCAL_EXECUTION_POLICY,
} from "../runtime/inProcessRun.js";
import {
  attachmentRow,
  saveUploadedFile,
  UploadRejected,
} from "./attachments.js";
import {
  answerRoleQuestionsBy,
  evaluateRecipientAvailability,
  openRoleQuestion,
  recipientUserIdFor,
} from "../runtime/roleMessageWait.js";

const uid = () => crypto.randomUUID();

/** Превью в списке чатов: без конверта, виджет и артефакт — словом, а не
 *  кодом. */
function previewText(text: string): string {
  return unwrapRoleEnvelope(text)
    .replace(/```(?:html|artifact)[^\n]*\n[\s\S]*?(?:```|$)/g, "✦ Интерактив")
    .replace(/```widget[^\n]*\n[\s\S]*?(?:```|$)/g, (block) => {
      const type = block.match(/"type"\s*:\s*"([a-z_]+)"/)?.[1];
      return type === "weather" ? "🌤 Погода" : "▦ Виджет";
    })
    .trim();
}

/** Быстрые ответы (владелец 25.09.2026): модель заканчивает ответ строкой
 *  `БЫСТРО: вариант1 | вариант2 | вариант3` — разбираем и убираем из
 *  текста, который ложится в ленту. Раньше жило только у Помощника владельца,
 *  теперь это общий формат ответа любой роли. */
function extractQuickReplies(text: string): { clean: string; replies: string[] | null } {
  const lines = text.split("\n");
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx < 0) return { clean: text, replies: null };
  const match = lines[lastIdx].trim().match(/^БЫСТРО:\s*(.+)$/i);
  if (!match) return { clean: text, replies: null };
  const replies = match[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!replies.length) return { clean: text, replies: null };
  const clean = lines.slice(0, lastIdx).join("\n").trimEnd();
  return { clean, replies };
}

type ChatKind = "direct" | "group";
const KINDS: ChatKind[] = ["direct", "group"];

/** Обычная комната меняет адресацию вместе с составом. Проектные группы,
 *  темы задач и системный общий чат сохраняют групповой контракт. */
function syncChatKindFromMembers(chatId: string): void {
  db.prepare(`UPDATE chats SET kind = CASE
      WHEN (SELECT COUNT(*) FROM chat_members WHERE chat_id = chats.id) > 2
      THEN 'group' ELSE 'direct' END
    WHERE id = ? AND id <> 'chat-common'
      AND project_id IS NULL AND parent_chat_id IS NULL AND task_id IS NULL`).run(chatId);
}

/** Владелец видит лички ролей, не будучи участником, — ему тоже шлём. */
function ownerIdsForChat(chatId: string): string[] {
  if (!isDirectRoom(chatId)) return [];
  return (db.prepare("SELECT id FROM users WHERE role='owner'").all() as Array<{ id: string }>).map((r) => r.id);
}

function memberIds(chatId: string): string[] {
  return (
    db
      .prepare("SELECT member_id FROM chat_members WHERE chat_id = ?")
      .all(chatId) as Array<{ member_id: string }>
  ).map((r) => r.member_id).filter((id) => isMember(chatId,id));
}

function isMember(chatId: string, userId: string): boolean {
  const chat = db.prepare("SELECT project_id, parent_chat_id, task_id FROM chats WHERE id = ?").get(chatId) as any;
  // Приватный проект (задача 9d583c58…): его чаты не видны никому, кроме
  // владельца трекера — иначе утечка через название группового чата
  // (оно равно имени проекта) и через task_title темы.
  if (chat?.project_id && !isOwner(userId)) {
    const meta = db
      .prepare("SELECT is_private, archived_at FROM projects WHERE id = ?")
      .get(chat.project_id) as
      | { is_private?: number | null; archived_at?: string | null }
      | undefined;
    if (meta?.is_private === 1) return false;
    // Архивный проект (карточка a1be7d63…): его чаты закрыты и с глаз
    // убраны — для всех, кроме владельца.
    if (meta?.archived_at) return false;
  }
  if (chat?.parent_chat_id) {
    const task=chat.task_id ? getTaskForRead(chat.task_id,userId) : null;
    if (!task || task.project_id !== chat.project_id) return false;
  }
  if (chat?.project_id && !chat.parent_chat_id && !getProjectForWrite(chat.project_id,userId)) {
    const teammate=db.prepare(`SELECT 1 FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id JOIN tasks t ON t.id=p.task_id JOIN users u ON u.role_key=n.role_key WHERE t.project_id=? AND p.status='approved' AND n.skipped_at IS NULL AND u.id=? AND u.type='ai'`).get(chat.project_id,userId);
    if(!teammate) return false;
  }
  // Личку двух ролей владелец читает, не будучи её участником (21.10.2026):
  // «нажал на Оркестратора — вижу, что к нему пришло от Помощника».
  if (isOwner(userId) && isDirectRoom(chatId)) return true;
  return !!db
    .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_id = ?")
    .get(chatId, userId);
}

function roleAccountId(role: RoleName): string | null {
  const row = db
    .prepare(
      "SELECT id FROM users WHERE role_key = ? AND role = 'agent' AND type = 'ai'",
    )
    .get(role) as { id: string } | undefined;
  return row?.id ?? null;
}

function chatRow(chatId: string) {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as
    | { id: string; title: string | null; kind: ChatKind; created_by: string; task_id: string | null; created_at: string; updated_at: string }
    | undefined;
  if (!chat) return null;
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.role, u.type, u.role_key, u.avatar_color, u.avatar_url, u.initials
         FROM chat_members cm JOIN users u ON u.id = cm.member_id
        WHERE cm.chat_id = ? ORDER BY cm.added_at`,
    )
    .all(chatId);
  const pinnedMessageId = (chat as any).pinned_message_id as string | null | undefined;
  const pinned = pinnedMessageId
    ? (db.prepare("SELECT id FROM chat_messages WHERE id = ?").get(pinnedMessageId) as
        | { id: string }
        | undefined)
    : undefined;
  return {
    ...chat,
    execution_mode: chatExecutionMode(chatId),
    members,
    closed_at: taskTopicClosedAt(chat as any),
    pinned_message_id: pinnedMessageId ?? null,
    pinned_message: pinned ? loadChatMessage(pinned.id) : null,
  };
}

export async function registerChatsRoutes(app: FastifyInstance): Promise<void> {
  const authPre = authOrApiToken;

  // Исправляем сохранённые раньше direct-комнаты с несколькими собеседниками
  // и группы, где осталась одна роль. История, участники и сессии сохраняются.
  db.transaction(() => {
    const ordinary = db.prepare(`SELECT id FROM chats WHERE id <> 'chat-common'
      AND project_id IS NULL AND parent_chat_id IS NULL AND task_id IS NULL`).all() as Array<{id: string}>;
    for (const chat of ordinary) syncChatKindFromMembers(chat.id);
  })();

  function ensureProjectGroup(project: any, userId: string) {
    let group = db.prepare("SELECT id FROM chats WHERE project_id=? AND parent_chat_id IS NULL").get(project.id) as any;
    if (!group) {
      group={id:uid()};
      db.prepare("INSERT INTO chats (id,title,kind,created_by,project_id) VALUES (?,?,'group',?,?)").run(group.id,project.name,userId,project.id);
    }
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id,member_id) VALUES (?,?)").run(group.id,userId);
    return group.id as string;
  }
  app.post("/api/projects/:projectId/chat",{preHandler:authPre},async(req:any,reply)=>{
    const project=getProjectForWrite(req.params.projectId,req.userId);
    if (!project) return reply.code(404).send({error:"Проект не найден"});
    const id=db.transaction(()=>ensureProjectGroup(project,req.userId))();
    return {chat:chatRow(id)};
  });
  app.post("/api/tasks/:taskId/topic",{preHandler:authPre},async(req:any,reply)=>{
    const task=getTaskForRead(req.params.taskId,req.userId);
    if (!task?.project_id) return reply.code(404).send({error:"Задача проекта не найдена"});
    const project=getProjectForWrite(task.project_id,req.userId);
    if (!project) return reply.code(403).send({error:"Нет доступа к группе проекта"});
    const previous=db.prepare("SELECT project_id FROM chats WHERE task_id=? AND parent_chat_id IS NOT NULL").get(task.id) as any;
    const id=db.transaction(()=>{
      const parent=ensureProjectGroup(project,req.userId);
      if (previous && previous.project_id !== task.project_id) {
        const moving=db.prepare("SELECT id FROM chats WHERE task_id=? AND parent_chat_id IS NOT NULL").get(task.id) as {id:string};
        if (!rehomeEmptyTopic(moving.id,task.project_id,parent)) return null;
      }
      let topic=db.prepare("SELECT id FROM chats WHERE task_id=? AND parent_chat_id IS NOT NULL").get(task.id) as any;
      if (!topic) {
        topic={id:uid()};
        db.prepare("INSERT INTO chats (id,title,kind,created_by,task_id,project_id,parent_chat_id) VALUES (?,?,'group',?,?,?,?)").run(topic.id,task.title,req.userId,task.id,task.project_id,parent);
      }
      db.prepare("INSERT OR IGNORE INTO chat_members (chat_id,member_id) VALUES (?,?)").run(topic.id,req.userId);
      return topic.id;
    })();
    if (!id) return reply.code(409).send({error:"Тема относится к прежнему проекту задачи"});
    return {chat:chatRow(id)};
  });
  app.get("/api/chats/:id/topics",{preHandler:authPre},async(req:any,reply)=>{
    if (!isMember(req.params.id,req.userId)) return reply.code(404).send({error:"Чат не найден"});
    // Закрытые темы в списке проекта не копятся (владелец 07.10.2026); переписка остаётся
    // доступной из карточки задачи, весь список — с include_closed=1.
    const includeClosed = String(req.query?.include_closed ?? "") === "1";
    const rows=db.prepare("SELECT id,task_id,parent_chat_id,closed_at FROM chats WHERE parent_chat_id=? ORDER BY updated_at DESC,id").all(req.params.id) as Array<{id:string;task_id:string|null;parent_chat_id:string|null;closed_at:string|null}>;
    return {chats:rows.filter(c=>isMember(c.id,req.userId) && (includeClosed || !taskTopicClosedAt(c))).map(c=>({
      ...chatRow(c.id),
      unread_count:(db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=? AND from_user_id != ? AND created_at > COALESCE((SELECT last_read_at FROM chat_members WHERE chat_id=? AND member_id=?),'1970-01-01')`).get(c.id,req.userId,c.id,req.userId) as {n:number}).n,
    }))};
  });

  // Reopen the real owner↔role conversation, including a conversation the
  // role created earlier. Keeping the same room preserves history and receipts.
  app.post<{Body:{role_id?:unknown}}>("/api/chats/with-role",{preHandler:authPre},async(req:any,reply)=>{
    const me=db.prepare("SELECT role FROM users WHERE id=?").get(req.userId) as {role:string}|undefined;
    if(me?.role!=="owner")return reply.code(403).send({error:"Личный чат роли открывает владелец"});
    const roleId=typeof req.body?.role_id==="string"?req.body.role_id.trim():"";
    const active=db.prepare("SELECT 1 FROM users WHERE id=? AND COALESCE(archived,0)=0").get(roleId);
    if(!active || !roleFromUserId(roleId))return reply.code(400).send({error:"Нужна действующая роль"});
    // Личная комната роли — по назначению, а не «первый чат на двоих»:
    // иначе подбиралась служебная «Передача принятых изменений» (21.10.2026).
    const id=ensurePersonalRoom(roleId);
    if(!id)return reply.code(400).send({error:"Нужна действующая роль"});
    return {chat:chatRow(id)};
  });

  // Создать чат. member_ids — роли-агенты (или любые существующие учётки).
  // Создатель добавляется участником автоматически: он — сторона разговора.
  app.post<{
    Body: { title?: string; kind?: string; member_ids?: string[]; task_id?: string | null };
  }>("/api/chats", { preHandler: authPre }, async (req: any, reply) => {
    const kind = (req.body?.kind || "group") as ChatKind;
    if (!KINDS.includes(kind))
      return reply.code(400).send({ error: `kind должен быть: ${KINDS.join(", ")}` });

    const requested = Array.isArray(req.body?.member_ids)
      ? req.body!.member_ids.filter((m: unknown) => typeof m === "string" && m)
      : [];
    if (kind === "direct" && requested.length !== 1)
      return reply.code(400).send({ error: "персональный чат — ровно один участник" });
    // B1 (проверка Гермеса 21.09.2026): персональный чат с самим собой —
    // бессмысленный дефект. Создатель и так добавляется участником, поэтому
    // «direct» с единственным member_id = собственный id надо отклонить.
    if (kind === "direct" && requested[0] === req.userId)
      return reply.code(400).send({ error: "персональный чат с самим собой не нужен" });
    if (requested.length === 0)
      return reply.code(400).send({ error: "нужен хотя бы один участник" });

    // Все участники должны существовать. Создателя тоже включаем в состав.
    const all = [...new Set([req.userId, ...requested])];
    const placeholders = all.map(() => "?").join(",");
    // B3 (проверка Гермеса 21.09.2026): архивную учётку (миграция 040)
    // в участники не берём — она уже выведена из работы и ответить не сможет,
    // а список и состав только засоряет.
    const found = (
      db
        .prepare(
          `SELECT id FROM users WHERE id IN (${placeholders}) AND COALESCE(archived, 0) = 0`,
        )
        .all(...all) as Array<{ id: string }>
    ).map((r) => r.id);
    const missing = all.filter((id) => !found.includes(id));
    if (missing.length)
      return reply.code(400).send({ error: `нет таких участников: ${missing.join(", ")}` });

    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : null;
    const taskId = req.body?.task_id || null;
    if (taskId) {
      const t = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
      if (!t) return reply.code(400).send({ error: "нет такой задачи" });
    }

    const id = uid();
    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO chats (id, title, kind, created_by, task_id) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, title, kind, req.userId, taskId);
      const ins = db.prepare(
        "INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?)",
      );
      for (const m of all) ins.run(id, m);
      syncChatKindFromMembers(id);
    });
    txn();

    return { chat: chatRow(id) };
  });

  // Ветка от сообщения (владелец 14.10.2026): новый чат с теми же
  // участниками, первым сообщением — копия исходного от того же автора.
  // У ветки своя сессия роли: первый ход получит историю ветки (с этой
  // копией), а основной разговор её переписку не увидит.
  app.post<{ Params: { id: string }; Body: { message_id?: string } }>(
    "/api/chats/:id/branch", { preHandler: authPre }, async (req: any, reply) => {
      const parentId = req.params.id;
      if (!isMember(parentId, req.userId)) return reply.code(404).send({ error: "Чат не найден" });
      const source = db.prepare("SELECT id, from_user_id, text FROM chat_messages WHERE id = ? AND chat_id = ?")
        .get(String(req.body?.message_id ?? ""), parentId) as { id: string; from_user_id: string; text: string } | undefined;
      if (!source) return reply.code(404).send({ error: "Сообщение не найдено в этом чате" });
      const parent = db.prepare("SELECT kind FROM chats WHERE id = ?").get(parentId) as { kind: ChatKind };
      const firstLine = unwrapRoleEnvelope(source.text).split("\n").map(l => l.replace(/[#*`>_-]/g, "").trim()).find(Boolean) ?? "сообщение";
      const title = "Ветка: " + (firstLine.length > 60 ? firstLine.slice(0, 59) + "…" : firstLine);
      const id = uid();
      db.transaction(() => {
        db.prepare("INSERT INTO chats (id, title, kind, created_by, branch_of_chat_id, branch_of_message_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, title, parent.kind, req.userId, parentId, source.id);
        db.prepare("INSERT INTO chat_members (chat_id, member_id) SELECT ?, member_id FROM chat_members WHERE chat_id = ?").run(id, parentId);
        db.prepare("INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(id, req.userId);
        db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)")
          .run(uid(), source.from_user_id, unwrapRoleEnvelope(source.text), id);
      })();
      return { chat: chatRow(id) };
    });

  // Мои чаты: где я участник. С превью последнего сообщения и числом
  // непрочитанных (владелец 21.09.2026: бейдж в строке списка чатов,
  // LOCK-195). Сортировка — по `updated_at`: он обновляется на каждое
  // сообщение (см. POST /:id/messages), то есть чат с свежей перепиской
  // всегда наверху.
  // Панель «Комнаты» (21.10.2026): Общая, личные комнаты ролей и их лички.
  app.get("/api/chats/rooms", { preHandler: authPre }, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "Комнаты видит владелец" });
    return roomsSnapshot(previewText);
  });

  app.get("/api/chats", { preHandler: authPre }, async (req: any) => {
    const includeClosed = String(req.query?.include_closed ?? "") === "1";
    const rows = db
      .prepare(
        `SELECT c.* FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id
          WHERE cm.member_id = ?
          ORDER BY c.updated_at DESC`,
      )
      .all(req.userId) as Array<{ id: string; task_id: string | null; parent_chat_id: string | null; closed_at: string | null }>;
    return {
      chats: rows.filter((c) => isMember(c.id,req.userId) && (includeClosed || !taskTopicClosedAt(c))).map((c) => {
        // Имя отправителя — превью группы идёт с ним («QA: проверка
        // прошла»), счётчики вложений — чтобы клиент мог показать
        // «Голосовое»/«Файл» вместо пустой строки (у голосового текста нет).
        const last = db
          .prepare(
            `SELECT m.text, m.created_at, m.from_user_id,
                    f.name AS from_user_name,
                    (SELECT COUNT(*) FROM attachments a
                      WHERE a.chat_message_id = m.id) AS attachment_count,
                    (SELECT COUNT(*) FROM attachments a
                      WHERE a.chat_message_id = m.id
                        AND (a.mime LIKE 'audio/%' OR a.file_name LIKE '%.m4a')) AS audio_count
               FROM chat_messages m
               LEFT JOIN users f ON f.id = m.from_user_id
              WHERE m.chat_id = ?
              ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
          )
          .get(c.id) as
          | {
              text: string;
              created_at: string;
              from_user_id: string;
              from_user_name: string | null;
              attachment_count: number;
              audio_count: number;
            }
          | undefined;
        // Отметка прочтения — на участнике (миграция 055). Нет строки —
        // значит чат новее миграции и участник ещё не открывал его.
        const read = db
          .prepare(
            "SELECT last_read_at FROM chat_members WHERE chat_id = ? AND member_id = ?",
          )
          .get(c.id, req.userId) as { last_read_at: string } | undefined;
        const { n: unread } = db
          .prepare(
            `SELECT COUNT(*) AS n FROM chat_messages
              WHERE chat_id = ? AND from_user_id != ? AND created_at > ?`,
          )
          .get(c.id, req.userId, read?.last_read_at ?? "1970-01-01 00:00:00") as {
          n: number;
        };
        return {
          ...chatRow(c.id),
          last_message: last
            ? { ...last, text: typeof last.text === "string" ? previewText(last.text) : last.text }
            : null,
          unread_count: unread,
          // Название задачи для пометки в строке списка: по ней видно, какой
          // чат за какой задачей (владелец 21.09.2026, LOCK-195).
          task_title: c.task_id
            ? ((
                db.prepare("SELECT title FROM tasks WHERE id = ?").get(c.task_id) as
                  | { title: string }
                  | undefined
              )?.title ?? null)
            : null,
          // Проект сессии для группировки списка (21.10.2026): у проектного
          // чата — свой, у сессии задачи («Заминки», тема) — проект задачи.
          project_name: (db.prepare(`SELECT p.name FROM projects p WHERE p.id = COALESCE(?, (SELECT project_id FROM tasks WHERE id = ?))`)
            .get((c as any).project_id ?? null, c.task_id ?? null) as { name: string } | undefined)?.name ?? null,
        };
      }),
    };
  });

  // Один чат с участниками. Доступ — только участнику.
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      return { chat: chatRow(req.params.id) };
    },
  );

  // Изменить чат (создатель): название и/или привязку к задаче.
  //
  // Про привязку. Привязка — то, что выводит переписку в ленту задачи:
  // `routes/tasks.ts` подмешивает сообщения привязанных чатов в `comments`
  // (владелец 21.09.2026, LOCK-195). Перепривязка переносит и УЖЕ написанные
  // сообщения чата: иначе после привязки лента задачи показала бы только новую
  // переписку, а весь разговор до неё остался бы невидимым — человек ждёт
  // обратного. Сообщения, привязанные к другой задаче явно (через task_id в
  // теле отправки), не трогаем: их привязка сильнее чатовой.
  //
  // Про название (владелец 21.09.2026: «переименовывать почему-то я не умею
  // этот чат»). Пустое или пробельное название — это `NULL`: тогда список и
  // шапка показывают состав участников, как у группы без названия.
  app.patch<{
    Params: { id: string };
    Body: { task_id?: string | null; title?: string | null };
  }>(
    "/api/chats/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const chat = db
        .prepare<[string], { created_by: string; task_id: string | null }>(
          "SELECT created_by, task_id FROM chats WHERE id = ?",
        )
        .get(req.params.id);
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "менять чат может создатель" });

      const hasTask = Object.prototype.hasOwnProperty.call(req.body ?? {}, "task_id");
      const hasTitle = Object.prototype.hasOwnProperty.call(req.body ?? {}, "title");
      if (!hasTask && !hasTitle)
        return reply.code(400).send({ error: "нечего менять" });

      const managed=db.prepare("SELECT project_id FROM chats WHERE id=?").get(req.params.id) as any;
      if (hasTask && managed?.project_id) return reply.code(409).send({error:"Тему проекта нельзя перепривязать"});
      const rawTask = req.body?.task_id;
      const taskId = typeof rawTask === "string" && rawTask ? rawTask : null;
      if (hasTask && taskId && !db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId))
        return reply.code(400).send({ error: "нет такой задачи" });

      const title = hasTitle
        ? (typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : "") || null
        : null;

      const previous = chat.task_id;
      const txn = db.transaction(() => {
        if (hasTitle) {
          db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, req.params.id);
        }
        if (hasTask) {
          db.prepare("UPDATE chats SET task_id = ? WHERE id = ?").run(taskId, req.params.id);
          const scope = previous ? "task_id IS NULL OR task_id = ?" : "task_id IS NULL";
          const params = previous
            ? [taskId, req.params.id, previous]
            : [taskId, req.params.id];
          db.prepare(
            `UPDATE chat_messages SET task_id = ?
              WHERE chat_id = ? AND channel = 'chat' AND (${scope})`,
          ).run(...params);
        }
      });
      txn();

      return { chat: chatRow(req.params.id) };
    },
  );

  // Закрыть или вернуть сессию (21.10.2026): закрытая уходит из списка в
  // фильтр «Закрытые», история сохраняется. Постоянные комнаты не закрываются.
  app.post<{ Params: { id: string }; Body: { closed?: unknown } }>(
    "/api/chats/:id/close",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "Закрывает сессию владелец" });
      const chat = db.prepare("SELECT id, room_kind, archived_at FROM chats WHERE id=?").get(req.params.id) as { id: string; room_kind: string | null; archived_at: string | null } | undefined;
      if (!chat || !isMember(chat.id, req.userId)) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.room_kind === "personal" || chat.room_kind === "dm" || chat.room_kind === "common")
        return reply.code(409).send({ error: "Постоянную комнату закрыть нельзя" });
      const closed = req.body?.closed !== false;
      // Убранный чат в список не возвращается: уборка — это не «закрыть и
      // потом открыть», а спрятать пустую комнату навсегда.
      if (!closed && chat.archived_at)
        return reply.code(409).send({ error: "Убранный в архив чат вернуть нельзя" });
      db.prepare("UPDATE chats SET closed_at = CASE WHEN ? THEN COALESCE(closed_at, datetime('now')) ELSE NULL END WHERE id=?").run(closed ? 1 : 0, chat.id);
      // Ветка закрыта — её сводка уходит в комнату-родитель, к основной роли.
      const branch = db.prepare("SELECT branch_of_chat_id, title FROM chats WHERE id=?").get(chat.id) as
        | { branch_of_chat_id: string | null; title: string | null }
        | undefined;
      if (closed && branch?.branch_of_chat_id) {
        try {
          const answers = (db
            .prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND from_user_id LIKE 'role_%' ORDER BY created_at")
            .all(chat.id) as Array<{ text: string }>).map((row) => unwrapRoleEnvelope(row.text));
          const lines = branchSummaryLines(answers);
          const summaryId = uid();
          const summary =
            "Ветка «" + String(branch.title ?? "").replace(/^Ветка:\s*/, "") + "» закрыта." +
            (lines.length ? "\nИтог: " + lines.join(" · ") : "");
          db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, message_type) VALUES (?, ?, ?, 'chat', ?, 'system')")
            .run(summaryId, req.userId, summary, branch.branch_of_chat_id);
          broadcastToUsers(memberIds(branch.branch_of_chat_id), { type: "chat:new", message: loadChatMessage(summaryId) });
        } catch (error) {
          console.warn("[chats] сводка закрытой ветки не ушла в родителя:", error instanceof Error ? error.message : error);
        }
      }
      return { chat: chatRow(chat.id) };
    },
  );

  // Закрепить сообщение чата (создатель или владелец). Закреплённое
  // показывается баром в шапке — в общем чате это регламент. Регламент
  // обновляется только явным действием, а не серверным автообновлением.
  app.post<{ Params: { id: string }; Body: { message_id?: string | null } }>(
    "/api/chats/:id/pin",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const messageId =
        typeof req.body?.message_id === "string" && req.body.message_id
          ? req.body.message_id
          : null;
      if (messageId) {
        const message = db
          .prepare("SELECT from_user_id FROM chat_messages WHERE id = ? AND chat_id = ?")
          .get(messageId, req.params.id) as { from_user_id: string } | undefined;
        if (!message) return reply.code(404).send({ error: "Сообщение не найдено" });
        const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
          | { created_by: string }
          | undefined;
        if (chat?.created_by !== req.userId && message.from_user_id !== req.userId)
          return reply.code(403).send({ error: "закрепить чужое сообщение может создатель" });
      }
      db.prepare("UPDATE chats SET pinned_message_id = ? WHERE id = ?").run(
        messageId,
        req.params.id,
      );
      return { chat: chatRow(req.params.id) };
    },
  );

  // Отметить чат прочитанным (участник). По этой отметке список считает
  // бейдж непрочитанных; экран комнаты зовёт её при открытии и когда в
  // открытом чате появляется чужое сообщение (владелец 21.09.2026,
  // LOCK-195). Идемпотентно.
  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/read",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      db.prepare(
        `UPDATE chat_members SET last_read_at = datetime('now')
          WHERE chat_id = ? AND member_id = ?`,
      ).run(req.params.id, req.userId);
      return { ok: true };
    },
  );

  // Залить файл ДО отправки сообщения в чат с ролями. Никакой
  // привязки к конкретному чату на этом шаге нет — точно как у
  // /api/chat/attachments: файл ложится «ничьим» (task_id NULL,
  // comment_id NULL, chat_message_id NULL) и ждёт POST
  // /api/chats/:id/messages с attachment_ids, который его подберёт.
  //
  // Маршрут свой, а не алиас старого: у новых чатов свой префикс
  // /api/chats/*, и тащить веб-клиент к чужому единственному числу
  // ради одного шага — лишняя сущность. Логика — байт-в-байт та же,
  // что у /api/chat/attachments (server/src/routes/chat.ts:850):
  // saveUploadedFile сам проверяет mime, размер и имя; сюда мы
  // передаём только INSERT, чтобы не дублировать валидации.
  app.post<{ Querystring: { name?: string } }>(
    "/api/chats/attachments",
    { preHandler: authPre },
    async (req: any, reply) => {
      try {
        const id = saveUploadedFile(
          {
            body: req.body,
            name: req.query?.name,
            mime: req.headers["content-type"],
          },
          (fields) =>
            db
              .prepare(
                `INSERT INTO attachments
                 (id, task_id, comment_id, chat_message_id, kind, user_id, file_name, mime, size, stored_name)
               VALUES (?, NULL, NULL, NULL, 'comment', ?, ?, ?, ?, ?)`,
              )
              .run(
                fields.id,
                req.userId,
                fields.fileName,
                fields.mime,
                fields.size,
                fields.storedName,
              ),
        );
        return reply.code(201).send({ attachment: attachmentRow(id) });
      } catch (e) {
        if (e instanceof UploadRejected)
          return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    },
  );

  // Идущие сейчас ходы ролей в чате — снимок живого хода (текст, шаги) для
  // того, кто открыл чат посреди ответа или переподключился. Дальше
  // обновления идут событием chats:live.
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/live",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      return { turns: liveTurnsOfChat(req.params.id) };
    },
  );

  // История сообщений чата (по возрастанию времени).
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const messages = db
        .prepare(
          `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
                  f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
                  t.title as task_title
             FROM chat_messages m
             LEFT JOIN users f ON f.id = m.from_user_id
             LEFT JOIN tasks t ON t.id = m.task_id
            WHERE m.chat_id = ? ORDER BY m.created_at ASC, m.rowid ASC`,
        )
        .all(req.params.id);
      return { messages: formatChatHistory(messages) };
    },
  );

  app.post<{Params:{id:string;messageId:string};Body:{emoji?:unknown}}>(
    "/api/chats/:id/messages/:messageId/reaction", {preHandler:authPre}, async (req:any,reply) => {
      if(!isMember(req.params.id,req.userId)) return reply.code(404).send({error:"Чат не найден"});
      const message=db.prepare("SELECT id FROM chat_messages WHERE id=? AND chat_id=?").get(req.params.messageId,req.params.id);
      if(!message) return reply.code(404).send({error:"Сообщение не найдено"});
      const emoji=req.body?.emoji;
      if(emoji!==null && !["👍","❤️","🎉","🤔","👎"].includes(emoji)) return reply.code(400).send({error:"Неизвестная реакция"});
      if(emoji===null) db.prepare("DELETE FROM chat_message_reactions WHERE message_id=? AND user_id=?").run(req.params.messageId,req.userId);
      else db.prepare("INSERT INTO chat_message_reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji").run(req.params.messageId,req.userId,emoji);
      return {message:loadChatMessage(req.params.messageId)};
    });

  // Отметка пункта checklist-виджета (карточка 21842242, владелец 19.10.2026:
  // «Отметки в виджете checklist должны доезжать до роли»). Устроено как
  // реакция на сообщение: клиент шлёт widget_key (id блока или его номер),
  // item_key (id пункта или его номер) и done. Сервер сверяет, что пункт
  // действительно есть в тексте сообщения, и кладёт строку в
  // chat_checklist_items — оттуда её читает роль (taskflow_checklist_state)
  // и видит клиент в истории сообщений (поле checklist_state).
  app.post<{Params:{id:string;messageId:string};Body:{widget_key?:unknown;item_key?:unknown;item_index?:unknown;done?:unknown}}>(
    "/api/chats/:id/messages/:messageId/checklist", {preHandler:authPre}, async (req:any,reply)=> {
      if(!isMember(req.params.id,req.userId)) return reply.code(404).send({error:"Чат не найден"});
      const message=db.prepare("SELECT id,text FROM chat_messages WHERE id=? AND chat_id=?").get(req.params.messageId,req.params.id) as {id:string;text:string}|undefined;
      if(!message) return reply.code(404).send({error:"Сообщение не найдено"});
      const done=req.body?.done;
      if(typeof done!=="boolean") return reply.code(400).send({error:"Нужно done: true или false"});
      const widgetKey=String(req.body?.widget_key??"0").trim()||"0";
      const itemKey=String(req.body?.item_key??req.body?.item_index??"").trim();
      if(!itemKey) return reply.code(400).send({error:"Нужен item_key (id пункта) или item_index (номер пункта)"});
      try{
        setChecklistItem({messageId:message.id,text:message.text,widgetKey,itemKey,done,userId:req.userId});
      }catch(error){
        if(error instanceof ChecklistItemError) return reply.code(400).send({error:error.message});
        throw error;
      }
      return {checklist_state:checklistStateOfMessage(message.id),message:loadChatMessage(message.id)};
    });

  // Состояние отметок чата — то же, что видит роль, для клиента и отладки.
  app.get<{Params:{id:string};Querystring:{only_done?:string}}>(
    "/api/chats/:id/checklist", {preHandler:authPre}, async (req:any,reply)=> {
      if(!isMember(req.params.id,req.userId)) return reply.code(404).send({error:"Чат не найден"});
      const onlyDone=req.query?.only_done==="1"||req.query?.only_done==="true";
      const checklists=checklistStateOfChat(req.params.id);
      return {checklists:onlyDone
        ? checklists.map(m=>({...m,widgets:m.widgets.map(w=>({...w,items:w.items.filter(i=>i.done)}))})).filter(m=>m.widgets.some(w=>w.items.length))
        : checklists};
    });

  // Сообщение в чат. Логика:
  //   1. Сохранить сообщение от пользователя.
  //   2. Определить роль-адресата (@role в тексте, иначе «Авто» через
  //      pickRoleForChat; null = никому, просто кладём сообщение в ленту).
  //   3. Если роль определена: проверить, что участник role_<role> есть в
  //      чате; поставить в очередь на (chat_id, role_id) задачу
  //      deliverAgentReply — она поднимет/продолжит живую сессию Пи через
  //      startChatRun, ответ положит в chat_messages от имени role_<role>
  //      и разошлёт chat:new.
  //
  // Шаг 2 и шаг 3 НЕ блокируют ответ пользователю: мы возвращаем исходное
  // сообщение сразу, а ответ роли придёт отдельным событием chat:new
  // (broadcast внутри try/catch не роняет запрос, даже если Пи упал —
  // пользовательский текст уже в ленте и не потеряется).
  app.post<{Params:{id:string};Body:{execution_mode:unknown}}>("/api/chats/:id/execution-mode", {preHandler:authPre}, async(req:any,reply)=>{
    if (!isMember(req.params.id,req.userId)) return reply.code(404).send({error:"Чат не найден"});
    if (!isOwner(req.userId) || roleFromUserId(req.userId)) return reply.code(403).send({error:"Способ выполнения выбирает владелец"});
    let mode;
    try {mode=parseChatExecutionMode(req.body?.execution_mode);} catch(error) {return reply.code(400).send({error:(error as Error).message});}
    db.prepare("UPDATE chats SET execution_mode=?,updated_at=datetime('now') WHERE id=?").run(mode,req.params.id);
    return {chat:chatRow(req.params.id)};
  });

  app.post<{
    Params: { id: string };
    Body: { execution_mode?: unknown; text?: string; attachment_ids?: string[]; task_id?: string; kind?: string; reply_to_message_id?: string; subtask_id?: string; recipient_subtask_id?: string; work_mode?: ChatWorkMode; model?: string };
  }>(
    "/api/chats/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      if (isDirectRoom(req.params.id) && !db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(req.params.id, req.userId))
        return reply.code(403).send({ error: "Это личная переписка ролей: её можно читать, писать — в личной комнате роли" });
      let mode: ChatWorkMode;
      try { mode = parseChatWorkMode(req.body?.work_mode); }
      catch { return reply.code(400).send({error: "Неизвестный режим работы"}); }
      if (mode !== "work" && roleFromUserId(req.userId)) return reply.code(403).send({error: "Режим выбирает человек"});
      let requestedExecutionMode;
      if (req.body?.execution_mode !== undefined) {
        if (!isOwner(req.userId) || roleFromUserId(req.userId)) return reply.code(403).send({error:"Способ выполнения выбирает владелец"});
        try {requestedExecutionMode=parseChatExecutionMode(req.body.execution_mode);} catch {return reply.code(400).send({error:"Неизвестный способ выполнения"});}
      }
      const text = String(req.body?.text || "").trim();
      // MAK-98 и гейт формата ниже используют отправителя — считаем один раз.
      const senderRole = roleFromUserId(req.userId);
      // ФОРМАТ СООБЩЕНИЯ РОЛИ (карточка cea8d997). Тема задачи — то же место,
      // где пишут роли, поэтому гейт тот же: очевидное сервер заменяет сам
      // (таблица Markdown → блок table), неверный блок роль получает назад
      // с образцом и переписывает. Текст владельца не трогаем: он пишет в чат
      // сам, и молча переписанная его таблица — потеря его слов.
      let storedText = text;
      if (senderRole && text) {
        const formatted = applyRoleFormat(text);
        if (formatted.problems.length) {
          return reply.code(400).send({ error: roleFormatRefusal(formatted), code: "role_format" });
        }
        storedText = formatted.text;
      }
      // Промежуточные сообщения ИИ в чате не валидируем по длине —
      // иначе агент падает на 400 посреди работы (владелец 04.10.2026).
      // Лимит остаётся только для финального ответа роли (см. ниже,
      // truncateAgentText): сообщение в чат всегда доходит, просто короче.
      if (mode === "deep_research" && (!chatMemberRoles(req.params.id).includes("researcher") || parseRoleMentions(text).some(r => r !== "researcher"))) {
        return reply.code(400).send({error: "Глубокое исследование доступно в чате с Исследователем"});
      }
      // Вложения без подписи — то же правило, что в /api/chat: пустой
      // текст ок, когда есть файлы («вот голосовое» без комментария),
      // а пустое совсем, без файлов — 400.
      const attachmentIds: string[] = Array.isArray(req.body?.attachment_ids)
        ? req.body.attachment_ids.filter(
            (id: unknown) => typeof id === "string" && id,
          )
        : [];
      if (!text && attachmentIds.length === 0)
        return reply.code(400).send({ error: "пустое сообщение" });

      const chatId = req.params.id;
      // Привязка к задаче (владелец 21.09.2026: «чтобы не комментарии они там
      // писать в самой задаче, а в чате переписываться»). Сообщение берёт
      // задачу у СВОЕГО чата; явный task_id в теле перекрывает её — этим
      // привязывается отдельное сообщение, когда чат живёт сам по себе.
      const chat = db
        .prepare<[string], { task_id: string | null; parent_chat_id: string | null; closed_at: string | null }>(
          "SELECT task_id, parent_chat_id, closed_at FROM chats WHERE id = ?",
        )
        .get(chatId);
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      // Закрытая тема задачи — read-only: история остаётся, новые сообщения не принимаем.
      if (taskTopicClosedAt(chat)) return reply.code(409).send({ error: "Чат задачи закрыт" });
      // Общий чат: сервер сюда не пишет. Владелец и роль через инструмент — можно.
      try {
        assertCommonChatWritable(
          chatId,
          roleFromUserId(req.userId) ? "role_tool" : "user",
        );
      } catch (error) {
        return reply.code(403).send({ error: error instanceof Error ? error.message : "запись запрещена" });
      }
      const chatTaskId = chat.task_id;
      const taskId =
        typeof req.body?.task_id === "string" && req.body.task_id
          ? req.body.task_id
          : chatTaskId;
      const replyTo = typeof req.body?.reply_to_message_id === "string" ? req.body.reply_to_message_id : null;
      if(replyTo && !db.prepare("SELECT 1 FROM chat_messages WHERE id=? AND chat_id=?").get(replyTo,chatId)) return reply.code(400).send({error:"Исходное сообщение не принадлежит этому чату"});
      if(taskId && !db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId)) return reply.code(404).send({error:"Задача не найдена"});
      const sourceSlot=roleFromUserId(req.userId) && typeof req.body?.subtask_id==="string" ? req.body.subtask_id : null;
      const recipientSlot=typeof req.body?.recipient_subtask_id==="string" ? req.body.recipient_subtask_id : null;
      const inTopicBranch=(stageTask:string)=>stageTask===chatTaskId || (!!chatTaskId && !!branchMembership(chatTaskId) && branchMembership(stageTask)?.root_plan_id===branchMembership(chatTaskId)?.root_plan_id);
      if(sourceSlot){
        const source=db.prepare("SELECT task_id FROM subtasks WHERE id=? AND agent_id=?").get(sourceSlot,req.userId) as {task_id:string}|undefined;
        if(!source || (chat.parent_chat_id && !inTopicBranch(source.task_id)))return reply.code(403).send({error:"Этап твоего хода не закреплён за тобой или относится к другой ветке — сообщение не отправлено. Дальше: проверь taskflow_my_tasks; если этап с тебя сняли — заверши ход и коротко опиши итог в ответе; если этап твой — пиши в тему его ветки (taskflow_topic_send). Повтор того же вызова даст тот же отказ."});
      }
      if(recipientSlot){
        const recipient=db.prepare("SELECT task_id,agent_id FROM subtasks WHERE id=?").get(recipientSlot) as {task_id:string;agent_id:string}|undefined;
        if(!recipient || (chat.parent_chat_id ? !inTopicBranch(recipient.task_id) : !isMember(chatId,recipient.agent_id)))return reply.code(400).send({error:"Этап адресата не относится к согласованной ветке"});
      }
      // MAK-98: быстрый отказ, когда адресата некому исполнить — лучше
      // сказать сразу с кодом причины, чем отправить вопрос в пустоту.
      if (senderRole && recipientSlot && chat.parent_chat_id) {
        const availability = evaluateRecipientAvailability({
          recipientSubtaskId: recipientSlot,
        });
        if (!availability.ok) {
          return reply
            .code(409)
            .send({ error: availability.error, code: availability.code });
        }
      }
      const parentMessage=typeof req.body?.coordination_parent_message_id==="string" ? req.body.coordination_parent_message_id : replyTo;
      let coordinationHop=0;
      if(senderRole && parentMessage){
        const parent=db.prepare("SELECT q.payload_json,q.status,m.chat_id FROM chat_message_queue q JOIN chat_messages m ON m.id=q.message_id WHERE q.message_id=? AND q.role_id=?").get(parentMessage,req.userId) as {payload_json:string;status:string;chat_id:string}|undefined;
        if(parent){
          if(parent.status==="superseded" || !isMember(parent.chat_id,req.userId))return reply.code(409).send({error:"Исходная переписка больше недоступна"});
          coordinationHop=Number(JSON.parse(parent.payload_json).hop??0)+1;
        }
      }
      if(coordinationHop>MAX_AGENT_HOPS)return reply.code(409).send({error:"Лимит цепочки вопросов коллегам достигнут; продолжи работу или зафиксируй препятствие"});
      const outstanding=replyTo ? db.prepare("SELECT id,session_generation,status,payload_json FROM chat_message_queue WHERE message_id=? AND role_id=? AND chat_id=?").get(replyTo,req.userId,chatId) as {id:string;session_generation:number;status:string;payload_json:string}|undefined : undefined;
      const addressedSlot=outstanding ? JSON.parse(outstanding.payload_json).subtaskId ?? (replyTo ? (db.prepare("SELECT recipient_subtask_id FROM chat_messages WHERE id=?").get(replyTo) as {recipient_subtask_id:string|null}|undefined)?.recipient_subtask_id : null) : null;
      if(outstanding && addressedSlot && sourceSlot && addressedSlot!==sourceSlot)return reply.code(403).send({error:"Ответ должен исходить из адресованного этапа"});
      if(outstanding && (outstanding.status==="superseded" || fenceDeliveryIfStale(outstanding.id,outstanding.session_generation)))return reply.code(409).send({error:"Вопрос относится к предыдущему поколению сессии"});
      const id = uid();
      const sourceMessage = senderRole && parentMessage ? db.prepare("SELECT chat_id FROM chat_messages WHERE id=?").get(parentMessage) as {chat_id:string}|undefined : undefined;
      const executionMode = senderRole
        ? sourceSlot ? "card" : sourceMessage && isMember(sourceMessage.chat_id,req.userId) ? chatExecutionMode(sourceMessage.chat_id,parentMessage) : "chat"
        : isOwner(req.userId) && isCardHandoffCommand(text) ? "card" : requestedExecutionMode ?? chatExecutionMode(chatId);
      db.transaction(()=>{
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, work_mode,model,message_type,reply_to_message_id,subtask_id,recipient_subtask_id)
         VALUES (?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, req.userId, storedText, chatId, taskId, mode === "goal" ? "work" : mode, chatModelChoice(req.body?.model),req.body?.kind==="task_proposal"&&taskId?"task_proposal":null,replyTo,sourceSlot,recipientSlot);
      db.prepare("UPDATE chat_messages SET execution_mode=? WHERE id=?").run(executionMode,id);
      if(outstanding && ["pending","picked"].includes(outstanding.status)){
        pickDurableDelivery(outstanding.id);completeDurableDelivery(outstanding.id,true);
        db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id IN (SELECT id FROM subtasks WHERE agent_id=?)").run(replyTo,req.userId);
      }
      })();
      db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(
        chatId,
      );

      // Файлы залиты заранее и лежат «ничьими» (chat_message_id = NULL,
      // task_id = NULL) — здесь их подбирает отправленное сообщение.
      // Берём только свои и только ещё не подобранные: чужое вложение к
      // своему сообщению не привяжется, даже если знать его
      // идентификатор. UPDATE, а не проверка через SELECT — ник заранее
      // не знает, какие из переданных id реально «ничейные», а лишний
      // SELECT ради этого был бы лишним раундом в БД.
      if (attachmentIds.length) {
        const attach = db.prepare(
          `UPDATE attachments SET chat_message_id = ?
             WHERE id = ? AND user_id = ?
               AND chat_message_id IS NULL AND task_id IS NULL`,
        );
        for (const attId of attachmentIds) attach.run(id, attId, req.userId);
      }

      if(senderRole && parentMessage && !outstanding)traceCoordination(()=>registerCoordinationOrigin(id,parentMessage,req.userId));
      const message = loadChatMessage(id);
      // Владелец написал в чат задачи — будим её план: готовые шаги стартуют, замолчавшие
      // перезапускаются той же ролью (runtime/taskNudge.ts). Ответ на сообщение этим не задерживаем.
      if (executionMode === "card" && chatTaskId && chat.parent_chat_id && isOwner(req.userId)) {
        void nudgeTaskPlan(chatTaskId, req.userId).catch((error) => req.log?.warn?.({ err: error, taskId: chatTaskId }, "не удалось разбудить план задачи"));
      }

      // MAK-98: вопрос роли берём под срок жизни, ответ — снимаем с учёта.
      try {
        if (replyTo) answerRoleQuestionsBy(chatId, req.userId, replyTo);
        else if (senderRole) answerRoleQuestionsBy(chatId, req.userId, null);
        if (senderRole && recipientSlot) {
            const toUserId = recipientUserIdFor(recipientSlot);
            if (toUserId) {
              openRoleQuestion({
                messageId: id,
                chatId,
                taskId,
                fromUserId: req.userId,
                toUserId,
                subtaskId: sourceSlot,
                recipientSubtaskId: recipientSlot,
                text,
              });
            }
          }
      } catch (error) {
        console.warn(
          `[chats] учёт вопроса роли не сработал для ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }

      const audience = memberIds(chatId).filter((m) => m !== req.userId && isMember(chatId,m));
      broadcastToUsers([...audience, req.userId], {
        type: "chat:new",
        message,
      });

      // Свод ветки в основной чат (22.10.2026): ветка — отдельный поток, но
      // владельцу не нужно заглядывать в каждую. Ответ роли в ветке одной
      // строкой возвращается в комнату, из которой ветку открыли.
      try {
        if (senderRole) mirrorBranchResult(chatId, roleFromUserId(req.userId), storedText);
        if (senderRole) {
          const parentBranch = db.prepare("SELECT branch_of_chat_id FROM chats WHERE id = ?").get(chatId) as { branch_of_chat_id: string | null } | undefined;
          const roleId = roleAccountId(roleFromUserId(req.userId) ?? "builder");
          if (parentBranch?.branch_of_chat_id && roleId) postRoomSummaryIfAllBranchesAnswered(parentBranch.branch_of_chat_id, roleId);
        }
      } catch (error) {
        console.warn(`[chats] свод ветки в основной чат не удался:`, error instanceof Error ? error.message : error);
      }

      // Ветка на каждое сообщение владельца (22.10.2026): «принял — открыл
      // ветку — работаю там». Основная комната остаётся разговором, каждая
      // просьба живёт отдельным потоком и не ждёт конца чужого хода.
      let handledByBranch = false;
      try {
        handledByBranch = await fanOutOwnerMessage({
          chatId,
          messageId: id,
          text,
          fromUserId: req.userId,
          mode,
          hop: coordinationHop,
        });
      } catch (error) {
        console.warn(
          `[chats] ветка по сообщению ${id} не создалась:`,
          error instanceof Error ? error.message : error,
        );
      }

      // Новое сообщение владельца останавливает текущий ход роли: отвечать
      // надо на новое, а не доканчивать старое (владелец 23.10.2026).
      if (!handledByBranch && isOwner(req.userId) && !chatTaskId && !chat.parent_chat_id) {
        try {
          const stopped = await interruptChatTurnForOwner(chatId, req.userId);
          // В чате пауза не нужна (владелец 23.10.2026: схема с паузой и
          // веткой-срезом — только для режима задачи): ход просто
          // останавливается, роль отвечает здесь же на новое сообщение.
          if (stopped) console.log(`[chats] ход остановлен новым сообщением владельца chat=${chatId}`);
        } catch (error) {
          console.warn(`[chats] остановка хода не удалась chat=${chatId}:`, error instanceof Error ? error.message : error);
        }
      }

      // Этап 2: авто-ответ ролей. «Best effort»: ошибки НЕ откатывают уже
      // сохранённое сообщение и не роняют запрос — пользователь уже видит
      // своё сообщение в ленте.
      //
      // Помощник владельца (владелец 25.09.2026, docs/ПЛАН Супер Помощник владельца/) —
      // отдельная ветка: у него нет users.role_key. Его ходы тоже идут
      // через очередь: раньше второе сообщение подряд попадало на занятый
      // лок и молча терялось.
      try {
        if (!handledByBranch) await dispatchRoleReplies({
          chatId,
          messageId: id,
          fromUserId: req.userId,
          text,
          hop: coordinationHop,
          mode,
          idempotencyKey: readIdempotencyKey(req),
        });
      } catch (error) {
        console.warn(
          `[chats] постановка авто-ответа не удалась для chat=${chatId}:`,
          error instanceof Error ? error.message : error,
        );
      }

      return { message };
    },
  );

  // Удалить сообщения чата. Два режима, оба входят из меню «…» комнаты
  // (владелец 21.09.2026: «нажать троеточие и либо удалить все, либо выбрать
  // отдельные сообщения и потом удалить их»):
  //   • без `ids` — очистить чат целиком, только создатель;
  //   • с `ids` — удалить выбранные. Создателю можно любые, остальным — только
  //     свои. Если в выборке есть чужое, не удаляем НИЧЕГО и отвечаем 403:
  //     молчаливое частичное удаление хуже отказа — человек не поймёт, почему
  //     часть выбранного осталась.
  //
  // Вложения отвязываются, чтобы не висели на удалённых строках; сами файлы на
  // диске не трогаем — чистка осиротевших файлов отдельная и общая для всех
  // вложений.
  //
  // `updated_at` чата пересчитывается по самому свежему из ОСТАВШИХСЯ
  // сообщений: список чатов сортируется и показывает превью по нему, и без
  // пересчёта удаление последнего сообщения оставляло бы в строке списка то,
  // чего в чате уже нет.
  app.delete<{ Params: { id: string }; Querystring: { ids?: string } }>(
    "/api/chats/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });

      const ids = String(req.query?.ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const chat = db
        .prepare("SELECT created_by FROM chats WHERE id = ?")
        .get(req.params.id) as { created_by: string } | undefined;
      const isCreator = chat?.created_by === req.userId;

      let targets: Array<{ id: string; from_user_id: string }>;
      if (ids.length === 0) {
        if (!isCreator)
          return reply.code(403).send({ error: "очистить чат может создатель" });
        targets = db
          .prepare("SELECT id, from_user_id FROM chat_messages WHERE chat_id = ?")
          .all(req.params.id) as Array<{ id: string; from_user_id: string }>;
      } else {
        const placeholders = ids.map(() => "?").join(",");
        targets = db
          .prepare(
            `SELECT id, from_user_id FROM chat_messages
              WHERE chat_id = ? AND id IN (${placeholders})`,
          )
          .all(req.params.id, ...ids) as Array<{
          id: string;
          from_user_id: string;
        }>;
        if (targets.length !== ids.length)
          return reply.code(404).send({ error: "часть сообщений не найдена" });
        if (!isCreator && targets.some((m) => m.from_user_id !== req.userId))
          return reply.code(403).send({ error: "удалить можно свои сообщения" });
      }

      const remove = db.prepare("DELETE FROM chat_messages WHERE id = ?");
      const detach = db.prepare(
        "UPDATE attachments SET chat_message_id = NULL WHERE chat_message_id = ?",
      );
      const txn = db.transaction(() => {
        for (const message of targets) {
          detach.run(message.id);
          remove.run(message.id);
        }
        db.prepare(
          `UPDATE chats SET updated_at = COALESCE(
             (SELECT created_at FROM chat_messages
               WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1),
             updated_at)
            WHERE id = ?`,
        ).run(req.params.id, req.params.id);
      });
      txn();

      return { deleted: targets.length };
    },
  );

  // Рабочие чек-листы ролей в чате (21.10.2026): полоска над полем ввода.
  app.get<{ Params: { id: string } }>("/api/chats/:id/work-plans", { preHandler: authPre }, async (req: any, reply) => {
    if (!isMember(req.params.id, req.userId)) return reply.code(404).send({ error: "Чат не найден" });
    // Выполненный целиком план закрыт — полоска его не показывает.
    return { plans: readChatWorkPlans(req.params.id).filter((p) => p.items.length && !isWorkPlanFinished(p.items)) };
  });
  app.get<{ Params: { id: string } }>("/api/chats/:id/work-plan", { preHandler: authPre }, async (req: any, reply) => {
    if (!isMember(req.params.id, req.userId)) return reply.code(404).send({ error: "Чат не найден" });
    return readChatWorkPlan(req.params.id, req.userId) ?? { chat_id: req.params.id, role_id: req.userId, revision: 0, items: [] };
  });
  // Пишет только сама роль — участник чата, и только свой план.
  app.put<{ Params: { id: string }; Body: { base_revision?: unknown; items?: unknown } }>("/api/chats/:id/work-plan", { preHandler: authPre }, async (req: any, reply) => {
    const chatId = req.params.id;
    if (!roleFromUserId(req.userId)) return reply.code(403).send({ error: "Чек-лист ведёт роль" });
    if (!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(chatId, req.userId))
      return reply.code(404).send({ error: "Чат не найден" });
    let items;
    try { items = validateWorkPlan(req.body?.items); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Неверный план" }); }
    const base = Number(req.body?.base_revision ?? 0);
    try {
      const plan = saveChatWorkPlan(chatId, req.userId, Number.isFinite(base) ? base : 0, items);
      broadcastToUsers(memberIds(chatId).concat(ownerIdsForChat(chatId)), { type: "chat:work_plan", chat_id: chatId, plan });
      return plan;
    } catch (error) {
      if (error instanceof Error && error.message === "revision_conflict")
        return reply.code(409).send({ error: "План уже обновлён: прочитай его заново и возьми свежий revision", current: readChatWorkPlan(chatId, req.userId) });
      throw error;
    }
  });

  // Новая сессия без удаления истории (владелец 25.09.2026, docs/ПЛАН
  // Супер Помощник владельца/): сбрасывает pi_session_id роли в этом чате — агент
  // следующим сообщением поднимет разговор с нуля, сама лента остаётся
  // нетронутой. В ленту кладётся видимая метка-разделитель.
  app.post<{ Params: { id: string }; Body: { role_id?: string } }>(
    "/api/chats/:id/new-session",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chatId = req.params.id;
      if (!isMember(chatId, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      if (taskTopicClosedAt(db.prepare("SELECT task_id, parent_chat_id, closed_at FROM chats WHERE id = ?").get(chatId) as any))
        return reply.code(409).send({ error: "Чат задачи закрыт" });
      const roleId = typeof req.body?.role_id === "string" ? req.body.role_id : "";
      if (!roleId) return reply.code(400).send({ error: "role_id обязателен" });
      if (!isMember(chatId, roleId))
        return reply.code(400).send({ error: "role_id не участник этого чата" });
      // Общий чат: маркер новой сессии — служебная запись серверного пути, а
      // не команда роли через её инструмент. Инвариант п. 3: сюда такое не
      // пишем (карточка ca816271).
      try {
        assertCommonChatWritable(chatId, "system");
      } catch (error) {
        return reply
          .code(403)
          .send({ error: error instanceof Error ? error.message : "запись запрещена" });
      }

      db.prepare("DELETE FROM chat_sessions WHERE chat_id = ? AND role_id = ?").run(
        chatId,
        roleId,
      );
      clearChatWorkPlan(chatId, roleId);
      broadcastToUsers(memberIds(chatId).concat(ownerIdsForChat(chatId)), { type: "chat:work_plan", chat_id: chatId, plan: { chat_id: chatId, role_id: roleId, revision: 0, items: [] } });

      // Карточка ebc4d338: fence ответа от старой сессии. Любые
      // pending в chat_message_queue со старым generation уходят в
      // superseded — поздний ответ прежней Pi-сессии НЕ попадёт в
      // новую. Это критично, когда в чате висит ответ старой
      // модели и пользователь нажал «новая сессия».
      bumpChatGeneration({ chatId, roleId, reason: "owner_new_session" });

      const id = uid();
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, is_session_marker)
         VALUES (?, ?, 'Новая сессия', 'chat', ?, 1)`,
      ).run(id, roleId, chatId);
      db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);

      const message = loadChatMessage(id);
      broadcastToUsers(memberIds(chatId), { type: "chat:new", message });
      return { message };
    },
  );

  // «Сжать» (владелец 20.10.2026): принудительно сжать сессию роли в этом
  // чате — то же сжатие, что Pi делает сам при переполнении, но по кнопке.
  // Лента не трогается; роль продолжит ту же сессию, только короче.
  app.post<{ Params: { id: string }; Body: { role_id?: string } }>(
    "/api/chats/:id/compact",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chatId = req.params.id;
      if (!isMember(chatId, req.userId)) return reply.code(404).send({ error: "Чат не найден" });
      if (roleFromUserId(req.userId)) return reply.code(403).send({ error: "Сжатие выбирает человек" });
      const roleId = typeof req.body?.role_id === "string" ? req.body.role_id : "";
      const role = roleFromUserId(roleId);
      if (!role || !isMember(chatId, roleId)) return reply.code(400).send({ error: "role_id не участник этого чата" });
      if (externalRuntime(role)) return reply.code(400).send({ error: "Внешний агент сжимает сессию сам" });
      const saved = db.prepare("SELECT pi_session_id FROM chat_sessions WHERE chat_id = ? AND role_id = ?").get(chatId, roleId) as { pi_session_id: string } | undefined;
      if (!saved) return reply.code(409).send({ error: "Сессии ещё нет — сжимать нечего" });
      try {
        await startChatRun({ chatId, role, roleId, prompt: "", sessionId: saved.pi_session_id, compactOnly: true });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "CHAT_RUN_BUSY") return reply.code(409).send({ error: "Роль сейчас отвечает — сожмите после ответа" });
        return reply.code(500).send({ error: error instanceof Error ? error.message : "Сжатие не удалось" });
      }
      return { ok: true };
    },
  );

  app.post<{Params:{id:string;messageId:string}}>(
    "/api/chats/:id/coordination/:messageId/stop",{preHandler:authPre},async(req:any,reply)=>{
      if(!isMember(req.params.id,req.userId))return reply.code(404).send({error:"Чат не найден"});
      const row=db.prepare("SELECT steps FROM chat_messages WHERE id=? AND chat_id=?").get(req.params.messageId,req.params.id) as {steps:string}|undefined;
      const c=row?coordinationCardData(row):undefined;
      if(!c)return reply.code(404).send({error:"Обращение не найдено"});
      const origin=db.prepare("SELECT from_user_id FROM chat_messages WHERE id=?").get(c.origin_message_id) as {from_user_id:string}|undefined;
      if(!isOwner(req.userId) && origin?.from_user_id!==req.userId)return reply.code(403).send({error:"Остановить может автор вопроса или владелец"});
      if(c.terminal)return {stopped:0};
      const q=db.prepare("SELECT id,status FROM chat_message_queue WHERE message_id=? AND role_id=?").get(c.question_id,c.recipient_id) as {id:string;status:string}|undefined;
      const live=liveTurnsOfChat(c.child_chat_id).find(t=>t.user_id===c.recipient_id && t.trigger_message_id===c.question_id);
      if(!q || (q.status==="done" && !live))return reply.code(409).send({error:"Вопрос уже передан в рабочую сессию. Остановить только это обращение отдельно от работы нельзя."});
      db.prepare("UPDATE chat_message_queue SET status='superseded',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','picked')").run(q.id);
      if(live){await cancelChatRunsFor(c.child_chat_id,c.recipient_id);await cancelSlotConversationsFor(c.child_chat_id,c.recipient_id);}
      updateCoordination(c.question_id,c.recipient_id,{status:"cancelled",activity:"Обращение остановлено",terminal:true,last_activity_at:new Date().toISOString()});
      return {stopped:1};
    });

  // Остановить ход роли (кнопка «Остановить» в окне чата). Без role_id —
  // все идущие ходы этого чата. Написанное ролью до остановки ложится в
  // чат обычным ответом — остановка не стирает сделанное.
  app.post<{ Params: { id: string }; Body: { role_id?: string } }>(
    "/api/chats/:id/stop",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chatId = req.params.id;
      if (!isMember(chatId, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const roleId =
        typeof req.body?.role_id === "string" && req.body.role_id ? req.body.role_id : undefined;
      const stopped = await cancelChatRunsFor(chatId, roleId) + await cancelSlotConversationsFor(chatId,roleId);
      return { stopped };
    },
  );

  // Добавить участника (создатель чата).
  app.post<{ Params: { id: string }; Body: { member_id?: string } }>(
    "/api/chats/:id/members",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
        | { created_by: string }
        | undefined;
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "менять участников может создатель чата" });
      const memberId = String(req.body?.member_id || "").trim();
      if (!memberId) return reply.code(400).send({ error: "нужен member_id" });
      if (
        !db
          .prepare(
            "SELECT id FROM users WHERE id = ? AND COALESCE(archived, 0) = 0",
          )
          .get(memberId)
      )
        return reply.code(400).send({ error: "нет такого участника" });
      // Новичок не должен получить бейдж на всю историю до его появления:
      // отметка прочтения ставится на момент добавления (миграция 055).
      db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO chat_members (chat_id, member_id, last_read_at)
           VALUES (?, ?, datetime('now'))`,
        ).run(req.params.id, memberId);
        syncChatKindFromMembers(req.params.id);
      })();
      return { chat: chatRow(req.params.id) };
    },
  );

  // Убрать участника (создатель чата; себя убрать нельзя).
  app.delete<{ Params: { id: string; memberId: string } }>(
    "/api/chats/:id/members/:memberId",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
        | { created_by: string }
        | undefined;
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "менять участников может создатель чата" });
      if (req.params.memberId === req.userId)
        return reply.code(400).send({ error: "себя из чата не убрать" });
      db.transaction(() => {
        db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND member_id = ?").run(
          req.params.id,
          req.params.memberId,
        );
        syncChatKindFromMembers(req.params.id);
      })();
      return { chat: chatRow(req.params.id) };
    },
  );

  // Убрать чат = архивировать (карточка 0b7a8b81…, 21.10.2026). Строки НЕ
  // стираются: чат получает closed_at (уходит из общего списка, новые
  // сообщения не принимаются) и archived_at (отметка уборки, её не снимает
  // возврат задачи в работу). История, счётчики и статистика по задачам
  // остаются в базе.
  //
  // Право: системные комнаты — темы задач — убирает любой участник проекта
  // (создатель у них один на весь проект, проверка «только создатель» была
  // неприменима); личные и групповые переписки (dm, personal, handoff, wake)
  // — только их создатель.
  const archiveChatRoute = async (req: any, reply: any) => {
    const chat = chatRoomRow(req.params.id);
    if (!chat) return reply.code(404).send({ error: "Чат не найден" });
    if (!isMember(chat.id, req.userId))
      return reply.code(404).send({ error: "Чат не найден" });
    const right = archiveRight(chat, req.userId);
    if (!right.allowed) return reply.code(403).send({ error: right.reason });
    // Тема карточки, которая сейчас в работе, — рабочее место роли: её
    // никто не убирает, пока карточка не отдана (дефект D1).
    if (isTaskTopic(chat) && !canArchiveTaskTopic(chat.task_id))
      return reply.code(409).send({ error: "Чат задачи в работе убрать нельзя" });
    archiveChat(chat.id);
    return { ok: true, archived: true, chat: chatRow(chat.id) };
  };

  app.delete<{ Params: { id: string } }>(
    "/api/chats/:id",
    { preHandler: authPre },
    archiveChatRoute,
  );

  // То же действие другим методом: DELETE в TaskFlow закрыт для
  // делегированных ролей (auth.ts), а тему задачи убирать вправе участник
  // проекта — в том числе роль.
  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/archive",
    { preHandler: authPre },
    archiveChatRoute,
  );

  // Уборка лишних чатов (карточка 0b7a8b81…). Кандидаты — пустые темы
  // задач: без сообщений, без строк в очереди доставки, не тронутые два
  // часа, без живых попыток. Личные и групповые переписки в кандидаты не
  // попадают никогда.
  //
  // Два шага: сначала предпросмотр (сколько и какие), потом сама уборка —
  // и только после подтверждения (confirm: true в теле запроса).
  app.get("/api/chats/cleanup/candidates", { preHandler: authPre }, async (req: any, reply) => {
    if (!isOwner(req.userId) && roleFromUserId(req.userId) !== "code_orchestrator")
      return reply.code(403).send({ error: "Уборку запускает владелец" });
    const chats = cleanupCandidates();
    return { count: chats.length, chats };
  });

  app.post("/api/chats/cleanup", { preHandler: authPre }, async (req: any, reply) => {
    if (!isOwner(req.userId) && roleFromUserId(req.userId) !== "code_orchestrator")
      return reply.code(403).send({ error: "Уборку запускает владелец" });
    // Без подтверждения уборки не делаем: сначала человек должен увидеть
    // список и количество.
    if (req.body?.confirm !== true)
      return reply.code(400).send({ error: "Нужно подтверждение уборки" });
    const archived = runCleanup();
    return { archived: archived.length, chats: archived };
  });
}

// ===== Помощники онлайн-сессии (этап 2) =====

// Живой список: роли добавляются и отключаются без перезапуска.
const VALID_ROLES = { has: (role: string) => ROLE_NAMES.includes(role) };

/** Роли, которые реально есть среди участников чата. id вроде role_*
 *  считаются ролевыми, остальные id (владелец, гость) — нет. */
function chatMemberRoles(chatId: string): RoleName[] {
  const memberList = memberIds(chatId);
  const result: RoleName[] = [];
  for (const id of memberList) {
    const role = roleFromUserId(id);
    if (role && isMember(chatId,id)) result.push(role);
  }
  return result;
}

function roleFromUserId(userId: string): RoleName | null {
  const row = db
    .prepare("SELECT role, role_key, type FROM users WHERE id = ?")
    .get(userId) as
    | { role: string | null; role_key: string | null; type: string | null }
    | undefined;
  if (!row) return null;
  if (row.type !== "ai" || row.role !== "agent") return null;
  if (!row.role_key || !VALID_ROLES.has(row.role_key as RoleName)) return null;
  return row.role_key as RoleName;
}

/** Прочитать Idempotency-Key из HTTP-заголовков. HTTP-стандарт — `Idempotency-Key`,
 *  наш внутренний псевдоним — `x-delivery-id`. Приоритет у HTTP-стандарта;
 *  если заданы оба — берём `Idempotency-Key`. Возвращаем null, если оба
 *  пустые или заданы не как непустые строки. Клиент контролирует дедуп:
 *  повторная отправка с тем же ключом даст ровно одну доставку и один
 *  ответ, даже если `message_id` у двух запросов разные (важно для
 *  случая «упала сеть ДО того, как message_id вернулся в ответ»). */
export function readIdempotencyKey(req: { headers: Record<string, unknown> }): string | null {
  const headers = req.headers ?? {};
  const candidates: string[] = [];
  const idem = headers["idempotency-key"];
  if (typeof idem === "string" && idem.trim()) candidates.push(idem.trim());
  const xDelivery = headers["x-delivery-id"];
  if (typeof xDelivery === "string" && xDelivery.trim()) candidates.push(xDelivery.trim());
  return candidates[0] ?? null;
}

/** Проверить, не устарел ли ход по поколению; если устарел — поставить fence.
 *  Возвращаем true, если запись была fence-нута (т.е. дальше её брать в
 *  работу не надо). Используется в двух точках: до постановки в in-memory
 *  очередь (холодный fence) и после Pi-ответа (горячий fence — пока
 *  готовили, generation уже могла уехать через `/new-session`). */
export function fenceDeliveryIfStale(deliveryId: string, expectedGeneration: number): boolean {
  const row = db
    .prepare(
      `SELECT chat_id, role_id FROM chat_message_queue WHERE id = ?`,
    )
    .get(deliveryId) as
    | { chat_id: string; role_id: string }
    | undefined;
  if (!row) return false;
  const currentGen = currentChatGeneration(row.chat_id, row.role_id);
  if (currentGen <= expectedGeneration) return false;
  // pending или picked — fence-им обоих (chatQueue.fenceMessageDelivery это умеет).
  fenceMessageDelivery(deliveryId);
  return true;
}

/** Восстановление pending хода после рестарта процесса. Делает ТО ЖЕ,
 *  что живой маршрут: FIFO admission, fence если поколение уже не то,
 *  реальный Pi-вызов через deliverAgentReply, finally-close с разделением
 *  success/failure. Возвращает `replyId` сохранённого ответа либо null,
 *  если ход был fenced, Pi не выполнился, или роль дала сбой. */
class MessageForwardedToWork extends Error {
  constructor(readonly busy:boolean){super("Message forwarded to existing work");}
}
function retainForwardedDelivery(deliveryId:string):void {
  db.prepare("UPDATE chat_message_queue SET status='pending',picked_at=NULL,updated_at=datetime('now') WHERE id=? AND status='picked'").run(deliveryId);
}

const recoveringDeliveries = new Set<string>();
export async function recoverAgentDelivery(
  input: Parameters<typeof recoverAgentDeliveryOnce>[0],
): ReturnType<typeof recoverAgentDeliveryOnce> {
  if (recoveringDeliveries.has(input.deliveryId)) return {status:"skipped",replyId:null};
  // Reserve before any await without claiming that a queued delivery is executing.
  recoveringDeliveries.add(input.deliveryId);
  try { return await recoverAgentDeliveryOnce(input); }
  finally { recoveringDeliveries.delete(input.deliveryId); }
}

async function recoverAgentDeliveryOnce(input: {
  chatId: string;
  roleId: string;
  deliveryId: string;
}): Promise<{ status: "done" | "failed" | "fenced" | "skipped"; replyId: string | null }> {
  const { chatId, roleId, deliveryId } = input;
  const row = db
    .prepare(
      `SELECT message_id, session_generation, status, payload_json FROM chat_message_queue
         WHERE id = ? AND chat_id = ? AND role_id = ?`,
    )
    .get(deliveryId, chatId, roleId) as
    | { message_id: string | null; session_generation: number; status: string; payload_json:string }
    | undefined;
  if (!row) return { status: "skipped", replyId: null };
  if (row.status === "done" || row.status === "superseded" || row.status === "failed") {
    return { status: "skipped", replyId: null };
  }
  // Fence: generation уже другая — не делаем Pi.
  const currentGen = currentChatGeneration(chatId, roleId);
  if (currentGen > row.session_generation) {
    fenceMessageDelivery(deliveryId);
    return { status: "fenced", replyId: null };
  }
  // message_id обязателен: без триггерного сообщения в БД Pi-вызов
  // нечего формировать.
  if (!row.message_id) {
    fenceMessageDelivery(deliveryId);
    return { status: "fenced", replyId: null };
  }
  if(isIntegrationHandoff(row.message_id) && !integrationHandoffContext(row.message_id,roleId)){
    fenceMessageDelivery(deliveryId);return {status:"fenced",replyId:null};
  }
  const role = roleFromUserId(roleId);
  if (!role) {
    // Роль убрали из чата (или переименовали) — fence, а не
    // вечный picked. Нечего отвечать, отправитель не существует.
    fenceMessageDelivery(deliveryId);
    return { status: "fenced", replyId: null };
  }
  if(!isMember(chatId,roleId)){fenceMessageDelivery(deliveryId);return {status:"fenced",replyId:null};}
  const trigger=db.prepare("SELECT text,recipient_subtask_id FROM chat_messages WHERE id=?").get(row.message_id) as {text:string;recipient_subtask_id:string|null}|undefined;
  const saved=JSON.parse(row.payload_json);
  const integrationText=integrationHandoffContext(row.message_id,roleId);
  const recipientSlot=saved.subtaskId ?? trigger?.recipient_subtask_id ?? undefined;
  const topic=chatExecutionMode(chatId,row.message_id) === "card" ? db.prepare("SELECT task_id FROM chats WHERE id=? AND parent_chat_id IS NOT NULL").get(chatId) as {task_id:string}|undefined : undefined;
  const slot=topic && trigger ? resolveTopicSlot(topic.task_id,role,topicSlotKey(trigger.text),recipientSlot) : null;
  const chatOnly=row.message_id.startsWith("review-return:") && saved.chatOnly===true;
  const activeDelivery=chatOnly || chatExecutionMode(chatId,row.message_id) === "chat" ? "idle" : slot ? await deliverTopicToWork(slot.task_id,role,row.message_id,trigger!.text,slot.plan_node_key)
    : trigger ? await deliverChatToWork(role,chatId,row.message_id,integrationText ? integrationText+"\n"+trigger.text : trigger.text,recipientSlot) : "idle";
  if(activeDelivery!=="idle"){
    if(activeDelivery==="busy"){
      if(isIntegrationHandoff(row.message_id))retainForwardedDelivery(deliveryId);
      messengerAmbiguityNotice(chatId,roleId,row.message_id);
    }
    return {status:"skipped",replyId:null};
  }
  // Уже «в работе» (picked) — второй раз не дёргаем Pi,
  // иначе получим второй ответ. Recovery-sweep вызывается
  // ДО того, как живые маршруты начали обрабатывать
  // новые ходы; in-memory очередь пересоздана, поэтому
  // pick ещё не выставлялся. Если всё же picked — пишем
  // диагностику и пропускаем: пусть висит, дожмёт другой
  // гонщик при следующем старте.
  if (row.status === "picked") {
    return { status: "skipped", replyId: null };
  }
  // FIFO owns admission: pending while waiting, picked only during execution.
  let replyId: string | null = null;
  try {
    replyId = await enqueueChatReply(chatId, roleId, () =>
      deliverAgentReply({
        chatId,
        role,
        triggerMessageId: row.message_id!,
        subtaskId:recipientSlot,
        hop: saved.hop ?? 0,
        mode: saved.mode,
        chatOnly,
      }),
      {deliveryId},
    );
    // Двойная проверка fence: пока готовили ответ, generation
    // могла уехать. Тогда закрываем как superseded и не светится
    // как success.
    if (fenceDeliveryIfStale(deliveryId, row.session_generation)) {
      return { status: "fenced", replyId: null };
    }
    // Pi не выдал ответа — ход закрываем как failed, чтобы
    // он не висел picked-вечно.
    const ok = replyId !== null;
    completeDurableDelivery(deliveryId, ok);
    return { status: ok ? "done" : "failed", replyId };
  } catch (error) {
    if(error instanceof MessageForwardedToWork){retainForwardedDelivery(deliveryId);if(error.busy)messengerAmbiguityNotice(chatId,roleId,row.message_id!);return {status:"skipped",replyId:null};}
    console.warn(
      `[chats] recovery ход ${deliveryId} chat=${chatId} role=${role} не закрыт успешно:`,
      error instanceof Error ? error.message : error,
    );
    completeDurableDelivery(deliveryId, false);
    return { status: "failed", replyId: null };
  }
}

/** Распарсить явное @упоминание роли в тексте. Возвращает первую
 *  валидную роль в нижнем регистре, игнорируя прочие токены.
 *
 *  B4 (замечание Гермеса 21.09.2026): ранний разбор /\B@(\w+)/g ловил
 *  «ложные» упоминания в e-mail и URL — например, в тексте
 *  «напиши на support@acme.com» роль @acme считалась упомянутой.
 *  Теперь матчинг требует ГРАНИЦЫ СЛОВА слева: перед @ должна быть
 *  либо пустая строка, либо знак препинания/пробел. Это убирает
 *  матчи внутри e-mail/URL и оставляет чистую разметку
 *  «... @роль ...» в любой точке текста. */
function parseRoleMention(text: string): RoleName | null {
  // (?<![\p{L}\p{N}_]) — «перед @ не должно быть буквы/цифры/_».
  // Используем Unicode-классы, чтобы ловить кириллицу тоже — на случай,
  // если в будущем имена ролей на русском; сейчас они латиницей, но
  // правило не зависит от языка исходного текста.
  const matches = text.toLowerCase().matchAll(
    /(?<![\p{L}\p{N}_])@([a-z_][a-z0-9_]*)/gu,
  );
  for (const m of matches) {
    const candidate = m[1];
    if (VALID_ROLES.has(candidate as RoleName)) {
      return candidate as RoleName;
    }
  }
  // Телефон подставляет имя участника, как его видит человек: «@Разработчик»,
  // «@Дизайнер интерфейсов» (22.09.2026). Имена берём из учёток ролей;
  // длинные проверяем первыми, чтобы составное имя не перехватило короткое.
  const lower = text.toLowerCase();
  const named = [...ROLE_NAMES]
    .map((role) => ({
      role,
      name: (
        (db.prepare("SELECT name FROM users WHERE role_key = ?").get(role) as
          | { name?: string }
          | undefined)?.name ?? ""
      ).toLowerCase(),
    }))
    .filter((r) => r.name)
    .sort((a, b) => b.name.length - a.name.length);
  for (const r of named) {
    const at = lower.indexOf(`@${r.name}`);
    if (at < 0) continue;
    const before = at > 0 ? lower[at - 1] : "";
    if (before && /[\p{L}\p{N}_]/u.test(before)) continue;
    return r.role;
  }
  return null;
}

/** Все упомянутые роли по порядку появления в тексте, без повторов:
 *  «@architect @qa, что думаете?» — отвечают обе. Те же правила границы
 *  слова, что у parseRoleMention (e-mail и URL не считаются). */
export function parseRoleMentions(text: string): RoleName[] {
  const lower = text.toLowerCase();
  const found: Array<{ role: RoleName; at: number; end: number }> = [];
  for (const m of lower.matchAll(/(?<![\p{L}\p{N}_])@([a-z_][a-z0-9_]*)/gu)) {
    if (VALID_ROLES.has(m[1] as RoleName)) {
      found.push({ role: m[1] as RoleName, at: m.index!, end: m.index! + m[0].length });
    }
  }
  const named = [...ROLE_NAMES]
    .map((role) => ({
      role,
      name: (
        (db.prepare("SELECT name FROM users WHERE role_key = ?").get(role) as
          | { name?: string }
          | undefined)?.name ?? ""
      ).toLowerCase(),
    }))
    .filter((r) => r.name)
    .sort((a, b) => b.name.length - a.name.length);
  for (const r of named) {
    const token = `@${r.name}`;
    for (let at = lower.indexOf(token); at >= 0; at = lower.indexOf(token, at + 1)) {
      const before = at > 0 ? lower[at - 1] : "";
      if (before && /[\p{L}\p{N}_]/u.test(before)) continue;
      // Уже занято более длинным именем («@Дизайнер интерфейсов»).
      if (found.some((f) => at >= f.at && at < f.end)) continue;
      found.push({ role: r.role, at, end: at + token.length });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.role))];
}

/** Эмбеддинги ролей (role_embeddings). Хранится как BLOB Float32. Читаем
 *  ленивым загрузчиком: таблица небольшая (8 ролей), но дёргать её на
 *  каждое сообщение вхолостую тоже незачем, поэтому оборачиваем в Map. */
const roleEmbeddingCache = new Map<
  RoleName,
  { vec: Float32Array | null; tags: string[] }
>();

function loadRoleEmbeddings(): Map<RoleName, { vec: Float32Array | null; tags: string[] }> {
  if (roleEmbeddingCache.size > 0) return roleEmbeddingCache;
  const rows = db
    .prepare("SELECT role, embedding, tags FROM role_embeddings")
    .all() as Array<{ role: string; embedding: Buffer; tags: string | null }>;
  for (const row of rows) {
    if (!VALID_ROLES.has(row.role as RoleName)) continue;
    let vec: Float32Array | null = null;
    if (row.embedding && row.embedding.byteLength > 0) {
      vec = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
    }
    let tags: string[] = [];
    if (row.tags) {
      try {
        const parsed = JSON.parse(row.tags);
        if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
      } catch { /* тихо: битый tags = пустой список */ }
    }
    roleEmbeddingCache.set(row.role as RoleName, { vec, tags });
  }
  return roleEmbeddingCache;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Определить роль-адресата сообщения в чате.
 *
 *  Приоритет:
 *    1) явное @упоминание роли в тексте — валидируется по составу участников.
 *       R1 (замечание Гермеса 21.09.2026): проверка поднята НАД веткой
 *       memberRoles.length === 1. Иначе в direct-чате @роль проверяется
 *       в коде, но в груповом при одной роли мы раньше отдавали её без
 *       проверки mention — @роль всё равно мог существовать, но
 *       упоминание было бы проигнорировано в пользу дефолта «единственная
 *       роль в чате». Это не ошибка, но это «тихая подмена»: пользователь
 *       написал @qa, а в коде было «раз в чате одна роль, отвечает она».
 *       Теперь @упоминание всегда побеждает, даже в прямом чате с одной
 *       ролью.
 *    2) «Авто» — семантический подбор против role_embeddings (как делает
 *       dispatch.pickRole, но без taskId: текстом сообщения напрямую);
 *    3) null — никому не отвечаем, молчание корректнее чужой роли.
 *
 *  Семантический шаг может вернуть null (нет эмбеддингов, модель ушла в
 *  ошибку, ни одна роль не похожа) — это нормальный исход, не ошибка. */
export async function pickRoleForChat(args: {
  messageText: string;
  memberRoles: RoleName[];
}): Promise<RoleName | null> {
  const { messageText, memberRoles } = args;
  if (memberRoles.length === 0) return null;

  // 1) явное @упоминание — самый сильный сигнал (R1: побеждает даже
  //    в direct-чате с одной ролью). Если @роль указана явно, но её нет
  //    среди участников, мы НЕ подменяем её «единственной ролью чата»:
  //    это тихая подмена намерения пользователя. Возвращаем null, и
  //    вызывающая сторона решает, что делать (в нашем случае —
  //    просто не отвечать).
  const mention = parseRoleMention(messageText);
  if (mention) {
    if (memberRoles.includes(mention)) return mention;
    return null;
  }

  // 2) «Авто»: семантический подбор. Только если в чате больше одной
  //    роли — иначе выбор очевиден и тратить токены на эмбеддинг
  //    незачем.
  if (memberRoles.length < 2) return memberRoles[0];

  try {
    const { getEmbeddings } = await import("../lib/embeddingClient.js");
    const text = messageText.trim();
    if (!text) return null;
    const result = await getEmbeddings(text);
    const query = new Float32Array(result.embeddings as number[]);
    if (query.length === 0) return null;

    const roles = loadRoleEmbeddings();
    let bestRole: RoleName | null = null;
    let bestScore = -Infinity;
    for (const role of memberRoles) {
      const entry = roles.get(role);
      if (!entry?.vec) continue;
      const score = cosine(query, entry.vec);
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }
    return bestRole;
  } catch (error) {
    // Эмбеддинги — улучшение, а не условие запуска. Сетевая ошибка или
    // пустой каталог — молча возвращаем null, как если бы роль не
    // определилась. Никаких пробросов наверх.
    console.warn(
      `[chats] семантический подбор роли не удался:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Максимум сообщений, которые кладём в контекст агенту при первом ходе
 *  сессии. Дальше сессия помнит разговор сама, и в ход идут только новые
 *  сообщения (см. deliverAgentReply). */
const CHAT_AGENT_CONTEXT_MESSAGES = 20;
/** Потолок новых сообщений в продолжении сессии — если роль долго молчала
 *  в оживлённой группе. */
const CHAT_AGENT_FOLLOWUP_MESSAGES = 30;

/** Сколько раз подряд роли могут передать слово друг другу через @имя,
 *  пока в разговор не вмешается человек. Страховка от бесконечного
 *  пинг-понга: живой разговор двух-трёх ролей укладывается с запасом. */
export const MAX_AGENT_HOPS = 4;

/** Кому отвечать на новое сообщение в чате и поставить их ходы в очередь.
 *
 *  Сообщение человека:
 *    1) явные @упоминания участников — отвечают ВСЕ упомянутые, каждый в
 *       своей очереди (разные роли работают параллельно);
 *    2) без упоминаний — в ЛИЧНОМ чате отвечает его роль (адресация
 *       неявная), в групповом и общем никто не просыпается: сообщение
 *       ложится в ленту как контекст (владелец 06.10.2026);
 *    3) упомянута роль, которой нет в чате, — молчание (не подменяем
 *       адресата).
 *
 *  Сообщение роли (передача слова, владелец 01.10.2026: «чтобы роли
 *  переписывались между собой без тупняка»): отвечают только те коллеги,
 *  кого роль явно позвала через @имя, не больше двух, и не дальше
 *  MAX_AGENT_HOPS передач подряд. */
function topicSlotKey(text:string):string|undefined {
  return text.match(/\[slot:\s*([^\]]+)\]/)?.[1]?.trim() ?? text.match(/\[этап:\s*([^\]]+)\]/i)?.[1]?.trim();
}
function slotChoiceNotice(chatId:string,taskId:string,role:RoleName,replyTo:string):void {
  const roleId=roleAccountId(role);if(!roleId)return;
  const slots=topicSlots(taskId,role);
  const text=slots.length ? "Уточни рабочий этап, к которому относится вопрос." : "В этой задаче у меня нет рабочего этапа. Обратись к назначенному участнику или открой общий чат со мной.";
  const name=(db.prepare("SELECT name FROM users WHERE id=?").get(roleId) as {name:string}).name;
  const id=uid();
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,reply_to_message_id,quick_replies) VALUES(?,?,?,'chat',?,?,?,?)").run(id,roleId,text,chatId,taskId,replyTo,slots.length ? JSON.stringify(slots.slice(0,4).map(slot=>`@${name} [этап: ${slot.title}]`)) : null);
  broadcastToUsers(memberIds(chatId),{type:"chat:new",message:loadChatMessage(id)});
}
/** Visible but not dispatched: the original delivery remains pending until its slot is selected. */
function messengerAmbiguityNotice(chatId:string,roleId:string,messageId:string):void {
  if(db.prepare("SELECT 1 FROM chat_messages WHERE chat_id=? AND from_user_id=? AND reply_to_message_id=? AND message_type='system'").get(chatId,roleId,messageId))return;
  const id=uid();
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id,message_type) VALUES(?,?,?,'chat',?,?,'system')").run(id,roleId,"У адресата несколько работающих этапов. Укажите конкретный этап в теме задачи; исходное сообщение сохранено и ожидает доставки.",chatId,messageId);
  broadcastToUsers(memberIds(chatId),{type:"chat:new",message:loadChatMessage(id)});
}

/** Модель из пилюли окна ввода: короткая строка или null («как у роли»). */
function chatModelChoice(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:\/-]{1,120}$/.test(value.trim()) ? value.trim() : null;
}

/** Ветка под сообщение владельца. Возвращает true, если просьбу забрала ветка
 *  и в основной комнате отдельный ход уже не нужен.
 *
 *  Почему ветка, а не «подмешать в текущий ход»: подмешивание не даёт ни
 *  видимой реакции, ни отдельного потока — владелец писал три сообщения и
 *  получал тишину, пока роль копалась в первом. Ветка отвечает сразу и
 *  работает параллельно. Ветки не ветвятся, на ответ роли ветки нет, темы
 *  задач и общий чат не трогаем. */
/** Новое сообщение владельца важнее текущего хода (владелец 23.10.2026:
 *  «зачем подмешивание — останови текущую задачу и займись новым»).
 *  Подмешивание держало ответ на полчаса: роль продолжала гонять инструменты,
 *  а сообщение лежало в её контексте без ответа. Останавливаем ход и запускаем
 *  новый — по новому сообщению. */
async function interruptChatTurnForOwner(chatId: string, ownerId: string): Promise<boolean> {
  if (!isMember(chatId, ownerId) || !isOwner(ownerId)) return false;
  const roleIds = chatMemberRoles(chatId)
    .map((role) => roleAccountId(role))
    .filter((id): id is string => Boolean(id));
  if (!roleIds.length) return false;
  const live = liveTurnsOfChat(chatId);
  const running = roleIds.filter((roleId) => live.some((turn) => turn.user_id === roleId));
  if (!running.length) return false;
  for (const roleId of running) {
    try {
      await cancelChatRunsFor(chatId, roleId);
    } catch (error) {
      console.warn(`[chats] не удалось остановить ход ${roleId} в ${chatId}:`, error instanceof Error ? error.message : error);
    }
  }
  return true;
}

/** Короткий контекст задачи для ветки-среза: что уже сделано по шагам и
 *  последние события. Владелец будет спрашивать по этому контексту. */
function taskSliceContext(taskId: string | null | undefined): string {
  if (!taskId) return "";
  const task = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as
    | { title: string; description: string | null }
    | undefined;
  if (!task) return "";
  const steps = db
    .prepare("SELECT title, COALESCE(agent_state, CASE WHEN done=1 THEN 'done' ELSE 'pending' END) AS state FROM subtasks WHERE task_id = ? ORDER BY position")
    .all(taskId) as Array<{ title: string; state: string }>;
  const events = db
    .prepare("SELECT kind, COALESCE(field,'') AS field, COALESCE(to_value,'') AS value, created_at FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 5")
    .all(taskId) as Array<{ kind: string; field: string; value: string; created_at: string }>;
  const lines: string[] = [`Задача: ${task.title}`];
  if (steps.length) lines.push("Шаги: " + steps.map((step) => `${step.title} — ${step.state}`).join("; "));
  if (events.length) {
    lines.push("Последние события:");
    for (const event of events) lines.push(`- ${event.created_at}: ${event.kind} ${event.field} ${event.value}`.trim());
  }
  return lines.join("\n");
}

async function fanOutOwnerMessage(args: {
  chatId: string;
  messageId: string;
  text: string;
  fromUserId: string;
  mode?: ChatWorkMode;
  hop: number;
}): Promise<boolean> {
  const chat = db
    .prepare("SELECT kind, task_id, parent_chat_id, branch_of_chat_id, room_kind FROM chats WHERE id = ?")
    .get(args.chatId) as
    | { kind: ChatKind; task_id: string | null; parent_chat_id: string | null; branch_of_chat_id: string | null; room_kind: string | null }
    | undefined;
  if (!chat) return false;
  const roles = chatMemberRoles(args.chatId);
  const source = db
    .prepare("SELECT reply_to_message_id FROM chat_messages WHERE id = ? AND chat_id = ?")
    .get(args.messageId, args.chatId) as { reply_to_message_id: string | null } | undefined;
  const repliesToRole = Boolean(
    source?.reply_to_message_id &&
      db.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND from_user_id LIKE 'role_%'").get(source.reply_to_message_id),
  );
  const roleId = roles.length === 1 ? roleAccountId(roles[0]) : null;
  if (!roleId) return false;
  // Занятость роли — не про этот чат, а про саму роль: пока у неё идёт ход
  // или ждёт сообщение в очереди (в любом чате), владельцу ответить некому и
  // ветка оправдана. Свободная роль отвечает обычным ходом в комнате.
  const busy = Boolean(
    db.prepare("SELECT 1 FROM chat_message_queue WHERE role_id = ? AND status IN ('pending','picked') LIMIT 1").get(roleId),
  ) || liveTurnsOfChat(args.chatId).some((turn) => turn.user_id === roleId);
  // Открытая ветка комнаты — та, где роль ещё не ответила по делу (одна
  // отбивка «Принял» ответом не считается). Второе сообщение под ту же
  // работу получит свою ветку только после закрытия этой.
  const openBranch = Boolean(
    db.prepare(
      `SELECT 1 FROM chats b
        WHERE b.branch_of_chat_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages m
             WHERE m.chat_id = b.id AND m.from_user_id LIKE 'role_%'
               AND m.text NOT LIKE 'Принял: «%'
          )
        LIMIT 1`,
    ).get(args.chatId),
  );
  const fromOwner = isOwner(args.fromUserId);
  const isTaskTopic = Boolean(chat.task_id) && Boolean(chat.parent_chat_id);
  // Тема задачи: сообщение владельца идёт в работу слота (подмешивание) и
  // открывает ветку-срез, где роль сразу отвечает владельцу (23.10.2026).
  const topicSlice = shouldFanOutTaskTopic({
    fromOwner,
    isTaskTopic,
    isBranch: Boolean(chat.branch_of_chat_id),
    repliesToRole,
    roleBusy: busy,
  });
  const allowed =
    topicSlice ||
    shouldFanOutOwnerMessage({
      fromOwner,
      direct: chat.kind === "direct",
      roleMembers: roles.length,
      isBranch: Boolean(chat.branch_of_chat_id),
      isTaskTopic: Boolean(chat.task_id) || Boolean(chat.parent_chat_id),
      isCommon: chat.room_kind === "common",
      repliesToRole,
      roleBusy: busy,
      openBranch,
    });
  if (!allowed) return false;
  const branchId = uid();
  const copyId = uid();
  const branchAckId = uid();
  const parentAckId = uid();
  db.transaction(() => {
    db.prepare("INSERT INTO chats (id, title, kind, created_by, branch_of_chat_id, branch_of_message_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(branchId, fanoutTitle(args.text), chat.kind, args.fromUserId, args.chatId, args.messageId);
    db.prepare("INSERT INTO chat_members (chat_id, member_id) SELECT ?, member_id FROM chat_members WHERE chat_id = ?").run(branchId, args.chatId);
    db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)").run(copyId, args.fromUserId, args.text, branchId);
    db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, reply_to_message_id) VALUES (?, ?, ?, 'chat', ?, ?)").run(branchAckId, roleId, topicSlice ? taskTopicBranchAck(args.text, taskSliceContext(chat.task_id)) : fanoutBranchAck(args.text, busy), branchId, copyId);
    db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, reply_to_message_id) VALUES (?, ?, ?, 'chat', ?, ?)").run(parentAckId, roleId, topicSlice ? "Принял: «" + String(args.text).slice(0, 60) + "» — правка ушла в работу, подробности открою в ветке." : fanoutParentAck(args.text), args.chatId, args.messageId);
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id IN (?, ?)").run(args.chatId, branchId);
  })();
  broadcastToUsers(memberIds(branchId), { type: "chat:new", message: loadChatMessage(copyId) });
  broadcastToUsers(memberIds(branchId), { type: "chat:new", message: loadChatMessage(branchAckId) });
  broadcastToUsers(memberIds(args.chatId), { type: "chat:new", message: loadChatMessage(parentAckId) });
  await dispatchRoleReplies({
    chatId: branchId,
    messageId: copyId,
    fromUserId: args.fromUserId,
    text: args.text,
    hop: args.hop,
    mode: args.mode,
  });
  // Тема задачи: ветка — срез для ответа владельцу, сама правка уже ушла в ход
  // слота через обычную доставку, поэтому основной dispatch не отменяем.
  return !topicSlice;
}

/** Итог по всем веткам комнаты: одна карточка «что сделано» вместо
 *  десятка строк. Появляется, когда ответила КАЖДАЯ ветка комнаты, и только
 *  один раз на волну: новая ветка (created_at новее свода) снова включит свод. */
function postRoomSummaryIfAllBranchesAnswered(parentId: string, roleId: string): void {
  const branches = db
    .prepare("SELECT id, title, created_at FROM chats WHERE branch_of_chat_id = ? ORDER BY created_at")
    .all(parentId) as Array<{ id: string; title: string; created_at: string }>;
  if (!branches.length) return;
  const newestBranch = branches[branches.length - 1].created_at;
  const existing = db
    .prepare("SELECT created_at FROM chat_messages WHERE chat_id = ? AND text LIKE 'Всё сведено:%' ORDER BY created_at DESC LIMIT 1")
    .get(parentId) as { created_at: string } | undefined;
  if (existing && existing.created_at > newestBranch) return;

  const lines: string[] = [];
  let open = 0;
  branches.forEach((branch, index) => {
    const firstMessage = db
      .prepare("SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid LIMIT 1")
      .get(branch.id) as { id: string } | undefined;
    const answer = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND from_user_id LIKE 'role_%' AND NOT (reply_to_message_id = ? AND text LIKE 'Принял: «%') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(branch.id, firstMessage?.id ?? "") as { text: string } | undefined;
    const title = branch.title.replace(/^Ветка:\s*/, "");
    if (!answer) {
      open += 1;
      lines.push(index + 1 + ". «" + title + "» — в работе");
      return;
    }
    const firstLine =
      unwrapRoleEnvelope(answer.text)
        .split("\n")
        .map((line) => line.replace(/[#*`>_-]/g, "").trim())
        .find(Boolean) ?? "готово";
    const digest = firstLine.length > 100 ? firstLine.slice(0, 99) + "…" : firstLine;
    lines.push(index + 1 + ". «" + title + "» — " + digest);
  });
  if (open) return;

  const id = uid();
  const text = "Всё сведено: " + branches.length + " " + (branches.length === 1 ? "ветка" : "веток") + ".\n" + lines.join("\n");
  db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)")
    .run(id, roleId, text, parentId);
  db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(parentId);
  broadcastToUsers(memberIds(parentId), { type: "chat:new", message: loadChatMessage(id) });
}

/** Строка-свод из ветки в основной чат: одна, короткая, без пересказа. */
function mirrorBranchResult(chatId: string, role: RoleName | null, text: string): void {
  const branch = db
    .prepare("SELECT branch_of_chat_id, title FROM chats WHERE id = ?")
    .get(chatId) as { branch_of_chat_id: string | null; title: string | null } | undefined;
  const parentId = branch?.branch_of_chat_id;
  const roleId = roleAccountId(role ?? "builder");
  if (!parentId || !roleId) return;
  const firstLine =
    text
      .split("\n")
      .map((line) => line.replace(/[#*`>_-]/g, "").trim())
      .find(Boolean) ?? "";
  const digest = firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine;
  const title = (branch?.title ?? "").replace(/^Ветка:\s*/, "");
  const id = uid();
  db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)")
    .run(id, roleId, "Ветка «" + title + "» — готово. " + digest, parentId);
  db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(parentId);
  broadcastToUsers(memberIds(parentId), { type: "chat:new", message: loadChatMessage(id) });
}

async function dispatchRoleReplies(args: {
  chatId: string;
  messageId: string;
  fromUserId: string;
  text: string;
  hop: number;
  mode?: ChatWorkMode;
  /** HTTP-Idempotency-Key из заголовков POST /messages.
   *  Приоритет над `messageId` как deliveryId — повторная отправка
   *  с тем же ключом даст ровно один durable ход и один Pi-вызов. */
  idempotencyKey?: string | null;
}): Promise<void> {
  const { chatId, text } = args;
  const senderRole = roleFromUserId(args.fromUserId);
  const candidates = chatMemberRoles(chatId).filter((r) => r !== senderRole || /\[slot:\s*[a-z][a-z0-9_]{1,63}\]/.test(text));
  if (candidates.length === 0) return;

  const message=db.prepare("SELECT reply_to_message_id,recipient_subtask_id FROM chat_messages WHERE id=? AND chat_id=?").get(args.messageId,chatId) as {reply_to_message_id:string|null;recipient_subtask_id:string|null}|undefined;
  const original=message?.reply_to_message_id ? db.prepare("SELECT from_user_id,reply_to_message_id FROM chat_messages WHERE id=? AND chat_id=?").get(message.reply_to_message_id,chatId) as {from_user_id:string;reply_to_message_id:string|null}|undefined : undefined;
  const authorRole=original ? roleFromUserId(original.from_user_id) : null;
  const mentioned = parseRoleMentions(text).filter((r) => candidates.includes(r));
  let targets: RoleName[];
  if (args.mode === "plan" && senderRole) return;
  if (args.mode === "deep_research") {
    targets = candidates.includes("researcher") ? ["researcher"] : [];
  } else if (senderRole) {
    if (args.hop > MAX_AGENT_HOPS) return;
    // Replies return to the question author once. An answer to that answer
    // remains context unless the role explicitly asks another question via @.
    targets = mentioned.length ? mentioned.slice(0,2)
      : authorRole && !original?.reply_to_message_id && candidates.includes(authorRole) ? [authorRole]
      : isDirectRoleChat(chatId) && candidates.length===1 && !message?.reply_to_message_id ? candidates : [];
  } else if (mentioned.length) {
    targets = mentioned;
  } else if (parseRoleMention(text)) {
    targets = [];
  } else if (isDirectRoleChat(chatId)) {
    // Личный чат — адресация неявная: @ каждый раз бессмысленен, роль
    // отвечает и без него.
    const picked = await pickRoleForChat({ messageText: text, memberRoles: candidates });
    targets = picked ? [picked] : [];
  } else {
    // Групповой и общий чат: без @ никто не просыпается — сообщение
    // ложится в ленту как контекст (владелец 06.10.2026).
    targets = [];
  }

  const topic=chatExecutionMode(chatId,args.messageId) === "card" ? db.prepare("SELECT task_id FROM chats WHERE id=? AND parent_chat_id IS NOT NULL").get(chatId) as {task_id:string}|undefined : undefined;
  for (const role of targets) {
    let selectedSlot:string|undefined;
    if(topic){
      const recipient=(db.prepare("SELECT recipient_subtask_id FROM chat_messages WHERE id=?").get(args.messageId) as {recipient_subtask_id:string|null}|undefined)?.recipient_subtask_id;
      const slot=resolveTopicSlot(topic.task_id,role,topicSlotKey(text),recipient ?? undefined);
      if(!slot && (recipient || topicSlotKey(text))){slotChoiceNotice(chatId,topic.task_id,role,args.messageId);continue;}
      if(slot){
        selectedSlot=slot.id;
      }
    }
    const accountId = roleAccountId(role);
    if (!accountId) continue;
    // Очередь на (chat_id, role_id): два быстрых сообщения подряд одной
    // роли отвечаются по порядку, контекст сессии не перемешивается.
    //
    // Карточка ebc4d338 (queue): перед постановкой в in-memory очередь
    // обязательно фиксируем durable-лог в chat_message_queue. Без этого
    // рестарт процесса между POST и Pi-ответом съест ход.
    // delivery_id — обычно id сообщения (сохраняет однократность даже
    // при сетевом retry POST). Если клиент прислал свой
    // Idempotency-Key, используем его как deliveryId
    // (HTTP-заголовок `x-delivery-id` или `Idempotency-Key` —
    // клиент контролирует дедуп сам, в т.ч. если messageId ещё
    // не вернулся в ответ). Сообщение же продолжаем привязывать
    // по messageId — это ключ для триггера `reply_to_message_id`
    // и history.
    const idempotencyKey = args.idempotencyKey ?? null;
    const deliveryKey = idempotencyKey ?? args.messageId;
    const durableRecord = recordDurableDelivery({
      chatId,
      roleId: accountId,
      deliveryId: deliveryKey,
      messageId: args.messageId,
      payload: {
        triggerMessageId: args.messageId,
        text,
        subtaskId: selectedSlot ?? message?.recipient_subtask_id,
        hop: args.hop,
        mode: args.mode,
      },
    });
    // Идемпотентный повтор: тот же delivery_id уже в работе. Не
    // дублируем in-memory очередь — это бы создало второй ответ. Но и
    // не молчим: «уже принято» — нормальный сценарий повторной отправки
    // при сетке.
    if (!durableRecord.created) continue;
    if(fenceDeliveryIfStale(durableRecord.id,durableRecord.generation))continue;
    const selected=selectedSlot ? resolveTopicSlot(topic!.task_id,role,undefined,selectedSlot) : null;
    const delivery=chatExecutionMode(chatId,args.messageId) === "chat" ? "idle" : selected ? await deliverTopicToWork(selected.task_id,role,args.messageId,text,selected.plan_node_key)
      : await deliverChatToWork(role,chatId,args.messageId,text,message?.recipient_subtask_id ?? undefined);
    if(delivery!=="idle"){
      // Pending survives a process crash. The recipient's linked reply (or
      // persisted processing of an answer) completes the obligation.
      if(delivery==="busy") messengerAmbiguityNotice(chatId,accountId,args.messageId);
      // Рабочий исполнитель сам подтверждает включение ввода в контекст.
      continue;
    }
    // Перед постановкой в очередь проверяем generation fence: ход
    // мог устареть, пока ждал durable-записи (например, пришёл
    // `/new-session` ровно в этот момент). Если generation уже
    // другая — fence-им до постановки в in-memory очередь, и
    // никакого Pi-вызова не будет.
    if (fenceDeliveryIfStale(durableRecord.id, durableRecord.generation)) continue;
    const replyWork = async () => {
      try {
        const replyId = await deliverAgentReply({
          chatId,
          role,
          triggerMessageId: args.messageId,
          subtaskId: selectedSlot,
          hop: args.hop,
          mode: args.mode,
        });
        // Повторная проверка fence ПОСЛЕ Pi-ответа: пока мы
        // готовили ответ, generation могла измениться (пользователь
        // успел нажать /new-session). Ответ из старого run'а
        // публиковать нельзя — он пойдёт старой сессии.
        // Закрываем ход как superseded и не светится в
        // result: finishDelivery тут уже не вызываем.
        if (fenceDeliveryIfStale(durableRecord.id, durableRecord.generation)) {
          return null;
        }
        // Pi не выдал ответа (Pi-сбой, общий чат и т.п.) —
        // ход закрываем как failed, чтобы он не висел
        // picked-вечно и попал под recovery / обработку
        // ошибки владельцем.
        const ok = replyId !== null;
        completeDurableDelivery(durableRecord.id, ok);
        return replyId;
      } catch (error) {
        if(error instanceof MessageForwardedToWork){retainForwardedDelivery(durableRecord.id);if(error.busy)messengerAmbiguityNotice(chatId,accountId,args.messageId);return null;}
        // Pi-исполнение должно было вернуть null и обработать
        // ошибку внутри (deliverAgentReply ловит Pi-сбои и
        // шлёт сообщение «Ой, что-то пошло не так…»), но если
        // что-то пошло не так снаружи — фиксируем failed,
        // чтобы ход не висел picked вечно и попал под
        // следующий recovery-sweep.
        console.warn(
          `[chats] ход ${durableRecord.id} chat=${chatId} role=${role} не закрыт успешно:`,
          error instanceof Error ? error.message : error,
        );
        completeDurableDelivery(durableRecord.id, false);
        // Context/persistence failures must leave a visible result too.
        try {
          assertCommonChatWritable(chatId, "system");
          const failureId = uid();
          db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)")
            .run(failureId, accountId, chatRunFailureText(error), chatId, args.messageId);
          broadcastToUsers(memberIds(chatId), { type: "chat:new", message: loadChatMessage(failureId) });
        } catch {
          console.warn(`[chats] failure notification unavailable chat=${chatId}`);
        }
        return null;
      }
    };
    // Уточнение в ход: сообщение занятой роли — от владельца или от коллеги,
    // из этого чата или из соседнего — подмешивается в её текущий ход. Роль
    // сама решает, учесть его сейчас или отложить; непрочитанное уходит
    // обычной очередью, ничего не теряется.
    const steeringMessage=db.prepare(`${HISTORY_SELECT} WHERE m.id = ?`).get(args.messageId) as HistoryRow | undefined;
    const steeringSource=steeringMessage
      ? steeringSourceFor(chatId,steeringMessage)
      : {from:"владелец",chatId,chatTitle:chatTitleOf(chatId),body:text};
    // Reserve FIFO position synchronously, before awaiting SDK/CLI acceptance.
    const receiptPromise = !selectedSlot && !topic
      ? offerChatSteering(chatId,accountId,args.messageId,{...steeringSource,executionMode:chatExecutionMode(chatId,args.messageId),workMode:args.mode ?? "work"})
      : Promise.resolve(null);
    // Служебная строка появляется сразу, как только SDK взял ввод: сообщение
    // в работе роли. Ждать конца хода нельзя — строка должна быть видна
    // во время работы, а очередь роли этим ходом занята.
    void receiptPromise.then(receipt=>{
      if(!receipt)return;
      void receipt.delivered.then(taken=>{
        if(taken)traceCoordination(()=>markDeliveredToWork(args.messageId,accountId));
      });
    });
    void enqueueChatReply(chatId,accountId,async () => {
      const receipt=await receiptPromise;
      if (fenceDeliveryIfStale(durableRecord.id,durableRecord.generation)) return;
      if (!receipt) return replyWork();
      const consumed=await receipt.consumed;
      if (fenceDeliveryIfStale(durableRecord.id,durableRecord.generation)) return;
      if (!consumed) return replyWork();
      const ok=await receipt.outcome;
      if (!fenceDeliveryIfStale(durableRecord.id,durableRecord.generation)){
        // A consumed input is not a linked answer to a cross-room question.
        const answered=ok && markCoordinationAnswered(args.messageId,accountId);
        if(ok && hasCoordinationCard(args.messageId,accountId) && !answered)retainForwardedDelivery(durableRecord.id);
        else completeDurableDelivery(durableRecord.id,ok);
      }
    }, {deliveryId:durableRecord.id}).catch(error => {
      console.warn("[chats] clarification delivery failed",error);
      completeDurableDelivery(durableRecord.id,false);
    });
  }
}

/** Пометка источника уточнения: от кого, из какого чата и что написано. */
function steeringSourceFor(chatId:string,message:HistoryRow):{from:string;chatId:string;chatTitle:string;body:string}{
  return {
    from:message.from_name||message.from_user_id,
    chatId,
    chatTitle:chatTitleOf(chatId),
    body:`${unwrapRoleEnvelope(message.text)}${message.task_id ? "\nКонтекст задачи: "+message.task_id : ""}${message.attachments ? "\n[вложения: "+message.attachments+"]" : ""}`,
  };
}

/** Название чата — чтобы роль видела, откуда пришло уточнение. */
function chatTitleOf(chatId:string):string{
  return (db.prepare("SELECT title FROM chats WHERE id=?").get(chatId) as {title:string}|undefined)?.title??"";
}

/** Персональный чат с ролью (ровно один собеседник-роль). В нём адресация
 *  неявная; во всех остальных чатах роль просыпается только по `@`. */
function isDirectRoleChat(chatId: string): boolean {
  const row = db.prepare("SELECT kind FROM chats WHERE id = ?").get(chatId) as
    | { kind: string }
    | undefined;
  return row?.kind === "direct";
}

interface HistoryRow {
  id: string;
  from_user_id: string;
  text: string;
  created_at: string;
  from_name: string | null;
  attachments: string | null;
  recipient_subtask_id: string | null;
  subtask_id: string | null;
  task_id: string | null;
}

const HISTORY_SELECT = `SELECT m.task_id, m.id, m.from_user_id, m.text, m.created_at, m.recipient_subtask_id, m.subtask_id, f.name as from_name,
        (SELECT group_concat(a.file_name, ', ') FROM attachments a
          WHERE a.chat_message_id = m.id) as attachments
   FROM chat_messages m
   LEFT JOIN users f ON f.id = m.from_user_id`;

function historyLine(row: HistoryRow): string {
  const who = row.from_name || row.from_user_id;
  const files = row.attachments ? ` [вложения: ${row.attachments}]` : "";
  return `- [${row.created_at}] ${who}: ${unwrapRoleEnvelope(row.text)}${files}`;
}

/** Кто в чате — чтобы роль знала, кого можно позвать через @имя. */
function participantsText(chatId: string, selfId: string): string {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.role, u.role_key, u.type
         FROM chat_members cm JOIN users u ON u.id = cm.member_id
        WHERE cm.chat_id = ? ORDER BY cm.added_at`,
    )
    .all(chatId) as Array<{
    id: string;
    name: string;
    role: string | null;
    role_key: string | null;
    type: string | null;
  }>;
  return rows
    .map((u) => {
      const me = u.id === selfId ? " — это ты" : "";
      if (u.type === "ai" && u.role_key) return `- @${u.name} (${titleOfRole(u.role_key as RoleName)})${me}`;
      return `- ${u.name}${u.role === "owner" ? " (владелец)" : ""}${me}`;
    })
    .join("\n");
}

/** Поднять/продолжить онлайн-сессию Пи для роли, дождаться ответа и
 *  положить его как сообщение от имени role_<role>. Никаких правок
 *  tasks/attempts/agent_state — изоляция по требованию плана.
 *
 *  Вызывается ТОЛЬКО через очередь enqueueChatReply (B5).
 *
 *  Контекст. Первый ход сессии получает инструкцию роли, состав чата и
 *  последние сообщения. Продолжение сессии получает только то, что
 *  написали с прошлого ответа роли: всё прежнее сессия уже помнит. Раньше
 *  каждый ход заново вкладывал инструкцию и 20 сообщений истории — сессия
 *  пухла копиями одного и того же, роль тупела и отвечала медленнее.
 *
 *  Порядок в конце хода: сохранить ответ → разослать `chat:new` с готовым
 *  сообщением → «ход закончен». Клиент меняет живой пузырь на готовый
 *  одним кадром.
 *
 *  Возвращает id сохранённого ответа либо null, если ответа нет. */
async function deliverAgentReply(args: {
  chatId: string;
  role: RoleName;
  triggerMessageId: string;
  subtaskId?: string;
  hop: number;
  mode?: ChatWorkMode;
  /** Server-created one-shot result returns to its requesting conversation. */
  chatOnly?: boolean;
}): Promise<string | null> {
  const { chatId, role } = args;
  const roleUserId = roleAccountId(role);
  if (!roleUserId) {
    console.warn(`[chats] deliverAgentReply: ролевая учётка для ${role} не найдена`);
    return null;
  }
  // Роль могли убрать из чата, пока ход ждал в очереди.
  if (!isMember(chatId, roleUserId)) return null;

  const trigger = db
    .prepare(`${HISTORY_SELECT} WHERE m.id = ?`)
    .get(args.triggerMessageId) as HistoryRow | undefined;
  // Сообщение удалили, пока ход ждал в очереди, — отвечать не на что.
  if (!trigger) return null;
  const integrationContext=integrationHandoffContext(trigger.id,roleUserId);
  if(isIntegrationHandoff(trigger.id) && !integrationContext)return null;
  const triggerTask = trigger.task_id ? `\nКонтекст задачи: ${trigger.task_id}` : "";
  const triggerFiles = trigger.attachments ? `\n[вложения: ${trigger.attachments}]` : "";
  const intentGuidance=isOwner(trigger.from_user_id) ? await chatIntentBlockForMessage(trigger.id) : "";
  const userText = `${integrationContext ? integrationContext+"\n" : ""}${trigger.from_name || trigger.from_user_id}: ${unwrapRoleEnvelope(trigger.text)}${triggerTask}${triggerFiles}${intentGuidance}`;

  const topic=chatExecutionMode(chatId,args.triggerMessageId) === "card" ? db.prepare("SELECT task_id FROM chats WHERE id=? AND parent_chat_id IS NOT NULL").get(chatId) as {task_id:string}|undefined : undefined;
  const slot=topic ? resolveTopicSlot(topic.task_id,role,topicSlotKey(trigger.text),args.subtaskId ?? trigger.recipient_subtask_id ?? undefined) : null;
  if(topic && !slot && (args.subtaskId || trigger.recipient_subtask_id || topicSlotKey(trigger.text))){slotChoiceNotice(chatId,topic.task_id,role,args.triggerMessageId);return null;}
  const fromOwner = isOwner(trigger.from_user_id);
  const activeDelivery=args.chatOnly || chatExecutionMode(chatId,args.triggerMessageId) === "chat" ? "idle" : topic && slot ? await deliverTopicToWork(slot.task_id,role,args.triggerMessageId,userText,slot.plan_node_key)
    : !topic ? await deliverChatToWork(role,chatId,args.triggerMessageId,userText,args.subtaskId??trigger.recipient_subtask_id??undefined,undefined,fromOwner) : "idle";
  if(activeDelivery!=="idle"){
    traceCoordination(()=>updateCoordination(args.triggerMessageId,roleUserId,{status:activeDelivery==="busy"?"busy":"queued",activity:activeDelivery==="busy"?"Выбери рабочий этап адресата":"Ожидает завершения текущего действия",last_activity_at:new Date().toISOString()}));
    throw new MessageForwardedToWork(activeDelivery==="busy");
  }
  const roleTitle = titleOfRole(role);
  const previousSessionId = slot ? null : getChatSessionId(chatId, roleUserId);
  let prompt: string;
  if(slot){prompt=userText;}
  else if (previousSessionId) {
    const since = db
      .prepare(
        `${HISTORY_SELECT}
          WHERE m.chat_id = ? AND m.id != ? AND COALESCE(m.is_session_marker, 0) = 0
            AND m.rowid > COALESCE(
              (SELECT MAX(rowid) FROM chat_messages WHERE chat_id = ? AND from_user_id = ?), 0)
            AND m.rowid < (SELECT rowid FROM chat_messages WHERE id = ?)
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(
        chatId,
        trigger.id,
        chatId,
        roleUserId,
        trigger.id,
        CHAT_AGENT_FOLLOWUP_MESSAGES,
      ) as HistoryRow[];
    since.reverse();
    prompt = renderInstruction(role, "chat.followup", {
      roleTitle,
      role,
      history: since.map(historyLine).join("\n") || "(ничего нового)",
      userText,
    });
  } else {
    const history = db
      .prepare(
        `${HISTORY_SELECT}
          WHERE m.chat_id = ? AND m.id != ? AND COALESCE(m.is_session_marker, 0) = 0
            AND m.rowid < (SELECT rowid FROM chat_messages WHERE id = ?)
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(chatId, trigger.id, trigger.id, CHAT_AGENT_CONTEXT_MESSAGES) as HistoryRow[];
    history.reverse();
    // Состав команды (14.10.2026) — в первый ход сессии, дальше сессия помнит.
    // Инструкция роли (общий шаблон + AGENTS.md) уже в системном промпте чата
    // (chatSystemPrompt) — второй раз её сюда не кладём (20.10.2026).
    const roleInstruction = teamStructureText(role);
    prompt = renderInstruction(role, "chat.wrapper", {
      roleInstruction,
      localPolicy: composeLayer(role, "local_policy")!.effective,
      roleTitle,
      role,
      participants: participantsText(chatId, roleUserId),
      history: history.map(historyLine).join("\n") || "(пусто)",
      userText,
    });
  }

  // Время — в каждый ход: сессия помнит старое, а час уже другой (14.10.2026).
  prompt = clockLine() + "\n\n" + prompt;

  // Память команды по теме сообщения (02.10.2026) — в каждый ход: тема
  // разговора меняется, и вспоминать надо то, что относится к ней сейчас.
  const chatProject = (db.prepare(
    "SELECT COALESCE(c.project_id,t.project_id) project_id FROM chats c LEFT JOIN tasks t ON t.id = c.task_id WHERE c.id = ?",
  ).get(chatId) as { project_id?: string | null } | undefined)?.project_id ?? null;
  // Чат задачи: первым блоком — сама задача и место роли в ней (lib/taskChatBrief.ts).
  if (topic) { const brief = taskChatBrief(topic.task_id, role); if (brief) prompt = `${brief}\n\n${prompt}`; }
  const memory = await prepareChatValue(roleProjectContext({ role, projectId: chatProject, taskId:topic?.task_id ?? trigger.task_id ?? undefined, query: trigger.text }));
  if (memory) prompt = `${prompt}\n\n${memory}`;
  // Снимки работы слотов (владелец 04.10.2026, пункт 5 плана: «подмешивать
  // последний снимок в общий контекст роли — и для чата, и для работы»).
  // Для конкретного этапа — его снимок, без этапа — короткий перечень моих
  // слотов. Это ДАННЫЕ о работе, а не инструкция: в чат ничего не отправляется
  // автоматически, роль сама решает, упоминать ли это в ответе.
  const snapshots = slot
    ? roleSlotSnapshotsBlock({ role, taskId: slot.task_id, subtaskId: slot.id })
    : roleSlotSnapshotsBlock({ role, taskId: topic?.task_id ?? null, projectId: topic ? null : chatProject });
  if (snapshots) prompt = `${prompt}\n\n${snapshots}`;
  prompt += `\nОтвечаешь на сообщение ${trigger.id}; сервер свяжет итоговый текст с этим вопросом. Не отправляй тот же ответ повторно инструментом. Для отдельного нового вопроса коллеге используй taskflow_chat_send.`;
  prompt += "\nМессенджер: максимум 100 слов. Блок — максимум 50 слов: причина и нужное действие. Материалы сохраняй инструментом doc_write в документах проекта или прикладывай файлом к этому разговору; для этого не нужна карточка задачи. Обращение: адресат, задача, этап и один конкретный вопрос по специализации адресата. Ответ адресуй автору вопроса, без повторного отчёта.";
  if(topic) prompt += `\n\n${topicContext(topic.task_id)}\nЭтот ход — обсуждение той же роли в проекте. Не запускай этап автоматически; рабочие операции выполняются только в назначенном сервером слоте.`;

  if(integrationContext) prompt = integrationContext+"\n\n"+prompt;

  const roleName =
    (db.prepare("SELECT name FROM users WHERE id = ?").get(roleUserId) as
      | { name?: string }
      | undefined)?.name ?? role;

  // «Печатает» (владелец 22.09.2026): ровно то время, пока роль готовит
  // ответ, — от запуска до готового текста или сбоя.
  const typing = (active: boolean, tool?: string) => {
    broadcastToUsers(memberIds(chatId), {
      type: "chats:typing",
      chat_id: chatId,
      user_id: roleUserId,
      name: roleName,
      active,
      ...(tool ? { tool } : {}),
    });
  };

  const live = startLiveTurn({
    chatId,
    userId: roleUserId,
    name: roleName,
    triggerMessageId: trigger.id,
    audience: () => memberIds(chatId),
  });

  let replyId: string | null = null;
  let replyText = "";
  let reply: { sessionId: string | null; text: string } | null = null;
  let failure: unknown = null;
  let settleDelivery!:(ok:boolean)=>void;
  const deliveryOutcome=new Promise<boolean>(resolve=>{settleDelivery=resolve;});
  let persistedReply=false;
  try {
    typing(true);
  try {
    reply = topic && slot ? await startSlotConversation({taskId:slot.task_id,subtaskId:slot.id,role,chatId,messageId:trigger.id,prompt,onStep:(tool)=>typing(true,tool),onEvent:(event)=>{observeDeliveryActivity(chatId,roleUserId,event);live.onEvent(event);}}) : await startChatRun({
      mode: integrationContext ? "work" : roleFromUserId(trigger.from_user_id) ? "discussion" : args.mode,
      messageId: trigger.id,
      deliveryOutcome,
      chatId,
      role,
      roleId: roleUserId,
      prompt,
      model: (db.prepare("SELECT model FROM chat_messages WHERE id = ?").get(trigger.id) as { model: string | null } | undefined)?.model ?? undefined,
      sessionId: previousSessionId,
      onStep: (tool) => typing(true, tool),
      onEvent: (event) => { observeDeliveryActivity(chatId,roleUserId,event); live.onEvent(event); },
      // «Цель»: промежуточный итог роли сразу ложится в чат отдельным
      // сообщением (владелец 20.10.2026). Без reply_to — иначе клиент
      // принял бы его за конец живого хода.
      onGoalProgress: (text) => {
        const progressId = uid();
        db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)").run(progressId, roleUserId, text, chatId);
        broadcastToUsers(memberIds(chatId), { type: "chat:new", message: loadChatMessage(progressId) });
      },
    });
    if((reply as {forwarded?:boolean})?.forwarded)throw new MessageForwardedToWork(false);
  } catch (error) {
    if(error instanceof MessageForwardedToWork)throw error;
    // Онлайн-сессия не роняет HTTP-запрос, но и молчать нельзя (владелец
    // 27.09.2026): о сорванном ходе в чат ложится сообщение с причиной.
    console.warn(
      `[chats] startChatRun не удался для chat=${chatId} role=${role}:`,
      error instanceof Error ? error.message : error,
    );
    failure = error;
  }
  const partial = live.partialText();
  const cancelled = (failure as { code?: string } | null)?.code === "CHAT_RUN_CANCELLED";
  let storedRoleEnvelope: string | null = null;
  let quickReplies: string[] | null = null;
  replyText = cancelled && partial
    ? `${partial}\n\n_Остановлено._`
    : failure
      ? chatRunFailureText(failure)
      : "";

  if (!cancelled && !failure) {
    const rawAnswer = (reply?.text || "").trim();
    if (rawAnswer) {
      const normalized = normalizeRoleReplyV1(rawAnswer);
      if (normalized.normalizedByServer) {
        console.warn("[chats] ответ роли нормализован в JSON v1:", {
          role,
          chatId,
          validationErrors: normalized.validationErrors,
        });
      }
      const replies: string[] = [];
      normalized.envelope.output = normalized.envelope.output.map((block) => {
        if (block.type !== "text" || typeof block.text !== "string") return block;
        const widgetsNormalized = normalizeWidgetBlocks(block.text);
        const extracted = extractQuickReplies(widgetsNormalized);
        if (extracted.replies) replies.push(...extracted.replies);
        return { ...block, text: extracted.clean };
      });
      quickReplies = replies.length ? replies.slice(0, 4) : null;
      storedRoleEnvelope = JSON.stringify(normalized.envelope);
      replyText = structuredOutputText(normalized.envelope.output).trim();
    }
  }

  // A terminal run must leave a visible result even if the provider returned no final text.
  if (!replyText && !failure) {
    // Пустой ответ модели (21.10.2026): молчание с известной причиной —
    // говорим ею, а не «ход завершился без текста».
    const emptyReason = live.emptyAnswerReason();
    if (emptyReason) {
      failure = Object.assign(new Error(emptyReason), { code: "CHAT_RUN_EMPTY_ANSWER" });
      replyText = chatRunFailureText(failure);
    } else {
      replyText = partial || "Ход завершился без текста ответа. Отправьте сообщение ещё раз.";
      if (!partial) failure = Object.assign(new Error("модель завершила ход без текста ответа"), { code: "CHAT_RUN_EMPTY" });
    }
  }
  if (!failure && !cancelled) live.replaceFinalText(replyText);
  const steps: SavedSteps | null = live.finish({ deferAnnounce: true });

  // Сообщение о сбое хода — не для общего чата (инвариант п. 3): сбой идёт
  // в личную переписку роли, в общем чате ему места нет.
  if (replyText && failure) {
    try {
      assertCommonChatWritable(chatId, "system");
    } catch {
      console.warn(
        `[chats] сбой хода роли ${role} в общем чате — сообщение не публикуем в chat=${chatId}`,
      );
      replyText = "";
    }
  }

  // Ответ пользователя остаётся без потери: валидный JSON v1 сохраняем
  // структурированным, а plain/invalid ответ — без изменений внутри text-блока.
  if (replyText) {
    const prepared=preparedReportMaterials(chatId,roleUserId,trigger.id);
    let overflow: import("../lib/chatReportMaterials.js").ChatMaterial[]=[];
    if(prepared.length){
      const envelope=storedRoleEnvelope ? JSON.parse(storedRoleEnvelope) : normalizeRoleReplyV1(replyText).envelope;
      if(failure){envelope.ok=false;envelope.error={code:"tool_error",message:replyText,retryable:false};}
      const compacted=compactChatReportMaterials(envelope,prepared);
      storedRoleEnvelope=JSON.stringify(compacted.envelope);
      overflow=compacted.overflow;
    }
    replyId = uid();
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, text, role_envelope_json, channel, chat_id, quick_replies, steps, reply_to_message_id,task_id,subtask_id,recipient_subtask_id)
       VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(replyId, roleUserId, replyText, storedRoleEnvelope, chatId, quickReplies ? JSON.stringify(quickReplies) : null, steps ? JSON.stringify(steps) : null,trigger.id,slot?.task_id ?? topic?.task_id ?? null,slot?.id ?? null,trigger.subtask_id ?? null);
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);
    traceCoordination(()=>coordinationAnswered(trigger.id,roleUserId,replyText,!!failure));
    broadcastToUsers(memberIds(chatId), { type: "chat:new", message: loadChatMessage(replyId) });
    for(const material of overflow){
      const materialId=uid();
      const card={type:"card",title:material.title,link:{title:"Открыть материал",url:material.ref}};
      db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)")
        .run(materialId,roleUserId,"\`\`\`widget\n"+JSON.stringify(card)+"\n\`\`\`",chatId,trigger.id);
      broadcastToUsers(memberIds(chatId),{type:"chat:new",message:loadChatMessage(materialId)});
    }
    persistedReply=!failure;
  }
  } finally {
    settleDelivery(persistedReply);
    live.finish({ deferAnnounce: true });
    live.announceEnd(replyId);
    typing(false);
  }

  // Передача слова коллеге по чату: роль позвала кого-то через @имя.
  if (replyId && !failure) {
    try {
      await dispatchRoleReplies({
        chatId,
        messageId: replyId,
        fromUserId: roleUserId,
        text: replyText,
        hop: args.hop + 1,
        mode: args.mode,
        // При передаче слова клиентского ключа уже нет; на
        // стороне сервера используем replyId, чтобы сеть
        // дублей между Pi-ретраями не плодила Pi.
        idempotencyKey: replyId,
      });
    } catch (error) {
      console.warn(
        `[chats] передача слова не удалась для chat=${chatId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return failure ? null : replyId;
}

/** Тестовая утилита: сбросить кэш эмбеддингов ролей. Используется в
 *  тестах после подмены role_embeddings в БД. В проде не нужна —
 *  таблица меняется только руками через seed-скрипт. */
export function _resetChatRolePickerForTests(): void {
  roleEmbeddingCache.clear();
}
