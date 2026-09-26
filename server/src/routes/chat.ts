// Чат агентов (27.08.2026, решение владельца): канал координации между
// исполнителями — Клод, Гермес и остальные — по образцу телеграм-канала.
//
// 28.08.2026 канал стал ДВУМЯ (владелец: «должно быть тут 2 канала: у нас с
// тобой, оркестратор, и другой канал между вами, чтобы я только для контроля
// туда смотрел, а по сути вёл диалог только с тобой»). До этого канал был
// один, и Максим оказывался диспетчером четырёх агентов сразу: любой из них
// адресовался ему напрямую и ждал ответа.
//
//   channel='owner'  — ОКНО ПОСТАНОВКИ ЗАДАЧ (10.09.2026, карточка
//                      4396f8c9). Раньше это был «разговор владельца с
//                      оркестратором», и написанное сюда уходило поручением
//                      живому агенту. Автономного оркестратора решением
//                      08.09.2026 нет и не будет, так что адресовать было
//                      некому: владелец наговаривает сюда задачу, её
//                      разбирает локальная модель, и в ответ приходит
//                      карточка-черновик. Думающего посредника в этом канале
//                      нет — работает скрипт (lib/ownerDraft.ts).
//   channel='agents' — рабочая переписка исполнителей и оркестратора.
//                      Владелец её читает для контроля и может написать в неё
//                      сам, если хочет озадачить кого-то лично. Адресатом он
//                      там бывает ровно в одном случае — когда исполнитель
//                      ОТВЕЧАЕТ на его же сообщение (28.08.2026, карточка
//                      4caa266f); заговорить с ним первым исполнителю
//                      по-прежнему нечем.
//
// Внутри своего канала сообщение по-прежнему видит каждый его участник:
// to_user_id остаётся адресным намёком (кого будить/кому отвечают), а не
// приватным ЛС.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { broadcastToUsers } from "../ws.js";
import { isOwner } from "../access.js";
import { currentTypists, startTyping, stopTyping } from "../chatTyping.js";
import {
  attachmentRow,
  saveUploadedFile,
  UploadRejected,
} from "./attachments.js";
import { routeAddressee, loadCatalog } from "./agent-inbox.js";
import { registryRecord } from "../agentState.js";
import { startDraftFromChat } from "../lib/ownerDraft.js";

const uid = () => crypto.randomUUID();

// Будильник для резидента Гермеса (27-28.08.2026, подзадача «Сторона
// Гермеса»): MCP "taskflow" у него уже подключён (taskflow_chat_send/read),
// но это pull-only инструменты — без вебхука он никогда не узнает о новом
// сообщении. Формат подписи — генерик V2 вебхук-адаптера Гермеса
// (gateway/platforms/webhook.py): hex(HMAC-SHA256(secret, "<ts>.<body>")) в
// заголовке X-Webhook-Signature-V2 + X-Webhook-Timestamp, окно ±300с.
const HERMES_USER_ID = "u3";
const HERMES_WEBHOOK_URL =
  process.env.HERMES_WEBHOOK_URL ||
  "http://127.0.0.1:8644/webhooks/taskflow_chat";

// Вложения сообщения — одним запросом на сообщение. Отдаются и в истории, и
// в рассылке по сокету, чтобы клиенту не приходилось догружать их отдельно и
// пузырь не прыгал, дорисовывая скрепку через полсекунды после появления.
// Готовится ЛЕНИВО, а не на уровне модуля. index.ts импортирует маршруты
// (строка 32) раньше, чем прогоняет миграции (runMigrations, строка 146):
// db.prepare с колонкой chat_message_id на ещё не обновлённой базе упал бы
// прямо на импорте — сервер не поднялся бы вовсе, и по сообщению об ошибке
// связь с миграцией никак не читалась бы.
let attachmentsOf: import("better-sqlite3").Statement | null = null;

function withAttachments(message: any) {
  if (!message) return message;
  attachmentsOf ??= db.prepare(
    `SELECT id, file_name, mime, size FROM attachments
      WHERE chat_message_id = ? ORDER BY created_at`,
  );
  return { ...message, attachments: attachmentsOf.all(message.id) };
}

function notifyHermesWebhook(message: any) {
  if (message.to_user_id !== HERMES_USER_ID) return;
  const secret = process.env.TASKFLOW_WEBHOOK_SECRET;
  if (!secret) {
    // Сервер не перезапущен с секретом (vault-run drop-in) — не шум, просто
    // пропуск: отправка сообщения в чат не должна зависеть от этого пути.
    console.warn(
      "chat: TASKFLOW_WEBHOOK_SECRET не задан — вебхук Гермесу не отправлен",
    );
    return;
  }
  const body = JSON.stringify({
    task_id: message.task_id,
    from_name: message.from_user_name || message.from_user_id,
    text: message.text,
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("hex");

  // Fire-and-forget: упавший/занятый Гермес не должен ронять отправку
  // сообщения в TaskFlow — это уведомление, не доставка.
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 3000);
  fetch(HERMES_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature-V2": sig,
      "X-Webhook-Timestamp": ts,
    },
    body,
    signal: ctl.signal,
  })
    .catch((err) => {
      console.warn("chat: вебхук Гермесу не доставлен:", err.message || err);
    })
    .finally(() => clearTimeout(timeout));
}

const CHAT_KINDS = new Set(["совещание", "делегирование", "находка"]);

// Адресат обязателен (28.08.2026, владелец: «как я должен догадаться, что ты
// мне написал, не упомянув ни слова обо мне»). Молчаливый пропуск поля
// больше не значит «всем»: «всем» — это ЯВНЫЙ выбор, слово в запросе.
// В базе «всем» по-прежнему NULL — схема не меняется, и старые сообщения
// (они тоже шли всем) в сводке читаются правильно.
const TO_ALL = new Set(["all", "всем", "*"]);
const TO_REQUIRED_HINT =
  'адресат обязателен: to_user_id = id участника или "all" (всем)';
const TEXT_MAX = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

// Сторож потолка (шаг «ПОВОД, а не счётчик»): правило — переписка живёт при
// задаче, разговор закрывается явно. Если оно где-то дырявое, за час
// натечёт лавина сообщений между агентами — это симптом, а не норма.
// Сторож не блокирует отправку (агенты не должны упереться в 429 посреди
// координации), только будит Максима, и не чаще раза в час, чтобб не
// заспамить его же самой тревогой.
const HOURLY_CEILING = 20;

function ownerId(): string | null {
  const row = db
    .prepare(
      "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

// ── Кто есть кто и что кому видно ───────────────────────────────────────
//
// Канал сообщения выводится ЗДЕСЬ, из ролей отправителя и адресата, и
// никогда не берётся из тела запроса. Иначе запрет «исполнитель не пишет
// владельцу напрямую» обходился бы одним лишним полем в JSON — то есть не
// существовал бы вовсе.
//
// Роли, а не зашитые идентификаторы: учётка оркестратора уже однажды
// переезжала между пользователями (chat_resident_watch.py, 28.08.2026), и
// зашитая константа разошлась с действительностью молча.
type Channel = "owner" | "agents";
const CHANNELS: Channel[] = ["owner", "agents"];

function roleOf(userId: string): string | null {
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as
    { role: string } | undefined;
  return row?.role ?? null;
}

function orchestratorId(): string | null {
  const row = db
    .prepare(
      "SELECT id FROM users WHERE role = 'orchestrator' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/** Какие каналы участник вправе читать. Исполнителю служебный, владельцу и
 *  оркестратору — оба: первому чтобы смотреть за работой, второму чтобы
 *  вести обе стороны разговора. */
function visibleChannels(userId: string): Channel[] {
  const role = roleOf(userId);
  return role === "owner" || role === "orchestrator"
    ? ["owner", "agents"]
    : ["agents"];
}

/** Какие каналы попадают в счётчик непрочитанного. Владельцу — только его
 *  собственный: служебную переписку он открывает сам, когда захочет, и
 *  дёргать его бейджем на каждое сообщение агентов — ровно то, от чего
 *  задача и заводилась. */
function unreadChannels(userId: string): Channel[] {
  if (roleOf(userId) === "owner") return ["owner"];
  return visibleChannels(userId);
}

// Сколько живёт право ответить владельцу (28.08.2026, карточка 4caa266f).
// Запрет «не пишу Максиму» означает «не начинаю разговор по своей
// инициативе», а не «молчу, когда он сам спросил»: иначе выходил тупик —
// владелец задал вопрос лично исполнителю, а ответ уезжал оркестратору,
// который этого вопроса не задавал. Слова владельца: «если я пишу кому-то в
// общем чате, то у этого типочка появляется возможность ответить мне в
// обраточку».
//
// Сутки — потому что цена ошибки несимметрична. Отказать слишком рано значит
// воспроизвести ровно тот баг, из-за которого правило и правится: агент мог
// уйти на два часа делать работу и вернуться с ответом. Пропустить лишнее
// почти безвредно: разговор всё равно лежит в служебной ленте у оркестратора
// на виду.
const REPLY_WINDOW_HOURS = 24;

/**
 * Открыто ли у исполнителя право ответить владельцу.
 *
 * Окно открывает только ЛИЧНОЕ обращение владельца (to_user_id = этот
 * исполнитель) в служебной ленте. Сообщение «всем» его не открывает: иначе
 * один броадкаст выдавал бы лицензию сразу всем агентам, и возвращался бы
 * Максим-диспетчер четверых, от которого каналы и заводились.
 *
 * Свои же ответы окно НЕ продлевают — считается только последнее сообщение
 * владельца. Иначе лицензия сама себя кормила бы: пиши раз в сутки, и она
 * вечная.
 *
 * Три исхода вместо булева ответа ради текста отказа: «он тебе не писал» и
 * «писал, но разговор давно кончился» — разные вещи, и агенту куда понятнее
 * прочитать, какая из них про него.
 */
function ownerReplyWindow(
  owner: string,
  agentId: string,
): "open" | "stale" | "never" {
  const row = db
    .prepare(
      `SELECT created_at > datetime('now', ?) AS fresh
         FROM chat_messages
        WHERE channel = 'agents' AND from_user_id = ? AND to_user_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(`-${REPLY_WINDOW_HOURS} hours`, owner, agentId) as
    { fresh: number } | undefined;
  if (!row) return "never";
  return row.fresh ? "open" : "stale";
}

/**
 * Куда ляжет сообщение и кому оно в итоге адресовано.
 *
 * Владелец пишет — в своё окно постановки задач, и адресата у такого
 * сообщения НЕТ (10.09.2026, карточка 4396f8c9). Раньше сервер молча
 * подставлял сюда оркестратора, и надиктовка становилась поручением живому
 * агенту; сейчас её разбирает локальная модель, а агента будить незачем и
 * некого. Обратно оркестратор по-прежнему может ответить владельцу в тот же
 * канал — учётка из чата не убрана, она просто больше не адресат поручений.
 * Любой другой отправитель, адресующийся владельцу, получает отказ с
 * подсказкой, куда нести вопрос.
 *
 * ⚠️ Запреты здесь — ИСПОЛНИТЕЛЯМ, но не хозяину (поправка оркестратора
 * 28.08.2026): «он владелец, а не участник схемы — если он всё же отправит
 * сообщение в агентскую ленту, оно должно уйти, просто строки ввода мы там
 * не показываем». Поэтому единственный, чьё желание про канал сервер
 * слушает, — владелец: попросил служебный, значит служебный. Разница между
 * «не предлагаем» и «запрещаем хозяину» принципиальная, второе он
 * справедливо примет за работу системы против себя.
 *
 * Пустой ответ по ролям (в базе нет владельца — так бывает на голой базе и
 * в тестах) означает «делить нечего»: всё уходит в служебный канал.
 */
type Routing = { channel: Channel; toUserId: string | null };

function routeMessage(
  fromUserId: string,
  toUserId: string | null,
  wanted: Channel | null,
): Routing | { error: string } {
  const owner = ownerId();
  if (!owner) return { channel: "agents", toUserId };

  const orchestrator = orchestratorId();
  if (fromUserId === owner)
    return wanted === "agents"
      ? { channel: "agents", toUserId }
      : { channel: "owner", toUserId: null };

  if (toUserId === owner) {
    if (fromUserId === orchestrator)
      return { channel: "owner", toUserId: owner };

    // Ответ на вопрос самого владельца ложится в СЛУЖЕБНУЮ ленту, а не в
    // личный канал: отвечают там же, где спросили, и оркестратор видит
    // разговор целиком, не вставая посередине.
    const window = ownerReplyWindow(owner, fromUserId);
    if (window === "open") return { channel: "agents", toUserId: owner };
    return {
      error:
        window === "stale"
          ? `Максим тебе писал, но тот разговор закончился (больше ${REPLY_WINDOW_HOURS} часов назад). Ответить можно, пока разговор идёт; новое — адресуй оркестратору, он решит сам или вынесет вопрос владельцу`
          : "Максиму напрямую не пишут: адресуй сообщение оркестратору — он решит сам или вынесет вопрос владельцу. Ответить ему можно только на его же сообщение — когда он написал тебе первым",
    };
  }

  return { channel: "agents", toUserId };
}

// Владелец озадачил исполнителя напрямую — оркестратор должен об этом
// ЗНАТЬ (28.08.2026, карточка 4caa266f): «оркестратор вообще не в курсе, что
// я мимо него кинул задачку». Именно знать, а не вставать посередине:
// сообщение никуда не сворачивается и ничем не гейтится, оркестратору просто
// падает уведомление. Сам разговор он и так видит — служебная лента открыта
// ему целиком.
//
// Сигналит момент раздачи работы (владелец → исполнитель), а не каждый ответ:
// ответы это уже течение разговора, о котором он предупреждён.
function notifyOrchestratorOfDirect(
  fromUserId: string,
  routed: Routing,
  taskId: string | null,
) {
  const owner = ownerId();
  const orchestrator = orchestratorId();
  if (!owner || !orchestrator) return;
  if (fromUserId !== owner) return;
  if (routed.channel !== "agents") return;
  // «Всем» — не раздача работы мимо оркестратора, он в этой рассылке и сам
  // адресат. Сообщение лично ему — тем более.
  if (!routed.toUserId || routed.toUserId === orchestrator) return;

  // Не чаще раза в час на одного исполнителя: смысл сигнала в том, что
  // работа ушла мимо, и он одинаков для первого сообщения и десятого подряд.
  const recent = db
    .prepare(
      `SELECT id FROM notifications
         WHERE user_id = ? AND type = 'chat_direct' AND text LIKE ?
           AND created_at > datetime('now', '-1 hour')`,
    )
    .get(orchestrator, `%${routed.toUserId}%`);
  if (recent) return;

  const to = db
    .prepare("SELECT name FROM users WHERE id = ?")
    .get(routed.toUserId) as { name: string } | undefined;
  const task = taskId
    ? (db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as
        { title: string } | undefined)
    : undefined;

  // task_id НАМЕРЕННО не проставляется, хотя карточка известна и в тексте
  // названа. Уведомление с task_id — это команда будильнику: trigger.py
  // ловит notification:new с taskId и поднимает по этой карточке сессию
  // (handle_task). Здесь такое было бы ровно тем «вставанием посередине»,
  // от которого владелец и отделял «видеть» от «вмешиваться»: оркестратор
  // должен узнать о раздаче работы, а не побежать её делать.
  const notifId = uid();
  db.prepare(
    "INSERT INTO notifications (id, user_id, type, text, actor_id) VALUES (?, ?, 'chat_direct', ?, ?)",
  ).run(
    notifId,
    orchestrator,
    `Максим написал напрямую: ${to?.name ?? routed.toUserId} (${routed.toUserId})` +
      (task ? ` по задаче «${task.title}»` : "") +
      " — работа роздана мимо тебя, разговор в служебной ленте чата",
    owner,
  );
  broadcastToUsers([orchestrator], {
    type: "notification:new",
    notificationId: notifId,
  });
}

function maybeRaiseCeilingAlarm(actorId: string) {
  const owner = ownerId();
  if (!owner || actorId === owner) return; // сам Максим лавину не устроит

  const { n } = db
    .prepare(
      `SELECT COUNT(*) as n FROM chat_messages
         WHERE channel = 'agents' AND from_user_id != ?
           AND created_at > datetime('now', '-1 hour')`,
    )
    .get(owner) as { n: number };
  if (n < HOURLY_CEILING) return;

  const recentAlarm = db
    .prepare(
      `SELECT id FROM notifications
         WHERE user_id = ? AND type = 'chat_alarm' AND created_at > datetime('now', '-1 hour')`,
    )
    .get(owner);
  if (recentAlarm) return; // уже тревожили в этот час — не дублировать

  const notifId = uid();
  db.prepare(
    "INSERT INTO notifications (id, user_id, type, text) VALUES (?, ?, 'chat_alarm', ?)",
  ).run(
    notifId,
    owner,
    `Чат агентов: за час ${n}+ сообщений между исполнителями — правило «повод, а не счётчик» где-то дырявое, посмотри переписку`,
  );
  broadcastToUsers([owner], {
    type: "notification:new",
    notificationId: notifId,
  });
}

export function registerChatRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Участники канала — НЕ /api/agents: тот намеренно узкий (только связанные
  // общей задачей + системные боты, чтобы свежая учётка не смогла
  // перечислить всех людей в системе). Канал координации — обратный случай:
  // это шесть известных всем участников, и адресовать сообщение любому из
  // них должен уметь любой, а не только тот, с кем уже есть общая задача.
  app.get("/api/chat/participants", { preHandler: authPre }, async () => {
    // role — чтобы клиент знал, кто здесь оркестратор: в канале владельца
    // адресат один и постоянный, и выбирать его не из чего. Аватарка — ему
    // же: в этом канале вместо кнопки выбора стоит лицо собеседника.
    return db
      .prepare(
        `SELECT id, name, type, role, avatar_color, avatar_url, initials
           FROM users
          WHERE archived = 0 OR archived IS NULL
          ORDER BY name`,
      )
      .all();
  });

  // История. Курсор — id уже полученного сообщения (не таймстамп): секундная
  // точность SQLite даёт коллизии created_at, а по id сервер сам достаёт его
  // созданное_at и режет строго старше него по паре (created_at, id).
  app.get<{
    Querystring: {
      before?: string;
      limit?: string;
      task_id?: string;
      channel?: string;
    };
  }>("/api/chat", { preHandler: authPre }, async (req: any, reply) => {
    const limit = Math.max(
      1,
      Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT),
    );
    const taskId = req.query.task_id || null;

    // Канал спрашивают явно (экран владельца всегда так и делает), а без
    // него отдаём ВСЁ, что участнику видно. Молчаливый дефолт «служебный»
    // ослепил бы оркестратора-резидента: он читает канал инструментом
    // taskflow_chat_read без параметров и перестал бы видеть Максима.
    const allowed = visibleChannels(req.userId);
    const requested = req.query.channel || null;
    if (requested && !CHANNELS.includes(requested as Channel))
      return reply.code(400).send({
        error: `channel должен быть одним из: ${CHANNELS.join(", ")}`,
      });
    if (requested && !allowed.includes(requested as Channel))
      return reply.code(403).send({
        error:
          "этот канал не для исполнителей: разговор владельца с оркестратором читают только они двое",
      });
    const channels = requested ? [requested as Channel] : allowed;

    let cursor: { created_at: string; id: string } | null = null;
    if (req.query.before) {
      const row = db
        .prepare("SELECT created_at, id FROM chat_messages WHERE id = ?")
        .get(req.query.before) as
        { created_at: string; id: string } | undefined;
      if (!row) return reply.code(404).send({ error: "курсор не найден" });
      cursor = row;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    conditions.push(`m.channel IN (${channels.map(() => "?").join(", ")})`);
    params.push(...channels);
    if (taskId) {
      conditions.push("m.task_id = ?");
      params.push(taskId);
    }
    if (cursor) {
      conditions.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      params.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `SELECT m.*,
                  f.name as from_user_name, f.avatar_color as from_user_color,
                  f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
                  d.name as to_user_name, d.avatar_color as to_user_color,
                  t.title as task_title
             FROM chat_messages m
             LEFT JOIN users f ON f.id = m.from_user_id
             LEFT JOIN users d ON d.id = m.to_user_id
             LEFT JOIN tasks t ON t.id = m.task_id
             ${where}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ?`,
      )
      .all(...params, limit) as any[];

    rows.reverse(); // клиенту — от старых к новым, как в telegram-подобной ленте
    return {
      messages: rows.map(withAttachments),
      has_more: rows.length === limit,
    };
  });

  app.post<{
    Body: {
      text: string;
      to_user_id?: string;
      task_id?: string;
      kind?: string;
      channel?: string;
      attachment_ids?: string[];
      // Формат тела сообщения: text | voice (5f292e87 — голос из chat.ts
      // записывался как text; источник нужен, чтобы inbox помечал voice).
      source?: string;
    };
  }>("/api/chat", { preHandler: authPre }, async (req: any, reply) => {
    const text = (req.body?.text || "").trim();
    const attachmentIds: string[] = Array.isArray(req.body?.attachment_ids)
      ? req.body.attachment_ids
      : [];
    // Пустой текст допустим, когда приложены файлы — то же правило, что у
    // комментариев к задаче: «вот скриншот» без подписи это нормальное
    // сообщение. Пустое совсем, без файлов, по-прежнему 400.
    if (!text && attachmentIds.length === 0)
      return reply.code(400).send({ error: "text required" });
    if (text.length > TEXT_MAX)
      return reply.code(400).send({
        error: `text слишком длинный (${text.length}, предел ${TEXT_MAX})`,
      });

    const kind = req.body?.kind || null;
    if (kind && !CHAT_KINDS.has(kind))
      return reply.code(400).send({
        error: `kind должен быть одним из: ${[...CHAT_KINDS].join(", ")}`,
      });

    const taskId = req.body?.task_id || null;
    if (taskId) {
      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
      if (!task) return reply.code(404).send({ error: "задача не найдена" });
    }

    // Текст ошибки — сам механизм обучения: у резидента и Гермеса в живых
    // процессах висит СТАРАЯ схема инструмента, где `to` был необязателен,
    // и перечитать её они не могут. Единственное, что они увидят, — эта
    // строка, поэтому в ней сразу написано, чем поле заполнить.
    const rawTo =
      typeof req.body?.to_user_id === "string"
        ? req.body.to_user_id.trim()
        : "";
    if (!rawTo) return reply.code(400).send({ error: TO_REQUIRED_HINT });

    // Сначала «всем», и только потом поиск в users: иначе законный вариант
    // «всем» упал бы с «адресат не найден».
    let toUserId: string | null = null;
    if (!TO_ALL.has(rawTo.toLowerCase())) {
      const target = db.prepare("SELECT id FROM users WHERE id = ?").get(rawTo);
      if (!target)
        return reply
          .code(404)
          .send({ error: `адресат «${rawTo}» не найден. ${TO_REQUIRED_HINT}` });
      toUserId = rawTo;
    }

    // Канал и окончательный адресат — от сервера, из ролей. Поле channel в
    // теле запроса это не диктат клиента, а пожелание, и слушается оно
    // только у владельца (см. routeMessage): исполнителю выбирать канал
    // нечем — иначе запрет «не пишу владельцу напрямую» обходился бы одним
    // лишним полем в JSON.
    const wanted = req.body?.channel || null;
    if (wanted && !CHANNELS.includes(wanted as Channel))
      return reply.code(400).send({
        error: `channel должен быть одним из: ${CHANNELS.join(", ")}`,
      });

    const routed = routeMessage(req.userId, toUserId, wanted as Channel | null);
    // Отказ ВОЗВРАЩАЕТ написанное (поправка оркестратора 28.08.2026):
    // сообщение готовила модель, второй раз она его слово в слово не
    // напишет, а потерянный текст выглядит как сломанный канал.
    if ("error" in routed)
      return reply.code(400).send({
        error: routed.error,
        адресуй: "Оркестратор Claude",
        ваш_текст: text,
      });

    const id = uid();
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, to_user_id, task_id, kind, text, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.userId, routed.toUserId, taskId, kind, text, routed.channel);

    // Сообщение по задаче — признак жизни её исполнителя (карточка 5de557a5,
    // разбор DeepSeek-Agent, правка внесена 29.08.2026). До неё аренду
    // продлевал только комментарий в ленту задачи: правило «любое действие
    // агента по задаче продлевает аренду само» было написано, но на чат не
    // распространено. А писать в чат — теперь основной путь, и агент,
    // ответивший по своей задаче, через минуту проявлялся на доске как
    // брошенный, хотя продолжал работать. Живой прецедент 28.08.2026:
    // DeepSeek ответил в канал и тут же «пропал» по меркам сервера.
    //
    // Граница та же, что у комментария: продлеваем, только когда отправитель
    // и есть исполнитель, а задача реально в работе. Иначе сообщение
    // владельца по чужой задаче обнуляло бы чужой простой и прикрывало его.
    // updated_at и журнал не трогаем: это heartbeat по форме, а не правка
    // карточки (см. agentState.ts).
    if (taskId) {
      db.prepare(
        `UPDATE tasks
            SET agent_heartbeat_at = datetime('now')
          WHERE id = ? AND assignee_id = ? AND agent_state = 'in_progress'`,
      ).run(taskId, req.userId);
    }
    // Карточка 5f292e87: agent_inbox — единый механизм доставки. Сообщение
    // по задаче с явным адресатом пишет в inbox; UNIQUE на chat_message_id
    // обеспечивает дедупликацию (повтор — глотаем). Адресат берётся из
    // каталога команды: явный адресат приоритетен, иначе fallback в
    // Оркестратора. Обычный чат без task_id или без адресата — НЕ пишем
    // (это не поручение).
    //
    // Только СЛУЖЕБНАЯ лента (10.09.2026, карточка 4396f8c9): окно
    // постановки задач поручений не порождает вовсе. Раньше владелец,
    // написавший в своё окно по карточке, поднимал этим сессию агента —
    // ровно то, от чего окно и отделяется. Раздать работу он по-прежнему
    // может, но явно и в служебной ленте, где адресат виден.
    if (taskId && toUserId && routed.channel === "agents") {
      try {
        const inboxTo = routeAddressee(toUserId, req.userId, loadCatalog());
        const inboxId = uid();
        const bodyKind = req.body?.source === "voice" ? "voice" : "text";
        db.prepare(
          `INSERT INTO agent_inbox
             (id, chat_message_id, to_user_id, body_text, task_id,
              task_version, kind, event_type, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', 'sent', datetime('now'))`,
        ).run(
          inboxId,
          id,
          inboxTo,
          text,
          taskId,
          (
            db
              .prepare("SELECT current_revision FROM tasks WHERE id=?")
              .get(taskId) as any
          )?.current_revision ?? null,
          bodyKind,
        );
        registryRecord({
          source: "chat",
          trigger: "POST /api/chat",
          toUserId: inboxTo,
          data: {
            chat_message_id: id,
            task_id: taskId,
            event_type: "chat",
            source: bodyKind,
          },
          result: "inbox_sent",
        });
      } catch (e: any) {
        // Дедупликация — ТОЛЬКО по chat_message_id (Reviewer 5f292e87: чат
        // ловил любой UNIQUE). Прочие конфликты пробрасываем.
        if (!String(e?.message || "").includes("agent_inbox.chat_message_id"))
          throw e;
      }
    }

    // Файлы залиты заранее и лежат «ничьими» (chat_message_id = NULL) —
    // здесь их подбирает отправленное сообщение. Берём только свои и только
    // ещё не подобранные: чужое вложение к своему сообщению не привяжется,
    // даже если знать его идентификатор.
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
          `SELECT m.*,
                f.name as from_user_name, f.avatar_color as from_user_color,
                f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
                d.name as to_user_name, d.avatar_color as to_user_color,
                t.title as task_title
           FROM chat_messages m
           LEFT JOIN users f ON f.id = m.from_user_id
           LEFT JOIN users d ON d.id = m.to_user_id
           LEFT JOIN tasks t ON t.id = m.task_id
          WHERE m.id = ?`,
        )
        .get(id),
    );

    // Рассылка — всем участникам КАНАЛА, не только адресату: это то, что
    // делает канал каналом, а не парой личных сообщений. Служебный канал
    // уходит и владельцу — он смотрит в него для контроля, и лента у него
    // должна обновляться живьём, как у всех.
    //
    // ⚠️ Окно постановки задач рассылается ТОЛЬКО владельцу и адресату, а не
    // всем, кому канал виден (10.09.2026, карточка 4396f8c9). Резидент
    // оркестратора просыпается на любое событие chat:new, которое до него
    // долетело (~/.claude/skills/taskflow/server.ts), — то есть прежняя
    // рассылка «владельцу и оркестратору» и БЫЛА тем самым поручением,
    // независимо от того, что написано в поле адресата. Надиктовка теперь
    // никого не будит: у неё адресата нет, и уходит она только на экраны
    // самого владельца. Ответ оркестратора владельцу (адресат — владелец)
    // по-прежнему доезжает обоим.
    const audience =
      routed.channel === "owner"
        ? [...new Set([ownerId(), routed.toUserId, req.userId].filter(Boolean))]
        : (
            db.prepare("SELECT id FROM users").all() as Array<{ id: string }>
          ).map((r) => r.id);
    broadcastToUsers(audience as string[], { type: "chat:new", message });

    // Сообщение ушло — отправитель больше не «печатает». Гасим здесь, а не
    // ждём срока: иначе после отправки отметка висела бы ещё минуту у
    // агента, и выходило бы «Гермес печатает…» под его же свежим пузырём.
    stopTyping(req.userId);

    notifyHermesWebhook(message);
    notifyOrchestratorOfDirect(req.userId, routed, taskId);
    maybeRaiseCeilingAlarm(req.userId);

    // «Супер Секретарь» (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/):
    // Секретарь переехал в настоящую комнату /api/chats/chat-secretary —
    // этот канал (owner) им больше не пользуется, ответ живёт в
    // routes/chats.ts + lib/secretaryReply.ts. Надиктовка в окно постановки
    // задач (10.09.2026, карточка 4396f8c9) — на разбор локальной моделью,
    // как и было. Не ждём: разбор идёт десятки секунд, отправка сообщения
    // должна вернуться сразу.
    //
    // Сообщение С карточкой сюда не идёт: это не постановка новой задачи, а
    // разговор про уже существующую.
    if (routed.channel === "owner" && !taskId) startDraftFromChat(message);

    return message;
  });

  // Сводка «кого озадачивают чаще всего» (28.08.2026, владелец: «чтобы потом
  // статистику вести, кого озадачиваем чаще всего»). Без выбора периода:
  // вопрос владельца — «кого чаще», а не «кого чаще на прошлой неделе», и
  // лишний селектор пришлось бы объяснять.
  //
  // Считается ТОЛЬКО по служебной ленте (channel='agents') — распоряжение
  // оркестратора 28.08.2026 при разводе двух смежных карточек: канал
  // владельца это его разговор с оркестратором, а не нагрузка на
  // исполнителей, и смешение дало бы число, которое выглядит правдой, но
  // отвечает не на тот вопрос.
  //
  // to_user_id IS NULL — это «всем»: и явно выбранное сегодня, и сообщения
  // до введения обязательного адресата (они тоже уходили всем), поэтому
  // отдельной строкой «без адресата» сводку не засоряем.
  app.get("/api/chat/stats", { preHandler: authPre }, async () => {
    const ALL = "Всем";
    const total = (
      db
        .prepare(
          "SELECT COUNT(*) as n FROM chat_messages WHERE channel = 'agents'",
        )
        .get() as { n: number }
    ).n;

    const toRows = db
      .prepare(
        `SELECT m.to_user_id as id, COALESCE(d.name, ?) as имя, COUNT(*) as сообщений
           FROM chat_messages m
           LEFT JOIN users d ON d.id = m.to_user_id
          WHERE m.channel = 'agents'
          GROUP BY m.to_user_id
          ORDER BY сообщений DESC, имя`,
      )
      .all(ALL);

    const fromRows = db
      .prepare(
        `SELECT m.from_user_id as id, COALESCE(f.name, m.from_user_id) as имя,
                COUNT(*) as сообщений
           FROM chat_messages m
           LEFT JOIN users f ON f.id = m.from_user_id
          WHERE m.channel = 'agents'
          GROUP BY m.from_user_id
          ORDER BY сообщений DESC, имя`,
      )
      .all();

    const pairs = db
      .prepare(
        `SELECT m.from_user_id as от_id, COALESCE(f.name, m.from_user_id) as от,
                m.to_user_id as кому_id, COALESCE(d.name, ?) as кому,
                COUNT(*) as сообщений
           FROM chat_messages m
           LEFT JOIN users f ON f.id = m.from_user_id
           LEFT JOIN users d ON d.id = m.to_user_id
          WHERE m.channel = 'agents'
          GROUP BY m.from_user_id, m.to_user_id
          ORDER BY сообщений DESC, от, кому`,
      )
      .all(ALL);

    return { всего: total, кому: toRows, от_кого: fromRows, пары: pairs };
  });

  // Сколько сообщений пропущено с последнего прочтения — тем же полем
  // пользуются и бейдж экрана, и хвост «у тебя N непрочитанных» в ответах
  // taskflow_heartbeat/claim/subtask_work (mcp_server.py дёргает это же GET).
  app.get("/api/chat/unread", { preHandler: authPre }, async (req: any) => {
    const readRow = db
      .prepare("SELECT last_read_at FROM chat_reads WHERE user_id = ?")
      .get(req.userId) as { last_read_at: string } | undefined;
    const since = readRow?.last_read_at ?? "1970-01-01 00:00:00";
    const channels = unreadChannels(req.userId);
    // Второе условие — про владельца: его канал в счётчике только свой, но
    // ОТВЕТ на его же вопрос лежит в служебной ленте (28.08.2026, карточка
    // 4caa266f), и без этой строчки он спросил бы и не узнал, что ответили.
    // Остальным она ничего не меняет: служебная лента у них и так в списке.
    // Последнее условие — про надиктовку в окно постановки задач
    // (10.09.2026, карточка 4396f8c9): у неё нет адресата, и «без адресата»
    // в этом канале больше не значит «всем». Без этой строчки надиктовка
    // владельца легла бы в непрочитанное оркестратору — тот же зов агента,
    // только через счётчик. Самому владельцу она и так не считается: своё
    // отсекает from_user_id.
    const { n } = db
      .prepare(
        `SELECT COUNT(*) as n FROM chat_messages
           WHERE (channel IN (${channels.map(() => "?").join(", ")})
                  OR (channel = 'agents' AND to_user_id = ?))
             AND from_user_id != ?
             AND (to_user_id IS NULL OR to_user_id = ?)
             AND NOT (channel = 'owner' AND to_user_id IS NULL)
             AND created_at > ?`,
      )
      .get(...channels, req.userId, req.userId, req.userId, since) as {
      n: number;
    };
    return { непрочитано: n };
  });

  // Залить файл ДО отправки сообщения. Отдельный маршрут, а не общий с
  // задачами: тот требует task_id в пути и проверяет доступ к карточке, а у
  // сообщения чата карточки может не быть вовсе.
  app.post<{ Querystring: { name?: string } }>(
    "/api/chat/attachments",
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

  // «Печатает…». Сигнал явный и у человека, и у агента: у первого его шлёт
  // строка ввода на нажатия клавиш, у второго — инструмент MCP перед тем,
  // как браться за ответ (клавиатуры у него нет, угадывать нечего).
  // state='stop' — передумал/ушёл; отправленное сообщение гасит отметку
  // само (см. POST /api/chat выше).
  app.post<{ Body: { state?: string } }>(
    "/api/chat/typing",
    { preHandler: authPre },
    async (req: any) => {
      if (req.body?.state === "stop") {
        stopTyping(req.userId);
        return { печатает: false };
      }
      const started = startTyping(req.userId);
      return { печатает: !!started, гаснет_через_мс: started?.ttl_ms ?? 0 };
    },
  );

  // Снимок для только что открытого экрана: событие о начале печати ушло по
  // сокету до того, как экран подписался, и без снимка Максим, открыв чат
  // посреди чужого ответа, увидел бы ту же пустоту, ради которой всё
  // затевалось.
  app.get("/api/chat/typing", { preHandler: authPre }, async () => {
    return { typing: currentTypists() };
  });

  app.post("/api/chat/read", { preHandler: authPre }, async (req: any) => {
    db.prepare(
      `INSERT INTO chat_reads (user_id, last_read_at) VALUES (?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET last_read_at = datetime('now')`,
    ).run(req.userId);
    return { ok: true };
  });

  // Очистить ленту канала — владелец 21.09.2026: «должна быть возможность
  // очищать этот чат». Удаляем ВСЕ сообщения канала (owner/agents), не
  // трогая чаты с ролями (у них chat_id заполнен) и вложения.
  app.delete<{ Querystring: { channel?: string } }>(
    "/api/chat/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId))
        return reply
          .code(403)
          .send({ error: "очистить чат может только владелец" });
      const channel = req.query?.channel === "agents" ? "agents" : "owner";
      const info = db
        .prepare(
          "DELETE FROM chat_messages WHERE channel = ? AND chat_id IS NULL",
        )
        .run(channel);
      return { ok: true, deleted: info.changes };
    },
  );
}
