import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import db from "./db.js";

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

  const row = db
    .prepare(
      "SELECT id FROM users WHERE api_token = ? AND api_token IS NOT NULL AND api_token != ''",
    )
    .get(token) as { id: string } | undefined;
  return row?.id ?? null;
}

function extractBearer(req: FastifyRequest): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "");
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
  if (!token) return reply.code(401).send({ error: "No token" });
  const userId = resolveUserIdFromToken(req.server as FastifyInstance, token);
  if (!userId) return reply.code(401).send({ error: "Invalid token" });
  (req as any).userId = userId;
}

export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply) {
  const token = extractBearer(req);
  const userId = resolveUserIdFromToken(req.server as FastifyInstance, token);
  if (userId) (req as any).userId = userId;
}
