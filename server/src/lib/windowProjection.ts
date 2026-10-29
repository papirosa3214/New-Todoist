// Проекции ответа для «окна» — телефон рисует, считает сервер.
//
// Задача владельца 29.10.2026: телефон должен быть чистым окошком, где
// показывается всё, и никаких операций на нём не проводится — вся
// переработка JSON делается на сервере.
//
// Откуда задача. Профиль iPhone (29.10.2026, 13 срабатываний за 11 дней,
// 50–100% CPU, всегда во фронте) и замер живых ответов того же дня:
//   • GET /api/tasks             — 2,9 МБ на 126 задач, из них 1,85 МБ —
//     подзадачи (716 штук, по 22 поля каждая);
//   • GET /api/roles             — 839 КБ на 11 ролей, из них 258 КБ —
//     системные промпты, 187 КБ — описания операций, 72 КБ — навыки;
//   • GET /api/chats/:id/messages — до 1,1 МБ на чат, из них 3,2 МБ (на
//     20 чатов) — выводы инструментов (`output`) и аргументы вызовов
//     (`args`), которые рисуются только в раскрытой шторке шага.
//
// Разбор 2,9 МБ в модель задачи на хосте — 127 мс против 7 мс у лёгкой
// проекции (замер в Tools/ на маке, 29.10.2026).
//
// Что такое проекция `list`: тот же ответ, из которого убрано то, что
// экрану списка не нужно. Правила простые:
//   • старый клиент проекцию не просит и получает полный ответ как раньше;
//   • новый клиент с новым сервером рисует список сразу;
//   • полные данные берутся по точечным адресам, когда они реально
//     понадобились: GET /api/tasks/:id, GET /api/roles/:role,
//     GET /api/chats/:id/messages/:messageId/steps/:stepId.
//
// Урок из записи в routes/tasks.ts (10.09.2026): в список нельзя класть под
// именем существующего поля его обрезанную версию — у типизированного
// клиента это не «меньше данных», а невалидный ответ. Поэтому убранные
// поля заменяются НОВЫМИ именами (`subtask_total`, `subtask_done`), а под
// прежними именами остаётся то же, что было.

/** Проекция ответа: полный (по умолчанию) или лёгкий для списка. */
export type Projection = "full" | "list";

/** Проекция из query-строки: `?projection=list`. Всё остальное — полный ответ. */
export function projectionOf(query: unknown): Projection {
  const raw = (query as { projection?: unknown } | undefined)?.projection;
  return raw === "list" ? "list" : "full";
}

/** Описание задачи для списка: одна строка вместо всего описания.
 *
 * Строка списка рисует описание одной строкой (`lineLimit(1)` в
 * `TFTaskRowContent`), а присылали её целиком — 210 КБ на 126 задач, из
 * которых видно было первые сорок символов. Здесь текст склеивается в одну
 * строку (как это делает клиент: переводы строк → пробелы) и обрезается.
 */
export function listDescription(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const joined = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!joined) return null;
  const limit = 240;
  return joined.length <= limit ? joined : `${joined.slice(0, limit).trimEnd()}…`;
}

/** Шаги хода для списка: без вывода инструмента и аргументов вызова.
 *
 * Их рисует только раскрытая шторка шага (`RoleLiveDetailSheet`), а в ленте
 * — одна строка с именем инструмента. Поэтому в списке их нет, а полные
 * тела телефон берёт по шагу, когда владелец его раскрывает.
 *
 * `has_output`/`has_args` — новые поля: по ним клиент знает, что детали
 * есть и их стоит запросить.
 */
export function projectStepsForList(steps: unknown): unknown {
  if (!steps || typeof steps !== "object") return steps;
  const source = steps as { items?: unknown };
  if (!Array.isArray(source.items)) return steps;
  const items = source.items.map((item: unknown) => {
    if (!item || typeof item !== "object") return item;
    const step = item as Record<string, unknown>;
    if (step.kind !== "step") return step;
    const { output, args, ...rest } = step;
    return {
      ...rest,
      output: undefined,
      args: undefined,
      has_output: typeof output === "string" && output.length > 0,
      has_args: typeof args === "string" && args.length > 0,
    };
  });
  return { ...source, items };
}

/** Профиль роли для списка: без системного промпта, навыков и описаний
 * операций — их показывают только карточка роли и редактор инструкции.
 */
export function projectRoleForList(role: unknown): unknown {
  if (!role || typeof role !== "object") return role;
  const { prompt, skills, tools_detail, operations_detail, ...rest } = role as Record<string, unknown>;
  return {
    ...rest,
    prompt: undefined,
    skills: undefined,
    tools_detail: undefined,
    operations_detail: undefined,
    has_prompt: typeof prompt === "string" && prompt.length > 0,
    has_skills: Array.isArray(skills) && skills.length > 0,
  };
}
