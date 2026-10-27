// Пауза хода роли на решение владельца (27.10.2026, по образцу interrupt
// из протокола AG-UI). Инструмент `taskflow_ask_user_question` не завершает
// ход, а ждёт ответа здесь: ответ владельца (POST …/questions/:qid/answer)
// отдаётся в тот же ход, и роль продолжает с того же вызова инструмента.
//
// Реестр — в памяти процесса: ожидание живёт столько же, сколько ход. Если
// ход оборван (остановка, потолок времени) или пауза вышла по таймауту,
// ожидание снимается, вопрос остаётся открытым, а ответ поднимает новый ход
// роли — как было до паузы.
import type { AnswerPayload } from "./chatQuestions.js";

/** Сколько ход ждёт ответа владельца (владелец согласовал 30 мин). */
export const QUESTION_WAIT_MS = 30 * 60_000;

const waiting = new Map<string, (answer: AnswerPayload | null) => void>();

/** Ждать ответа на вопрос. null — ответа не будет в этом ходе (таймаут или
 *  ход оборван): роль заканчивает ход, ответ придёт новым ходом. */
export function waitForAnswer(
  questionId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AnswerPayload | null> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve(null);
    const finish = (answer: AnswerPayload | null) => {
      if (waiting.get(questionId) !== finish) return;
      waiting.delete(questionId);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? QUESTION_WAIT_MS);
    timer.unref?.();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(questionId, finish);
  });
}

/** Отдать ответ ждущему ходу. false — никто не ждёт: ответ поднимает новый ход. */
export function deliverAnswer(questionId: string, answer: AnswerPayload): boolean {
  const finish = waiting.get(questionId);
  if (!finish) return false;
  finish(answer);
  return true;
}

export function isWaiting(questionId: string): boolean {
  return waiting.has(questionId);
}

/** Событие «нужен ответ» в потоке живого хода (AG-UI interrupt): ход роли
 *  стоит на паузе, клиент рисует вопрос с вариантами. */
export function liveInterruptEvent(args: {
  chatId: string; userId: string; questionId: string; messageId: string;
  payload: { questions: unknown[]; note?: string };
}): Record<string, unknown> {
  return {
    type: "chats:live:interrupt",
    chat_id: args.chatId,
    user_id: args.userId,
    question_id: args.questionId,
    message_id: args.messageId,
    questions: args.payload.questions,
    ...(args.payload.note ? { note: args.payload.note } : {}),
  };
}

/** Пауза снята: ответ получен (answered) или ждать перестали (expired). */
export function liveResumeEvent(args: {
  chatId: string; userId: string; questionId: string; outcome: "answered" | "expired";
}): Record<string, unknown> {
  return {
    type: "chats:live:resume",
    chat_id: args.chatId,
    user_id: args.userId,
    question_id: args.questionId,
    outcome: args.outcome,
  };
}
