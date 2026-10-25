import db from "../db.js";
export type WorkPlanItem = { id: string; title: string; state: "pending" | "in_progress" | "done" };
export const WORK_PLAN_INSTRUCTION = "РАБОЧИЙ ЧЕК-ЛИСТ — это твой рабочий план, а не отчёт. Заведи его ДО начала работы через taskflow_work_plan, из того, как ТЫ сам видишь путь к результату: обычно 3–7 этапов, у каждого понятно, что считается сделанным. Он нужен тебе, чтобы не теряться и не закрутиться: следующий шаг берёшь по нему, а не по ощущению «ещё чуть-чуть». ГРАНИЦА: работа закончена, когда выполнены «Результат» и «Критерии приёмки» карточки. Всё, что сверх этого, — уже не твой этап: не раздувай объём и не уходи в перфекционизм. В начале прочитай сохранённый план (инструмент без items), при продолжении используй его и не обнуляй выполненное. Перед этапом отметь его in_progress, по факту выполнения — done, при необходимости дополни список. Передавай весь актуальный список с устойчивыми id и base_revision из последнего ответа. Чек-лист не запрещает сдачу: галочки не сдача и не ревью, обычную сдачу делай через taskflow_subtask_done, после успешной сдачи сервер сам закроет последний пункт. Честность: не заводи пункты, которые не собираешься выполнять, и не дописывай план перед самой сдачей лишь бы он выглядел заполненным — владелец смотрит на него, чтобы видеть ход работы.";
export function validateWorkPlan(raw: unknown): WorkPlanItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw new Error("План содержит от 1 до 20 этапов");
  const ids = new Set<string>(); let current = 0;
  return raw.map(item => {
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) throw new Error("У этапов должны быть уникальные устойчивые id");
    ids.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.trim().length > 200) throw new Error("Название этапа: 1–200 символов");
    if (!["pending", "in_progress", "done"].includes(item.state)) throw new Error("Состояние этапа: pending, in_progress или done");
    if (item.state === "in_progress" && ++current > 1) throw new Error("Текущим может быть только один этап");
    return {id:item.id, title:item.title.trim(), state:item.state};
  });
}
export function readWorkPlan(subtaskId: string) {
  const row = db.prepare("SELECT * FROM subtask_work_plans WHERE subtask_id=?").get(subtaskId) as any;
  return row ? {subtask_id:subtaskId, revision:row.revision, items:JSON.parse(row.items_json), updated_at:row.updated_at, author_id:row.author_id} : null;
}
export function saveWorkPlan(subtaskId: string, authorId: string, revision: number, items: WorkPlanItem[]) {
  return db.transaction(() => {
    const existing = readWorkPlan(subtaskId);
    if ((existing?.revision ?? 0) !== revision) throw new Error("revision_conflict");
    db.prepare(`INSERT INTO subtask_work_plans(subtask_id,revision,items_json,author_id,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(subtask_id) DO UPDATE SET revision=excluded.revision,items_json=excluded.items_json,author_id=excluded.author_id,updated_at=excluded.updated_at`)
      .run(subtaskId, revision+1, JSON.stringify(items), authorId, new Date().toISOString());
    return readWorkPlan(subtaskId);
  })();
}

/** Рабочий чек-лист роли в чате (21.10.2026): одна запись на «чат + роль».
 *  Правила и проверка — те же, что у слота (`validateWorkPlan`). */
export type ChatWorkPlan = { chat_id: string; role_id: string; revision: number; items: WorkPlanItem[]; updated_at: string };
const chatPlanRow = (row: any): ChatWorkPlan => ({ chat_id: row.chat_id, role_id: row.role_id, revision: row.revision, items: JSON.parse(row.items_json), updated_at: row.updated_at });
export function readChatWorkPlan(chatId: string, roleId: string): ChatWorkPlan | null {
  const row = db.prepare("SELECT * FROM chat_work_plans WHERE chat_id=? AND role_id=?").get(chatId, roleId);
  return row ? chatPlanRow(row) : null;
}
export function readChatWorkPlans(chatId: string): ChatWorkPlan[] {
  return (db.prepare("SELECT * FROM chat_work_plans WHERE chat_id=? ORDER BY updated_at DESC").all(chatId) as any[]).map(chatPlanRow);
}
/** План выполнен целиком — закрыт: в полоске не показывается, а новый план
 *  ложится поверх него без сверки revision (владелец 21.10.2026). */
export function isWorkPlanFinished(items: WorkPlanItem[]): boolean {
  return items.length > 0 && items.every((item) => item.state === "done");
}
export function saveChatWorkPlan(chatId: string, roleId: string, revision: number, items: WorkPlanItem[]): ChatWorkPlan {
  return db.transaction(() => {
    const existing = readChatWorkPlan(chatId, roleId);
    const finished = existing ? isWorkPlanFinished(existing.items) : false;
    if (!finished && (existing?.revision ?? 0) !== revision) throw new Error("revision_conflict");
    revision = existing?.revision ?? 0;
    db.prepare(`INSERT INTO chat_work_plans(chat_id,role_id,revision,items_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(chat_id,role_id) DO UPDATE SET revision=excluded.revision,items_json=excluded.items_json,updated_at=excluded.updated_at`)
      .run(chatId, roleId, revision + 1, JSON.stringify(items), new Date().toISOString());
    return readChatWorkPlan(chatId, roleId)!;
  })();
}
/** «Новая сессия» роли в чате начинает и план с чистого листа. */
export function clearChatWorkPlan(chatId: string, roleId: string): void {
  db.prepare("DELETE FROM chat_work_plans WHERE chat_id=? AND role_id=?").run(chatId, roleId);
}

/** Плана нет: правило про чек-лист на этот ход (владелец 25.10.2026). */
export const CHAT_PLAN_MISSING_PROMPT =
  "ЧЕК-ЛИСТ В ЧАТЕ: плана на эту сессию пока нет. Если поручение больше одного шага — ПЕРВЫМ действием заведи его через taskflow_work_plan: 3–7 этапов, у каждого понятно, что считается сделанным, ровно один in_progress. Сервер сам читает твой план, выдаёт тебе текущий этап и закрывает план, когда все пункты done. Для простого вопроса или короткого ответа план не нужен.";

/** Текст серверного ведения по чатовому плану. Чистая функция: без БД и без
 *  состояния — так её видно в тесте. Пустая строка = плана нет либо он закрыт. */
export function chatWorkPlanPromptText(items: WorkPlanItem[], revision: number): string {
  if (!items.length) return CHAT_PLAN_MISSING_PROMPT;
  if (isWorkPlanFinished(items)) return "";
  const current = items.find((item) => item.state === "in_progress") ?? items.find((item) => item.state === "pending")!;
  const list = items
    .map((item) => `${item.state === "done" ? "✓" : item.id === current.id ? "▶" : "•"} ${item.title}`)
    .join("\n");
  return [
    `ТВОЙ ЧЕК-ЛИСТ В ЧАТЕ (его ведёт сервер, revision ${revision}):`,
    list,
    "",
    `Текущий этап — «${current.title}» (id ${current.id}). Работай по нему, остальные не бери.`,
    `- начал этап — отметь in_progress, выполнил — done: taskflow_work_plan с полным списком и base_revision ${revision};`,
    "- по ходу пиши владельцу коротко, что делаешь и что вышло по этапу;",
    "- закрыл этап — сервер выдаст следующий на следующем ходу;",
    "- когда все этапы done, сервер закроет план сам: полоска исчезнет, работа считается законченной и по ней даётся отчёт.",
  ].join("\n");
}

/** Что сервер подкладывает роли в начало чатового хода: текущий этап её плана. */
export function chatWorkPlanPrompt(chatId: string, roleId: string): string {
  const plan = readChatWorkPlan(chatId, roleId);
  return plan ? chatWorkPlanPromptText(plan.items, plan.revision) : CHAT_PLAN_MISSING_PROMPT;
}
