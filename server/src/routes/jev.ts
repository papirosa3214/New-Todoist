// Настройки оценщика JEV — только владелец (как и серверные параметры:
// admin-server-settings.ts). Ключ наружу не отдаётся никогда, только
// признак hasApiKey.
//   GET    /api/jev/settings  — текущие настройки
//   PUT    /api/jev/settings  — сохранить (пустой apiKey ключ не стирает)
//   DELETE /api/jev/settings  — сбросить всё и удалить ключ
//   POST   /api/jev/test      — живая проверка сохранённого подключения
import { readObservability, readJevUsage } from "../lib/contextObservability.js";
import { currentJevKeyIdentity } from "../lib/jev.js";
import { startContextObservabilityWatcher } from "../lib/contextObservabilityWatcher.js";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import {
  getJevSettings,
  JevSettingsError,
  resetJevSettings,
  saveJevSettings,
  testJevConnection,
} from "../lib/jev.js";

function ownerOr403(req: any, reply: any): boolean {
  if (isOwner(req.userId)) return true;
  reply.code(403).send({ error: "доступно только владельцу" });
  return false;
}

export function registerJevRoutes(app: FastifyInstance): void {
  for(const url of ["/api/coordination/context-observability","/api/jev/usage"]) app.get(url,{preHandler:authOrApiToken},async(req:any,reply)=>{
    if(!ownerOr403(req,reply))return;
    const window=req.query?.window??"24h";
    if(!["24h","3d","week","month"].includes(window))return reply.code(400).send({error:"invalid_window"});
    return url.endsWith("/usage")?readJevUsage(currentJevKeyIdentity(),window):readObservability(window);
  });
  if(process.env.NODE_ENV!=="test"&&!process.env.VITEST){let stop=()=>{};app.addHook("onReady",async()=>{stop=startContextObservabilityWatcher();});app.addHook("onClose",async()=>stop());}

  app.get(
    "/api/jev/settings",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      return getJevSettings();
    },
  );

  app.put(
    "/api/jev/settings",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      try {
        return saveJevSettings(req.body ?? {});
      } catch (err) {
        if (err instanceof JevSettingsError)
          return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.delete(
    "/api/jev/settings",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      return resetJevSettings();
    },
  );

  app.post(
    "/api/jev/test",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      return testJevConnection();
    },
  );
}
