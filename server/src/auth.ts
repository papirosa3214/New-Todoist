import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import db, { hashApiToken } from "./db.js";
import { isOrchestrator } from "./access.js";
import { isServiceUser } from "./serviceUser.js";
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
    const decoded = (app as any).jwt.verify(token) as { id: string; internalService?: string };
    if (decoded?.id) {
      // Вход архивной учётки больше не действует (владелец 01.10.2026:
      // «Оркестратор Claude» из архива появился в карточке). api_token
      // ниже не трогаем: им ходят службы трекера (taskflow-trigger).
      const row = db.prepare("SELECT archived FROM users WHERE id = ?").get(decoded.id) as
        | { archived: number | null }
        | undefined;
      // Служебная учётка в архиве, но её пропуск выписывает сам сервер
      // (внутренний планировщик) — снаружи ей войти нечем: вход архивных
      // закрыт, внешнего ключа у планировщика больше нет.
      const internalScheduler = isServiceUser(decoded.id) && decoded.internalService === "scheduler";
      return row?.archived && !internalScheduler ? null : decoded.id;
    }
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
  // Нативное приложение (01.09.2026): у него нет ни Sec-Fetch-*, ни Origin,
  // а User-Agent — «TaskFlow/1.0 CFNetwork/... Darwin/...», то есть под
  // прежнее правило оно не попадало и дома всё равно просило пароль.
  //
  // Смысл ограничения при этом сохраняется. Оно защищает не от подделки, а
  // от того, что скрипты агентов, живущие на этой же машине, СЛУЧАЙНО
  // ходили бы curl-ом под учёткой владельца (так 19.08.2026 её руками были
  // закрыты 27 шагов). Ни curl, ни requests такого заголовка не отправляют,
  // пока их об этом не попросят специально — а специально просить нельзя:
  // у агента есть своя дверь, постоянный api_token.
  if (String(h["x-taskflow-client"] || "") === "ios-native") return true;
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
 */
export async function authOrApiToken(req: FastifyRequest, reply: FastifyReply) {
  const token = extractBearer(req);
  const userId = token
    ? resolveUserIdFromToken(req.server as FastifyInstance, token)
    : null;
  if (userId) {
    if (deleteForbidden(req, reply, userId)) return reply;
    (req as any).userId = userId;
    // Отпечаток активности (29.08.2026, задача 31f2759e): на каждый запрос
    // агента обновляем «когда видели» и «что делает». Используется в
    // GET /api/agents (online/last_action) и в WS-событиях активности.
    // Не бросает — упавший отпечаток не должен ронять авторизацию.
    touchActive(userId, req.method, req.url);
    return;
  }
  // Токена нет или он протух — из домашней сети пускаем владельцем, но
  // только если это браузер (см. lanOwnerId): скрипту эта дверь закрыта.
  const owner = lanOwnerId(req);
  if (owner) {
    if (deleteForbidden(req, reply, owner)) return reply;
    (req as any).userId = owner;
    return;
  }
  return reply.code(401).send({
    error: token
      ? "Invalid token"
      : "нужен ключ: агент ходит своим api_token (Authorization: Bearer …), " +
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

/** Скоупы, которые есть у токена, проходящего через preHandler. Сейчас
 *  поддерживается только один — runtime:auth (см. ownerOrApiToken). При
 *  появлении новых скоупов — расширять enum и проверки. */
export type ApiScope = "runtime:auth";

/** Токен с областью runtime:auth — единственный способ через API-ключ
 *  вызвать connectProvider / putRouting. Задаётся ENV
 *  TASKFLOW_RUNTIME_AUTH_TOKEN. Миграция БД не нужна (18.09.2026, спек:
 *  «Что не входит — миграция БД»). Если ENV не задан — ни один
 *  api_token не имеет runtime:auth, и доступ к connect остаётся только
 *  у owner/service. */
const RUNTIME_AUTH_TOKEN: string | undefined =
  process.env.TASKFLOW_RUNTIME_AUTH_TOKEN?.trim() || undefined;

/** Доступ к runtime-операциям (connectProvider, putRouting). Принимает:
 *  1) api_token из ENV TASKFLOW_RUNTIME_AUTH_TOKEN (scope runtime:auth);
 *  2) user с role ∈ (owner, service).
 *  Обычный api_token (из users.api_token) НЕ проходит. */
export async function ownerOrApiToken(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractBearer(req);

  // (1) Специальный api-token со scope runtime:auth
  if (RUNTIME_AUTH_TOKEN && token && token === RUNTIME_AUTH_TOKEN) {
    (req as any).apiTokenScopes = ["runtime:auth"] as ApiScope[];
    return;
  }

  // (2) User с ролью owner/service
  const userId = token
    ? resolveUserIdFromToken(req.server as FastifyInstance, token)
    : null;
  if (userId) {
    if (deleteForbidden(req, reply, userId)) return reply as unknown as void;
    const row = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(userId) as { role: string | null } | undefined;
    const role = row?.role ?? "";
    if (role === "owner" || role === "service") {
      (req as any).userId = userId;
      touchActive(userId, req.method, req.url);
      return;
    }
    return reply.code(403).send({ error: "owner_or_service_required" });
  }

  // Из LAN owner тоже пускаем (как authOrApiToken), но только если
  // это браузер — скрипту эта дверь закрыта.
  const owner = lanOwnerId(req);
  if (owner) {
    const row = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(owner) as { role: string | null } | undefined;
    if (row?.role === "owner") {
      if (deleteForbidden(req, reply, owner)) return reply as unknown as void;
      (req as any).userId = owner;
      return;
    }
  }
  return reply.code(401).send({
    error: token
      ? "Invalid token or missing runtime:auth scope"
      : "нужен ключ: owner/service или api_token со scope runtime:auth",
  });
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
