// Пользовательские ленты содержат работу и решения, технические переходы — в журнале.
const routine = /^(?:Материал для работы собран\.|Изменил план совместной работы:|Сторож снял задачу с работы:)|^«[^»]+»: (?:мой ход оборвался|после рестарта сервера снят признак|снят признак|поток событий остановился — перезапускаю попытку)/;
export function isRoutineServiceComment(row: {user_id?: string|null; text?: unknown}): boolean {
  const author = row.user_id;
  if (author != null && !author.startsWith("role_")) return false;
  return author == null || (typeof row.text === "string" && routine.test(row.text.trim()));
}
export function visibleTaskComments<T extends {user_id?: string|null; text?: unknown}>(rows:T[]):T[] {
  return rows.filter(row=>!isRoutineServiceComment(row));
}
export function isQuietSystemMessage(row:any): boolean {
  if (!row) return false;
  if (row.is_session_marker) return true;
  // Обращение к коллеге — раскрываемая карточка с вопросом/ответом, не шум.
  if (row.coordination && typeof row.coordination === "object") return false;
  // Чип наблюдателя памяти — тихая метка в ленте, не шум.
  if (row.memory_update && typeof row.memory_update === "object") return false;
  if (row.message_type !== "system" && row.kind !== "system") return false;
  // Ошибки доставки и запросы решения владельцу остаются видимыми.
  return !/не удалось|ошибка|нужен ваш|нужно ваше|требуется|укажите|выберите|approve\/reject/i.test(String(row.text ?? ""));
}

// Тот же отбор до LIMIT/COUNT: скрытый шум не занимает превью и не даёт бейдж.
export function visibleChatSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  const phrases = ["не удалось", "Не удалось", "ошибка", "Ошибка", "нужен ваш", "Нужен ваш", "нужно ваше", "Нужно ваше", "требуется", "Требуется", "укажите", "Укажите", "выберите", "Выберите", "approve/reject"];
  const actionable = phrases.map(text=>`instr(${p}text, '${text}') > 0`).join(" OR ");
  const coordination = `CASE WHEN json_valid(${p}steps) THEN json_type(${p}steps, '$.coordination') = 'object' ELSE 0 END`;
  const memoryUpdate = `CASE WHEN json_valid(${p}steps) AND json_type(${p}steps, '$.memory_update') = 'object' THEN 1 ELSE 0 END`;
  return `(COALESCE(${p}is_session_marker, 0) = 0 AND (COALESCE(${p}message_type, '') != 'system' OR (${coordination}) OR (${memoryUpdate}) OR ${actionable}))`;
}
