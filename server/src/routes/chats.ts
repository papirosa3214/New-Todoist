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
//   2) «Авто» — семантический подбор pickRoleForChat по тексту сообщения
//      против ролевых эмбеддингов; ограничиваемся участниками чата.
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
import { deliverSecretaryReply, SECRETARY_CHAT_ID } from "../lib/secretaryReply.js";
import {
  chatRunFailureText,
  liveTurnsOfChat,
  startLiveTurn,
  stepDetailFallback,
  unwrapRoleEnvelope,
  type SavedSteps,
} from "../runtime/chatLiveTurn.js";
import {
  ROLE_NAMES,
  roleTitle as titleOfRole,
  rolePromptText,
  type RoleName,
} from "../roleRouting.js";
import {
  enqueueChatReply,
  getChatSessionId,
} from "../runtime/chatSession.js";
import {
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

const uid = () => crypto.randomUUID();

// Вложения сообщения — тем же приёмом, что в routes/chat.ts: ленивая
// подготовка SELECT, чтобы db.prepare с колонкой chat_message_id не
// падал на импорте, если миграция 053 ещё не прошла (тот же риск, та же
// причина — index.ts импортирует маршруты раньше, чем прогоняет миграции).
let attachmentsOf: import("better-sqlite3").Statement | null = null;

function withAttachments(message: any) {
  if (!message) return message;
  attachmentsOf ??= db.prepare(
    `SELECT id, file_name, mime, size FROM attachments
      WHERE chat_message_id = ? ORDER BY created_at`,
  );
  return {
    ...message,
    attachments: attachmentsOf.all(message.id),
    // Быстрые ответы (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/) —
    // хранятся в chat_messages.quick_replies как JSON-строка (у SQLite
    // нет своего типа массива), здесь разворачиваем в настоящий массив.
    quick_replies: message.quick_replies ? JSON.parse(message.quick_replies) : null,
    // SQLite отдаёт 0/1 числом — iOS Decodable для Bool ждёт true/false,
    // не 0/1, приводим здесь же.
    is_session_marker: Boolean(message.is_session_marker),
    // Шаги хода роли (владелец 27.09.2026, живой ход как в Claude Code) —
    // JSON-строка в chat_messages.steps, см. runtime/chatLiveTurn.ts.
    steps: message.steps ? savedSteps(message.steps) : null,
    // Конверт ok/output в ответе роли (01.10.2026) — показываем только output,
    // в том числе у сообщений, сохранённых раньше.
    text: typeof message.text === "string" ? unwrapRoleEnvelope(message.text) : message.text,
  };
}

/** Шаги из БД; инструментам трекера без подписи — подпись по имени. */
function savedSteps(raw: string): SavedSteps {
  const steps = JSON.parse(raw) as SavedSteps;
  for (const it of steps.items ?? []) {
    if (it.kind === "step") it.detail = stepDetailFallback(it.tool, it.detail);
  }
  return steps;
}

type ChatKind = "direct" | "group";
const KINDS: ChatKind[] = ["direct", "group"];

function memberIds(chatId: string): string[] {
  return (
    db
      .prepare("SELECT member_id FROM chat_members WHERE chat_id = ?")
      .all(chatId) as Array<{ member_id: string }>
  ).map((r) => r.member_id);
}

function isMember(chatId: string, userId: string): boolean {
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
      `SELECT u.id, u.name, u.role, u.type, u.avatar_color, u.avatar_url, u.initials
         FROM chat_members cm JOIN users u ON u.id = cm.member_id
        WHERE cm.chat_id = ? ORDER BY cm.added_at`,
    )
    .all(chatId);
  return { ...chat, members };
}

export async function registerChatsRoutes(app: FastifyInstance): Promise<void> {
  const authPre = authOrApiToken;

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
    });
    txn();

    return { chat: chatRow(id) };
  });

  // Мои чаты: где я участник. С превью последнего сообщения и числом
  // непрочитанных (владелец 21.09.2026: бейдж в строке списка чатов,
  // LOCK-195). Сортировка — по `updated_at`: он обновляется на каждое
  // сообщение (см. POST /:id/messages), то есть чат с свежей перепиской
  // всегда наверху.
  app.get("/api/chats", { preHandler: authPre }, async (req: any) => {
    const rows = db
      .prepare(
        `SELECT c.* FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id
          WHERE cm.member_id = ?
          ORDER BY c.updated_at DESC`,
      )
      .all(req.userId) as Array<{ id: string; task_id: string | null }>;
    return {
      chats: rows.map((c) => {
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
              ORDER BY m.created_at DESC LIMIT 1`,
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
            ? { ...last, text: typeof last.text === "string" ? unwrapRoleEnvelope(last.text) : last.text }
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
            WHERE m.chat_id = ? ORDER BY m.created_at ASC`,
        )
        .all(req.params.id);
      return { messages: messages.map(withAttachments) };
    },
  );

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
  app.post<{
    Params: { id: string };
    Body: { text?: string; attachment_ids?: string[]; task_id?: string };
  }>(
    "/api/chats/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const text = String(req.body?.text || "").trim();
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
        .prepare<[string], { task_id: string | null }>(
          "SELECT task_id FROM chats WHERE id = ?",
        )
        .get(chatId);
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      const chatTaskId = chat.task_id;
      const taskId =
        typeof req.body?.task_id === "string" && req.body.task_id
          ? req.body.task_id
          : chatTaskId;
      const id = uid();
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id)
         VALUES (?, ?, ?, 'chat', ?, ?)`,
      ).run(id, req.userId, text, chatId, taskId);
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

      const message = withAttachments(
        db
          .prepare(
            `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
                    f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
                    t.title as task_title
               FROM chat_messages m
               LEFT JOIN users f ON f.id = m.from_user_id
               LEFT JOIN tasks t ON t.id = m.task_id
              WHERE m.id = ?`,
          )
          .get(id),
      );

      const audience = memberIds(chatId).filter((m) => m !== req.userId);
      broadcastToUsers([...audience, req.userId], {
        type: "chat:new",
        message,
      });

      // Этап 2: попытка авто-ответа. Делается «best effort»: ошибки НЕ
      // должны откатывать уже сохранённое сообщение и не должны ронять
      // запрос — пользователь уже видит своё сообщение в ленте. Поэтому
      // вокруг — try/catch с логированием.
      //
      // Секретарь (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/) —
      // отдельная ветка: chatMemberRoles/roleAccountId завязаны на
      // users.role_key, а у Секретаря его нет и не может быть (БД-триггер
      // требует id = 'role_' + role_key, у него фиксированный u-secretary).
      try {
        if (chatId === SECRETARY_CHAT_ID) {
          void deliverSecretaryReply(text);
        } else {
        const memberRoles = chatMemberRoles(chatId);
        const targetRole = await pickRoleForChat({
          messageText: text,
          memberRoles,
        });
        if (targetRole) {
          // Ставим ход в очередь на (chat_id, role_id). Без неё два
          // быстрых сообщения подряд на одну роль начнут startChatRun
          // параллельно, и порядок ответов в ленте окажется случайным
          // — хуже того, контекст (pi_session_id) мог бы перемешаться.
          // Очередь сериализует ходы; другие роли и чаты продолжают
          // работать параллельно.
          const accountId = roleAccountId(targetRole);
          if (accountId) {
            void enqueueChatReply(chatId, accountId, () =>
              deliverAgentReply({
                chatId,
                role: targetRole,
                userText: text,
              }),
            );
          }
        }
        }
      } catch (error) {
        // Логируем, но не возвращаем 5xx — текст уже в ленте, а ошибку
        // подбора/постановки в очередь разберём отдельно.
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

  // Новая сессия без удаления истории (владелец 25.09.2026, docs/ПЛАН
  // Супер Секретарь/): сбрасывает pi_session_id роли в этом чате — агент
  // следующим сообщением поднимет разговор с нуля, сама лента остаётся
  // нетронутой. В ленту кладётся видимая метка-разделитель.
  app.post<{ Params: { id: string }; Body: { role_id?: string } }>(
    "/api/chats/:id/new-session",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chatId = req.params.id;
      if (!isMember(chatId, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const roleId = typeof req.body?.role_id === "string" ? req.body.role_id : "";
      if (!roleId) return reply.code(400).send({ error: "role_id обязателен" });
      if (!isMember(chatId, roleId))
        return reply.code(400).send({ error: "role_id не участник этого чата" });

      db.prepare("DELETE FROM chat_sessions WHERE chat_id = ? AND role_id = ?").run(
        chatId,
        roleId,
      );

      const id = uid();
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, is_session_marker)
         VALUES (?, ?, 'Новая сессия', 'chat', ?, 1)`,
      ).run(id, roleId, chatId);
      db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);

      const message = withAttachments(
        db
          .prepare(
            `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
                    f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
                    t.title as task_title
               FROM chat_messages m
               LEFT JOIN users f ON f.id = m.from_user_id
               LEFT JOIN tasks t ON t.id = m.task_id
              WHERE m.id = ?`,
          )
          .get(id),
      );
      broadcastToUsers(memberIds(chatId), { type: "chat:new", message });
      return { message };
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
      db.prepare(
        `INSERT OR IGNORE INTO chat_members (chat_id, member_id, last_read_at)
         VALUES (?, ?, datetime('now'))`,
      ).run(req.params.id, memberId);
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
      db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND member_id = ?").run(
        req.params.id,
        req.params.memberId,
      );
      return { chat: chatRow(req.params.id) };
    },
  );

  // Удалить чат (создатель). Сообщения уходят каскадом (chat_messages.chat_id).
  app.delete<{ Params: { id: string } }>(
    "/api/chats/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
        | { created_by: string }
        | undefined;
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "удалить чат может создатель" });
      db.prepare("DELETE FROM chats WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );
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
    if (role) result.push(role);
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

/** Максимум сообщений, которые кладём в контекст агенту. Больше — дороже
 *  по токенам, меньше — агент теряет нить разговора. 20 — типичный
 *  «последний экран» чата; при необходимости владелец подкрутит. */
const CHAT_AGENT_CONTEXT_MESSAGES = 20;

/** Поднять/продолжить онлайн-сессию Пи для роли, дождаться ответа и
 *  положить его как сообщение от имени role_<role>. Никаких правок
 *  tasks/attempts/agent_state — изоляция по требованию плана.
 *
 *  Вызывающая сторона (POST /api/chats/:id/messages) ставит эту функцию
 *  В ОЧЕРЕДЬ через enqueueChatReply (B5) — иначе два быстрых сообщения
 *  подряд на одну роль стартанут параллельно, и порядок ответов в
 *  ленте станет случайным.
 *
 *  Возвращает id сохранённого сообщения-ответа либо null, если ответ
 *  пуст (агент не счёл нужным ответить — легитимный исход, в ленту
 *  ничего не идёт). */
async function deliverAgentReply(args: {
  chatId: string;
  role: RoleName;
  userText: string;
}): Promise<string | null> {
  const { chatId, role } = args;
  const roleUserId = roleAccountId(role);
  if (!roleUserId) {
    // Роль-учётка не заведена — пропускаем, без сообщения. Владелец увидит
    // проблему в логах, чат продолжит работать.
    console.warn(
      `[chats] deliverAgentReply: ролевая учётка для ${role} не найдена`,
    );
    return null;
  }

  // Сборка контекста: последние N сообщений + новый user turn.
  const history = db
    .prepare(
      `SELECT m.from_user_id, m.text, m.created_at, f.name as from_name,
              f.role as from_role
         FROM chat_messages m
         LEFT JOIN users f ON f.id = m.from_user_id
        WHERE m.chat_id = ?
        ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(chatId, CHAT_AGENT_CONTEXT_MESSAGES) as Array<{
      from_user_id: string;
      text: string;
      created_at: string;
      from_name: string | null;
      from_role: string | null;
    }>;
  // Переворачиваем обратно в хронологический порядок (от старых к новым).
  history.reverse();

  const historyLines = history
    .map((row) => {
      const who = row.from_name || row.from_user_id;
      return `- [${row.created_at}] ${who}: ${row.text}`;
    })
    .join("\n");

  const roleTitle = titleOfRole(role);
  const roleInstruction =
    composeLayer(role, "role.prompt")?.effective
      || rolePromptText(role)
      || `Ты — ${roleTitle} в трекере TaskFlow.`;
  const prompt = renderInstruction(role, "chat.wrapper", { roleInstruction, localPolicy: composeLayer(role, "local_policy")!.effective, roleTitle, role, history: historyLines || "(пусто)", userText: args.userText });

  // Достаём ранее сохранённый sessionId, чтобы продолжить ту же сессию.
  const previousSessionId = getChatSessionId(chatId, roleUserId);

  // «Печатает» (владелец 22.09.2026): показываем ровно то время, пока роль
  // готовит ответ, — от запуска до готового текста или сбоя. Не таймер и не
  // догадка клиента: сигнал даёт тот, кто роль запускает.
  const typing = (active: boolean, tool?: string) => {
    const name =
      (db.prepare("SELECT name FROM users WHERE id = ?").get(roleUserId) as
        | { name?: string }
        | undefined)?.name ?? role;
    broadcastToUsers(memberIds(chatId), {
      type: "chats:typing",
      chat_id: chatId,
      user_id: roleUserId,
      name,
      active,
      ...(tool ? { tool } : {}),
    });
  };

  const roleName =
    (db.prepare("SELECT name FROM users WHERE id = ?").get(roleUserId) as
      | { name?: string }
      | undefined)?.name ?? role;
  const live = startLiveTurn({
    chatId,
    userId: roleUserId,
    name: roleName,
    audience: () => memberIds(chatId),
  });

  let reply: { sessionId: string | null; text: string } | null = null;
  let failure: unknown = null;
  let steps: SavedSteps | null = null;
  typing(true);
  try {
    reply = await startChatRun({
      chatId,
      role,
      roleId: roleUserId,
      prompt,
      sessionId: previousSessionId,
      onStep: (tool) => typing(true, tool),
      onEvent: live.onEvent,
    });
  } catch (error) {
    // Онлайн-сессия не должна ронять HTTP-запрос — пользовательский
    // текст уже в ленте. Но и молчать нельзя (владелец 27.09.2026): о
    // сорванном ходе в чат ложится сообщение с причиной.
    console.warn(
      `[chats] startChatRun не удался для chat=${chatId} role=${role}:`,
      error instanceof Error ? error.message : error,
    );
    failure = error;
  } finally {
    steps = live.finish();
    typing(false);
  }

  const replyText = failure
    ? chatRunFailureText(failure)
    : unwrapRoleEnvelope((reply?.text || "").trim()).trim();
  if (!replyText) return null;

  const replyId = uid();
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, steps)
     VALUES (?, ?, ?, 'chat', ?, ?)`,
  ).run(
    replyId,
    roleUserId,
    replyText,
    chatId,
    steps ? JSON.stringify(steps) : null,
  );
  db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(
    chatId,
  );

  const replyRow = db
    .prepare(
      `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
              f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
              t.title as task_title
         FROM chat_messages m
         LEFT JOIN users f ON f.id = m.from_user_id
         LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.id = ?`,
    )
    .get(replyId);

  const audience = memberIds(chatId);
  broadcastToUsers(audience, { type: "chat:new", message: replyRow });

  return replyId;
}

/** Тестовая утилита: сбросить кэш эмбеддингов ролей. Используется в
 *  тестах после подмены role_embeddings в БД. В проде не нужна —
 *  таблица меняется только руками через seed-скрипт. */
export function _resetChatRolePickerForTests(): void {
  roleEmbeddingCache.clear();
}
