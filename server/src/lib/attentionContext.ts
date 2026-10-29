// Наводящая строка карточки «Входящих» (владелец 29.10.2026).
//
// Задача владельца: карточка во «Входящих» должна сама отвечать на вопрос
// «что делать» — иначе каждую задачу приходится открывать и вникать в неё
// заново. Строка собирается из живых данных задачи: причина блокировки,
// вопрос роли, вердикт проверки, текущий шаг. Ничего не придумывается —
// сервер отдаёт готовую строку, телефон её только рисует (та же идея, что
// в `windowProjection.ts`: телефон — чисто окошко).

/** Группа «Входящих» — статус задачи, из которого собрана строка. */
export type AttentionGroupKey = "blocked" | "in_progress" | "review";

/** Данные задачи, из которых собирается наводящая строка. */
export interface AttentionContext {
  group: AttentionGroupKey;
  /** Причина блокировки задачи (`tasks.blocked_reason`). */
  blockedReason: string | null;
  /** Вопрос роли, на который нужен ответ владельца. */
  clarificationQuestion: string | null;
  /** Заголовок незакрытого шага. */
  openStepTitle: string | null;
  /** Результат незакрытого шага (вердикт проверки, доработка). */
  openStepResult: string | null;
  /** Заголовок шага, который сейчас в работе. */
  activeStepTitle: string | null;
  /** Вердикт проверки: результат шага с пометкой `approved:` / `changes_requested:`. */
  verdictResult: string | null;
  /** Заголовок последнего закрытого шага. */
  lastStepTitle: string | null;
  /** Результат последнего закрытого шага. */
  lastStepResult: string | null;
  /** Описание задачи — последний запас. */
  description: string | null;
}

/** Сколько символов влезает в строку карточки (две строки на телефоне). */
export const HINT_LIMIT = 140;

/** Текст в одну строку: переводы строк — в пробелы, длинное обрезано. */
export const oneLine = (text: string | null | undefined): string | null => {
  if (typeof text !== "string") return null;
  const joined = text.replace(/\s+/g, " ").trim();
  if (!joined) return null;
  return joined.length <= HINT_LIMIT ? joined : `${joined.slice(0, HINT_LIMIT).trimEnd()}…`;
};

/** Первая содержательная часть описания.
 *
 * Описания задач приходят разделами («## Работа», «## Результат»…), и
 * заголовок раздела на карточке показывать нельзя — показываем первую часть,
 * которая не заголовок.
 */
export const descriptionLine = (description: string | null | undefined): string | null => {
  if (!description) return null;
  const paragraph = description
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("#"));
  return oneLine(paragraph ?? null);
};

/** Наводящая строка карточки: что с задачей делать прямо сейчас.
 *
 * Порядок источников — по тому, что владелец делает первым:
 *   1. вопрос роли — задача ждёт ответа владельца;
 *   2. причина блокировки — она и про другие группы объясняет, что ждёт
 *      решения владельца (у задачи «На проверке» она тоже бывает);
 *   3. свой источник группы: текущий шаг, вердикт проверки, результат шага;
 *   4. описание задачи — последний запас.
 */
export const attentionHint = (ctx: AttentionContext): string | null => {
  const question = oneLine(ctx.clarificationQuestion);
  if (question) return `Нужен ваш ответ: ${question}`;

  const reason = oneLine(ctx.blockedReason);
  if (reason) return reason;

  const byGroup: Record<AttentionGroupKey, (string | null)[]> = {
    blocked: [ctx.openStepResult, ctx.openStepTitle],
    in_progress: [ctx.activeStepTitle, ctx.openStepTitle, ctx.openStepResult],
    review: [ctx.verdictResult, ctx.lastStepResult, ctx.openStepTitle, ctx.lastStepTitle],
  };
  const found = byGroup[ctx.group].map(oneLine).find((value) => value !== null);
  return found ?? descriptionLine(ctx.description);
};
