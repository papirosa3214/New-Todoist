// ═══ НОВАЯ ВЕРСИЯ ЧАТА: «Сессии» — вопрос владельцу от Помощника ═══
// Владелец 13.11.2026: вопрос — запись в таблице chat_questions, чат не нужен.
// Помощник в сессии спрашивает карточкой с вариантами; ход ждёт ответа
// (waitForAnswer), ответ приходит по /api/questions/:id/answer из ленты
// сессии, «Входящих» или напоминания — сервер отдаёт его в этот же ход.
// У ролей-субагентов этого инструмента нет: субагент вопросов не задаёт,
// он возвращает результат Помощнику.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createQuestionRow,
  questionById,
  questionEnvelope,
  QuestionValidationError,
  renderAnswerText,
  validateQuestionPayload,
  type QuestionPayload,
} from "../lib/chatQuestions.js";
import { waitForAnswer } from "../lib/questionWait.js";

export const SESSION_ASK_TOOL = "taskflow_ask_user_question";

export function createSessionAskOwnerTool(roleId = "u-secretary") {
  return defineTool({
    name: SESSION_ASK_TOOL,
    label: "Вопрос владельцу",
    description:
      "Задать владельцу уточняющий вопрос с вариантами ответа (1–4 вопроса, у каждого 2–4 варианта). " +
      "Владелец видит карточку в ленте сессии и во «Входящих»; ход ждёт ответа до 30 минут и продолжается с ним.",
    promptSnippet: "taskflow_ask_user_question: спросить владельца карточкой с вариантами и дождаться ответа",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({ description: "текст вопроса" }),
        header: Type.Optional(Type.String({ description: "короткая метка вопроса, до 16 символов" })),
        options: Type.Array(Type.Object({
          label: Type.String({ description: "метка варианта, до 60 символов" }),
          description: Type.Optional(Type.String({ description: "что выбор значит" })),
        }), { minItems: 2, maxItems: 4 }),
        multiSelect: Type.Optional(Type.Boolean()),
      }), { minItems: 1, maxItems: 4 }),
      note: Type.Optional(Type.String({ description: "пояснение для владельца" })),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      let payload: QuestionPayload;
      try {
        payload = validateQuestionPayload(params);
      } catch (error) {
        if (error instanceof QuestionValidationError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const row = createQuestionRow({ chatId: "", roleId, payload });
      // Карточка для ленты: клиент рисует её по этим данным (тонкий клиент).
      const question = questionEnvelope(questionById(row.id));
      onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ question }) }], details: { question } });
      const answer = await waitForAnswer(row.id, { signal });
      const final = questionEnvelope(questionById(row.id));
      if (answer) {
        return {
          content: [{ type: "text", text: `Владелец ответил: ${renderAnswerText(payload, answer)}` }],
          details: { question: final, status: "answered" },
        };
      }
      return {
        content: [{ type: "text", text: "Владелец не ответил за полчаса. Вопрос остаётся открытым во «Входящих»; продолжай без ответа или спроси позже." }],
        details: { question: final, status: "open" },
      };
    },
  });
}
