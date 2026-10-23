// Ветка на каждое сообщение владельца (22.10.2026).
//
// Владелец: «Он получает моё сообщение — и сразу ответвляется: принял, вот
// последовательность, сейчас додeлаю это, потом твоя задача. Сообщаю третью —
// третья ветка. Дальше ветки работают параллельно».
//
// Уточнение владельца 22.10.2026: ветка — не на каждое сообщение, а только
// когда роль занята и ответить сразу не может. Свободная роль отвечает в
// комнате обычным ходом; открытая ветка уже держит ожидание — вторую под него
// не заводим.
//
// Модуль отвечает только за решение и текст: когда ответвлять и что именно
// написать. Создание чата-ветки и запуск хода живут в routes/chats.ts — там уже
// есть вся механика веток, сессий и очереди.

/** Условия, при которых сообщение владельца получает свою ветку. */
export type OwnerFanoutFacts = {
  /** Пишет владелец, а не роль и не служебный путь. */
  fromOwner: boolean;
  /** Чат — личная комната: kind = direct. */
  direct: boolean;
  /** Сколько ролей в чате. Ветка — только когда роль ровно одна. */
  roleMembers: number;
  /** Сам чат уже ветка. Ветки не ветвятся, иначе это рекурсия. */
  isBranch: boolean;
  /** Тема задачи внутри проекта — там карточный процесс, ветки не нужны. */
  isTaskTopic: boolean;
  /** Общий чат: там параллельные ветки создали бы хаос. */
  isCommon: boolean;
  /** Ответ на сообщение роли: это продолжение разговора, а не новая задача. */
  repliesToRole: boolean;
  /** Роль занята: её ход идёт или её сообщение ждёт в очереди.
   *  Ветка нужна только тогда, когда ответить сразу некому (владелец
   *  22.10.2026: «не на каждое же сообщение новая ветка»). */
  roleBusy: boolean;
  /** В комнате уже есть открытая ветка, которая ещё может отвечать:
   *  вторую под то же ожидание не заводим. */
  openBranch: boolean;
};

/**
 * Автоветвление выключено (владелец 23.10.2026: «давай выключим эту ветку»).
 * В личной комнате ветка дублировала работу: занятая роль и так получает
 * сообщение. Ветка осталась ручной — кнопкой «Ответвление».
 */
export const AUTO_BRANCH_ENABLED = false;

export function shouldFanOutOwnerMessage(facts: OwnerFanoutFacts): boolean {
  if (!AUTO_BRANCH_ENABLED) return false;
  return (
    facts.fromOwner &&
    facts.direct &&
    facts.roleMembers === 1 &&
    !facts.isBranch &&
    !facts.isTaskTopic &&
    !facts.isCommon &&
    !facts.repliesToRole &&
    // Свободная роль отвечает обычным ходом в комнате — ветка тут была бы
    // лишним потоком на каждое сообщение.
    facts.roleBusy &&
    !facts.openBranch
  );
}

/** Первая содержательная строка сообщения, ужатая до 60 символов. */
export function fanoutDigest(text: string): string {
  const first = text
    .split("\n")
    .map((line) => line.replace(/[#*`>_-]/g, "").trim())
    .find(Boolean);
  const value = (first ?? text).trim();
  if (!value) return "сообщение";
  return value.length > 60 ? value.slice(0, 59) + "…" : value;
}

export function fanoutTitle(text: string): string {
  return "Ветка: " + fanoutDigest(text);
}

/** Что роль пишет в самой ветке: приняла и держит последовательность. */
export function fanoutBranchAck(text: string, busy: boolean): string {
  return (
    "Принял: «" + fanoutDigest(text) + "». " +
    (busy
      ? "Сейчас доделаю то, что в работе, и сразу приступаю к этому — последовательность держу."
      : "Приступаю сразу.") +
    " Всё под контролем."
  );
}

/** Что роль пишет в основной чат, чтобы владелец видел реакцию сразу. */
export function fanoutParentAck(text: string): string {
  return "Принял: «" + fanoutDigest(text) + "» — открыл ветку, работаю там.";
}

/** Тема задачи (карточка): сообщение владельца идёт в работу слота
 *  (подмешивание) И открывает ветку-срез — в ней роль сразу отвечает
 *  владельцу, что приняла правку и на какой она стадии. Основную работу
 *  не отвлекаем (владелец 23.10.2026). */
export function shouldFanOutTaskTopic(facts: {
  fromOwner: boolean;
  isTaskTopic: boolean;
  isBranch: boolean;
  repliesToRole: boolean;
  roleBusy: boolean;
}): boolean {
  return facts.fromOwner && facts.isTaskTopic && !facts.isBranch && !facts.repliesToRole && facts.roleBusy;
}

/** Первое сообщение ветки-среза: «на связи» и что уже сделано по задаче.
 *  Владелец 23.10.2026: дежурная фраза «принял, ушла в ход» не нужна — нужен
 *  контекст, по которому он будет спрашивать: что было сделано в рамках
 *  задачи и какая цель. */
export function taskTopicBranchAck(text: string, context: string): string {
  return (
    "На связи. Принял: «" + fanoutDigest(text) + "».\n\n" +
    "Что сделано по задаче к этому моменту:\n" +
    (context.trim() || "по шагам пока пусто") +
    "\n\nСпрашивай — отвечу по этому контексту и по цели задачи."
  );
}

/** Сводка ветки для основной роли: последние ответы ветки, по строкам. */
export function branchSummaryLines(answers: string[]): string[] {
  return answers
    .map((text) => fanoutDigest(text))
    .filter((line, index, all) => line && all.indexOf(line) === index)
    .slice(-5);
}
