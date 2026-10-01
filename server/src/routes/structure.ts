// Собрать постановку из ПРОИЗВОЛЬНОГО текста (заметка, файл) — тот же контур,
// что и надиктовка из чата: локальная модель → родитель + шаги + дочерние
// карточки. Отдельный маршрут, потому что владелец 20.09.2026 хочет большой
// текст (диалог, план) прогнать не через чат с его лимитом в 4000 символов,
// а прямо из заметки, и получить дерево «как положено по схеме».
//
// Ничего не запускаем: карточки ложатся черновиком без флага готовности —
// владелец откроет и поднимет флаг сам. Только владелец.
import { NonTaskInputError } from "../lib/taskPreparation.js";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { createDraftFromText, ownerId } from "../lib/ownerDraft.js";

export function registerStructureRoutes(app: FastifyInstance) {
  app.post<{ Body: { text?: string } }>(
    "/api/ai/structure-draft",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const owner = ownerId();
      if (!owner || req.userId !== owner) {
        return reply.code(403).send({ error: "только владелец" });
      }
      const text = String(req.body?.text || "").trim();
      if (text.length < 20) {
        return reply.code(400).send({ error: "текст слишком короткий" });
      }
      try {
        const { parentId, childIds, title } = await createDraftFromText(
          text,
          owner,
        );
        return { task_id: parentId, children: childIds.length, title };
      } catch (e) {
        if (e instanceof NonTaskInputError) return reply.code(422).send({intent:e.intent,error:e.message,task_id:null});
        return reply
          .code(502)
          .send({ error: `Модель не справилась: ${(e as Error).message}` });
      }
    },
  );
}
