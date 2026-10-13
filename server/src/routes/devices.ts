/**
 * Список устройств и отзыв (карточка b5a16110, документ решения §8 и §11.2).
 *
 * Отзыв — одна ручка, и она должна быть мгновенной. Здесь ставится
 * `revoked_at`, а `closeDeviceSockets()` (ws.ts) рвёт живые сокеты этого
 * устройства кодом 4401: приложение по этому коду отличает «устройство
 * отозвали» от «сеть моргнула» и возвращает экран привязки, а не
 * бесконечно переподключается.
 *
 * Офлайн-телефон узнаёт об отзыве при СЛЕДУЮЩЕМ своём запросе: проверка
 * `revoked_at IS NULL` живёт в resolveUserIdFromToken (auth.ts) и
 * выполняется на каждом запросе, кэша прав нет.
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { closeDeviceSockets } from "../ws.js";

export function registerDeviceRoutes(app: FastifyInstance) {
  // Список устройств владельца. Секретов в нём нет и быть не должно: в
  // базе лежит только sha256 токена, наружу отдаём префикс (tfd_ab12…),
  // по которому человек узнаёт свой телефон в списке.
  app.get("/api/devices", { preHandler: authOrApiToken }, async (req, reply) => {
    const userId = (req as any).userId as string;
    const devices = db
      .prepare(
        `SELECT id, name, model, os, app_version, install_id, token_prefix,
                created_at, last_seen_at, revoked_at, revoke_reason
           FROM devices
          WHERE user_id = ?
          ORDER BY created_at DESC`,
      )
      .all(userId);
    return devices;
  });

  // Отзыв. Идемпотентен: повторный DELETE снова 200, потому что «уже отозвано»
  // — это тот же результат, а не ошибка (телефон может повторно слать запрос,
  // пока разбирается, что произошло).
  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>(
    "/api/devices/:id",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      const userId = (req as any).userId as string;
      const deviceId = String(req.params.id);

      const device = db
        .prepare(
          "SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?",
        )
        .get(deviceId, userId) as
        | { id: string; revoked_at: string | null }
        | undefined;
      if (!device) return reply.code(404).send({ error: "device_not_found" });

      if (device.revoked_at) {
        // Уже отозвано — тот же успех, сокеты закрывать нечего.
        return { ok: true };
      }

      // Причина — в query, а не в теле: DELETE с телом через прокси и
      // клиенты iOS отбрасывается чаще, чем query, и терять из-за этого
      // сам отзыв нельзя. Причина по умолчанию одинаковая — она нужна для
      // журнала, а не для логики отзыва.
      const reason =
        String((req.query as any)?.reason || "revoked_by_owner").slice(0, 120);
      db.prepare(
        "UPDATE devices SET revoked_at = ?, revoke_reason = ? WHERE id = ?",
      ).run(new Date().toISOString(), reason, deviceId);

      // Живые сокеты этого устройства — вон. Сделано ДО ответа: приложение по
      // коду закрытия сразу знает, что пора на экран привязки, и не тратит
      // на это следующий запрос.
      closeDeviceSockets(deviceId);

      try {
        db.prepare(
          "INSERT INTO device_events(id, device_id, user_id, kind, created_at, data) VALUES (?,?,?,?,?,?)",
        ).run(
          `dev_${crypto.randomUUID()}`,
          deviceId,
          userId,
          "device_revoked",
          new Date().toISOString(),
          JSON.stringify({ reason }),
        );
      } catch {
        // Журнал не должен ронять отзыв: устройство уже отозвано.
      }

      return { ok: true };
    },
  );
}