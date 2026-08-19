import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import db, { hashApiToken } from "./db.js";

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
 * Владелец трекера для входа без пароля из домашней сети.
 *
 * Требование Максима 19.08.2026: «в своей домашней сети не хочу постоянно
 * вбивать эти пароли». Включено флагом `TASKFLOW_LAN_NO_AUTH` — выключить
 * можно, не трогая код: убрать переменную и перезапустить сервер.
 *
 * Снаружи домашней сети (VPN-адрес, чужая подсеть) правило не действует, там
 * по-прежнему нужен токен.
 */
export function lanOwnerId(req: FastifyRequest): string | null {
  if (process.env.TASKFLOW_LAN_NO_AUTH !== "1") return null;
  if (!isLanRequest(req)) return null;
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
    (req as any).userId = userId;
    return;
  }
  // Токена нет или он протух — из домашней сети пускаем владельцем.
  const owner = lanOwnerId(req);
  if (owner) {
    (req as any).userId = owner;
    return;
  }
  return reply.code(401).send({ error: token ? "Invalid token" : "No token" });
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
