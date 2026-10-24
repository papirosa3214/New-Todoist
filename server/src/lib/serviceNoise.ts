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
  if (row.message_type !== "system" && row.kind !== "system") return false;
  // Ошибки доставки и запросы решения владельцу остаются видимыми.
  return !/не удалось|ошибка|нужен ваш|нужно ваше|требуется|укажите|выберите|approve\/reject/i.test(String(row.text ?? ""));
}

// Тот же отбор до LIMIT/COUNT: скрытый шум не занимает превью и не даёт бейдж.
export function visibleChatSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  const phrases = ["не удалось", "Не удалось", "ошибка", "Ошибка", "нужен ваш", "Нужен ваш", "нужно ваше", "Нужно ваше", "требуется", "Требуется", "укажите", "Укажите", "выберите", "Выберите", "approve/reject"];
  const actionable = phrases.map(text=>`instr(${p}text, '${text}') > 0`).join(" OR ");
  return `(COALESCE(${p}is_session_marker, 0) = 0 AND (COALESCE(${p}message_type, '') != 'system' OR ${actionable}))`;
}
