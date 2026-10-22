// Ветка на каждое сообщение владельца (22.10.2026).
//
// Владелец: «Он получает моё сообщение — и сразу ответвляется: принял, вот
// последовательность, сейчас додeлаю это, потом твоя задача. Сообщаю третью —
// третья ветка. Дальше ветки работают параллельно».
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
};

export function shouldFanOutOwnerMessage(facts: OwnerFanoutFacts): boolean {
  return (
    facts.fromOwner &&
    facts.direct &&
    facts.roleMembers === 1 &&
    !facts.isBranch &&
    !facts.isTaskTopic &&
    !facts.isCommon &&
    !facts.repliesToRole
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
