// Уточнение роли у владельца из чата (26.10.2026). Серверная часть:
// таблица вопросов, инструмент роли `taskflow_ask_user_question`, ответ
// владельца одним POST и поле `question` в сообщении для iOS-клиента.
//
// Проверяем то, что решает сервер: правила валидации вопроса (коды ошибок),
// права на инструмент (только Помощник владельца), переход open → answered и
// то, что вопрос виден в ленте в том виде, в каком его ждёт клиент.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { chatTools } from "../src/runtime/chatTools.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";
import { QuestionValidationError, validateQuestionPayload } from "../src/lib/chatQuestions.js";
import { deliverAnswer, isWaiting, liveInterruptEvent, waitForAnswer } from "../src/lib/questionWait.js";

const ВОПРОС = {
  question: "Какой вариант верный?",
  header: "Выбор",
  options: [
    { label: "Только iOS", description: "веб не трогаем" },
    { label: "Оба" },
  ],
};

function кодОшибки(input: unknown): string {
  try {
    validateQuestionPayload(input);
  } catch (error) {
    if (error instanceof QuestionValidationError) return error.code;
    throw error;
  }
  return "";
}

let app: any;
let владелец: any;
let chatId: string;
let anchorId: string;
const auth = () => ({ authorization: `Bearer ${владелец.token}` });

beforeAll(async () => {
  app = await buildApp();
  const registered = (await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "owner-questions", email: "owner-questions@test.local", password: "owner-pass-1" },
  })).json();
  владелец = registered;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(владелец.user.id);
  chatId = (await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth(),
    payload: { kind: "direct", member_ids: ["u-secretary"] },
  })).json().chat.id;
  // Исходное сообщение владельца: вопрос относится к нему.
  const сообщение = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/messages`,
    headers: auth(),
    payload: { text: "Разберись с выбором варианта." },
  });
  expect(сообщение.statusCode).toBe(200);
  anchorId = сообщение.json().message.id;
});

afterAll(async () => {
  await app?.close();
});

describe("валидация вопроса роли", () => {
  it("корректный вопрос проходит", () => {
    const payload = validateQuestionPayload({ questions: [ВОПРОС] });
    expect(payload.questions).toHaveLength(1);
    expect(payload.questions[0].options[0].label).toBe("Только iOS");
  });

  it("вопросов должен быть от одного до четырёх", () => {
    expect(кодОшибки({ questions: [] })).toBe("no_questions");
    expect(кодОшибки({})).toBe("no_questions");
    expect(кодОшибки({ questions: [ВОПРОС, ВОПРОС, ВОПРОС, ВОПРОС, ВОПРОС] })).toBe("too_many_questions");
  });

  it("вариантов у вопроса должно быть от двух до четырёх", () => {
    expect(кодОшибки({ questions: [{ question: "Что выбрать?", options: [{ label: "Один" }] }] })).toBe("empty_options");
    expect(
      кодОшибки({
        questions: [
          {
            question: "Что выбрать?",
            options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }, { label: "5" }],
          },
        ],
      }),
    ).toBe("too_many_options");
  });

  it("метка вопроса до 16 символов, метка варианта — до 60", () => {
    expect(
      кодОшибки({ questions: [{ ...ВОПРОС, header: "х".repeat(17) }] }),
    ).toBe("header_too_long");
    expect(
      кодОшибки({
        questions: [
          { question: "Что выбрать?", options: [{ label: "я".repeat(61) }, { label: "Ок" }] },
        ],
      }),
    ).toBe("label_too_long");
  });

  it("зарезервированные метки вариантов запрещены", () => {
    for (const label of ["Other", "Type something.", "Next"]) {
      expect(
        кодОшибки({ questions: [{ question: "Что выбрать?", options: [{ label }, { label: "Ок" }] }] }),
        label,
      ).toBe("reserved_label");
    }
  });

  it("дубли вопросов и дубли меток вариантов запрещены", () => {
    expect(
      кодОшибки({ questions: [ВОПРОС, { ...ВОПРОС }] }),
    ).toBe("duplicate_question");
    expect(
      кодОшибки({
        questions: [{ question: "Что выбрать?", options: [{ label: "Ок" }, { label: "Ок" }] }],
      }),
    ).toBe("duplicate_option_label");
  });
});

describe("пауза хода на вопрос: реестр ожидания", () => {
  const ОТВЕТ = { answers: [{ questionIndex: 0, selected: ["Оба"] }] };
  it("ответ отдаётся ждущему ходу один раз", async () => {
    const ждём = waitForAnswer("q-1", { timeoutMs: 1000 });
    expect(isWaiting("q-1")).toBe(true);
    expect(deliverAnswer("q-1", ОТВЕТ)).toBe(true);
    expect(await ждём).toEqual(ОТВЕТ);
    expect(deliverAnswer("q-1", ОТВЕТ)).toBe(false);
  });
  it("таймаут и обрыв хода снимают ожидание", async () => {
    expect(await waitForAnswer("q-2", { timeoutMs: 5 })).toBeNull();
    expect(isWaiting("q-2")).toBe(false);
    const стоп = new AbortController();
    const ждём = waitForAnswer("q-3", { timeoutMs: 1000, signal: стоп.signal });
    стоп.abort();
    expect(await ждём).toBeNull();
    expect(deliverAnswer("q-3", ОТВЕТ)).toBe(false);
  });
  it("событие паузы несёт вопрос и варианты", () => {
    const событие = liveInterruptEvent({ chatId: "c", userId: "u-secretary", questionId: "q", messageId: "m", payload: { questions: [ВОПРОС] } });
    expect(событие).toEqual({
      type: "chats:live:interrupt", chat_id: "c", user_id: "u-secretary",
      question_id: "q", message_id: "m", questions: [ВОПРОС],
    });
  });
});

describe("инструмент уточнения: права", () => {
  it("доступен только Помощнику владельца", () => {
    expect(roleToolAllowed("secretary", "taskflow_ask_user_question")).toBe(true);
    for (const role of ["builder", "architect", "qa", "analyst", "designer", "researcher", "critic_verifier", "infra_engineer"]) {
      expect(roleToolAllowed(role, "taskflow_ask_user_question"), role).toBe(false);
    }
  });

  it("роль без права инструмент не видит — ни в наборе чата, ни в каталоге сессии", () => {
    const ctx = { chatId: "chat-secretary", messageId: "m1" };
    const имена = (role: string) =>
      taskflowTools(role, null, undefined, undefined, false, ctx).map((tool) => tool.name);
    expect(имена("secretary")).toContain("taskflow_ask_user_question");
    expect(имена("builder")).not.toContain("taskflow_ask_user_question");
    expect(имена("architect")).not.toContain("taskflow_ask_user_question");

    const каталог = (role: string) =>
      buildRoleToolCatalog({ role, model: null, mode: "chat", runId: "test", chatId: ctx.chatId, messageId: ctx.messageId });
    expect(каталог("secretary").registeredNames).toContain("taskflow_ask_user_question");
    // Ядро сессии: модель видит инструмент без подключения по требованию.
    expect(каталог("secretary").activeNames).toContain("taskflow_ask_user_question");
    expect(каталог("builder").registeredNames).not.toContain("taskflow_ask_user_question");
    expect(каталог("builder").activeNames).not.toContain("taskflow_ask_user_question");
  });
});

describe("уточнение у владельца из чата: сквозной сценарий", () => {
  function инструмент() {
    const список = chatTools("secretary", { chatId, messageId: anchorId });
    const tool = список.find((t: any) => t.name === "taskflow_ask_user_question");
    expect(tool, "инструмент должен быть у Помощника").toBeTruthy();
    return tool as any;
  }

  /** Инструмент отдаёт JSON в текстовом блоке (как все инструменты ролей). */
  //  Ход оборван сразу (signal aborted) — пауза не держит тест: инструмент
  //  ведёт себя как до паузы, ответ поднимет новый ход.
  async function вызвать(инструмент_: any, args: unknown): Promise<any> {
    const стоп = new AbortController();
    стоп.abort();
    const результат = await инструмент_.execute("call", args, стоп.signal);
    return JSON.parse(результат.content[0].text);
  }

  it("инструмент задаёт вопрос: строка в БД, сообщение в чате, вопрос виден в ленте", async () => {
    const ответ = await вызвать(инструмент(), {
      questions: [{ ...ВОПРОС, multiSelect: true }],
      note: "Ответ нужен до вечера.",
    });
    const questionId = String(ответ.вопрос ?? "");
    expect(questionId).toBeTruthy();

    const строка = db.prepare("SELECT * FROM chat_questions WHERE id=?").get(questionId) as any;
    expect(строка.status).toBe("open");
    expect(строка.chat_id).toBe(chatId);
    expect(строка.role_id).toBe("u-secretary");
    expect(строка.message_id).toBeTruthy();
    expect(JSON.parse(строка.payload_json).questions[0].question).toBe("Какой вариант верный?");

    // В ленте сообщение роли несёт поле question — так его ждёт iOS-клиент.
    const лента = await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages`, headers: auth() });
    const сообщения = лента.json().messages ?? [];
    const сВопросом = сообщения.find((m: any) => m.question);
    expect(сВопросом, "сообщение с вопросом должно быть в ленте").toBeTruthy();
    expect(сВопросом.question.id).toBe(questionId);
    expect(сВопросом.question.status).toBe("open");
    expect(сВопросом.question.answer).toBeNull();
    expect(сВопросом.question.questions[0].question).toBe("Какой вариант верный?");
    expect(сВопросом.question.questions[0].header).toBe("Выбор");
    expect(сВопросом.question.questions[0].multiSelect).toBe(true);
    expect(сВопросом.question.questions[0].options[0]).toEqual({
      label: "Только iOS",
      description: "веб не трогаем",
    });
    // Клиент читает дату из поля created_at.
    expect(typeof сВопросом.question.created_at).toBe("string");

    // Ответ владельца одним POST: вопрос закрывается, ответ уходит в чат.
    const ответВладельца = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/${questionId}/answer`,
      headers: auth(),
      payload: { answers: [{ questionIndex: 0, selected: ["Только iOS"] }], note: "Давай так" },
    });
    expect(ответВладельца.statusCode).toBe(200);
    expect(ответВладельца.json().message?.id).toBeTruthy();

    const закрытый = db.prepare("SELECT * FROM chat_questions WHERE id=?").get(questionId) as any;
    expect(закрытый.status).toBe("answered");
    expect(закрытый.answered_at).toBeTruthy();
    expect(JSON.parse(закрытый.answer_json).answers[0].selected).toEqual(["Только iOS"]);

    // В ленте вопрос уже отвечен, ответ виден.
    const лента2 = await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages`, headers: auth() });
    const сВопросом2 = (лента2.json().messages ?? []).find((m: any) => m.question);
    expect(сВопросом2.question.status).toBe("answered");
    expect(сВопросом2.question.answer[0]).toEqual({
      questionIndex: 0,
      selected: ["Только iOS"],
      custom: undefined,
    });

    // Повторный ответ на закрытый вопрос — отказ с понятным текстом.
    const повтор = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/${questionId}/answer`,
      headers: auth(),
      payload: { answers: [{ questionIndex: 0, selected: ["Оба"] }] },
    });
    expect(повтор.statusCode).toBe(400);
    expect(String(повтор.json().error)).toContain("уже отвечен");
  });

  it("вопрос из чужого чата и ответ не от владельца — отказ", async () => {
    const ответ = await вызвать(инструмент(), { questions: [ВОПРОС] });
    const questionId = String(ответ.вопрос ?? "");

    const чужой = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/не-существует/answer`,
      headers: auth(),
      payload: { answers: [{ questionIndex: 0, selected: ["Оба"] }] },
    });
    expect(чужой.statusCode).toBe(404);

    // Роль не отвечает за владельца.
    const роль = { authorization: `Bearer ${app.jwt.sign({ id: "u-secretary" })}` };
    const неВладелец = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/${questionId}/answer`,
      headers: роль,
      payload: { answers: [{ questionIndex: 0, selected: ["Оба"] }] },
    });
    expect(неВладелец.statusCode).toBe(403);

    // Пустой ответ — отказ.
    const пустой = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/${questionId}/answer`,
      headers: auth(),
      payload: { answers: [{ questionIndex: 0, selected: [] }] },
    });
    expect(пустой.statusCode).toBe(400);
  });

  it("пауза: ход ждёт ответа владельца и продолжает с того же вызова", async () => {
    const ход = инструмент().execute("call-wait", { questions: [ВОПРОС] });
    // Вопрос записан и открыт, ход стоит на паузе.
    let строка: any;
    for (let i = 0; i < 50 && !строка; i++) {
      await new Promise((r) => setTimeout(r, 10));
      строка = db.prepare("SELECT * FROM chat_questions WHERE chat_id=? AND status='open' ORDER BY rowid DESC").all(chatId).find((r: any) => isWaiting(r.id));
    }
    expect(строка, "вопрос должен ждать ответа").toBeTruthy();

    const ответВладельца = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/${строка.id}/answer`,
      headers: auth(),
      payload: { answers: [{ questionIndex: 0, selected: ["Оба"] }] },
    });
    expect(ответВладельца.statusCode).toBe(200);
    // Ответ ушёл в ждущий ход, новый ход не поднимали.
    expect(ответВладельца.json().resumed).toBe(true);

    const результат = JSON.parse((await ход).content[0].text);
    expect(результат.статус).toBe("answered");
    expect(результат.ответ.answers[0].selected).toEqual(["Оба"]);
    expect(isWaiting(строка.id)).toBe(false);
  });

  it("без ждущего хода ответ поднимает новый ход, как раньше", async () => {
    const ответ = await вызвать(инструмент(), { questions: [ВОПРОС] });
    const ответВладельца = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/questions/${ответ.вопрос}/answer`,
      headers: auth(),
      payload: { answers: [{ questionIndex: 0, selected: ["Оба"] }] },
    });
    expect(ответВладельца.statusCode).toBe(200);
    expect(ответВладельца.json().resumed).toBe(false);
  });

  it("инструмент отдаёт код ошибки валидации модели", async () => {
    const неверный = await инструмент().execute("call-3", { questions: [] }).catch((error: Error) => error);
    expect(String(неверный?.message ?? "")).toContain("no_questions");
  });
});
