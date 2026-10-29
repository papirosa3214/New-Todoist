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
 * Карточка координации живёт в чате ВЫЗЫВАЮЩЕЙ роли (chatId из контекста
 * инструмента) — там, где её и ждёт человек.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import db from "../db.js";
import { roleToolAllowed } from "../lib/roleToolScope.js";
import { ROLE_NAMES, roleTitle, roleUserId } from "../roleRouting.js";
import {
  coordinationActivity,
  coordinationAnswered,
  ensureSubagentCoordinationCard,
} from "./chatCoordination.js";
import { openSubagentRoom, type SubagentRoom } from "./subagentRoom.js";
import type { Context, Tool } from "./universalTaskflow.js";

export const ROLE_SUBAGENT_CALL_TOOL = "taskflow_call_role";
/** Не больше трёх вызовов субагента за один ход вызывающей роли. */
export const SUBAGENT_CALL_LIMIT = 3;
/** Ответ длиннее этого обрезается — иначе он съест контекст вызывающей роли. */
export const SUBAGENT_ANSWER_LIMIT = 16000;
/** Потолок хода субагента. */
export const SUBAGENT_TIMEOUT_MS = 10 * 60_000;

export type SubagentRunInput = {
  role: string;
  roleId: string;
  chatId: string;
  prompt: string;
  timeoutMs: number;
  onEvent?: (event: unknown) => void;
};

export type SubagentRunner = (input: SubagentRunInput) => Promise<string>;

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

/** Ход субагента по умолчанию: живая сессия Pi, своя сессия роли. */
async function runSubagentTurn(input: SubagentRunInput): Promise<string> {
  // Динамический импорт: PiRuntimeAdapter сам строит каталог ролей —
  // статический импорт дал бы цикл модулей.
  const { startChatRun } = await import("./PiRuntimeAdapter.js");
  const result = await startChatRun({
    chatId: input.chatId,
    role: input.role,
    roleId: input.roleId,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    onEvent: input.onEvent,
  });
  return result?.text ?? "";
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
      "Не больше 3 вызовов за ход. Свою роль звать нельзя.",
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

      // Сессия роли в этом чате — не трогаем: ход субагента одноразовый.
      const priorSession = readSession(runChatId, recipientId);
      let text = "";
      try {
        text = await runAsSubagent({ requesterRole: context.role, recipientRole: role }, () =>
          runner({
            role,
            roleId: recipientId,
            chatId: runChatId,
            prompt: subagentPrompt(context.role, role, question),
            timeoutMs: SUBAGENT_TIMEOUT_MS,
            onEvent: (event: unknown) => {
              try {
                room?.onEvent(event);
              } catch {
                /* живая лента — украшение */
              }
              try {
                coordinationActivity(questionId, recipientId, event);
              } catch {
                /* живая лента — украшение */
              }
            },
          }),
        );
      } catch (error) {
        const message = errorText(error);
        try {
          room?.finish(`Ход роли не состоялся: ${message}`, true);
        } catch {
          /* комната — украшение */
        }
        if (questionId) {
          try {
            coordinationAnswered(questionId, recipientId, `Ход роли не состоялся: ${message}`, true);
          } catch {
            /* карточка — украшение */
          }
        }
        try {
          room?.close("failed");
        } catch {
          /* статус комнаты — украшение */
        }
        throw new Error(`ХОД РОЛИ «${role}» НЕ СОСТОЯЛСЯ: ${message}`);
      } finally {
        restoreSession(runChatId, recipientId, priorSession);
      }

      const answer = truncateAnswer(text) || "(Роль не ответила)";
      try {
        room?.finish(answer, false);
      } catch (error) {
        console.warn("[subagent-call] ответ в комнату не лёг:", errorText(error));
      }
      if (questionId) {
        try {
          coordinationAnswered(questionId, recipientId, answer, false);
        } catch {
          /* карточка — украшение */
        }
      }
      // Выжимка ушла в главную сессию — комната закрывается сама (владелец
      // 28.10.2026): в боковой панели сессии у неё статус «завершена».
      try {
        room?.close("finished");
      } catch {
        /* статус комнаты — украшение */
      }
      return {
        content: [{ type: "text", text: answer }],
        details: { operation: ROLE_SUBAGENT_CALL_TOOL, role, question_id: questionId, room_chat_id: room?.chatId },
      };
    },
  };
}
