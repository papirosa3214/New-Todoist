// Рабочая папка чата (LOCK-CHAT-WORKSPACE-20261027): что выбрано и из чего
// выбирать; выбор действует со следующего хода роли.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { browseChatWorkspace, chatIdOfCopy, chatWorkspaceName, listChatWorkspaces, validChatWorkspace } from "../lib/chatWorkspace.js";

function state(chatId: string) {
  const selected = chatWorkspaceName(chatId);
  const options = listChatWorkspaces();
  const top = selected?.split("/")[0];
  const copy = options.find((option) => option.name === top)?.copy ?? false;
  return { selected, branch: copy ? `roles/${chatIdOfCopy(chatId)}` : null, options };
}

export function registerChatWorkspaceRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/chats/:id/workspace", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
    if (!db.prepare("SELECT id FROM chats WHERE id = ?").get(req.params.id)) return reply.code(404).send({ error: "Not found" });
    return state(req.params.id);
  });

  // Обзор папок для шторки выбора: заходить внутрь и выходить наверх.
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/chats/:id/workspace/browse",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
      const listing = browseChatWorkspace(typeof req.query?.path === "string" ? req.query.path : "");
      if (!listing) return reply.code(404).send({ error: "такой папки нет" });
      return listing;
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string | null } }>(
    "/api/chats/:id/workspace",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
      if (!db.prepare("SELECT id FROM chats WHERE id = ?").get(req.params.id)) return reply.code(404).send({ error: "Not found" });
      const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : null;
      if (name && !validChatWorkspace(name)) return reply.code(400).send({ error: "такой папки нет среди проектов" });
      db.prepare("UPDATE chats SET workspace = ? WHERE id = ?").run(name, req.params.id);
      return state(req.params.id);
    },
  );
}
