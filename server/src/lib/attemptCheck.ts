// Проверка attempt_id на сообщениях от агента (задача 8ca87c61, шаг 3).
//
// Инвариант: «сервер отклоняет сообщения с чужим или устаревшим attempt_id».
// Сообщение от агента — heartbeat, state, comments, subtaskWork. Все они
// привязаны к конкретной попытке, и сообщение с попыткой, отличной от
// текущей действующей попытки задачи, должно быть отвергнуто — иначе
// чужой/протухший исполнитель мог бы продлить аренду чужой работы.
//
// Мягкий enforcement (текущий шаг): проверяем только когда агент прислал
// X-Agent-Attempt-Id. Старые клиенты, которые не знают о попытках, шлют
// без заголовка — их запросы пропускаются как раньше, иначе сломаем всё
// до отката. В следующих шагах (claim выдаёт attempt_id в ответ, MCP-прокси
// прокидывает заголовок) перейдём к жёсткому «без заголовка — 400».

import type { FastifyRequest } from "fastify";

/** Достаёт attempt_id из заголовка X-Agent-Attempt-Id. null, если не прислали. */
export function readAttemptId(req: FastifyRequest): string | null {
  const raw = req.headers["x-agent-attempt-id"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

/** Сравнивает присланный attempt_id с текущей действующей попыткой задачи.
 *  Возвращает null при совпадении или отсутствии проверки, строку ошибки иначе. */
export function attemptMismatchReason(
  claimed: string | null,
  currentAttemptId: string | null,
): string | null {
  // Задача вообще не в работе — нет активной попытки. Агент не должен
  // слать attempt_id, потому что claim'а не было. Если шлёт — отвергаем
  // явно: «нет активной попытки», иначе агент мог бы подделать чужой id.
  if (currentAttemptId == null) {
    if (claimed != null) return "no_active_attempt";
    return null;
  }
  // Задача в работе. Без заголовка — мягкий пропуск (старый клиент).
  if (claimed == null) return null;
  // С заголовком — должно совпасть с текущей попыткой.
  if (claimed !== currentAttemptId) return "attempt_id_mismatch";
  return null;
}
