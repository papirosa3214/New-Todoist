// Граница прерывания обычного чата (карточка 252c400e, этап «чат»).
//
// Единственная процедура остановки прежней работы по новому сообщению
// владельца. Порядок зафиксирован архитектором:
//
//   1. ГРАНИЦА. Поколение пары (чат, роль) увеличивается — все ходы старого
//      поколения уходят в superseded. После этого старый ход не может ни
//      начать новое действие, ни опубликовать свой итог.
//   2. ОСТАНОВКА. Живые ходы роли отменяются по-настоящему: сигнал отмены
//      доходит до выполняемого действия, а не только помечает ход.
//   3. ДОЖИДАНИЕ. Ждём, пока ход действительно остановится (предел времени
//      задан настройкой), чтобы частичный ответ был собран целиком.
//   4. ЧАСТИЧНЫЙ ОТВЕТ. Его сохраняет сам прерванный ход (см. deliverAgentReply
//      в routes/chats.ts) — с признаками stop_reason/partial.
//
// Модуль сделан отдельным и с внедрёнными зависимостями: порядок шагов
// проверяется обычным тестом без живой модели и без сети.

/** Внедряемые зависимости процедуры — для теста и для живого сервера. */
export interface OwnerBoundaryDeps {
  /** Увеличить поколение пары (чат, роль); вернуть новое поколение. */
  bumpGeneration(input: { chatId: string; roleId: string; reason: string }): number;
  /** Остановить живые ходы роли в чате; вернуть число остановленных. */
  cancelRuns(chatId: string, roleId: string): Promise<number>;
  /** Дождаться фактической остановки ходов роли. */
  waitIdle(chatId: string, roleId: string, timeoutMs: number): Promise<void>;
}

export interface OwnerBoundaryInput {
  chatId: string;
  roleId: string;
  /** Причина в журнале событий. */
  reason?: string;
  /** Предел ожидания остановки, мс. */
  timeoutMs?: number;
}

export interface OwnerBoundaryResult {
  /** Новое поколение пары (чат, роль). */
  generation: number;
  /** Сколько живых ходов остановлено. */
  cancelled: number;
  /** true — ход действительно дошёл до состояния покоя. */
  idle: boolean;
}

/** Предел ожидания остановки по умолчанию (мс). Число из настроек сервера. */
export const DEFAULT_STOP_WAIT_MS = 10_000;

/**
 * Граница прерывания: поколение → отмена → ожидание.
 *
 * Шаги идут строго в этом порядке: отмена без границы оставила бы старому
 * ходу право опубликовать итог, а ожидание без отмены — висело бы в фоне.
 */
export async function applyOwnerBoundary(
  input: OwnerBoundaryInput,
  deps: OwnerBoundaryDeps,
): Promise<OwnerBoundaryResult> {
  const generation = deps.bumpGeneration({
    chatId: input.chatId,
    roleId: input.roleId,
    reason: input.reason ?? "owner_interrupt",
  });
  const cancelled = await deps.cancelRuns(input.chatId, input.roleId);
  let idle = true;
  try {
    await deps.waitIdle(input.chatId, input.roleId, input.timeoutMs ?? DEFAULT_STOP_WAIT_MS);
  } catch {
    idle = false;
  }
  return { generation, cancelled, idle };
}
