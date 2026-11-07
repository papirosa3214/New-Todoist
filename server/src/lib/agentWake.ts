// Этап A (10.10.2026, карточка d3a628eb-…): единая точка решения «что делать
// с адресатом» для каждого нового сообщения в чате агентов. До этого этапа
// сообщение в чате либо попадало в `agent_inbox` (и просыпалось только на
// следующем heartbeat'е исполнителя), либо вообще терялось, если адресат
// был «спящим» — закрытый сокет, протухший `last_seen_at`, задача не на
// его слоте. Карточки `ad31e99a-…` это описывали как R1 (доставка в спящего)
// и R7 (пробуждение по сообщению). Закрываем оба.
//
// Граница модуля:
//   - ВХОД: `toUserId`, `taskId`, `chatMessageId` (всё, что есть в момент
//     INSERT в chat_messages). Плюс DI для wake-раннера в исполняющей части
//     (`applyAgentWake`) — чтобы тесты могли подменить `defaultRunner`.
//   - ВЫХОД: `WakeDecision` — структура с одним из `action`:
//       * `slot_wake` — адресат на слоте этой задачи и `agent_state IN
//         ('in_progress','review')` (см. В3 в feature_spec: «спящий =
//         in_progress/review»). Возвращаем найденный `codex_thread_id`.
//       * `general_wake` — адресат не на слоте, но `online=true`.
//         Пробуждаем по ОБЩЕМУ каналу: отдельный wake-тред без привязки к
//         проекту (`webhook_subscriptions.project_id IS NULL`), иначе —
//         самая свежая включённая подписка с thread_id. Если ни одного
//         wake-канала нет, честно `unreachable, reason='no_slot'`.
//       * `unreachable` — `online=false`, пользователя нет, либо
//         thread_id для wake не найден.
//
//   - ИСПОЛНЕНИЕ: `applyAgentWake` принимает `WakeDecision` и реальный
//     `WakeCommandRunner`, ставит wake в очередь (slot_wake/general_wake)
//     или пишет событие `task_events.kind='unreachable_role'` (unreachable),
//     обновляет `chat_messages.delivery_state` и (для slot_wake) пишет
//     событие `wake_dispatched`. Идемпотентность нездесь не накручиваем:
//     `unreachable_role` идёт через `INSERT` в `task_events`, и единственный
//     дубль в живых данных маловероятен (chat_message_id уникален), а
//     повторный вызов на ту же `chat_message_id` маловероятен по
//     конструкции POST /api/chat.
//
// Сценарии из feature_spec:
//   1. Архитектор шлёт спящему критику → агент просыпается,
//      `delivery_state='delivered'` (или, до ответа на В1, остаётся
//      `'wake_queued'`).
//   2. Архитектор шлёт офлайн-агенту → `task_events.unreachable_role`,
//      `delivery_state='unreachable'`, без ретраев и broadcast'а в чат.
//
// Открытые вопросы (наследуются из feature_spec, до ответа владельца
// сохраняем fallback-ы из implementation_pack):
//   В1 — момент фиксации 'delivered' (закрыт по критерию приёмки карточки):
//        получатель отмечает прочтение (POST /api/chat/read — его зовёт
//        инструмент `taskflow_chat_read`), и все адресованные ему ещё не
//        доставленные сообщения переходят в 'delivered'. Это и есть ACK
//        от получателя: прочитал — значит доставлено.
//   В4 — формат payload_json: `{chat_message_id, to_user_id, reason}`.
//   В5 — отдельная колонка `delivery_state`: введена миграцией 130.
//   В6 — общий канал wake: `general_wake` отправляет wake через общий
//        (не привязанный к проекту) thread_id в ту же очередь
//        `webhook_wake_queue` / `tf_wake_dispatch`.

import db from "../db.js";
import { logEvent } from "../agentState.js";
import { wakeRunner } from "./webhookSubscriptions.js";

// Решение о доставке. Не содержит side-effects: чистая функция поверх БД.
export type WakeDecision =
  | {
      action: "slot_wake";
      threadId: string;
      message: string;
      chatMessageId: string;
    }
  | {
      action: "general_wake";
      threadId: string;
      message: string;
      chatMessageId: string;
    }
  | {
      action: "unreachable";
      reason: "offline" | "no_user" | "no_slot";
      chatMessageId: string;
    };

export interface ResolveAgentWakeInput {
  toUserId: string;
  taskId: string | null;
  chatMessageId: string;
}

/** Сообщение, с которым будится адресат. Человекочитаемое, чтобы Pi
 *  увидел в очереди сразу суть, не раскручивая context. Префикс «[wake]»
 *  помогает лога `webhook_wake_queue` отличать эти записи от подписочных
 *  пробуждений по событиям. */
function wakeMessage(chatMessageId: string, text: string): string {
  const trimmed = text.length > 140 ? text.slice(0, 137) + "..." : text;
  return `[wake] chat_message=${chatMessageId.slice(0, 8)} ${trimmed}`;
}

interface UserRow {
  id: string;
  role: string;
  type: string;
  status: string | null;
  last_seen_at: string | null;
}

interface TaskRow {
  id: string;
  assignee_id: string | null;
  agent_state: string | null;
  project_id: string | null;
  archived_at: string | null;
}

interface SubscriptionRow {
  id: string;
  enabled: number;
  codex_thread_id: string | null;
}

const STALE_AFTER_MS = 60_000;

/** Переводит `users.last_seen_at` (текстовое ISO в UTC, обновляется
 *  activeAgent.ts раз в 30 с) в абсолютный признак `online`. `NULL` —
 *  пользователь ни разу не стучался с момента, как его завели, и
 *  считается офлайн. По плану В3 (`tasks.agent_state IN ('in_progress',
 *  'review')`) и impl-pack'у порог ровно 60 с. */
function isOnline(user: UserRow, now: number): boolean {
  if (!user.last_seen_at) return false;
  const ts = Date.parse(
    user.last_seen_at.includes("T")
      ? user.last_seen_at
      : user.last_seen_at.replace(" ", "T") + "Z",
  );
  if (Number.isNaN(ts)) return false;
  return now - ts <= STALE_AFTER_MS;
}

/** Ищет активную (enabled и с непустым codex_thread_id) подписку
 *  webhook для проекта задачи. Это и есть «куда слать wake» в текущей
 *  модели: владелец настраивает подписку под проект, `tf_wake_dispatch.py`
 *  выходит на указанный thread_id. Берём самую свежую — детерминированно
 *  и без лотереи между двумя одновременно включёнными. */
function pickThreadIdForProject(projectId: string | null): string | null {
  if (!projectId) return null;
  const row = db
    .prepare(
      `SELECT id, enabled, codex_thread_id
         FROM webhook_subscriptions
        WHERE enabled = 1 AND codex_thread_id IS NOT NULL
          AND (project_id = ? OR project_id IS NULL)
        ORDER BY (project_id = ?) DESC, created_at DESC
        LIMIT 1`,
    )
    .get(projectId, projectId) as SubscriptionRow | undefined;
  return row?.codex_thread_id ?? null;
}

/** Общий (не привязанный к проекту) wake-тред — для `general_wake`, когда
 *  адресат онлайн, но не на слоте конкретной задачи (закрытие В6).
 *  Приоритет — подписке с `project_id IS NULL`: это и есть «общий канал».
 *  Если такой нет, берём самую свежую включённую подписку с thread_id —
 *  лучше разбудить через неё, чем не будить вовсе. `null` означает, что
 *  wake-канал не настроен и пробуждать нечем. */
function pickGeneralThreadId(): string | null {
  const row = db
    .prepare(
      `SELECT codex_thread_id
         FROM webhook_subscriptions
        WHERE enabled = 1 AND codex_thread_id IS NOT NULL
        ORDER BY (project_id IS NULL) DESC, created_at DESC
        LIMIT 1`,
    )
    .get() as { codex_thread_id: string } | undefined;
  return row?.codex_thread_id ?? null;
}

/** Главная функция этапа. Возвращает решение без записи в БД — запись
 *  делает `applyAgentWake`, чтобы не получить side-effect в чистой
 *  функции и не разъезжать с тестами, подменяющими раннер. */
export function resolveAgentWake(input: ResolveAgentWakeInput): WakeDecision {
  const { toUserId, taskId, chatMessageId } = input;
  const user = db
    .prepare(
      `SELECT id, role, type, status, last_seen_at FROM users WHERE id = ?`,
    )
    .get(toUserId) as UserRow | undefined;

  if (!user) {
    return { action: "unreachable", reason: "no_user", chatMessageId };
  }

  // В3: «спящий» = agent_state IN ('in_progress','review'). Если карточка
  // есть и исполнитель на слоте этой задачи — slot_wake.
  if (taskId) {
    const task = db
      .prepare(
        `SELECT id, assignee_id, agent_state, project_id, archived_at
           FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined;
    if (
      task &&
      task.assignee_id === toUserId &&
      !task.archived_at &&
      (task.agent_state === "in_progress" || task.agent_state === "review")
    ) {
      const threadId = pickThreadIdForProject(task.project_id);
      if (threadId) {
        return {
          action: "slot_wake",
          threadId,
          message: wakeMessage(chatMessageId, ""),
          chatMessageId,
        };
      }
      // Слот есть, thread_id не задан → всё равно недоставлено.
      return { action: "unreachable", reason: "no_slot", chatMessageId };
    }
  }

  // Не на слоте этой задачи. Проверяем общий онлайн.
  const online = isOnline(user, Date.now());
  if (!online) {
    return { action: "unreachable", reason: "offline", chatMessageId };
  }

  // Онлайн, но без слота этой задачи — пробуждаем по общему каналу
  // (карточка: «если не на слоте — пробудить по общему каналу при
  // online=true»). Общий канал — подписка без project_id, иначе самая
  // свежая включённая. Нет ни одного wake-треда — честно недоставлено.
  const generalThreadId = pickGeneralThreadId();
  if (generalThreadId) {
    return {
      action: "general_wake",
      threadId: generalThreadId,
      message: wakeMessage(chatMessageId, ""),
      chatMessageId,
    };
  }
  return { action: "unreachable", reason: "no_slot", chatMessageId };
}

// ───────────────── Исполнение решения (side-effects) ─────────────────

/** Минимальный контракт wake-раннера, чтобы тесты могли его подменить
 *  (DI). Совпадает по форме с `WakeCommandRunner` из webhookSubscriptions,
 *  но объявлен локально: модуль agentWake не должен зависеть от
 *  webhookSubscriptions (иначе любой импорт одного тянет второй, и
 *  циклическая инициализация мешает тестам). Реальный раннер берётся
 *  из webhookSubscriptions через `getWakeCommandRunner` ниже. */
export interface AgentWakeRunner {
  (threadId: string, message: string): Promise<{ ok: boolean; error?: string | null }>;
}

export interface ApplyAgentWakeDeps {
  runner: AgentWakeRunner;
  /** Запись о wake_dispatched в `task_events` нужна для наблюдаемости
   *  этапа A: «сколько раз слот реально будился». По умолчанию ON —
   *  отключается в юнит-тесте resolveAgentWake, где нет БД-side-эффектов. */
  recordDispatchEvent?: boolean;
  /** Текущее время в мс — позволяет тестам подменить clock. Не используется
   *  сейчас (вся хронология — `datetime('now')` сервера), оставлено
   *  заготовкой под тесты, где будет важно фиксировать момент «не более
   *  X секунд назад». */
  now?: () => number;
  /** Что писать в `task_events.payload_json`. По умолчанию — как
   *  договаривались в В4. */
  eventPayloadBuilder?: (input: {
    chatMessageId: string;
    toUserId: string;
    reason: string;
  }) => unknown;
}

/** Идемпотентная запись в `task_events` по тройке (task_id, kind,
 *  payload_json). Если уже есть — пропускаем, чтобы повторный вызов
 *  (например, после ручного retry) не плодил дубликаты. Колонки
 *  `payload_json` в task_events нет, и чтобы не делать миграцию
 *  только ради этого, кладём сериализованный JSON в `to_value` и
 *  помечаем `field='delivery_state'` — журнал остаётся линейным
 *  (как у остальных `logEvent()`), а полезные поля читаются
 *  json_extract-ом там, где понадобятся. */
function ensureTaskEvent(
  taskId: string | null,
  kind: "unreachable_role" | "wake_dispatched",
  payloadJson: string,
): void {
  if (!taskId) return;
  const exists = db
    .prepare(
      `SELECT 1 FROM task_events
        WHERE task_id = ? AND kind = ? AND to_value = ?
        LIMIT 1`,
    )
    .get(taskId, kind, payloadJson) as { 1: number } | undefined;
  if (exists) return;
  logEvent({
    taskId,
    actorId: null,
    kind,
    field: "delivery_state",
    fromValue: null,
    toValue: payloadJson,
  });
}

function defaultEventPayload(input: {
  chatMessageId: string;
  toUserId: string;
  reason: string;
}): unknown {
  return {
    chat_message_id: input.chatMessageId,
    to_user_id: input.toUserId,
    reason: input.reason,
  };
}

/** Берёт реальный wake-раннер через общий модуль webhookSubscriptions.
 *  Использует `wakeRunner()` (а не прямой `defaultRunner`), чтобы тесты
 *  могли подменить раннер через `setRuntimeDefaultRunner()` без
 *  перехвата ES-экспорта. */
export function getDefaultAgentWakeRunner(): AgentWakeRunner {
  return wakeRunner() as unknown as AgentWakeRunner;
}

/** Выполняет `WakeDecision`: ставит wake в очередь (slot_wake /
 *  general_wake) или пишет `task_events.unreachable_role`, обновляет
 *  `chat_messages.delivery_state`. Синхронная — маршрут POST /api/chat не
 *  должен ждать, пока tf_wake_dispatch долетит до Mac'а и ответит.
 *  Результат раннера приходит позже отдельным путём (см. В1 — до ответа
 *  владельца максимум `'wake_queued'`). */
export interface ApplyAgentWakeResult {
  deliveryState:
    | "pending"
    | "sent"
    | "delivered"
    | "unreachable"
    | "wake_queued";
  wakeAttempted: boolean;
  unreachableEventRecorded: boolean;
}

export function applyAgentWake(
  decision: WakeDecision,
  toUserId: string,
  taskId: string | null,
  deps: ApplyAgentWakeDeps,
): ApplyAgentWakeResult {
  const recordDispatch = deps.recordDispatchEvent ?? true;
  const payloadFor = deps.eventPayloadBuilder ?? defaultEventPayload;

  if (decision.action === "unreachable") {
    const payload = payloadFor({
      chatMessageId: decision.chatMessageId,
      toUserId,
      reason: decision.reason,
    });
    const payloadJson = JSON.stringify(payload);
    ensureTaskEvent(taskId, "unreachable_role", payloadJson);
    db.prepare(
      "UPDATE chat_messages SET delivery_state = ? WHERE id = ?",
    ).run("unreachable", decision.chatMessageId);
    return {
      deliveryState: "unreachable",
      wakeAttempted: false,
      unreachableEventRecorded: true,
    };
  }

  // slot_wake / general_wake — fire-and-forget. Маршрут не ждёт сети до
  // Mac'а: даже если wake_runner упал, исполнитель увидит сообщение на
  // следующем heartbeat (agent_inbox его хранит). В лог tf_wake_dispatch
  // упадёт отдельной строкой, и шаг «feature_test_report» сможет это
  // увидеть в `webhook_wake_queue.attempts/last_error`.
  if (decision.action === "slot_wake" || decision.action === "general_wake") {
    void deps.runner(decision.threadId, decision.message).catch((e) => {
      // Не блокируем POST /api/chat, но не глушим совсем: пишем в
      // server_events, чтобы observability нашла неуспех. На бое здесь
      // стоит console.warn; настоящий мониторинг включается карточкой
      // «server_events API».
      // eslint-disable-next-line no-console
      console.warn(
        `[agentWake] runner для ${decision.action} thread=${decision.threadId.slice(0, 8)} упал: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
  }

  db.prepare(
    "UPDATE chat_messages SET delivery_state = ? WHERE id = ?",
  ).run("wake_queued", decision.chatMessageId);

  if (recordDispatch && taskId) {
    const payload = payloadFor({
      chatMessageId: decision.chatMessageId,
      toUserId,
      reason: decision.action,
    });
    const threadId =
      decision.action === "slot_wake" || decision.action === "general_wake"
        ? decision.threadId
        : "";
    ensureTaskEvent(
      taskId,
      "wake_dispatched",
      JSON.stringify({ ...(payload as object), thread_id: threadId }),
    );
  }

  return {
    deliveryState: "wake_queued",
    wakeAttempted: true,
    unreachableEventRecorded: false,
  };
}

/** Удобный шорткат для тестов и для routes/chat.ts: вызвать `resolve` и
 *  сразу `apply` под одним раннером. */
export function dispatchAgentWake(
  input: ResolveAgentWakeInput,
  toUserId: string,
  taskId: string | null,
  runner: AgentWakeRunner = getDefaultAgentWakeRunner(),
): { decision: WakeDecision; result: ApplyAgentWakeResult } {
  const decision = resolveAgentWake(input);
  const result = applyAgentWake(decision, toUserId, taskId, { runner });
  return { decision, result };
}
