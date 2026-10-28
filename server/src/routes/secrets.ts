// Секреты владельца: мост к Agent Secret Broker (.110, 127.0.0.1:28443,
// служба agent-secret-broker под пользователем secretbroker).
//
// Брокер хранит API-ключи облачных сервисов; агенты пользуются ими через его
// MCP и значения не видят. Здесь — владельческий доступ из iOS-клиента:
// список, запись, просмотр значения, удаление. Сервер ходит в /owner-api
// брокера с токеном из файла (TASKFLOW_SECRET_BROKER_TOKEN_PATH, копия в
// vault: TASKFLOW_SECRET_BROKER_OWNER_TOKEN).
//
// Права: authOrApiToken + isOwner, и запрос НЕ с самого .110. Роли работают
// на этой же машине и через /api/auth/lan могут получить сессию владельца —
// поэтому секреты отдаются только другим устройствам сети (телефон, мак).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";

const SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "192.168.1.110"]);

function brokerUrl(): string {
  return process.env.TASKFLOW_SECRET_BROKER_URL || "http://127.0.0.1:28443";
}

function brokerToken(): string | null {
  const file =
    process.env.TASKFLOW_SECRET_BROKER_TOKEN_PATH ||
    path.join(os.homedir(), ".config", "taskflow", "secret-broker-owner.token");
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function allowed(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!isOwner((req as any).userId)) {
    reply.code(403).send({ error: "доступно только владельцу" });
    return false;
  }
  const ip = (req.ip || "").replace(/^::ffff:/, "");
  if (LOCAL_ADDRESSES.has(ip)) {
    reply.code(403).send({ error: "секреты открываются только с устройства владельца" });
    return false;
  }
  return true;
}

async function callBroker(
  reply: FastifyReply,
  method: string,
  suffix: string,
  body?: unknown,
): Promise<FastifyReply> {
  const token = brokerToken();
  if (!token) return reply.code(503).send({ error: "хранилище секретов не настроено" });
  let res: Response;
  try {
    res = await fetch(`${brokerUrl()}/owner-api/secrets${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return reply.code(502).send({ error: "хранилище секретов не отвечает" });
  }
  reply.header("cache-control", "no-store");
  if (res.status === 204) return reply.code(204).send();
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return reply.code(502).send({ error: "хранилище секретов ответило не JSON" });
  }
  if (res.status === 401) return reply.code(502).send({ error: "сервер не прошёл проверку в хранилище секретов" });
  return reply.code(res.status).send(payload);
}

function idOr400(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null {
  const id = req.params.id;
  if (!SECRET_ID.test(id)) {
    reply.code(400).send({ error: "id: латиница, цифры, точка, дефис, подчёркивание; до 64 символов" });
    return null;
  }
  return id;
}

export function registerSecretsRoutes(app: FastifyInstance): void {
  app.get("/api/secrets", { preHandler: authOrApiToken }, async (req, reply) => {
    if (!allowed(req, reply)) return;
    return callBroker(reply, "GET", "");
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/secrets/:id",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const id = idOr400(req, reply);
      if (!id) return;
      const b = req.body ?? {};
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      if (!str(b.name).trim() || !str(b.origin).trim() || !str(b.value)) {
        return reply.code(400).send({ error: "нужны name, origin и value" });
      }
      return callBroker(reply, "PUT", `/${encodeURIComponent(id)}`, {
        name: str(b.name).trim(),
        origin: str(b.origin).trim(),
        header_name: str(b.header_name).trim(),
        value: str(b.value),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/secrets/:id/reveal",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const id = idOr400(req, reply);
      if (!id) return;
      return callBroker(reply, "POST", `/${encodeURIComponent(id)}/reveal`);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/secrets/:id",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const id = idOr400(req, reply);
      if (!id) return;
      return callBroker(reply, "DELETE", `/${encodeURIComponent(id)}`);
    },
  );
}
