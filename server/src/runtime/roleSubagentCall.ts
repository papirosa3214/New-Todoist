/**
 * Вызов роли как субагента (28.10.2026).
 *
 * Инструмент `taskflow_call_role`: вызывающая роль (Помощник владельца или
 * Оркестратор) зовёт другую роль и получает ТЕКСТ её ответа.
 *
 * Правила (все — в коде, а не в промпте):
 *  - звать можно только существующую роль (ROLE_NAMES) и только имея право
 *    (roleToolScope: secretary, code_orchestrator);
 *  - нельзя звать саму себя и нельзя звать роль из роли (вложенный вызов);
 *  - не больше 3 вызовов за ход вызывающей роли;
 *  - ответ длиннее 16 000 символов обрезается;
 *  - ход субагента — 10 минут максимум.
 *
 * Ход субагента идёт через startChatRun: своя сессия (sessionId не передаём),
 * модель и инструменты роли — по умолчанию, как у ролей.
 *
 * ФОНОВЫЙ РЕЖИМ (владелец 29.10.2026): вызов НЕ ждёт. Ход субагента идёт в
 * фоне, вызывающая роль продолжает работать и отвечать владельцу — её чат не
 * «висит». Когда выжимка готова, она ложится в главную сессию и БУДИТ
 * вызывающую роль (очередь chat_message_queue + recoverAgentDelivery) — та
 * продолжает разговор уже с ответом.
 *
 * КОРРЕКТИРОВКА НА ХОДУ (владелец 29.10.2026): вызывающая роль может
 * докинуть уточнение работающему субагенту инструментом
 * `taskflow_call_role_steer`. Уточнение прерывает текущий ход роли (граница
 * прерывания), наработка уходит в чекпоинт, и ход перезапускается с новым
 * заданием — роль продолжает ту же работу с учётом правки.
 *
 * Карточка координации живёт в чате ВЫЗЫВАЮЩЕЙ роли (chatId из контекста
 * инструмента) — там, где её и ждёт человек.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { Type } from "typebox";
import db from "../db.js";
import { roleToolAllowed } from "../lib/roleToolScope.js";
import { ROLE_NAMES, roleTitle, roleUserId } from "../roleRouting.js";
import {
  coordinationActivity,
  coordinationAnswered,
  ensureSubagentCoordinationCard,
  updateCoordination,
} from "./chatCoordination.js";
import { applyOwnerBoundary } from "./chatOwnerBoundary.js";
import { bumpChatGeneration, enqueueMessageDelivery, fencePairDeliveries } from "./chatQueue.js";
import { activeVoiceCallId } from "../lib/voiceCallRegistry.js";
import { setPlanLink, clearPlanLink } from "./chatPlanLinks.js";
import { openSubagentRoom, type SubagentRoom } from "./subagentRoom.js";
import type { Context, Tool } from "./universalTaskflow.js";

export const ROLE_SUBAGENT_CALL_TOOL = "taskflow_call_role";
/** Уточнение работающему субагенту. */
export const ROLE_SUBAGENT_STEER_TOOL = "taskflow_call_role_steer";
/** Не больше трёх вызовов субагента за один ход вызывающей роли. */
export const SUBAGENT_CALL_LIMIT = 3;
/** Сколько раз можно перебить субагента за один вызов. */
export const SUBAGENT_STEER_LIMIT = 3;
/** Ответ длиннее этого обрезается — иначе он съест контекст вызывающей роли. */
export const SUBAGENT_ANSWER_LIMIT = 16000;
/** Потолок хода субагента. 0 — без потолка: дочерняя сессия живёт, пока
 *  модель не закончит (владелец 11.11.2026: ход в ветке не обрывать). */
export const SUBAGENT_TIMEOUT_MS = 0;

export type SubagentRunInput = {
  role: string;
  roleId: string;
  chatId: string;
  prompt: string;
  timeoutMs: number;
  /** Сессия предыдущего attempt'а — ход продолжает ту же сессию. */
  sessionId?: string | null;
  onEvent?: (event: unknown) => void;
};

export type SubagentTurnResult = {
  text: string;
  /** id сессии Pi — чтобы следующий attempt продолжил её, а не начал заново. */
  sessionId: string | null;
};

export type SubagentRunner = (input: SubagentRunInput) => Promise<SubagentTurnResult>;

/**
 * Пометка «сейчас идёт ход субагента». Живёт в асинхронном контексте, поэтому
 * каталог инструментов, который собирается внутри хода субагента, узнаёт об
 * этом и НЕ показывает ему инструмент вызова роли: иначе цепочки ролей
 * разойдутся (роль → роль → роль).
 */
type SubagentScope = { requesterRole: string; recipientRole: string };
const subagentScope = new AsyncLocalStorage<SubagentScope>();

export function isSubagentRun(): boolean {
  return subagentScope.getStore() !== undefined;
}

/** Выполнить fn в контексте хода субагента. */
export function runAsSubagent<T>(scope: SubagentScope, fn: () => T): T {
  return subagentScope.run(scope, fn);
}

/** Счётчик вызовов: ключ — роль и её чат. */
const callCounters = new Map<string, number>();

function callKey(role: string, chatId: string): string {
  return `${role}|${chatId}`;
}

/**
 * Начало хода роли: счётчик вызовов субагента обнуляется. Каталог роли
 * собирается один раз на ход — значит «3 вызова» считаются за ход.
 */
export function resetSubagentCallCounters(role: string, chatId: string): void {
  callCounters.delete(callKey(role, chatId));
}

/** Сброс всех счётчиков — тестам. */
export function resetAllSubagentCallCounters(): void {
  callCounters.clear();
}

/** Счётчик хода: превышение лимита — отказ до запуска роли. */
function countCall(role: string, chatId: string): number {
  const key = callKey(role, chatId);
  const next = (callCounters.get(key) ?? 0) + 1;
  callCounters.set(key, next);
  // Карта не должна расти бесконечно: чистим самые старые записи.
  while (callCounters.size > 500) {
    const oldest = callCounters.keys().next().value;
    if (oldest === undefined) break;
    callCounters.delete(oldest);
  }
  return next;
}

function truncateAnswer(text: string): string {
  const value = (text ?? "").trim();
  if (value.length <= SUBAGENT_ANSWER_LIMIT) return value;
  return (
    value.slice(0, SUBAGENT_ANSWER_LIMIT) +
    `\n… (ответ роли обрезан: ${value.length} символов, показаны первые ${SUBAGENT_ANSWER_LIMIT})`
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Сессия роли в чате: ход субагента не должен hijack'ить сессию роли. */
type SessionRow = { pi_session_id: string; generation: number } | undefined;

/**
 * Сообщение-источник обращения: в карточку идёт ссылка на реальную строку
 * чата (FK). В ходе карточки messageId может быть пустым или устаревшим —
 * тогда источником считаем сам вопрос, и карточка обходится без ссылки.
 */
function originMessageId(messageId?: string): string | undefined {
  if (!messageId) return undefined;
  const row = db.prepare("SELECT 1 FROM chat_messages WHERE id=?").get(messageId);
  return row ? messageId : undefined;
}

function readSession(chatId: string, roleId: string): SessionRow {
  const row = db
    .prepare("SELECT pi_session_id, generation FROM chat_sessions WHERE chat_id=? AND role_id=?")
    .get(chatId, roleId) as { pi_session_id: string; generation: number } | undefined;
  return row;
}

function restoreSession(chatId: string, roleId: string, prior: SessionRow): void {
  try {
    if (prior) {
      db.prepare(
        "UPDATE chat_sessions SET pi_session_id=?, generation=? WHERE chat_id=? AND role_id=?",
      ).run(prior.pi_session_id, prior.generation, chatId, roleId);
    } else {
      db.prepare("DELETE FROM chat_sessions WHERE chat_id=? AND role_id=?").run(chatId, roleId);
    }
  } catch {
    /* сессия — служебное; ход субагента от неё не зависит */
  }
}

/**
 * Ход субагента по умолчанию: живая сессия Pi в комнате вызова.
 *
 * Сессия передаётся из attempt'а в attempt: при корректировке ход
 * прерывается, но следующий attempt продолжает ТУ ЖЕ сессию — в ней вся
 * собранная работа (файлы, команды, выводы). Без этого роль начинала бы
 * заново, а правка приходила бы «в пустоту»: наработка субагента живёт в
 * сессии Pi, а не в сообщениях чата, поэтому чекпоинт её не заменяет.
 */
async function runSubagentTurn(input: SubagentRunInput): Promise<SubagentTurnResult> {
  // Динамический импорт: PiRuntimeAdapter сам строит каталог ролей —
  // статический импорт дал бы цикл модулей.
  const { startChatRun } = await import("./PiRuntimeAdapter.js");
  const result = await startChatRun({
    chatId: input.chatId,
    role: input.role,
    roleId: input.roleId,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    // Продолжить прежнюю сессию, если она есть (корректировка на ходу).
    sessionId: input.sessionId ?? undefined,
    onEvent: input.onEvent,
  });
  return { text: result?.text ?? "", sessionId: result?.sessionId ?? null };
}

function subagentPrompt(requesterRole: string, role: string, question: string): string {
  return [
    `Вопрос от роли «${roleTitle(requesterRole) || requesterRole}»:`,
    "",
    question,
    "",
    "Собери нужные данные сам: вызывающая роль первичные источники перебирать не будет — это твоя работа.",
    "Верни выжимку: что важно, выводы, числа, ссылки на источники. Без пересказа своих шагов.",
    "Выжимку прочитает вызывающая роль.",
  ].join("\n");
}

/* ── Уточнения субагенту на ходу ────────────────────────────────────────── */

/** Записать уточнение для работающего субагента. */
export function recordSubagentSteer(input: {
  roomChatId: string;
  questionId: string;
  text: string;
}): void {
  db.prepare("INSERT INTO subagent_steers(id,room_chat_id,question_id,text) VALUES(?,?,?,?)").run(
    crypto.randomUUID(),
    input.roomChatId,
    input.questionId,
    input.text,
  );
}

/**
 * Забрать непрочитанное уточнение комнаты (самое раннее) и отметить его
 * прочитанным: ход субагента после прерывания подхватит ровно одно.
 */
function takeSubagentSteer(roomChatId: string): { text: string } | undefined {
  const row = db
    .prepare(
      "SELECT id,text FROM subagent_steers WHERE room_chat_id=? AND consumed_at IS NULL ORDER BY created_at,rowid LIMIT 1",
    )
    .get(roomChatId) as { id: string; text: string } | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE subagent_steers SET consumed_at=datetime('now') WHERE id=?").run(row.id);
  return { text: row.text };
}

/** Прямой родитель чата (для чекпоинта: кто заберёт наработку). */
function rootChatIdOf(chatId: string): string {
  const row = db.prepare("SELECT branch_of_chat_id FROM chats WHERE id=?").get(chatId) as
    | { branch_of_chat_id: string | null }
    | undefined;
  return row?.branch_of_chat_id ?? chatId;
}

/* ── Фоновый ход субагента ─────────────────────────────────────────────── */

type BackgroundInput = {
  room?: SubagentRoom;
  /** Комната, где идёт ход субагента. */
  runChatId: string;
  /** Чат вызывающей роли — туда приходит выжимка. */
  callerChatId: string;
  role: string;
  roleId: string;
  requesterRole: string;
  requesterId: string;
  question: string;
  questionId?: string;
  runner: SubagentRunner;
};

/** Фоновые ходы субагентов — чтобы тесты дождались их. */
const backgroundRuns = new Set<Promise<void>>();

/** Дождаться всех фоновых ходов субагентов (тесты). */
export async function pendingSubagentRuns(): Promise<void> {
  while (backgroundRuns.size) {
    await Promise.allSettled([...backgroundRuns]);
  }
}

/**
 * Довести ход субагента до конца: комната закрывается, карточка закрывается
 * ответом, выжимка уходит в главную сессию и будит вызывающую роль.
 *
 * Перебивка (уточнение) не считается провалом: ход прерывается, наработка
 * уходит в чекпоинт, а роль перезапускается с новым заданием.
 */
async function runSubagentInBackground(input: BackgroundInput): Promise<void> {
  const priorSession = readSession(input.runChatId, input.roleId);
  const linkRoot = rootChatIdOf(input.runChatId);
  setPlanLink(linkRoot, input.roleId, { parentRoleId: input.requesterId, questionId: input.questionId ?? null });
  let prompt = subagentPrompt(input.requesterRole, input.role, input.question);
  // Сессия хода: при корректировке она продолжается, а не начинается заново.
  let sessionId: string | null = null;
  try {
    for (let attempt = 0; attempt <= SUBAGENT_STEER_LIMIT; attempt++) {
      let text = "";
      let failure: string | undefined;
      try {
        const turn = await runAsSubagent(
          { requesterRole: input.requesterRole, recipientRole: input.role },
          () =>
            input.runner({
              role: input.role,
              roleId: input.roleId,
              chatId: input.runChatId,
              prompt,
              timeoutMs: SUBAGENT_TIMEOUT_MS,
              sessionId,
              onEvent: (event: unknown) => {
                try {
                  input.room?.onEvent(event);
                } catch {
                  /* живая лента — украшение */
                }
                try {
                  coordinationActivity(input.questionId, input.roleId, event);
                } catch {
                  /* живая лента — украшение */
                }
              },
            }),
        );
        text = turn.text;
        if (turn.sessionId) sessionId = turn.sessionId;
      } catch (error) {
        failure = errorText(error);
      }

      // Нас перебили уточнением? Тогда ход не провален — продолжаем с правкой.
      const steer = takeSubagentSteer(input.runChatId);
      if (steer) {
        // Правка продолжает ту же работу: контекст уже в сессии.
        prompt = [
          "Уточнение от вызывающей роли — продолжи ту же работу с учётом правки:",
          "",
          steer.text,
        ].join("\n");
        try {
          if (input.questionId) {
            updateCoordination(input.questionId, input.roleId, {
              activity: `Уточнение от вызывающей роли: ${steer.text.slice(0, 120)}`,
              last_activity_at: new Date().toISOString(),
            });
          }
        } catch {
          /* карточка — украшение */
        }
        continue;
      }

      if (failure) {
        finishSubagentFailed(input, failure);
        return;
      }
      finishSubagentWithAnswer(input, truncateAnswer(text) || "(Роль не ответила)");
      return;
    }
    finishSubagentFailed(input, `Лимит уточнений (${SUBAGENT_STEER_LIMIT}) исчерпан`);
  } finally {
    clearPlanLink(linkRoot, input.roleId);
    restoreSession(input.runChatId, input.roleId, priorSession);
  }
}

function finishSubagentWithAnswer(input: BackgroundInput, answer: string): void {
  try {
    input.room?.finish(answer, false);
  } catch {
    /* комната — украшение */
  }
  try {
    input.room?.close("finished");
  } catch {
    /* статус комнаты — украшение */
  }
  if (input.questionId) {
    try {
      // Выжимка ложится в чат вызывающей роли — там же, где карточка, —
      // значит текст в карточку не копируем (иначе дубль).
      coordinationAnswered(input.questionId, input.roleId, answer, false, input.callerChatId);
    } catch {
      /* карточка — украшение */
    }
  }
  deliverDigest(input, answer);
}

function finishSubagentFailed(input: BackgroundInput, reason: string): void {
  try {
    input.room?.finish(`Ход роли не состоялся: ${reason}`, true);
  } catch {
    /* комната — украшение */
  }
  try {
    input.room?.close("failed");
  } catch {
    /* статус комнаты — украшение */
  }
  if (input.questionId) {
    try {
      coordinationAnswered(input.questionId, input.roleId, `Ход роли не состоялся: ${reason}`, true);
    } catch {
      /* карточка — украшение */
    }
  }
  deliverDigest(input, `Ход роли не состоялся: ${reason}`);
}

/**
 * Выжимка в главной сессии + будилка вызывающей роли.
 *
 * Сообщение ложится в чат вызывающей роли (её собственная нить — там
 * владелец её видит), а строка очереди отдаёт его в СЕССИЮ роли: доставка
 * поднимает ей ход, и она продолжает разговор уже с ответом.
 */
function deliverDigest(input: BackgroundInput, answer: string): void {
  try {
    const messageId = crypto.randomUUID();
    const roleName = roleTitle(input.role) || input.role;
    const text = [
      `Ответ субагента «${roleName}» на вопрос «${input.question.slice(0, 160)}»:`,
      "",
      answer,
    ].join("\n");
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)",
    ).run(messageId, input.requesterId, text, input.callerChatId);
    const deliveryId = `subagent:${input.questionId ?? messageId}`;
    const queued = enqueueMessageDelivery({
      chatId: input.callerChatId,
      roleId: input.requesterId,
      deliveryId,
      messageId,
      payload: { mode: "work", hop: 0 },
    });
    // Пока голосовой звонок жив, выжимка лежит в очереди и карточке,
    // но текстовый ход секретаря не поднимаем — его заберёт голос.
    if (activeVoiceCallId(input.callerChatId)) return;
    // queueRowId — id СТРОКИ очереди (queued.id), а не delivery_id:
    // recoverAgentDelivery ищет именно по колонке id. С delivery_id
    // выжимка молча оставалась в очереди и роль не просыпалась.
    void import("../routes/chats.js")
      .then(({ recoverAgentDelivery }) =>
        recoverAgentDelivery({
          chatId: input.callerChatId,
          roleId: input.requesterId,
          queueRowId: queued.id,
        }),
      )
      .catch((error) => console.warn("[subagent-call] доставка выжимки отложена:", errorText(error)));
  } catch (error) {
    console.warn("[subagent-call] выжимку не доставить:", errorText(error));
  }
}

/**
 * Инструмент вызова роли. runner подменяется в тестах (реальный ход роли
 * там не нужен), в каталоге ролей — обычный.
 */
export function createRoleSubagentCallTool(
  context: Context,
  runner: SubagentRunner = runSubagentTurn,
): Tool {
  return {
    name: ROLE_SUBAGENT_CALL_TOOL,
    description:
      "Вызвать другую роль как субагента и получить её ответ текстом. " +
      "Роль работает в одноразовой сессии: сама собирает нужные данные " +
      "и возвращает выжимку — первичные источники перебирать тебе не нужно. " +
      "Вызов не блокирует твой ход: роль работает в фоне, ответ придёт " +
      "в карточку в этом чате и поднимет тебе ход. Не больше 3 вызовов за ход. " +
      "Свою роль звать нельзя.",
    parameters: Type.Object({
      role: Type.String({
        description: "Кого зовёшь: ключ роли (например researcher, analyst, builder).",
      }),
      question: Type.String({
        description: "Текст вопроса — что именно нужно от роли.",
      }),
    }),
    execute: async (_id: string, args: any) => {
      const role = String(args?.role ?? "").trim();
      const question = String(args?.question ?? "").trim();
      if (!role) {
        throw new Error(
          "НЕ УКАЗАНА РОЛЬ: передай role — ключ роли, которую зовёшь (например researcher).",
        );
      }
      if (!question) {
        throw new Error("ПУСТОЙ ВОПРОС: передай question — что именно нужно от роли.");
      }
      if (!roleToolAllowed(context.role, ROLE_SUBAGENT_CALL_TOOL)) {
        throw new Error(
          `ВЫЗОВ РОЛИ НЕ РАЗРЕШЁН: операция ${ROLE_SUBAGENT_CALL_TOOL} недоступна роли ${context.role}.`,
        );
      }
      if (!ROLE_NAMES.includes(role)) {
        throw new Error(
          `НЕИЗВЕСТНАЯ РОЛЬ «${role}». Доступные роли: ${ROLE_NAMES.join(", ")}.`,
        );
      }
      if (role === context.role) {
        throw new Error(
          `ВЫЗВАТЬ САМОЙ СЕБЯ НЕЛЬЗЯ: ты уже «${roleTitle(role) || role}». Зови другую роль.`,
        );
      }
      if (isSubagentRun()) {
        throw new Error(
          "ВЛОЖЕННЫЙ ВЫЗОВ РОЛИ ЗАПРЕЩЁН: из роли роль не зовут — доведи работу сам.",
        );
      }
      const chatId = context.chatId ?? "";
      if (!chatId) {
        throw new Error(
          "НУЖЕН ЧАТ: вызов роли работает в чате. Позови коллегу в чате или оформи задачу.",
        );
      }
      const count = countCall(context.role, chatId);
      if (count > SUBAGENT_CALL_LIMIT) {
        throw new Error(
          `ЛИМИТ: не больше ${SUBAGENT_CALL_LIMIT} вызовов роли за ход (уже ${count - 1}). ` +
            "Собери ответ из того, что есть.",
        );
      }

      const requesterId = context.actor || roleUserId(context.role);
      const recipientId = roleUserId(role);
      // Своя комната-ветка: там видно, как роль работает (владелец 28.10.2026).
      // Не завелась — роль работает, как раньше, в исходном чате.
      let room: SubagentRoom | undefined;
      try {
        room = openSubagentRoom({
          originChatId: chatId,
          originMessageId: originMessageId(context.messageId),
          requesterId,
          recipientId,
          question,
        });
      } catch (error) {
        console.warn("[subagent-call] комната субагента не заведена:", errorText(error));
      }
      const runChatId = room?.chatId ?? chatId;

      let questionId: string | undefined;
      try {
        questionId = ensureSubagentCoordinationCard({
          chatId,
          requesterId,
          recipientId,
          question,
          originMessageId: originMessageId(context.messageId),
          roomChatId: room?.chatId,
        });
      } catch (error) {
        console.warn("[subagent-call] карточка обращения не создана:", errorText(error));
      }

      // Ход — в фоне: ход вызывающей роли не занимаем (владелец 29.10.2026).
      const background = runSubagentInBackground({
        room,
        runChatId,
        callerChatId: chatId,
        role,
        roleId: recipientId,
        requesterRole: context.role,
        requesterId,
        question,
        questionId,
        runner,
      }).catch((error) => {
        console.warn("[subagent-call] фоновый ход не состоялся:", errorText(error));
      });
      backgroundRuns.add(background);
      void background.finally(() => backgroundRuns.delete(background));

      const roleName = roleTitle(role) || role;
      return {
        content: [
          {
            type: "text",
            text:
              `Субагент «${roleName}» запущен в фоне. Ответ придёт в карточку в этом чате ` +
              `и поднимет тебе ход — продолжай свои дела, а уточнить работу субагента можно ` +
              `инструментом ${ROLE_SUBAGENT_STEER_TOOL} (question_id ниже).`,
          },
        ],
        details: {
          operation: ROLE_SUBAGENT_CALL_TOOL,
          role,
          question_id: questionId,
          room_chat_id: room?.chatId,
          started: true,
        },
      };
    },
  };
}

/**
 * Инструмент уточнения работающего субагента.
 *
 * Уточнение пишется в комнату (видно в переписке), текущий ход роли
 * прерывается границей прерывания, наработка уходит в чекпоинт — и ход
 * перезапускается с новым заданием. Роль продолжает ту же работу с учётом
 * правки.
 */
export function createRoleSubagentSteerTool(context: Context): Tool {
  return {
    name: ROLE_SUBAGENT_STEER_TOOL,
    description:
      "Докинуть уточнение субагенту, который сейчас работает. Он прервётся, " +
      "подхватит наработку и продолжит с учётом правки. question_id — из " +
      "деталей вызова роли.",
    parameters: Type.Object({
      question_id: Type.String({
        description: "question_id вызова роли — из details ответа taskflow_call_role.",
      }),
      text: Type.String({
        description: "Уточнение или корректировка работы субагента.",
      }),
    }),
    execute: async (_id: string, args: any) => {
      if (!roleToolAllowed(context.role, ROLE_SUBAGENT_STEER_TOOL)) {
        throw new Error(
          `УТОЧНЕНИЕ НЕ РАЗРЕШЕНО: операция ${ROLE_SUBAGENT_STEER_TOOL} недоступна роли ${context.role}.`,
        );
      }
      const questionId = String(args?.question_id ?? "").trim();
      const text = String(args?.text ?? "").trim();
      if (!questionId) {
        throw new Error(
          "НУЖЕН question_id: возьми его из details ответа taskflow_call_role (текущий вызов роли).",
        );
      }
      if (!text) {
        throw new Error("ПУСТОЕ УТОЧНЕНИЕ: напиши, что поправить.");
      }
      const row = db
        .prepare(
          "SELECT id,steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=? LIMIT 1",
        )
        .get(questionId) as { id: string; steps: string } | undefined;
      if (!row) throw new Error("ОБРАЩЕНИЕ НЕ НАЙДЕНО: нет карточки с таким question_id.");
      const card = (JSON.parse(row.steps) as any)?.coordination;
      if (!card) throw new Error("ОБРАЩЕНИЕ НЕ НАЙДЕНО: у сообщения нет coordination-карточки.");
      if (card.terminal) {
        return {
          content: [{ type: "text", text: "Обращение уже закрыто — уточнять нечего." }],
          details: { operation: ROLE_SUBAGENT_STEER_TOOL, question_id: questionId, applied: false },
        };
      }
      const roomChatId = String(card.child_chat_id ?? "");
      const recipientId = String(card.recipient_id ?? "");
      if (!roomChatId || !recipientId) {
        throw new Error("У ОБРАЩЕНИЯ НЕТ КОМНАТЫ: уточнить нечем.");
      }
      const requesterId = context.actor || roleUserId(context.role);

      // 1. Уточнение записано — фоновая ветка хода подхватит его после
      //    прерывания и перезапустит роль с новым заданием.
      recordSubagentSteer({ roomChatId, questionId, text });

      // 2. Гасим текущий ход роли в комнате. Наработка уходит в чекпоинт,
      //    чтобы следующий ход её увидел.
      const { cancelChatRunsFor, waitChatRunsIdle } = await import("./PiRuntimeAdapter.js");
      const boundary = await applyOwnerBoundary(
        { chatId: roomChatId, roleId: recipientId, reason: "subagent_steer" },
        {
          bumpGeneration: ({ chatId: c, roleId: r, reason }) =>
            bumpChatGeneration({ chatId: c, roleId: r, reason }).generation,
          cancelRuns: (c, r) => cancelChatRunsFor(c, r),
          waitIdle: (c, r, timeoutMs) => waitChatRunsIdle(c, r, timeoutMs).then(() => undefined),
        },
      );
      // Наработку несёт ПРОДОЛЖЕНИЕ СЕССИИ: следующий attempt открывает тот же
      // файл сессии Pi (startChatRun ищет файл по sessionId и открывает его).
      // Чекпоинт здесь не нужен: он собирается из сообщений чата, а работа
      // субагента живёт в сессии — и незакрытый указатель на перенос утек бы
      // в обычный ход чата.
      // Доставки прежнего поколения — не доставлять: ход уже перезапущен.
      try {
        fencePairDeliveries({
          chatId: roomChatId,
          roleId: recipientId,
          generation: boundary.generation,
        });
      } catch {
        /* доставки старого поколения — не критично */
      }

      // 3. Уточнение видно в переписке комнаты.
      try {
        db.prepare(
          "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)",
        ).run(crypto.randomUUID(), requesterId, `Уточнение от вызывающей роли: ${text}`, roomChatId);
      } catch (error) {
        console.warn("[subagent-call] уточнение в комнату не легло:", errorText(error));
      }

      return {
        content: [
          { type: "text", text: "Уточнение отправлено субагенту: он продолжит работу с учётом правки." },
        ],
        details: {
          operation: ROLE_SUBAGENT_STEER_TOOL,
          question_id: questionId,
          room_chat_id: roomChatId,
          applied: true,
        },
      };
    },
  };
}
