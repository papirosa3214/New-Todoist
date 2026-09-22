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
  return (
    typeof value === "string" &&
    (INTAKE_MODES as readonly string[]).includes(value)
  );
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
 * Зафиксировать режим владельца в строке черновика. Одна транзакция:
 *   1) INSERT INTO chat_task_drafts (chat_message_id, status, intake_mode)
 *      SELECT ?, 'pending', task_intake_mode FROM users WHERE id = ?
 *      ON CONFLICT(chat_message_id) DO NOTHING;
 *      при первом вызове — атомарно создаём строку черновика со статусом
 *      'pending' и снимком режима из users.task_intake_mode. При повторном
 *      вызове для того же chat_message_id — ON CONFLICT DO NOTHING молча
 *      пропускает вставку, и существующий снимок остаётся как есть (даже
 *      если владелец успел переключить users.task_intake_mode);
 *   2) читаем строку и возвращаем значение, которое в ней лежит.
 *
 * Никакого модульного состояния: повторный вызов в другом процессе, после
 * рестарта или в параллельной Node-сессии ведёт себя так же — берёт то,
 * что лежит в БД. Это и есть «поздние стадии не перечитывают настройку».
 *
 * Запись через INSERT ... SELECT из той же базы гарантирует, что режим
 * снимка — это users.task_intake_mode на момент вызова (а не статичный
 * DEFAULT 'manual'). На существующей строке SELECT пропускается целиком.
 */
export function snapshotIntakeMode(
  ownerId: string,
  chatMessageId: string,
): IntakeMode {
  return claimDraftForParsing(ownerId, chatMessageId).mode;
}

/**
 * То же, что snapshotIntakeMode, плюс ответ на вопрос «эту строку черновика
 * создали мы или она уже была».
 *
 * Нужно конвейеру надиктовки: раньше защитой от повторного разбора служило
 * падение INSERT на PRIMARY KEY, но снимок режима вставляет строку через
 * ON CONFLICT DO NOTHING и не падает. Без признака claimed повторная
 * доставка того же сообщения запустила бы второй разбор параллельно первому
 * и завела бы вторую пачку карточек.
 *
 * claimed=true означает «строку создал этот вызов, разбирать твоя очередь».
 */
export function claimDraftForParsing(
  ownerId: string,
  chatMessageId: string,
): { mode: IntakeMode; claimed: boolean } {
  const apply = db.transaction(() => {
    // Атомарный upsert: при первом вызове — вставляем строку черновика
    // со снимком режима из users, при повторном — ON CONFLICT оставляет
    // уже зафиксированное значение нетронутым. Никаких промежуточных
    // SELECT перед INSERT: гонки «выбрали режим → владелец переключил →
    // вставили старое» тут нет, потому что и SELECT, и INSERT — одна
    // statement на одной и той же БД.
    // changes=1 значит строку создал именно этот вызов. Для конвейера
    // надиктовки это и есть право начать разбор: тот, кто пришёл вторым,
    // получит 0 и уйдёт, вместо того чтобы завести вторую пачку карточек
    // по тому же сообщению.
    const inserted = db
      .prepare(
        `INSERT INTO chat_task_drafts (chat_message_id, status, intake_mode)
       SELECT ?, 'pending', task_intake_mode
         FROM users
        WHERE id = ?
       ON CONFLICT(chat_message_id) DO NOTHING`,
      )
      .run(chatMessageId, ownerId);

    const row = db
      .prepare(
        "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get(chatMessageId) as { intake_mode: IntakeMode } | undefined;
    if (!row) {
      // Сюда попадаем, только если у userId нет строки в users (тогда
      // INSERT ... SELECT дал 0 строк и ничего не вставил) или если
      // chat_message_id вовсе не существует в chat_messages (FK на
      // chat_messages сработает на INSERT, и в БД ничего не появится).
      // В обоих случаях хелпер должен явно об этом сказать — молчаливое
      // «manual» смазало бы ошибку в конвейере.
      throw new Error(
        `claimDraftForParsing: строка chat_task_drafts ${chatMessageId} не появилась ` +
          `(проверьте, что владелец ${ownerId} существует и сообщение ${chatMessageId} ` +
          `уже в chat_messages)`,
      );
    }
    // На случай, если в строке оказалось значение вне enum (например,
    // БД правили руками) — отдать дефолт, не пускать чужой режим.
    const mode: IntakeMode = isIntakeMode(row.intake_mode)
      ? row.intake_mode
      : "manual";
    return { mode, claimed: inserted.changes === 1 };
  });

  return apply();
}

export function registerTaskIntakeRoutes(app: FastifyInstance): void {
  // «✓ Идёт» на карточке Секретаря в чате — запустить черновик целиком.
  // Только владелец: флаг готовности — его решение.
  app.post<{ Params: { id: string } }>(
    "/api/task-intake/drafts/:id/start",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const owner = ownerIdOrNull();
      if (!owner || req.userId !== owner) {
        return reply.code(403).send({ error: "только владелец" });
      }
      // Отложенный импорт: ownerDraft сам зависит от этого модуля.
      const { startDraftTree } = await import("../lib/ownerDraft.js");
      const result = await startDraftTree(req.params.id, owner);
      if (!result) return reply.code(404).send({ error: "черновик не найден" });
      return { ok: true, ...result };
    },
  );

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
        .prepare("SELECT task_intake_mode, reviewer_first_default FROM users WHERE id = ?")
        .get(owner) as { task_intake_mode: IntakeMode; reviewer_first_default?: number } | undefined;
      // Колонка заведена миграцией 037 с NOT NULL DEFAULT 'manual', так
      // что row всегда есть. Страховка для рассинхрона схемы.
      const mode: IntakeMode = row?.task_intake_mode ?? "manual";
      return { mode, reviewer_first_default: (row?.reviewer_first_default ?? 1) === 1 };
    },
  );

  // PATCH — только владелец. Нераспознанный режим → 400, значение в БД
  // не трогается. CHECK в схеме страхует от гонки и от того, чтобы в БД
  // когда-либо лежало значение вне enum — хелпер snapshotIntakeMode
  // дальше по конвейеру считывает только эти два.
  app.patch<{ Body: { mode?: unknown; reviewer_first_default?: unknown } }>(
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
      const hasMode = req.body?.mode !== undefined;
      const hasReviewer = req.body?.reviewer_first_default !== undefined;
      if (!hasMode && !hasReviewer) {
        return reply
          .code(400)
          .send({ error: "нужно поле mode или reviewer_first_default" });
      }
      if (hasMode) {
        const raw = req.body?.mode;
        if (!isIntakeMode(raw)) {
          return reply.code(400).send({
            error: `mode должен быть одним из: ${INTAKE_MODES.join(", ")}`,
          });
        }
        db.prepare("UPDATE users SET task_intake_mode = ? WHERE id = ?").run(
          raw,
          owner,
        );
      }
      if (hasReviewer) {
        const raw = req.body?.reviewer_first_default;
        if (typeof raw !== "boolean") {
          return reply
            .code(400)
            .send({ error: "reviewer_first_default должен быть boolean" });
        }
        db.prepare("UPDATE users SET reviewer_first_default = ? WHERE id = ?").run(
          raw ? 1 : 0,
          owner,
        );
      }
      const row = db
        .prepare("SELECT task_intake_mode, reviewer_first_default FROM users WHERE id = ?")
        .get(owner) as { task_intake_mode: IntakeMode; reviewer_first_default?: number } | undefined;
      return {
        mode: row?.task_intake_mode ?? "manual",
        reviewer_first_default: (row?.reviewer_first_default ?? 1) === 1,
      };
    },
  );
}
