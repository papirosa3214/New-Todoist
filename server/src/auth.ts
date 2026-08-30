import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import db, { hashApiToken } from "./db.js";
import { isOrchestrator } from "./access.js";
import { touchTyping } from "./chatTyping.js";
import { touchActive } from "./activeAgent.js";

/**
 * Оркестратору удаление запрещено — на любом объекте и любым способом.
 *
 * Формулировка владельца (задача af2107b2, 28.08.2026): «полные права на
 * управление проектами и задачами ботов… право на удаление объектов должно
 * быть запрещено». Проверка стоит здесь, в общей двери авторизации, а не в
 * одиннадцати DELETE-роутах поимённо: через authOrApiToken проходит каждый
 * из них, и роут, дописанный завтра, будет закрыт с рождения — а список,
 * который надо не забыть пополнить, рано или поздно забывают пополнить.
 *
 * 403, а не 404: оркестратор объект видит и правит, отказано ему именно в
 * действии — молчаливое «не найдено» тут только запутает.
 */
function deleteForbidden(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): boolean {
  if (req.method !== "DELETE" || !isOrchestrator(userId)) return false;
  reply.code(403).send({
    error:
      "оркестратор не удаляет объекты: он раздаёт и правит работу, а удаление остаётся за владельцем",
  });
  return true;
}

/**
 * Resolves a bearer token to a userId. Accepts either:
 *  - a JWT issued by /api/auth/register or /api/auth/login (web frontend), or
 *  - a static users.api_token (AI agents — Claude/Hermes/etc).
 * Returns null if the token is missing/empty or matches neither.
 */
export function resolveUserIdFromToken(
  app: FastifyInstance,
  token: string | undefined | null,
): string | null {
  if (!token) return null;

  try {
    const decoded = (app as any).jwt.verify(token) as { id: string };
    if (decoded?.id) return decoded.id;
  } catch {
    // Not a valid/current JWT — fall through and try it as an api_token.
  }

  // В базе лежит ОТПЕЧАТОК ключа, не сам ключ (см. hashApiToken в db.ts):
  // хэшируем предъявленный и ищем совпадение. Прямое сравнение оставлять
  // нельзя — тогда утёкший файл базы сразу давал бы доступ агента.
  const row = db
    .prepare(
      "SELECT id FROM users WHERE api_token = ? AND api_token IS NOT NULL AND api_token != ''",
    )
    .get(hashApiToken(token)) as { id: string } | undefined;
  return row?.id ?? null;
}

function extractBearer(req: FastifyRequest): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "");
}

/**
 * Запрос пришёл из домашней сети?
 *
 * Считаем домашними обычные приватные диапазоны и петлю. Заголовкам
 * X-Forwarded-For намеренно НЕ верим: их подделывает кто угодно, а здесь от
 * этой проверки зависит вход без пароля.
 */
function isLanRequest(req: FastifyRequest): boolean {
  const ip = (req.ip || "").replace(/^::ffff:/, "");
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Запрос сделан из браузера, а не скриптом?
 *
 * Браузер обязан присылать метаданные запроса: `Sec-Fetch-*` (все движки с
 * 2020 года), `Origin`/`Referer` у fetch с фронта и `User-Agent: Mozilla/...`.
 * `curl`, `urllib`, `requests` не шлют ничего из этого, пока их об этом
 * специально не попросят.
 *
 * По адресу браузер от скрипта не отличить: фронт ходит через прокси Vite
 * (`vite.config.ts`, `/api → localhost:3001`), поэтому запрос Максима с
 * телефона приходит на сервер с того же 127.0.0.1, что и запрос локального
 * скрипта. Заголовки — единственный разделитель, который тут есть.
 */
function looksLikeBrowser(req: FastifyRequest): boolean {
  const h = req.headers;
  if (h["sec-fetch-mode"] || h["sec-fetch-site"] || h["sec-fetch-dest"]) {
    return true;
  }
  if (h.origin || h.referer) return true;
  return /Mozilla\//.test(String(h["user-agent"] || ""));
}

/**
 * Владелец трекера для входа без пароля из домашней сети.
 *
 * Требование Максима 19.08.2026: «в своей домашней сети не хочу постоянно
 * вбивать эти пароли». Включено флагом `TASKFLOW_LAN_NO_AUTH` — выключить
 * можно, не трогая код: убрать переменную и перезапустить сервер.
 *
 * Снаружи домашней сети (VPN-адрес, чужая подсеть) правило не действует, там
 * по-прежнему нужен токен.
 *
 * ⛔ И НИКОГДА — СКРИПТУ. Максим 20.08.2026: «закрой мою учётку, как она
 * вообще открылась для вас… так же и другие агенты полезут через мои
 * учётки». Так и было: вход без пароля выдавал владельца любому запросу из
 * локальной сети, а агенты живут на этой же машине — то есть любой их
 * `curl` работал от имени Максима и проходил мимо всех запретов «агент не
 * закрывает шаги, агент не принимает задачи». Ими я 19.08.2026 и прошёл,
 * закрыв 27 шагов его руками.
 *
 * Поэтому послабление действует только для браузера. У агента есть своя
 * дверь — постоянный `api_token` (AGENT-API.md, ключ в хранилище под
 * `TASKFLOW_AGENT_TOKEN`), и ходить он обязан ею: под ней он `type='ai'`
 * со всеми вытекающими запретами.
 */
export function lanOwnerId(req: FastifyRequest): string | null {
  if (process.env.TASKFLOW_LAN_NO_AUTH !== "1") return null;
  if (!isLanRequest(req)) return null;
  if (!looksLikeBrowser(req)) return null;
  const row = db
    .prepare(
      "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Strict JWT-only auth. Used where an api_token must NOT be sufficient —
 * currently only the endpoint that issues/rotates the api_token itself, so a
 * leaked api_token can never be used to mint another one.
 */
export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const token = extractBearer(req);
  if (!token) return reply.code(401).send({ error: "No token" });
  try {
    const decoded = (req.server as any).jwt.verify(token) as { id: string };
    (req as any).userId = decoded.id;
  } catch {
    reply.code(401).send({ error: "Invalid token" });
  }
}

/**
 * Auth accepting EITHER a JWT (web frontend) OR an Authorization: Bearer
 * <api_token> (agents). This is the auth used on all data routes.
 *
 * 29.08.2026, задача 31f2759e: в этой же точке фиксируется отпечаток
 * активности агента (touchActive). Это не дубликат touchTyping — тот
 * держит WS-отметку «работает», этот — карту последнего действия
 * (последний путь, last_action, last_action_title). Делят один userId,
 * живут рядом, и в этой точке он гарантированно есть.
 */
export async function authOrApiToken(req: FastifyRequest, reply: FastifyReply) {
  const token = extractBearer(req);
  const userId = token
    ? resolveUserIdFromToken(req.server as FastifyInstance, token)
    : null;
  if (userId) {
    if (deleteForbidden(req, reply, userId)) return reply;
    (req as any).userId = userId;
    // Отметка «печатает…» по факту работы агента (29.08.2026, задача
    // a56f35f6). Стоит здесь, в общей двери авторизации, а не отдельным
    // global preHandler-хуком: глобальные preHandler-хуки в Fastify v5
    // выполняются ДО route-level preHandler, и из хука мы видели бы
    // req.userId=undefined. authOrApiToken — это и есть тот момент, когда
    // userId гарантированно стоит. Цикла импортов нет: chatTyping.ts
    // импортирует ws.ts, ws.ts auth.ts не трогает.
    touchTyping(userId);
    touchActive(userId, req.method, req.url);
    return;
  }
  // Токена нет или он протух — из домашней сети пускаем владельцем, но
  // только если это браузер (см. lanOwnerId): скрипту эта дверь закрыта.
  const owner = lanOwnerId(req);
  if (owner) {
    if (deleteForbidden(req, reply, owner)) return reply;
    (req as any).userId = owner;
    touchTyping(owner);
    return;
  }
  return reply.code(401).send({
    error: token
      ? "Invalid token"
      : "нужен ключ: агент ходит своим api_token (Authorization: Bearer *** " +
        "вход без пароля из домашней сети работает только в браузере",
  });
}

export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply) {
  const token = extractBearer(req);
  const userId = resolveUserIdFromToken(req.server as FastifyInstance, token);
  if (userId) (req as any).userId = userId;
  else {
    const owner = lanOwnerId(req);
    if (owner) (req as any).userId = owner;
  }
}

/**
 * Метка сессии, которая физически делает запрос.
 *
 * Несколько сессий (и вообще несколько агентов) работают под ОДНОЙ учёткой
 * в трекере, поэтому «кто исполнитель» не отвечает на вопрос «кто именно
 * сейчас над этим работает». Раньше метку присылал только MCP-клиент, и
 * только в теле claim/state — то есть любой другой способ обращения
 * (curl из скрипта, чужой агент, сторонний инструмент) оставлял работу
 * без хозяина, и её подхватывал кто угодно.
 *
 * Максим 20.08.2026: «система должна идентифицировать, кто создал и кто
 * работал по этой задаче или подзадаче, и реагировать исключительно на эту
 * сессию; другие сессии к этой задаче отношения не имеют».
 *
 * Заголовок — потому что он работает для ЛЮБОГО клиента и не зависит от
 * тела запроса. Тело (`session_id`) продолжает приниматься ради MCP,
 * который так делает с 18.08.2026.
 */
export function sessionOf(req: FastifyRequest): string | null {
  const h = req.headers["x-agent-session"];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  const fromBody = (req.body as any)?.session_id;
  return (fromHeader || fromBody || null) as string | null;
}
