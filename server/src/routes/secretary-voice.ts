// POST /api/secretary/voice-token — короткоживущий LiveKit room-токен для
// голосового разговора с Секретарём. Только владелец. Каждый звонок —
// НОВАЯ комната (`secretary-voice-<ownerId>-<случайный хвост>`): LiveKit
// шлёт воркера только в свежесозданную комнату, а пустая комната после
// звонка ещё живёт какое-то время — второй звонок подряд в ту же комнату
// оставался без Секретаря (26.09.2026). Секрет LiveKit не уходит на
// телефон — только подписанный JWT.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
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

    const room = `secretary-voice-${owner}-${randomUUID().slice(0, 8)}`;
    const voice = req.body?.voice;
    const attributes = SECRETARY_VOICES.has(voice) ? { voice } : undefined;
    const at = new AccessToken(apiKey, apiSecret, { identity: owner, ttl: "10m", attributes });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();

    return { url, token, room };
  });
}
