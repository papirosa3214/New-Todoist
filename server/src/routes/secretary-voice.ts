// POST /api/secretary/voice-token — короткоживущий LiveKit room-токен для
// голосового разговора с Секретарём. Только владелец. Комната одна и та же
// между сессиями одного владельца (`secretary-voice-<ownerId>`) — так
// Python-воркер (server/agents/secretary-voice) может использовать
// автоматический dispatch по факту создания комнаты, без ручной регистрации
// per-session. Секрет LiveKit не уходит на телефон — только подписанный JWT.
import type { FastifyInstance } from "fastify";
import { AccessToken } from "livekit-server-sdk";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

// Gemini Live молча подменяет незнакомое имя голосом по умолчанию, поэтому
// список закрытый — тот же, что в настройках приложения и в воркере.
const SECRETARY_VOICES = new Set(["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"]);

function ownerIdOrNull(): string | null {
  const row = db
    .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function registerSecretaryVoiceRoutes(app: FastifyInstance): void {
  app.post("/api/secretary/voice-token", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const owner = ownerIdOrNull();
    if (!owner) return reply.code(404).send({ error: "владелец не найден" });
    if (req.userId !== owner) {
      return reply.code(403).send({ error: "только владелец" });
    }

    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) {
      return reply.code(503).send({ error: "LiveKit не настроен на сервере" });
    }

    const room = `secretary-voice-${owner}`;
    const voice = req.body?.voice;
    const attributes = SECRETARY_VOICES.has(voice) ? { voice } : undefined;
    const at = new AccessToken(apiKey, apiSecret, { identity: owner, ttl: "10m", attributes });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();

    return { url, token, room };
  });
}
