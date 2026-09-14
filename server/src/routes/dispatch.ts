// Карточка 5ceda583 — мост «owner поднял ready_for_pickup на задаче без
// исполнителя» → «канонический 8-ролевой выбор → запуск через Pi».
//
// Эта обязанность НЕ ложится на /api/tasks/:id/enrich (routes/enrichment.ts):
// тот мутирует ready_for_pickup прямо в обогащении (по сути — двух
// операций в одной транзакции), да ещё и возвращает архитектора первым
// всегда. Диспетчер — отдельная ось, и здесь он делает ровно одну вещь:
// фиксирует роль и отдаёт задачу единственному Pi runtime.
//
// Что делает endpoint:
//   1. Гейты: задача активна, ready_for_pickup=1, assignee_id IS NULL.
//      Чужое назначение не сбивается (защита от подмены уже розданной
//      работы), повторный dispatch — отказ (тот же защитный мотив, что и
//      у claim).
//   2. Выбирает роль: owner_selected_role → иначе «architect»
//      (дефолт-первый, чтобы поведение не менялось для уже
//      подготовленных карточек — ровно «returns architect first» из
//      описания дефекта, но теперь через явный шаг диспетчера).
//   3. Ставит assignee_id = Pi runtime, пишет dispatched_role/at/by,
//      отправляет notification (assigned) и agent_inbox (assignment) —
//      оба шва доставки должны сработать, иначе будильник задачу не
//      увидит (см. AGENT-PROTOCOL.md и логику trigger.py:
//      notification:new → handle_task).
//   4. ready_for_pickup НЕ трогает: это ось владельца, диспетчер её
//      не двигает, и повторное поднятие флага после отмены диспетчером
//      не должно стирать чужое решение.
//
// Реализация намеренно не вызывает существующий /enrich: тот мутирует
// readiness и смешивает концерны. Этот маршрут — единственная точка
// перехода «готовая карточка без исполнителя» → «у Пи».
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent, broadcastToUsers } from "../ws.js";
import { ROLE_NAMES, type RoleName } from "../roleRouting.js";
import { getTaskRow, hydrateTask } from "./tasks.js";

const uid = () => crypto.randomUUID();

// Единственный Pi runtime (миграция 005, role-routing.yaml). Все 8 ролей
// выполняет один и тот же Pi — отсюда и единственная точка выдачи: это
// не fan-out, а fan-in. Расходится только ролью: prompt/profile/model
// подбираются по выбранной роли уже внутри Pi.
const PI_AGENT_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2";

// Дефолтная роль диспетчера. Та же, что отдаёт /enrich «архитектором
// первым» — фиксируем явно, чтобы при изменении /enrich контракт
// диспетчера не сдвигался: задача, до которой владелец не добрался
// выбором роли, уходит архитектору, и это документировано здесь, а не
// в наследуемом поведении enricher'а.
const DEFAULT_DISPATCH_ROLE: RoleName = "architect";

function pickRole(ownerSelected: string | null | undefined): RoleName {
  // owner_selected_role валидируется на PATCH (миграция 038), здесь
  // проверка двойная — диспетчер не должен доверять колонке, если её
  // мог заполнить путь в обход роута (например, прямая правка БД).
  if (
    typeof ownerSelected === "string" &&
    (ROLE_NAMES as readonly string[]).includes(ownerSelected)
  ) {
    return ownerSelected as RoleName;
  }
  return DEFAULT_DISPATCH_ROLE;
}

/** Чем кончилась попытка отдать карточку Pi. */
export type DispatchOutcome =
  { ok: true; role: RoleName } | { ok: false; code: number; error: string };

/**
 * Ядро диспетчера: гейты, фиксация роли, назначение Pi и оба шва доставки.
 *
 * Вынесено из маршрута, потому что путей сюда два, а правила допуска должны
 * быть одни (раздел 8.2 спецификации от 14.09.2026):
 *   - ручной режим: владелец нажал «отдать в работу» → HTTP-маршрут ниже;
 *   - автоматический: конвейер надиктовки сам поднял флаг и зовёт эту же
 *     функцию напрямую, без похода в собственный HTTP.
 * Если бы автоматика ходила своим путём, гейты неизбежно разъехались бы —
 * и «автомат» начал бы запускать то, что руками запустить нельзя.
 *
 * Гейт «только владелец» сюда НЕ входит: он про того, кто нажимает, и
 * живёт в маршруте. Здесь — про состояние карточки.
 */
export function dispatchTaskToPi(
  taskId: string,
  actorId: string,
): DispatchOutcome {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as any;
  if (!task) {
    return { ok: false, code: 404, error: "Not found" };
  }
  if (task.status !== "active") {
    return {
      ok: false,
      code: 400,
      error: "отдать задачу исполнителю можно только пока она активна",
    };
  }
  if ((task.ready_for_pickup ?? 0) !== 1) {
    return {
      ok: false,
      code: 400,
      error:
        "задача ещё не готова к отдаче: владелец не поднял флаг готовности",
    };
  }
  if (task.assignee_id) {
    return {
      ok: false,
      code: 400,
      error:
        "у задачи уже назначен исполнитель — диспетчер не отдаёт чужую работу",
    };
  }

  const chosen = pickRole(task.owner_selected_role);

  const rejectionRef: { current: { code: number; error: string } | null } = {
    current: null,
  };
  const txn = db.transaction(() => {
    // Перечитываем строку под транзакцией: между SELECT выше и моментом
    // захвата write-лока кто-то мог успеть назначить исполнителя.
    // Повторный dispatch в таком случае — отказ, без затирания чужого
    // решения.
    const latest = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as any;
    if (!latest) {
      rejectionRef.current = { code: 404, error: "Not found" };
      return;
    }
    if (latest.status !== "active") {
      rejectionRef.current = {
        code: 400,
        error: "задача больше не активна — диспетчер не отдаёт её",
      };
      return;
    }
    if ((latest.ready_for_pickup ?? 0) !== 1) {
      rejectionRef.current = {
        code: 400,
        error: "задача больше не готова к отдаче",
      };
      return;
    }
    if (latest.assignee_id) {
      rejectionRef.current = {
        code: 400,
        error: "у задачи уже есть исполнитель — гонка за dispatch проиграна",
      };
      return;
    }

    const previousRole = latest.dispatched_role ?? null;

    db.prepare(
      `UPDATE tasks
          SET assignee_id = ?,
              dispatched_role = ?,
              dispatched_at = datetime('now'),
              dispatched_by = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(PI_AGENT_ID, chosen, actorId, taskId);

    logEvent({
      taskId,
      actorId,
      kind: "task_dispatched",
      field: "dispatched_role",
      fromValue: previousRole,
      toValue: chosen,
    });

    // Notification — основной шов, через него будильник ловит назначение.
    const notifId = uid();
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
       VALUES (?, ?, 'assigned', ?, ?, ?)`,
    ).run(
      notifId,
      PI_AGENT_ID,
      taskId,
      `Новая задача назначена: ${(latest.title || taskId).slice(0, 200)}`,
      actorId,
    );

    // Inbox-событие — второй шов доставки (карточка 5f292e87).
    const inboxId = uid();
    db.prepare(
      `INSERT INTO agent_inbox
         (id, chat_message_id, to_user_id, body_text, task_id, task_version,
          kind, event_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'text', 'assignment', 'sent', datetime('now'))`,
    ).run(
      inboxId,
      `dispatch-${inboxId}`,
      PI_AGENT_ID,
      `Вам назначена задача «${(latest.title || taskId).slice(0, 120)}» (роль ${chosen}).`,
      taskId,
      Number(latest.current_revision ?? 1),
    );

    broadcastToUsers([PI_AGENT_ID], {
      type: "notification:new",
      notificationId: notifId,
      taskId,
    });
  });
  txn();

  if (rejectionRef.current) {
    return {
      ok: false,
      code: rejectionRef.current.code,
      error: rejectionRef.current.error,
    };
  }

  const updated = getTaskRow(taskId);
  broadcastTaskEvent([updated.creator_id, updated.assignee_id], {
    type: "task:updated",
    task: hydrateTask(updated),
  });

  return { ok: true, role: chosen };
}

/**
 * Отпустить следующие карточки очереди после закрытия предшественницы.
 *
 * Зачем: автоматический режим поднимает флаг всему дереву, но отдаёт
 * исполнителю только карточки без незакрытой предшественницы — иначе
 * второй шаг поехал бы раньше первого. Без этой функции такие карточки
 * висели бы готовыми навсегда: автомат делал ровно один шаг дерева и
 * вставал, а владелец видел «готово, но никто не берёт».
 *
 * Зависимость между дочерними карточками живёт строкой в описании
 * («⛓ ОЧЕРЕДЬ: после карточки «…»») — отдельной таблицы зависимостей в
 * трекере нет (см. queueLine в lib/ownerDraft.ts). Поэтому и ищем по ней,
 * а не по несуществующему графу.
 *
 * Карточку, которой владелец не поднимал флаг, функция не трогает: гейт
 * готовности проверяет dispatchTaskToPi. В ручном режиме это значит, что
 * очередь не поедет сама, и так и задумано — там запускает владелец.
 */
export function releaseQueuedSuccessors(completedTaskId: string): number {
  const completed = db
    .prepare("SELECT id, title, parent_id FROM tasks WHERE id = ?")
    .get(completedTaskId) as
    { id: string; title: string | null; parent_id: string | null } | undefined;
  // Очередь существует только между дочерними карточками одного дерева.
  if (!completed?.parent_id || !completed.title) return 0;

  const marker = `⛓ ОЧЕРЕДЬ: после карточки «${completed.title}»`;

  const siblings = db
    .prepare(
      `SELECT id, description, ready_for_pickup, assignee_id, status
         FROM tasks
        WHERE parent_id = ? AND id <> ?`,
    )
    .all(completed.parent_id, completed.id) as Array<{
    id: string;
    description: string | null;
    ready_for_pickup: number | null;
    assignee_id: string | null;
    status: string;
  }>;

  let released = 0;
  for (const sibling of siblings) {
    // Сверяем подстроку в JS, а не через LIKE: название карточки пишет
    // модель, в нём легко встретится и кавычка, и процент, и подчёркивание
    // — экранировать их в SQL дороже и ошибочнее, чем сравнить здесь.
    if (!sibling.description?.includes(marker)) continue;
    if (sibling.status !== "active") continue;
    if ((sibling.ready_for_pickup ?? 0) !== 1) continue;
    if (sibling.assignee_id) continue;

    const outcome = dispatchTaskToPi(sibling.id, PI_AGENT_ID);
    if (outcome.ok) {
      released += 1;
    } else {
      // Не молчим: карточка осталась готовой и видимой на доске, но
      // причина, по которой её не удалось отдать, должна быть в журнале.
      console.warn(
        `очередь: карточку ${sibling.id} не удалось отдать после закрытия ${completedTaskId}:`,
        outcome.error,
      );
    }
  }

  return released;
}

export function registerDispatchRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  // POST /api/tasks/:id/dispatch — отдать готовую карточку без исполнителя
  // единственному Pi runtime с зафиксированной ролью. Атомарно: гейты,
  // фиксация роли, assignee, оба шва доставки и широковещание.
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/dispatch",
    { preHandler: authPre },
    async (req: any, reply) => {
      const { id } = req.params;

      // ГЕЙТ 1: только владелец. Это единственный гейт, который живёт в
      // маршруте, — он про того, КТО нажимает. Гейты состояния карточки
      // (активна, поднят флаг, свободен исполнитель) живут в
      // dispatchTaskToPi, потому что их обязан проходить и автоматический
      // режим, который сюда по HTTP не ходит.
      if (!isOwner(req.userId)) {
        return reply.code(403).send({
          error:
            "отдать готовую задачу исполнителю может только владелец трекера",
        });
      }

      const outcome = dispatchTaskToPi(id, req.userId);
      if (!outcome.ok) {
        return reply.code(outcome.code).send({ error: outcome.error });
      }

      return { task: hydrateTask(getTaskRow(id)) };
    },
  );
}
