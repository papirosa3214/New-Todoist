import db from "../db.js";
import { currentChatGeneration } from "../runtime/chatQueue.js";
export type WorkPlanItem = { id: string; title: string; state: "pending" | "in_progress" | "done" };
export const WORK_PLAN_INSTRUCTION = "РАБОЧИЙ ЧЕК-ЛИСТ — это твой рабочий план, а не отчёт. Заведи его ДО начала работы через taskflow_work_plan, из того, как ТЫ сам видишь путь к результату: обычно 3–7 этапов, у каждого понятно, что считается сделанным. Он нужен тебе, чтобы не теряться и не закрутиться: следующий шаг берёшь по нему, а не по ощущению «ещё чуть-чуть». ГРАНИЦА: работа закончена, когда выполнены «Результат» и «Критерии приёмки» карточки. Всё, что сверх этого, — уже не твой этап: не раздувай объём и не уходи в перфекционизм. В начале прочитай сохранённый план (инструмент без items), при продолжении используй его и не обнуляй выполненное. Перед этапом отметь его in_progress, по факту выполнения — done, при необходимости дополни список. Передавай весь актуальный список с устойчивыми id и base_revision из последнего ответа. Чек-лист не запрещает сдачу: галочки не сдача и не ревью, обычную сдачу делай через taskflow_subtask_done, после успешной сдачи сервер сам закроет последний пункт. Честность: не заводи пункты, которые не собираешься выполнять, и не дописывай план перед самой сдачей лишь бы он выглядел заполненным — владелец смотрит на него, чтобы видеть ход работы.";
export function validateWorkPlan(raw: unknown): WorkPlanItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw new Error("План содержит от 1 до 20 этапов");
  const ids = new Set<string>(); let current = 0;
  return raw.map(item => {
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) throw new Error("У этапов должны быть уникальные устойчивые id");
    ids.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.trim().length > 200) throw new Error("Название этапа: 1–200 символов");
    if (!["pending", "in_progress", "done"].includes(item.state)) throw new Error("Состояние этапа: pending, in_progress или done");
    if (item.state === "in_progress" && ++current > 1) throw new Error("Текущим может быть только один этап");
    return {id:item.id, title:item.title.trim(), state:item.state};
  });
}
export function readWorkPlan(subtaskId: string) {
  const row = db.prepare("SELECT * FROM subtask_work_plans WHERE subtask_id=?").get(subtaskId) as any;
  return row ? {subtask_id:subtaskId, revision:row.revision, items:JSON.parse(row.items_json), updated_at:row.updated_at, author_id:row.author_id} : null;
}
export function saveWorkPlan(subtaskId: string, authorId: string, revision: number, items: WorkPlanItem[]) {
  return db.transaction(() => {
    const existing = readWorkPlan(subtaskId);
    if ((existing?.revision ?? 0) !== revision) throw new Error("revision_conflict");
    db.prepare(`INSERT INTO subtask_work_plans(subtask_id,revision,items_json,author_id,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(subtask_id) DO UPDATE SET revision=excluded.revision,items_json=excluded.items_json,author_id=excluded.author_id,updated_at=excluded.updated_at`)
      .run(subtaskId, revision+1, JSON.stringify(items), authorId, new Date().toISOString());
    return readWorkPlan(subtaskId);
  })();
}

/** Рабочий чек-лист роли в чате (21.10.2026): одна запись на «чат + роль».
 *  Правила и проверка — те же, что у слота (`validateWorkPlan`).
 *
 *  25.10.2026 (карточка b504958a, контракт
 *  note://115ba2ac-6a1d-45ac-a92f-2081c6ecf0c2): `items_json` — это то, что
 *  пишет роль (порядок и названия). Состояние пунктов и самого плана хранит
 *  сервер: `outcomes_json` (принятые сдачи и блокировки) и `status`. Модель
 *  не может ни объявить пункт сданным, ни снять остановку плана. */
export type WorkPlanState = "pending" | "in_progress" | "done";
export type ChatPlanStatus = "active" | "finished" | "stopped";
export type ChatPlanStopReason = "owner_stop" | "budget_exhausted" | "session_reset" | "error";
export type ChatBlockType = "dependency" | "needs_input" | "capability" | "transient";
/** Что видит клиент и промпт роли по каждому пункту. */
export type ChatPlanItemState = WorkPlanState | "blocked" | "stopped";

export type ChatPlanOutcome = {
  /** Итог, который принял сервер. `stale` — запись отклонённой (устаревшей) сдачи. */
  state: "done" | "blocked";
  result: string | null;
  block_type: ChatBlockType | null;
  reason: string | null;
  submitted_at: string;
  submission_id: string;
  session_generation: number | null;
  plan_revision: number;
  stale: boolean;
};
export type ChatPlanOutcomes = Record<string, ChatPlanOutcome>;

export type ChatWorkPlan = {
  chat_id: string;
  role_id: string;
  revision: number;
  items: WorkPlanItem[];
  updated_at: string;
  status: ChatPlanStatus;
  stop_reason: ChatPlanStopReason | null;
  stopped_at: string | null;
  source_message_id: string | null;
  outcomes: ChatPlanOutcomes;
};
export type ChatPlanViewItem = {
  id: string;
  title: string;
  state: ChatPlanItemState;
  result?: string | null;
  block_reason?: string | null;
};
export type ChatPlanView = {
  chat_id: string;
  role_id: string;
  revision: number;
  status: ChatPlanStatus;
  stop_reason: ChatPlanStopReason | null;
  stopped_at: string | null;
  current_item_id: string | null;
  items: ChatPlanViewItem[];
  updated_at: string;
};

const parseOutcomes = (raw: unknown): ChatPlanOutcomes => {
  try {
    const parsed = JSON.parse(typeof raw === "string" && raw ? raw : "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChatPlanOutcomes) : {};
  } catch {
    return {};
  }
};
const chatPlanRow = (row: any): ChatWorkPlan => ({
  chat_id: row.chat_id,
  role_id: row.role_id,
  revision: row.revision,
  items: JSON.parse(row.items_json),
  updated_at: row.updated_at,
  status: (row.status === "stopped" || row.status === "finished" ? row.status : "active") as ChatPlanStatus,
  stop_reason: (row.stop_reason ?? null) as ChatPlanStopReason | null,
  stopped_at: row.stopped_at ?? null,
  source_message_id: row.source_message_id ?? null,
  outcomes: parseOutcomes(row.outcomes_json),
});
export function readChatWorkPlan(chatId: string, roleId: string): ChatWorkPlan | null {
  const row = db.prepare("SELECT * FROM chat_work_plans WHERE chat_id=? AND role_id=?").get(chatId, roleId);
  return row ? chatPlanRow(row) : null;
}
export function readChatWorkPlans(chatId: string): ChatWorkPlan[] {
  return (db.prepare("SELECT * FROM chat_work_plans WHERE chat_id=? ORDER BY updated_at DESC").all(chatId) as any[]).map(chatPlanRow);
}
/** План выполнен целиком — закрыт: в полоске не показывается, а новый план
 *  ложится поверх него без сверки revision (владелец 21.10.2026). */
export function isWorkPlanFinished(items: Array<{ state: string }>): boolean {
  return items.length > 0 && items.every((item) => item.state === "done");
}
/** Принятая сдача пункта: отклонённая (`stale`) сдачей не является. */
export function acceptedOutcome(plan: ChatWorkPlan, itemId: string): ChatPlanOutcome | null {
  const outcome = plan.outcomes[itemId];
  return outcome && !outcome.stale ? outcome : null;
}
/** Единственное вычисление состояния плана — по нему живут и клиент, и промпт
 *  роли, и допуск следующего пункта. Чистая функция: без БД. */
export function chatPlanViewOf(plan: ChatWorkPlan): ChatPlanView {
  const items: ChatPlanViewItem[] = [];
  let currentItemId: string | null = null;
  let pendingCandidate: ChatWorkPlan["items"][number] | null = null;
  for (const item of plan.items) {
    const outcome = acceptedOutcome(plan, item.id);
    if (!pendingCandidate && outcome?.state !== "done") pendingCandidate = item;
  }
  const storedStatus: ChatPlanStatus =
    plan.status === "stopped" ? "stopped" : plan.status === "finished" ? "finished" : "active";
  const obviousFinished = plan.items.length > 0 && plan.items.every((item) => acceptedOutcome(plan, item.id)?.state === "done");
  const status: ChatPlanStatus = storedStatus === "stopped" ? "stopped" : obviousFinished ? "finished" : "active";
  if (status === "active") currentItemId = pendingCandidate?.id ?? null;
  else if (status === "stopped") currentItemId = null;

  for (const item of plan.items) {
    const outcome = acceptedOutcome(plan, item.id);
    let state: ChatPlanItemState = "pending";
    if (outcome?.state === "done") state = "done";
    else if (outcome?.state === "blocked") state = "blocked";
    else if (status === "stopped" && item.id === pendingCandidate?.id) state = "stopped";
    else if (status === "active" && item.id === currentItemId) state = "in_progress";
    items.push({
      id: item.id,
      title: item.title,
      state,
      ...(outcome?.state === "done" ? { result: outcome.result ?? null } : {}),
      ...(outcome?.state === "blocked" ? { block_reason: outcome.reason ?? outcome.block_type ?? null } : {}),
    });
  }
  return {
    chat_id: plan.chat_id,
    role_id: plan.role_id,
    revision: plan.revision,
    status,
    stop_reason: plan.stop_reason,
    stopped_at: plan.stopped_at,
    current_item_id: currentItemId,
    items,
    updated_at: plan.updated_at,
  };
}
export function chatPlanView(chatId: string, roleId: string): ChatPlanView | null {
  const plan = readChatWorkPlan(chatId, roleId);
  return plan ? chatPlanViewOf(plan) : null;
}
/** Правило «done ставит сервер»: пункт считается сданным, только если по нему
 *  есть принятая сдача. Заявка `done` без сдачи — повод отклонить запись плана. */
function normalizePlanItems(plan: ChatWorkPlan | null, items: WorkPlanItem[]): WorkPlanItem[] {
  const current = plan ? chatPlanViewOf(plan).current_item_id : items[0]?.id ?? null;
  return items.map((item) => {
    const outcome = plan ? acceptedOutcome(plan, item.id) : null;
    if (outcome?.state === "done") return { ...item, state: "done" as const };
    return { ...item, state: item.id === current ? ("in_progress" as const) : ("pending" as const) };
  });
}
/** Почему новую запись плана нельзя принять. Коды — из контракта §3.2. */
export type ChatPlanWriteError =
  | "revision_conflict"
  | "item_not_started"
  | "item_not_submitted"
  | "current_item_locked"
  | "item_locked";
export class ChatPlanWriteRejection extends Error {
  constructor(public code: ChatPlanWriteError, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export type SaveChatWorkPlanOptions = { sourceMessageId?: string | null };

export function saveChatWorkPlan(
  chatId: string,
  roleId: string,
  revision: number,
  items: WorkPlanItem[],
  options: SaveChatWorkPlanOptions = {},
): ChatWorkPlan {
  return db.transaction(() => {
    const existing = readChatWorkPlan(chatId, roleId);
    const existingView = existing ? chatPlanViewOf(existing) : null;
    // Остановленный или закрытый план заменяется новым: без сверки revision,
    // с чистыми записями сдач. Старый план не возобновляется (контракт §3.2 п.6).
    const replaceable = !!existing && (existingView!.status !== "active" || isWorkPlanFinished(existing.items));
    if (!replaceable && (existing?.revision ?? 0) !== revision)
      throw new ChatPlanWriteRejection("revision_conflict", "План уже обновлён: прочитай его заново и возьми свежий revision", {
        current: existingView,
      });

    let nextItems = items;
    if (existing && !replaceable) {
      const view = existingView!;
      const incoming = new Map(items.map((item) => [item.id, item]));
      for (const item of view.items) {
        const given = incoming.get(item.id);
        const locked = item.state === "done" || item.state === "blocked" || item.state === "in_progress";
        if (!given) {
          if (item.state === "in_progress")
            throw new ChatPlanWriteRejection("current_item_locked", "Текущий пункт нельзя удалить: сдай его или останови план", {
              current_item_id: view.current_item_id,
            });
          if (locked)
            throw new ChatPlanWriteRejection("item_locked", "Начатый пункт нельзя удалить или переименовать", { item_id: item.id });
          continue;
        }
        if (locked && given.title.trim() !== item.title)
          throw new ChatPlanWriteRejection(
            item.state === "in_progress" ? "current_item_locked" : "item_locked",
            "Начатый пункт нельзя удалить или переименовать",
            { item_id: item.id },
          );
      }
      for (const item of items) {
        if (!existing.items.some((old) => old.id === item.id) && item.state === "done")
          throw new ChatPlanWriteRejection("item_not_submitted", "Пункт закрывает сервер: сдай результат, а не помечай пункт done", {
            item_id: item.id,
          });
        if (item.state === "done" && acceptedOutcome(existing, item.id)?.state !== "done")
          throw new ChatPlanWriteRejection("item_not_submitted", "Пункт закрывает сервер: сдай результат, а не помечай пункт done", {
            item_id: item.id,
          });
      }
      nextItems = normalizePlanItems(existing, items);
    } else {
      for (const item of items) {
        if (item.state === "done")
          throw new ChatPlanWriteRejection("item_not_submitted", "Пункт закрывает сервер: сдай результат, а не помечай пункт done", {
            item_id: item.id,
          });
      }
      nextItems = normalizePlanItems(null, items);
    }

    const nextRevision = (existing?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    const outcomes = existing && !replaceable ? JSON.stringify(existing.outcomes) : "{}";
    const sourceMessageId = replaceable || !existing ? (options.sourceMessageId ?? null) : existing.source_message_id;
    db.prepare(`INSERT INTO chat_work_plans(chat_id,role_id,revision,items_json,updated_at,status,stop_reason,stopped_at,source_message_id,outcomes_json)
        VALUES(?,?,?,?,?,'active',NULL,NULL,?,?)
      ON CONFLICT(chat_id,role_id) DO UPDATE SET revision=excluded.revision,items_json=excluded.items_json,updated_at=excluded.updated_at,
        status='active',stop_reason=NULL,stopped_at=NULL,source_message_id=excluded.source_message_id,outcomes_json=excluded.outcomes_json`)
      .run(chatId, roleId, nextRevision, JSON.stringify(nextItems), now, sourceMessageId, outcomes);
    return readChatWorkPlan(chatId, roleId)!;
  })();
}
/** «Новая сессия» роли в чате начинает и план с чистого листа. */
export function clearChatWorkPlan(chatId: string, roleId: string): void {
  db.prepare("DELETE FROM chat_work_plans WHERE chat_id=? AND role_id=?").run(chatId, roleId);
}

/** Живая доставка хода (чат, роль): по ней сервер узнаёт поколение и то, что
 *  сдача пришла из настоящего хода, а не из позднего ответа. */
export type ChatDeliveryState = "saved" | "accepted" | "queued" | "stale";
export function chatDeliveryRow(chatId: string, roleId: string, messageId?: string | null): {
  id: string;
  message_id: string | null;
  status: string;
  session_generation: number;
} | null {
  const row = messageId
    ? db
        .prepare("SELECT id,message_id,status,session_generation FROM chat_message_queue WHERE chat_id=? AND role_id=? AND message_id=? ORDER BY created_at DESC LIMIT 1")
        .get(chatId, roleId, messageId)
    : db
        .prepare("SELECT id,message_id,status,session_generation FROM chat_message_queue WHERE chat_id=? AND role_id=? ORDER BY created_at DESC LIMIT 1")
        .get(chatId, roleId);
  return (row as any) ?? null;
}
/** Поколение пары (чат, роль) — тот же счётчик, что и у очереди доставки.
 *  Источник один: иначе сдача пункта сравнивала бы с «поколением 0» против
 *  записанного «поколения 1» и поздний ответ проходил как свежий
 *  (карточка b504958a, доработка D1). */
export function chatSessionGeneration(chatId: string, roleId: string): number {
  return currentChatGeneration(chatId, roleId);
}
/** Различение «сообщение сохранено» и «передано исполнителю» (контракт §10):
 *  считается по очереди доставки, отдельного хранилища нет. */
export function chatDeliveryStateOf(chatId: string, roleId: string, messageId: string): ChatDeliveryState {
  const row = chatDeliveryRow(chatId, roleId, messageId);
  if (!row) return "saved";
  if (row.status === "superseded" || row.status === "failed") return "stale";
  if (row.status === "picked") return "accepted";
  if (row.status === "done") return "accepted";
  if (row.status === "pending") return "queued";
  return "saved";
}

export type ChatItemSubmitInput = {
  chatId: string;
  roleId: string;
  itemId: string;
  result?: string | null;
  outcome: "done" | "blocked";
  blockType?: ChatBlockType | null;
  reason?: string | null;
  /** Сообщение, из которого пришла сдача: по нему находится доставка. */
  messageId?: string | null;
};
export type ChatItemSubmitRejection = {
  code:
    | "chat_plan_missing"
    | "plan_stopped"
    | "item_not_current"
    | "item_already_done"
    | "item_unknown"
    | "result_required"
    | "block_type_required"
    | "run_stale";
  message: string;
  status: number;
  extra?: Record<string, unknown>;
};
export class ChatItemSubmitError extends Error {
  constructor(public rejection: ChatItemSubmitRejection) {
    super(rejection.message);
  }
}
export type ChatItemSubmitResult = {
  plan_revision: number;
  item: ChatPlanViewItem;
  current_item_id: string | null;
  next_item: ChatPlanViewItem | null;
  status: ChatPlanStatus;
  idempotent: boolean;
  view: ChatPlanView;
};

/** Явная сдача текущего пункта (контракт §5). Принимается только в живом ходе
 *  роли в этом чате: поздний ответ остановленного или устаревшего хода пункт не
 *  двигает. Ключ идемпотентности выводит сервер, а не модель. */
export function submitChatWorkItem(input: ChatItemSubmitInput): ChatItemSubmitResult {
  return db.transaction(() => {
    const plan = readChatWorkPlan(input.chatId, input.roleId);
    if (!plan)
      throw new ChatItemSubmitError({ code: "chat_plan_missing", status: 409, message: "Сначала заведи чек-лист: план не найден" });
    const view = chatPlanViewOf(plan);
    if (view.status === "stopped")
      throw new ChatItemSubmitError({
        code: "plan_stopped",
        status: 409,
        message: `План остановлен${plan.stop_reason ? ` (${plan.stop_reason})` : ""}: новые пункты не принимаются`,
        extra: { stop_reason: plan.stop_reason },
      });
    if (!plan.items.some((item) => item.id === input.itemId))
      throw new ChatItemSubmitError({
        code: "item_unknown",
        status: 409,
        message: "Такого пункта в плане нет",
        extra: { current_item_id: view.current_item_id },
      });
    const result = (input.result ?? "").trim();
    if (input.outcome === "done" && (!result || result.length > 400))
      throw new ChatItemSubmitError({
        code: "result_required",
        status: 400,
        message: "Для сдачи нужен result: 1–2 предложения (до 400 символов)",
      });
    if (input.outcome === "blocked" && !input.blockType)
      throw new ChatItemSubmitError({
        code: "block_type_required",
        status: 400,
        message: "Для блокировки нужен block_type: dependency | needs_input | capability | transient",
      });

    const delivery = chatDeliveryRow(input.chatId, input.roleId, input.messageId ?? undefined);
    const generation = delivery ? delivery.session_generation : null;
    const submissionId = `${delivery?.id ?? "no_delivery"}:${input.itemId}:${input.outcome}`;
    // Повтор той же сдачи — идемпотентен даже когда текущим стал следующий
    // пункт: иначе восстановление после рестарта получило бы отказ вместо
    // прежнего результата (контракт §5.3, п.4).
    const previous = plan.outcomes[input.itemId];
    if (previous && !previous.stale && previous.state === "done") {
      if (previous.submission_id === submissionId) {
        return {
          plan_revision: plan.revision,
          item: view.items.find((i) => i.id === input.itemId)!,
          current_item_id: view.current_item_id,
          next_item: view.items.find((i) => i.state === "pending" || i.state === "in_progress") ?? null,
          status: view.status,
          idempotent: true,
          view,
        };
      }
      throw new ChatItemSubmitError({
        code: "item_already_done",
        status: 409,
        message: "Пункт уже сдан",
        extra: { current_item_id: view.current_item_id },
      });
    }
    if (view.current_item_id !== input.itemId)
      throw new ChatItemSubmitError({
        code: "item_not_current",
        status: 409,
        message: "Сдавать можно только текущий пункт: прямой переход через несданный пункт не допускается",
        extra: { current_item_id: view.current_item_id },
      });

    const live = delivery?.status === "picked" || delivery?.status === "done";
    const currentGeneration = chatSessionGeneration(input.chatId, input.roleId);
    const stale = !live || (generation !== null && currentGeneration > generation);
    const now = new Date().toISOString();
    const outcomes: ChatPlanOutcomes = {
      ...plan.outcomes,
      [input.itemId]: {
        state: input.outcome,
        result: input.outcome === "done" ? result : null,
        block_type: input.outcome === "blocked" ? (input.blockType ?? null) : null,
        reason: (input.reason ?? null) || null,
        submitted_at: now,
        submission_id: submissionId,
        session_generation: generation,
        plan_revision: plan.revision + 1,
        stale,
      },
    };
    if (stale) {
      // Поздний ответ старого запуска виден, но ничего не двигает.
      db.prepare("UPDATE chat_work_plans SET outcomes_json=?,updated_at=? WHERE chat_id=? AND role_id=?")
        .run(JSON.stringify(outcomes), now, input.chatId, input.roleId);
      throw new ChatItemSubmitError({
        code: "run_stale",
        status: 409,
        message: "Сдача пришла из устаревшего или уже закрытого хода: состояние пункта не меняется",
        extra: { current_item_id: view.current_item_id },
      });
    }

    const nextPlan: ChatWorkPlan = { ...plan, revision: plan.revision + 1, outcomes, updated_at: now };
    const nextView = chatPlanViewOf(nextPlan);
    const finished = nextView.status === "finished";
    db.prepare("UPDATE chat_work_plans SET revision=?,outcomes_json=?,updated_at=?,status=?,stopped_at=NULL,stop_reason=NULL WHERE chat_id=? AND role_id=?")
      .run(nextPlan.revision, JSON.stringify(outcomes), now, finished ? "finished" : "active", input.chatId, input.roleId);
    const stored = readChatWorkPlan(input.chatId, input.roleId)!;
    const storedView = chatPlanViewOf(stored);
    return {
      plan_revision: stored.revision,
      item: storedView.items.find((i) => i.id === input.itemId)!,
      current_item_id: storedView.current_item_id,
      next_item: storedView.items.find((i) => i.state === "in_progress" || i.state === "pending") ?? null,
      status: storedView.status,
      idempotent: false,
      view: storedView,
    };
  })();
}

/** Стоп плана: останавливает, а не ставит на паузу (контракт §7). Продолжить
 *  работу можно только новым планом. */
export function stopChatWorkPlan(
  chatId: string,
  roleId: string,
  reason: ChatPlanStopReason = "owner_stop",
): ChatPlanView | null {
  return db.transaction(() => {
    const plan = readChatWorkPlan(chatId, roleId);
    if (!plan) return null;
    const view = chatPlanViewOf(plan);
    if (view.status !== "active") return view;
    const now = new Date().toISOString();
    db.prepare("UPDATE chat_work_plans SET status='stopped',stop_reason=?,stopped_at=?,revision=?,updated_at=? WHERE chat_id=? AND role_id=?")
      .run(reason, now, plan.revision + 1, now, chatId, roleId);
    return chatPlanView(chatId, roleId);
  })();
}

/** Исчерпан настроенный предел, но ход ещё можно продолжить: текущий пункт
 *  становится `blocked` с причиной. Ставит сервер, а не модель — иначе
 *  исчерпание бюджета выглядело бы как «роль забыла отметку» (контракт §7). */
export function markChatItemBlockedByServer(
  chatId: string,
  roleId: string,
  reason: string,
  blockType: ChatBlockType = "transient",
): boolean {
  return db.transaction(() => {
    const plan = readChatWorkPlan(chatId, roleId);
    if (!plan) return false;
    const view = chatPlanViewOf(plan);
    if (view.status !== "active" || !view.current_item_id) return false;
    const current = view.items.find((item) => item.id === view.current_item_id)!;
    if (current.state === "blocked") return false;
    const now = new Date().toISOString();
    const outcomes: ChatPlanOutcomes = {
      ...plan.outcomes,
      [current.id]: {
        state: "blocked",
        result: null,
        block_type: blockType,
        reason,
        submitted_at: now,
        submission_id: `server:${current.id}:blocked:${now}`,
        session_generation: null,
        plan_revision: plan.revision + 1,
        stale: false,
      },
    };
    db.prepare("UPDATE chat_work_plans SET revision=?,outcomes_json=?,updated_at=? WHERE chat_id=? AND role_id=?")
      .run(plan.revision + 1, JSON.stringify(outcomes), now, chatId, roleId);
    return true;
  })();
}

/** Плана нет: правило про чек-лист на этот ход (владелец 25.10.2026).
 *  25.10.2026 (контракт §4): «3–7 этапов» перестало быть обязательным
 *  минимумом — простая работа может быть одним пунктом. */
export const CHAT_PLAN_MISSING_PROMPT =
  "ЧЕК-ЛИСТ В ЧАТЕ: плана на эту сессию пока нет. Если поручение требует работы — ПЕРВЫМ действием заведи его через taskflow_work_plan: один пункт для простой работы, несколько — когда частей действительно несколько; у каждого понятно, что считается сделанным, ровно один in_progress. Сервер сам читает твой план, выдаёт текущий пункт и закрывает план, когда все пункты сданы. Для простого вопроса или короткого ответа план не нужен.";

/** Текст серверного ведения по чатовому представлению плана. Чистая функция:
 *  без БД и без состояния — так её видно в тесте. Пустая строка = плана нет
 *  либо он закрыт целиком. */
export function chatWorkPlanPromptText(view: ChatPlanView | null): string {
  if (!view || !view.items.length) return CHAT_PLAN_MISSING_PROMPT;
  if (view.status === "finished") return "";
  const mark = (item: ChatPlanViewItem) =>
    item.state === "done" ? "✓" : item.state === "blocked" ? "⊘" : item.state === "stopped" ? "■" : item.id === view.current_item_id ? "▶" : "•";
  const list = view.items.map((item) => `${mark(item)} ${item.title}`).join("\n");
  if (view.status === "stopped") {
    const reason = view.stop_reason === "budget_exhausted" ? "исчерпан бюджет" : view.stop_reason === "owner_stop" ? "остановил владелец" : view.stop_reason ?? "остановлен";
    return [
      `ТВОЙ ЧЕК-ЛИСТ В ЧАТЕ ОСТАНОВЛЕН (${reason}, revision ${view.revision}):`,
      list,
      "",
      "Следующие пункты не начинай: остановленный план сдачи не принимает. Покажи владельцу, что сделано и на чём работа остановлена. Продолжить можно только новым планом.",
    ].join("\n");
  }
  const current = view.items.find((item) => item.id === view.current_item_id);
  if (!current) return CHAT_PLAN_MISSING_PROMPT;
  const blocked = current.state === "blocked";
  return [
    `ТВОЙ ЧЕК-ЛИСТ В ЧАТЕ (его ведёт сервер, revision ${view.revision}):`,
    list,
    "",
    blocked
      ? `Текущий пункт — «${current.title}» (id ${current.id}) — заблокирован: жди ответа и не начинай следующий.`
      : `Текущий пункт — «${current.title}» (id ${current.id}). Работай по нему, остальные не бери.`,
    "- пункт — законченный результат, а не вызов инструмента: несколько инструментов внутри одного пункта нового запуска не требуют;",
    `- закончил пункт — сдай его: taskflow_work_item_submit с item_id ${current.id} и result (1–2 предложения, что сделано). Следующий пункт сервер выдаст только после сдачи;`,
    `- если пункт заблокирован — сдай его с outcome blocked и block_type (dependency | needs_input | capability | transient);`,
    `- добавить пункт в конец или поправить ещё не начатый можно через taskflow_work_plan с полным списком и base_revision ${view.revision}; сданный пункт и текущий не переименовать и не удалить;`,
    "- по ходу пиши владельцу коротко, что делаешь и что вышло по пункту.",
  ].join("\n");
}

/** Что сервер подкладывает роли в начало чатового хода: текущий пункт её плана. */
export function chatWorkPlanPrompt(chatId: string, roleId: string): string {
  return chatWorkPlanPromptText(chatPlanView(chatId, roleId));
}
