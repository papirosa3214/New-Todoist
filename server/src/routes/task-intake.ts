// Owner intake mode (карточка 5f292e87, серверная половина, шаг 1).
//
// GET   /api/task-intake/settings     — текущий режим ('manual'|'automatic'),
//                                       источник правды users.task_intake_mode.
// PATCH /api/task-intake/settings     — изменить режим; только владелец;
//                                       нераспознанное значение → 400.
//                                       НЕ хранится в user_defaults — это
//                                       пользовательская настройка, которая
//                                       лежит на пользователе.
//
// snapshotIntakeMode(ownerId, chatMessageId) — транзакционный хелпер для
// конвейера надиктовки: фиксирует users.task_intake_mode в строке
// chat_task_drafts ДО работы модели. Повторный вызов для того же сообщения
// возвращает уже зафиксированное значение — режим владельца мог
// переключиться, но карточка остаётся в той настройке, в которой была
// надиктована. Это и есть «поздние стадии не перечитывают настройку».

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

export type IntakeMode = "manual" | "automatic";

const INTAKE_MODES: readonly IntakeMode[] = ["manual", "automatic"] as const;

function isIntakeMode(value: unknown): value is IntakeMode {
  return typeof value === "string" && (INTAKE_MODES as readonly string[]).includes(value);
}

/** Текущая роль — единственный способ проверить, что перед нами владелец.
 *  Используем тот же подход, что в routes/agent-details.ts (requireOwner):
 *  никакого trust клиентскому полю «role», всегда перечитываем. */
function ownerIdOrNull(): string | null {
  const row = db
    .prepare(
      "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * chat_message_id, для которых снимок режима уже сделан в этой сессии.
 *
 * Колонка chat_task_drafts.intake_mode — NOT NULL DEFAULT 'manual', так
 * что по самому значению в строке нельзя отличить «записано хелпером» от
 * «дефолт миграции» (оба выглядят как 'manual'). Без отдельного маркера
 * повторный вызов хелпера для того же сообщения перечитывал бы
 * users.task_intake_mode — и перезаписывал бы снимок, если владелец
 * успел переключить режим. Эта карта — наш маркер.
 *
 * Живёт только в памяти процесса: помощь нужна ровно на время обработки
 * одного сообщения, после чего хелпер уже не дёргают. При перезапуске
 * сервера снимок не нужен — следующее сообщение создаст новую строку, и
 * хелпер для неё сработает с чистого листа.
 */
const snapshotted = new Set<string>();

/**
 * Зафиксировать режим владельца в строке черновика. Одна транзакция:
 *   1) прочитать текущий users.task_intake_mode;
 *   2) если для этого chat_message_id снимок ещё не делался — записать
 *      прочитанное значение в chat_task_drafts.intake_mode и запомнить
 *      chat_message_id в snapshotted. Если уже делался — не перечитывать
 *      пользовательскую настройку и не перезаписывать строку;
 *   3) вернуть значение, которое лежит в строке.
 *
 * Логика «один снимок на сообщение» держит его стабильным, даже если
 * владелец переключит режим между попытками. Хелпер детерминирован для
 * одного chat_message_id: первый вызов фиксирует режим, все последующие
 * возвращают то же значение.
 */
export function snapshotIntakeMode(
  ownerId: string,
  chatMessageId: string,
): IntakeMode {
  if (snapshotted.has(chatMessageId)) {
    const row = db
      .prepare(
        "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get(chatMessageId) as { intake_mode: IntakeMode } | undefined;
    if (!row) {
      throw new Error(
        `snapshotIntakeMode: строка chat_task_drafts ${chatMessageId} не найдена`,
      );
    }
    // На случай, если в строке оказалось значение вне enum (например,
    // БД правили руками) — отдать дефолт, не пускать чужой режим.
    return isIntakeMode(row.intake_mode) ? row.intake_mode : "manual";
  }

  const apply = db.transaction(() => {
    const userRow = db
      .prepare(
        "SELECT task_intake_mode FROM users WHERE id = ?",
      )
      .get(ownerId) as { task_intake_mode: IntakeMode } | undefined;
    // Без владельца работать не с чем — пусть это видно сразу, на этапе
    // хелпера. Не в роуте — там владелец уже проверен, а вот следующие
    // этапы конвейера могут звать хелпер из фонового пути.
    if (!userRow) {
      throw new Error(
        `snapshotIntakeMode: владелец ${ownerId} не найден в users`,
      );
    }
    const fromUser = userRow.task_intake_mode;

    const draftRow = db
      .prepare(
        "SELECT 1 FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get(chatMessageId);
    if (!draftRow) {
      throw new Error(
        `snapshotIntakeMode: строка chat_task_drafts ${chatMessageId} не найдена`,
      );
    }

    db.prepare(
      "UPDATE chat_task_drafts SET intake_mode = ? WHERE chat_message_id = ?",
    ).run(fromUser, chatMessageId);
    return fromUser;
  });

  const result = apply();
  snapshotted.add(chatMessageId);
  // Валидация на случай расхождения схемы: если в БД оказалось значение
  // вне нашего enum, дать дефолт, а не пускать чужой режим в конвейер.
  return isIntakeMode(result) ? result : "manual";
}

export function registerTaskIntakeRoutes(app: FastifyInstance): void {
  // GET — текущий режим. Источник правды (владелец) — фиксированный:
  // ровно один, тот же, что в /api/agents. Не-владельцу возвращаем 403:
  // настройка чужая, и читать её чужим агентам незачем.
  app.get(
    "/api/task-intake/settings",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const owner = ownerIdOrNull();
      if (!owner) {
        // Нет владельца в БД — настройки читать не у кого. 404 честнее,
        // чем дефолтное значение, которое не от чего отличить.
        return reply.code(404).send({ error: "владелец не найден" });
      }
      if (req.userId !== owner) {
        return reply.code(403).send({ error: "только владелец" });
      }
      const row = db
        .prepare(
          "SELECT task_intake_mode FROM users WHERE id = ?",
        )
        .get(owner) as { task_intake_mode: IntakeMode } | undefined;
      // Колонка заведена миграцией 037 с NOT NULL DEFAULT 'manual', так
      // что row всегда есть. Страховка для рассинхрона схемы.
      const mode: IntakeMode = row?.task_intake_mode ?? "manual";
      return { mode };
    },
  );

  // PATCH — только владелец. Нераспознанный режим → 400, значение в БД
  // не трогается. CHECK в схеме страхует от гонки и от того, чтобы в БД
  // когда-либо лежало значение вне enum — хелпер snapshotIntakeMode
  // дальше по конвейеру считывает только эти два.
  app.patch<{ Body: { mode?: unknown } }>(
    "/api/task-intake/settings",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const owner = ownerIdOrNull();
      if (!owner) {
        return reply.code(404).send({ error: "владелец не найден" });
      }
      if (req.userId !== owner) {
        return reply.code(403).send({ error: "только владелец" });
      }
      const raw = req.body?.mode;
      if (!isIntakeMode(raw)) {
        return reply
          .code(400)
          .send({ error: `mode должен быть одним из: ${INTAKE_MODES.join(", ")}` });
      }
      db.prepare(
        "UPDATE users SET task_intake_mode = ? WHERE id = ?",
      ).run(raw, owner);
      return { mode: raw };
    },
  );
}
