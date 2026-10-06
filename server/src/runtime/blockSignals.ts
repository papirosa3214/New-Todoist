/**
 * Сигнал по типизированному блоку (MAK-98).
 *
 * Когда роль уходит в `blocked`, мало записать тип: нужно, чтобы сигнал
 * дошёл до того, кто может снять препятствие. `needs_input` с признаком
 * «меняет результат карточки» (затрагивает «Результат», «Критерии приёмки»
 * или «Границы») идёт владельцу; остальные осмысленные блоки —
 * оркестратору. `dependency` и `transient` снимаются механизмами
 * (готовностью зависимости, повторным запуском) и сигнала не требуют.
 *
 * Тот же вид блока на том же шаге второй раз подряд — уже не случайность, а
 * застой: отдельное событие `block_type_repeated`, чтобы оркестратор видел
 * его в ленте, а не перечитывал всю историю.
 */
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent, registryRecord } from "../agentState.js";
import { broadcastToUsers } from "../ws.js";
import { blockSignalTarget, blockTypeLabel } from "../lib/blockedType.js";

function ownerId(): string | null {
  return (
    (
      db
        .prepare(
          "SELECT id FROM users WHERE role = 'owner' AND COALESCE(archived,0) = 0 ORDER BY created_at LIMIT 1",
        )
        .get() as { id: string } | undefined
    )?.id ?? null
  );
}

function orchestratorId(): string | null {
  return (
    (
      db
        .prepare(
          "SELECT id FROM users WHERE role = 'orchestrator' AND COALESCE(archived,0) = 0 ORDER BY created_at LIMIT 1",
        )
        .get() as { id: string } | undefined
    )?.id ?? null
  );
}

function pushNotification(userId: string, taskId: string, type: string, text: string, actorId: string | null): void {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, type, taskId, text, actorId);
  broadcastToUsers([userId], { type: "notification:new", notificationId: id, taskId });
}

/**
 * Провести сигнал по блоку. Возвращает адресата (`owner`/`orchestrator`/null)
 * и признак повтора того же типа на этом шаге. Пишет событие в ленту
 * карточки и уведомление адресату, а также строку в реестр диспетчеризации.
 */
export function signalBlock(input: {
  taskId: string;
  actorId: string | null;
  blockType: string;
  changesResult: boolean;
  reason?: string | null;
  /** Подзадача-шаг плана (если блок по шагу). */
  subtaskId?: string | null;
  /** Предыдущий тип блока на этом же шаге (null — блок впервые). */
  previousBlockType?: string | null;
  stepTitle?: string | null;
}): { target: "owner" | "orchestrator" | null; repeated: boolean } {
  const repeated =
    !!input.previousBlockType && input.previousBlockType === input.blockType;

  logEvent({
    taskId: input.taskId,
    actorId: input.actorId,
    kind: "block_type",
    field: input.subtaskId ? `subtask:${input.subtaskId}` : "task",
    fromValue: input.previousBlockType ?? null,
    toValue: input.blockType,
  });

  if (repeated) {
    logEvent({
      taskId: input.taskId,
      actorId: input.actorId,
      kind: "block_type_repeated",
      field: input.subtaskId ? `subtask:${input.subtaskId}` : "task",
      toValue: input.blockType,
    });
    registryRecord({
      source: "block_signals",
      trigger: "block_type_repeated",
      toUserId: orchestratorId(),
      data: {
        task_id: input.taskId,
        subtask_id: input.subtaskId ?? null,
        block_type: input.blockType,
      },
      result: "repeated",
    });
    const orch = orchestratorId();
    if (orch) {
      const where = input.stepTitle ? ` на шаге «${input.stepTitle}»` : "";
      pushNotification(
        orch,
        input.taskId,
        "orchestrator_signal",
        `Повторный блок «${blockTypeLabel(input.blockType)}»${where}: ${(input.reason ?? "").slice(0, 200)}`,
        input.actorId,
      );
    }
  }

  const target = blockSignalTarget(input.blockType, input.changesResult);
  if (!target) return { target: null, repeated };

  const text =
    target === "owner"
      ? `Блок меняет результат карточки (${blockTypeLabel(input.blockType)}): ${(input.reason ?? "").slice(0, 300)}`
      : `Блок «${blockTypeLabel(input.blockType)}», нужна помощь оркестратора: ${(input.reason ?? "").slice(0, 300)}`;
  logEvent({
    taskId: input.taskId,
    actorId: input.actorId,
    kind: target === "owner" ? "owner_signal" : "orchestrator_signal",
    field: input.subtaskId ? `subtask:${input.subtaskId}` : "task",
    toValue: text,
  });
  const recipient = target === "owner" ? ownerId() : orchestratorId();
  if (recipient) {
    // Тип уведомления — не 'agent_state': триггер notifications_owner_no_activity
    // глушит его для учётки владельца, и сигнал бы не до шёл.
    pushNotification(
      recipient,
      input.taskId,
      target === "owner" ? "owner_signal" : "orchestrator_signal",
      text,
      input.actorId,
    );
  }
  registryRecord({
    source: "block_signals",
    trigger: target === "owner" ? "owner_signal" : "orchestrator_signal",
    toUserId: recipient,
    data: {
      task_id: input.taskId,
      subtask_id: input.subtaskId ?? null,
      block_type: input.blockType,
      changes_result: input.changesResult,
    },
    result: target,
  });
  return { target, repeated };
}
