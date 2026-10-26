// Уточнение роли у владельца из чата (26.10.2026).
//
// Сервер — источник истины: он хранит заданный вопрос, его состояние
// (open → answered) и ответ владельца. Роль зовёт инструмент
// `taskflow_ask_user_question`, владелец отвечает одним POST
// (/api/chats/:id/questions/:questionId/answer), клиент рисует карточку
// вопроса по полю `question` в сообщении.
//
// Формат — как в пакете `@juicesharp/rpiv-ask-user-question`: от одного до
// четырёх вопросов, у каждого от двух до четырёх вариантов с пояснением.
// Коды ошибок те же, что у пакета: их роль читает и правит вызов.
import crypto from "node:crypto";

import db from "../db.js";

export const MAX_QUESTIONS = 4;
export const MIN_QUESTIONS = 1;
export const MAX_OPTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
/** Служебные метки пакета: свои варианты под такими именами не предлагаем —
 *  свой ответ владелец вводит сам, отдельной кнопкой. */
export const RESERVED_OPTION_LABELS = ["Other", "Type something.", "Next"];

export type QuestionOption = { label: string; description?: string };
export type QuestionItem = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};
export type QuestionPayload = { questions: QuestionItem[]; note?: string };
export type AnswerEntry = { questionIndex: number; selected: string[]; custom?: string };
export type AnswerPayload = { answers: AnswerEntry[]; note?: string };

export type QuestionRow = {
  id: string;
  chat_id: string;
  role_id: string;
  message_id: string | null;
  payload_json: string;
  status: "open" | "answered" | "expired" | "cancelled";
  answer_json: string | null;
  created_at: string;
  deadline_at: string | null;
  answered_at: string | null;
};

/** Ошибка валидации с кодом: код уходит модели, чтобы она исправила вызов. */
export class QuestionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

function отказ(code: string, message: string): never {
  throw new QuestionValidationError(code, message);
}

/**
 * Проверить вопрос роли. Порядок проверок — как у пакета
 * `@juicesharp/rpiv-ask-user-question`: сперва количество вопросов, потом
 * количество вариантов, потом длины меток, зарезервированные метки и уже
 * затем дубли.
 */
export function validateQuestionPayload(input: unknown): QuestionPayload {
  const сырьё = (input ?? {}) as { questions?: unknown; note?: unknown };
  const вопросы = Array.isArray(сырьё.questions) ? сырьё.questions : [];
  if (вопросы.length < MIN_QUESTIONS) {
    отказ("no_questions", "Нужен хотя бы один вопрос (questions: 1..4).");
  }
  if (вопросы.length > MAX_QUESTIONS) {
    отказ("too_many_questions", `Вопросов не больше ${MAX_QUESTIONS} за раз.`);
  }
  const разобранные: QuestionItem[] = [];
  for (const [номер, сырой] of вопросы.entries()) {
    const вопрос = (сырой ?? {}) as Record<string, unknown>;
    const текст = String(вопрос.question ?? "").trim();
    if (!текст) {
      отказ("empty_question", `Вопрос ${номер + 1}: текст вопроса пуст.`);
    }
    const варианты = Array.isArray(вопрос.options) ? вопрос.options : [];
    if (варианты.length < MIN_OPTIONS) {
      отказ("empty_options", `Вопрос ${номер + 1}: нужно от ${MIN_OPTIONS} до ${MAX_OPTIONS} вариантов ответа.`);
    }
    if (варианты.length > MAX_OPTIONS) {
      отказ("too_many_options", `Вопрос ${номер + 1}: вариантов не больше ${MAX_OPTIONS}.`);
    }
    const header = вопрос.header == null ? undefined : String(вопрос.header).trim();
    if (header && header.length > MAX_HEADER_LENGTH) {
      отказ("header_too_long", `Вопрос ${номер + 1}: header — не больше ${MAX_HEADER_LENGTH} символов.`);
    }
    const опции: QuestionOption[] = [];
    for (const [номерВарианта, сыройВариант] of варианты.entries()) {
      const вариант = (сыройВариант ?? {}) as Record<string, unknown>;
      const label = String(вариант.label ?? "").trim();
      if (!label) {
        отказ("empty_option", `Вопрос ${номер + 1}: у варианта ${номерВарианта + 1} пустая метка.`);
      }
      if (label.length > MAX_LABEL_LENGTH) {
        отказ("label_too_long", `Вопрос ${номер + 1}: метка варианта — не больше ${MAX_LABEL_LENGTH} символов.`);
      }
      if (RESERVED_OPTION_LABELS.includes(label)) {
        отказ("reserved_label", `Метка «${label}» зарезервирована: свой ответ владелец вводит сам.`);
      }
      const description = вариант.description == null ? undefined : String(вариант.description).trim();
      опции.push(description ? { label, description } : { label });
    }
    const multiSelect = вопрос.multiSelect === true;
    разобранные.push(header ? { question: текст, header, options: опции, multiSelect } : { question: текст, options: опции, multiSelect });
  }
  // Дубли вопросов (сравнение без учёта регистра и лишних пробелов).
  const seen = new Set<string>();
  for (const вопрос of разобранные) {
    const ключ = вопрос.question.toLowerCase();
    if (seen.has(ключ)) {
      отказ("duplicate_question", "Один и тот же вопрос задан дважды.");
    }
    seen.add(ключ);
  }
  // Дубли меток вариантов внутри одного вопроса.
  for (const [номер, вопрос] of разобранные.entries()) {
    const метки = new Set<string>();
    for (const вариант of вопрос.options) {
      const ключ = вариант.label.toLowerCase();
      if (метки.has(ключ)) {
        отказ("duplicate_option_label", `Вопрос ${номер + 1}: метка варианта «${вариант.label}» повторяется.`);
      }
      метки.add(ключ);
    }
  }
  const note = сырьё.note == null ? undefined : String(сырьё.note).trim();
  return note ? { questions: разобранные, note } : { questions: разобранные };
}

/**
 * Проверить ответ владельца: индексы — по вопросам, метки — из вариантов,
 * ответ не пустой.
 */
export function validateAnswerPayload(payload: QuestionPayload, answers: unknown, note?: unknown): AnswerPayload {
  if (!Array.isArray(answers) || answers.length === 0) {
    отказ("empty_answer", "Пустой ответ: нужен хотя бы один ответ по вопросу.");
  }
  const разобранныеОтветы: AnswerEntry[] = [];
  for (const [номер, сырой] of answers.entries()) {
    const ответ = (сырой ?? {}) as Record<string, unknown>;
    const questionIndex = Number(ответ.questionIndex);
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= payload.questions.length) {
      отказ("bad_question_index", `Ответ ${номер + 1}: questionIndex должен быть от 0 до ${payload.questions.length - 1}.`);
    }
    const вопрос = payload.questions[questionIndex];
    const selected = Array.isArray(ответ.selected)
      ? Array.from(new Set(ответ.selected.map((м) => String(м).trim()).filter(Boolean)))
      : [];
    for (const метка of selected) {
      if (!вопрос.options.some((вариант) => вариант.label === метка)) {
        отказ("unknown_option", `Вопрос ${questionIndex + 1}: варианта «${метка}» нет.`);
      }
    }
    const custom = ответ.custom == null ? undefined : String(ответ.custom).trim();
    if (!selected.length && !custom) {
      отказ("empty_answer", `Вопрос ${questionIndex + 1}: ответ пустой — выбери вариант или напиши свой.`);
    }
    разобранныеОтветы.push(custom ? { questionIndex, selected, custom } : { questionIndex, selected });
  }
  const текстЗаметки = note == null ? undefined : String(note).trim();
  return текстЗаметки ? { answers: разобранныеОтветы, note: текстЗаметки } : { answers: разобранныеОтветы };
}

/** Записать вопрос в БД. */
export function createQuestionRow(args: {
  chatId: string;
  roleId: string;
  payload: QuestionPayload;
  messageId?: string | null;
  deadlineAt?: string | null;
}): QuestionRow {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_questions(id, chat_id, role_id, message_id, payload_json, status, deadline_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    id,
    args.chatId,
    args.roleId,
    args.messageId ?? null,
    JSON.stringify(args.payload),
    args.deadlineAt ?? null,
  );
  const строка = questionById(id);
  if (!строка) throw new Error("chat_questions: запись не сохранилась");
  return строка;
}

export function questionById(id: string): QuestionRow | undefined {
  return db.prepare("SELECT * FROM chat_questions WHERE id = ?").get(id) as QuestionRow | undefined;
}

export function questionByMessageId(messageId: string): QuestionRow | undefined {
  return db.prepare("SELECT * FROM chat_questions WHERE message_id = ?").get(messageId) as QuestionRow | undefined;
}

export function questionsOfChat(chatId: string): QuestionRow[] {
  return db
    .prepare("SELECT * FROM chat_questions WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(chatId) as QuestionRow[];
}

/** Закрыть вопрос ответом владельца. Повторный ответ — отказ (статус уже не open). */
export function answerQuestionRow(id: string, answer: AnswerPayload): QuestionRow {
  db.prepare(
    "UPDATE chat_questions SET status='answered', answer_json=?, answered_at=datetime('now') WHERE id=? AND status='open'",
  ).run(JSON.stringify(answer), id);
  const строка = questionById(id);
  if (!строка) throw new Error("chat_questions: вопрос не найден");
  return строка;
}

export function payloadOf(row: QuestionRow): QuestionPayload {
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && Array.isArray(parsed.questions)) return parsed as QuestionPayload;
  } catch {
    /* битый JSON — пустой вопрос, лента не должна падать */
  }
  return { questions: [] };
}

/**
 * Вид вопроса для клиента (поле `question` в сообщении).
 *
 * Имена полей — как читает iOS-клиент (ChatQuestion.swift): `multiSelect`
 * (клиент берёт и `multi_select`), дата — `created_at`, ответ — массив
 * записей {questionIndex, selected, custom}.
 */
export function questionEnvelope(row: QuestionRow | undefined | null): Record<string, unknown> | null {
  if (!row) return null;
  const payload = payloadOf(row);
  let ответы: AnswerEntry[] | null = null;
  if (row.answer_json) {
    try {
      const parsed = JSON.parse(row.answer_json);
      if (Array.isArray(parsed?.answers)) ответы = parsed.answers as AnswerEntry[];
    } catch {
      ответы = null;
    }
  }
  return {
    id: row.id,
    status: row.status,
    questions: payload.questions.map((вопрос) => ({
      question: вопрос.question,
      ...(вопрос.header ? { header: вопрос.header } : {}),
      options: вопрос.options.map((вариант) => ({
        label: вариант.label,
        ...(вариант.description ? { description: вариант.description } : {}),
      })),
      multiSelect: вопрос.multiSelect === true,
    })),
    answer: ответы,
    created_at: row.created_at,
  };
}

/** Текст вопроса для ленты — карточку рисует клиент, текст нужен как запасной. */export function renderQuestionText(payload: QuestionPayload): string {
  const строки: string[] = [];
  if (payload.note) строки.push(String(payload.note));
  payload.questions.forEach((вопрос, номер) => {
    строки.push(`${номер + 1}. ${вопрос.question}`);
    for (const вариант of вопрос.options) {
      строки.push(`   - ${вариант.label}${вариант.description ? ` — ${вариант.description}` : ""}`);
    }
  });
  строки.push("Ответь в чате — я продолжу с того места, где остановился.");
  return строки.join("\n");
}

/** Текст ответа владельца — обычное сообщение в чате. */
export function renderAnswerText(payload: QuestionPayload, answer: AnswerPayload): string {
  const строки: string[] = [];
  for (const запись of answer.answers) {
    const вопрос = payload.questions[запись.questionIndex];
    const номер = запись.questionIndex + 1;
    const выбранное = запись.selected.length ? запись.selected.join(", ") : "";
    const своё = запись.custom ? `своими словами: ${запись.custom}` : "";
    строки.push(`Ответ ${номер}${вопрос ? ` (${вопрос.question})` : ""}: ${[выбранное, своё].filter(Boolean).join("; ")}`);
  }
  if (answer.note) строки.push(String(answer.note));
  return строки.join("\n");
}
