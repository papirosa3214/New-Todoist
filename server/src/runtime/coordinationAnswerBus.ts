/**
 * Реестр подписчиков «обращение закрылось ответом».
 *
 * Отдельный листовой модуль без единого импорта проекта (владелец 12.11.2026).
 * Раньше реестр `answerListeners` жил в `chatCoordination.ts`, а подписка —
 * в `roleCrossSessionMessage.ts`, и это замыкало цикл модулей:
 * roleCrossSessionMessage → chatCoordination → lib/chatMessages →
 * runtime/chatMessageWithdrawal → runtime/inProcessRun → runtime/agentMessaging
 * → roleCrossSessionMessage. Подписка выполнялась во время загрузки цикла,
 * `answerListeners` ещё не был инициализирован, и весь серверный граф падал
 * с `ReferenceError: Cannot access 'answerListeners' before initialization` —
 * модульные тесты не запускались, ветка не вливалась.
 *
 * Модуль намеренно без зависимостей: пока у него нет импортов, цикла через
 * него быть не может. Сюда — только реестр; издатель (`chatCoordination`) и
 * подписчик (`roleCrossSessionMessage`) импортируют его независимо.
 */
export type CoordinationAnswerListener = (input: {
  deliveryKey: string;
  questionId: string;
  recipientId: string;
  answer: string;
}) => void;

const answerListeners: CoordinationAnswerListener[] = [];

/** Подписка на закрытие обращения ответом (межсессионное обращение будит спросившего). */
export function onCoordinationAnswered(fn: CoordinationAnswerListener): void {
  answerListeners.push(fn);
}

/** Разослать событие ответа всем подписчикам; сбой одного не мешает остальным. */
export function emitCoordinationAnswered(input: Parameters<CoordinationAnswerListener>[0]): void {
  for (const fn of answerListeners) {
    try {
      fn(input);
    } catch (error) {
      console.warn("[coordination] слушатель ответа:", error);
    }
  }
}

/** Только для тестов: снять всех подписчиков. */
export function resetCoordinationAnswerListeners(): void {
  answerListeners.length = 0;
}
