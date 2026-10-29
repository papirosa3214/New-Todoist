// Инструмент вызова роли как субагента (taskflow_call_role).
//
// Покрывает:
//   1. Матрица прав: инструмент есть в каталоге только у Помощника и
//      Оркестратора, остальные роли его не видят.
//   2. Валидация аргументов: неизвестная роль, пустой вопрос, вызов самой
//      себя — понятная ошибка, ход роли не запускается.
//   3. Вложенный вызов запрещён: из роли роль не зовут (и в каталоге
//      субагента инструмента нет).
//   4. Лимит: не больше 3 вызовов субагента за ход вызывающей роли.
//   5. ФОНОВЫЙ РЕЖИМ (владелец 29.10.2026): вызов возвращается сразу, ход
//      субагента не занимает ход вызывающей роли; выжимка приходит позже в
//      чат вызывающей роли и будит её через очередь.
//   6. КОРРЕКТИРОВКА НА ХОДУ: уточнение прерывает ход субагента, роль
//      продолжает ту же работу с новым заданием.
//
// Ход субагента в тестах не настоящий: раннер подменяется, поэтому сеть и
// модель не трогаются.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import {
  createRoleSubagentCallTool,
  createRoleSubagentSteerTool,
  isSubagentRun,
  pendingSubagentRuns,
  resetAllSubagentCallCounters,
  ROLE_SUBAGENT_CALL_TOOL,
  ROLE_SUBAGENT_STEER_TOOL,
  runAsSubagent,
  SUBAGENT_CALL_LIMIT,
  SUBAGENT_STEER_LIMIT,
  type SubagentRunner,
} from "../src/runtime/roleSubagentCall.js";
import { roleUserId } from "../src/roleRouting.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

const CHAT_ID = "subagent_call_chat";
const SECRETARY_ID = roleUserId("secretary");
const RESEARCHER_ID = roleUserId("researcher");

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','ai')",
  ).run(SECRETARY_ID, "Секретарь", "subagent-call-secretary@test.local");
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,?,'group',?)").run(
    CHAT_ID,
    "Обращения субагента",
    SECRETARY_ID,
  );
  for (const member of [SECRETARY_ID, RESEARCHER_ID]) {
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(
      CHAT_ID,
      member,
    );
  }
});

beforeEach(() => {
  resetAllSubagentCallCounters();
});

/** Контекст хода вызывающей роли. */
function callerContext(role = "secretary") {
  return {
    actor: roleUserId(role),
    role,
    mode: "work",
    runId: `subagent-call-${role}`,
    chatId: CHAT_ID,
    messageId: "subagent-call-message",
  };
}

/** Подождать, пока состояние строки очереди изменится. */
const waitFor = async (predicate: () => boolean, ms = 8000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

/** Раннер-заглушка: ход роли не настоящий, ответ задан заранее. */
function stubRunner(answer = "Разбор готов: шаг контракта не меняем.") {
  const calls: Array<{
    role: string;
    roleId: string;
    chatId: string;
    prompt: string;
    sessionId: string | null | undefined;
  }> = [];
  const runner: SubagentRunner = async (input) => {
    calls.push({
      role: input.role,
      roleId: input.roleId,
      chatId: input.chatId,
      prompt: input.prompt,
      sessionId: input.sessionId,
    });
    return { text: answer, sessionId: "pi-session-stub" };
  };
  return { runner, calls };
}

const toolOf = (context: any, runner: SubagentRunner) =>
  createRoleSubagentCallTool(context, runner);

describe("вызов роли как субагента: права", () => {
  it("инструмент есть в каталоге только у Помощника и Оркестратора", () => {
    const has = (role: string) =>
      buildRoleToolCatalog({ role, mode: "work", runId: `matrix-${role}`, chatId: CHAT_ID }).operations.some(
        (tool) => tool.name === ROLE_SUBAGENT_CALL_TOOL,
      );
    expect(has("secretary")).toBe(true);
    expect(has("code_orchestrator")).toBe(true);
    // Остальным роль звать незачем: у них инструмента нет вовсе.
    expect(has("researcher")).toBe(false);
    expect(has("builder")).toBe(false);
    expect(has("analyst")).toBe(false);
    expect(has("critic_verifier")).toBe(false);
  });

  it("инструмент подключён к сессии нативно (без загрузчика по требованию)", () => {
    const catalog = buildRoleToolCatalog({
      role: "secretary",
      mode: "work",
      runId: "matrix-active",
      chatId: CHAT_ID,
    });
    expect(catalog.activeNames).toContain(ROLE_SUBAGENT_CALL_TOOL);
    expect(catalog.registeredNames).toContain(ROLE_SUBAGENT_CALL_TOOL);
  });
});

describe("вызов роли как субагента: аргументы", () => {
  it("неизвестная роль — понятная ошибка, ход роли не запускается", async () => {
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    await expect(
      tool.execute("call-1", { role: "нет_такой_роли", question: "Что делать?" }),
    ).rejects.toThrow(/НЕИЗВЕСТНАЯ РОЛЬ/);
    expect(calls).toHaveLength(0);
  });

  it("пустой вопрос — понятная ошибка", async () => {
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    await expect(tool.execute("call-2", { role: "researcher", question: "   " })).rejects.toThrow(
      /ПУСТОЙ ВОПРОС/,
    );
    expect(calls).toHaveLength(0);
  });

  it("вызвать самого себя нельзя", async () => {
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    await expect(
      tool.execute("call-3", { role: "secretary", question: "Совет самому себе?" }),
    ).rejects.toThrow(/ВЫЗВАТЬ САМОЙ СЕБЯ НЕЛЬЗЯ/);
    expect(calls).toHaveLength(0);
  });

  it("вызов возвращается сразу, ответ приходит позже (фоновый режим)", async () => {
    const { runner, calls } = stubRunner("Считаю: 12 строк, 3 файла.");
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("call-4", { role: "researcher", question: "Сколько строк?" });
    // Вызов НЕ ждёт хода роли: возвращает «запущен» и question_id.
    expect(result.content[0].text).toMatch(/запущен в фоне/i);
    expect(result.details.started).toBe(true);
    expect(result.details.question_id).toMatch(/^subagent:/);
    await pendingSubagentRuns();
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe("researcher");
    expect(calls[0].roleId).toBe(RESEARCHER_ID);
    // Роль работает в своей комнате-ветке исходного чата (владелец 28.10.2026).
    expect(calls[0].chatId).not.toBe(CHAT_ID);
    const room = db
      .prepare("SELECT branch_of_chat_id FROM chats WHERE id=?")
      .get(calls[0].chatId) as { branch_of_chat_id: string } | undefined;
    expect(room?.branch_of_chat_id).toBe(CHAT_ID);
    expect(result.details.room_chat_id).toBe(calls[0].chatId);
  });

  it("выжимка приходит в чат вызывающей роли и будит её через очередь", async () => {
    const { runner } = stubRunner("Выжимка: 12 строк, 3 файла.");
    const tool = toolOf(callerContext(), runner);
    await tool.execute("call-wake", { role: "researcher", question: "Сколько строк?" });
    await pendingSubagentRuns();
    const digestRow = db
      .prepare("SELECT id,from_user_id,text FROM chat_messages WHERE chat_id=? AND text LIKE 'Ответ субагента%' ORDER BY rowid DESC LIMIT 1")
      .get(CHAT_ID) as { id: string; from_user_id: string; text: string } | undefined;
    expect(digestRow).toBeTruthy();
    expect(digestRow!.text).toContain("12 строк");
    // Очередь: доставка поднимает ход вызывающей роли с этой выжимкой.
    const queued = db
      .prepare("SELECT role_id,status FROM chat_message_queue WHERE message_id=?")
      .get(digestRow!.id) as { role_id: string; status: string } | undefined;
    expect(queued?.role_id).toBe(SECRETARY_ID);
    // Доставка должна УЙТИ из очереди: с delivery_id вместо id строки
    // recoverAgentDelivery молчал, и вызывающая роль не просыпалась
    // (29.10.2026 — этот баг проскочил мимо первых тестов).
    const settled = await waitFor(
      () => {
        const row = db
          .prepare("SELECT status FROM chat_message_queue WHERE message_id=?")
          .get(digestRow!.id) as { status: string } | undefined;
        return row?.status !== "pending" && row?.status !== "picked";
      },
      15000,
    );
    expect(settled).toBe(true);
  });

  it("в комнате субагента лежат вопрос и ответ, карточка ведёт в комнату", async () => {
    const { runner, calls } = stubRunner("Ответ из комнаты.");
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("call-room", { role: "researcher", question: "Что в комнате?" });
    await pendingSubagentRuns();
    const roomId = result.details.room_chat_id;
    const rows = db
      .prepare("SELECT from_user_id, text, reply_to_message_id FROM chat_messages WHERE chat_id=? ORDER BY rowid")
      .all(roomId) as Array<{ from_user_id: string; text: string; reply_to_message_id: string | null }>;
    expect(rows.map((r) => r.text)).toEqual(["Что в комнате?", "Ответ из комнаты."]);
    expect(rows[0].from_user_id).toBe(SECRETARY_ID);
    expect(rows[1].from_user_id).toBe(RESEARCHER_ID);
    expect(rows[1].reply_to_message_id).not.toBeNull();
    const members = (db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(roomId) as Array<{ member_id: string }>)
      .map((m) => m.member_id);
    expect(members).toEqual(expect.arrayContaining([SECRETARY_ID, RESEARCHER_ID]));
    const card = db
      .prepare("SELECT steps FROM chat_messages WHERE chat_id=? AND message_type='system' AND json_extract(steps,'$.coordination.question_id')=?")
      .get(CHAT_ID, result.details.question_id) as { steps: string };
    const coordination = JSON.parse(card.steps).coordination;
    expect(coordination.child_chat_id).toBe(roomId);
    // Текст ответа лежит в комнате субагента, карточка — статус (без копии).
    expect(card.answer??"").toBe("");
    const roomAnswer = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND from_user_id=? ORDER BY rowid DESC LIMIT 1")
      .get(roomId, RESEARCHER_ID) as { text: string } | undefined;
    expect(roomAnswer?.text).toBe("Ответ из комнаты.");
  });
});

describe("вызов роли как субагента: вложенные вызовы", () => {
  it("из роли роль звать нельзя", async () => {
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    await expect(
      runAsSubagent({ requesterRole: "secretary", recipientRole: "researcher" }, () =>
        tool.execute("nested-1", { role: "builder", question: "Ещё глубже?" }),
      ),
    ).rejects.toThrow(/ВЛОЖЕННЫЙ ВЫЗОВ РОЛИ ЗАПРЕЩЁН/);
    expect(calls).toHaveLength(0);
  });

  it("в каталоге субагента инструмента нет — цепочка ролей невозможна", () => {
    const catalog = runAsSubagent(
      { requesterRole: "secretary", recipientRole: "secretary" },
      () =>
        buildRoleToolCatalog({
          role: "secretary",
          mode: "work",
          runId: "nested-catalog",
          chatId: CHAT_ID,
        }),
    );
    expect(catalog.operations.some((tool) => tool.name === ROLE_SUBAGENT_CALL_TOOL)).toBe(false);
    expect(isSubagentRun()).toBe(false);
  });
});

describe("вызов роли как субагента: лимит", () => {
  it("не больше трёх вызовов за ход", async () => {
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    for (let i = 0; i < SUBAGENT_CALL_LIMIT; i++) {
      const result: any = await tool.execute(`limit-${i}`, { role: "researcher", question: `Q${i}` });
      expect(result.content[0].text).toMatch(/запущен в фоне/i);
    }
    expect(calls).toHaveLength(SUBAGENT_CALL_LIMIT);
    await expect(
      tool.execute("limit-over", { role: "researcher", question: "Q4" }),
    ).rejects.toThrow(/ЛИМИТ/);
    expect(calls).toHaveLength(SUBAGENT_CALL_LIMIT);
  });

  it("счётчик обнуляется на новом ходу вызывающей роли", async () => {
    const { runner } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    for (let i = 0; i < SUBAGENT_CALL_LIMIT; i++) {
      await tool.execute(`turn-a-${i}`, { role: "researcher", question: `Q${i}` });
    }
    await expect(
      tool.execute("turn-a-over", { role: "researcher", question: "Q4" }),
    ).rejects.toThrow(/ЛИМИТ/);
    // Новый ход — новый каталог роли: лимит снова полный.
    buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "turn-b", chatId: CHAT_ID });
    const result: any = await tool.execute("turn-b-1", { role: "researcher", question: "Q1" });
    expect(result.content[0].text).toMatch(/запущен в фоне/i);
  });
});

describe("вызов роли как субагента: карточка координации", () => {
  it("карточка в чате вызывающей роли закрывается ответом субагента", async () => {
    const { runner } = stubRunner("Ответ субагента: всё в порядке.");
    const tool = toolOf(callerContext(), runner);
    await tool.execute("card-1", { role: "researcher", question: "Всё в порядке?" });
    await pendingSubagentRuns();
    const row = db
      .prepare(
        "SELECT steps FROM chat_messages WHERE chat_id=? AND message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id') LIKE 'subagent:%' ORDER BY rowid DESC LIMIT 1",
      )
      .get(CHAT_ID) as { steps: string } | undefined;
    expect(row).toBeTruthy();
    const coordination = JSON.parse(row!.steps).coordination;
    expect(coordination.recipient_id).toBe(RESEARCHER_ID);
    expect(coordination.terminal).toBe(true);
    expect(coordination.status).toBe("answered");
    // Карточка — статус обращения, текст ответа живёт в нитке один раз
    // (владелец 29.10.2026: дублирование «карточка + сообщение»).
    expect(coordination.answer??"").toBe("");
    expect(coordination.activity).toBe("Ответ получен");
    const digest = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND text LIKE 'Ответ субагента%' ORDER BY rowid DESC LIMIT 1")
      .get(CHAT_ID) as { text: string } | undefined;
    expect(digest?.text).toContain("Ответ субагента");
  });
});

describe("вызов роли как субагента: выжимка", () => {
  it("роли ставится задача собрать данные и вернуть выжимку (владелец 29.10.2026)", async () => {
    // Субагент одноразовый: он сам набирает контекст, сжимает его в выжимку
    // и исчезает. Вызывающая роль первичные источники не перебирает.
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    await tool.execute("call-1", { role: "researcher", question: "Что в последних правках по хранилищу?" });
    await pendingSubagentRuns();
    const prompt = calls[0].prompt;
    expect(prompt).toContain("Собери нужные данные сам");
    expect(prompt).toMatch(/выжимк/i);
    expect(prompt).not.toMatch(/Ответь по делу/);
  });
});

describe("вызов роли как субагента: фоновый режим", () => {
  it("ход субагента не занимает ход вызывающей роли", async () => {
    // Раннер висит — вызов всё равно возвращается сразу.
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const runner: SubagentRunner = async (input) => {
      calls.push(input.prompt);
      return { text: await gate, sessionId: "pi-session-stub" };
    };
    const tool = toolOf(callerContext(), runner);
    const started = Date.now();
    const result: any = await tool.execute("bg-1", { role: "researcher", question: "Долгий вопрос" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.details.started).toBe(true);
    expect(calls).toHaveLength(1);
    release("Готово.");
    await pendingSubagentRuns();
  });

  it("комната субагента закрывается, когда выжимка ушла в главную сессию", async () => {
    const { runner } = stubRunner("Ответ: всё в порядке.");
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("bg-close", { role: "researcher", question: "Всё в порядке?" });
    await pendingSubagentRuns();
    const room = db
      .prepare("SELECT subagent_state, closed_at FROM chats WHERE id=?")
      .get(result.details.room_chat_id) as { subagent_state: string | null; closed_at: string | null } | undefined;
    expect(room?.subagent_state).toBe("finished");
    expect(room?.closed_at).toBeTruthy();
  });
});

describe("вызов роли как субагента: корректировка на ходу", () => {
  it("уточнение прерывает ход, роль продолжает с новым заданием", async () => {
    // Первый ход висит до уточнения; второй — отвечает сразу.
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const prompts: string[] = [];
    let call = 0;
    const sessionIds: Array<string | null | undefined> = [];
    const runner: SubagentRunner = async (input) => {
      prompts.push(input.prompt);
      sessionIds.push(input.sessionId);
      call += 1;
      if (call === 1) return { text: await gate, sessionId: "pi-session-stub" };
      return { text: "Работа сделана с учётом правки.", sessionId: "pi-session-stub" };
    };
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("steer-1", { role: "researcher", question: "Разберись" });
    const questionId = result.details.question_id;
    const roomId = result.details.room_chat_id;
    expect(prompts).toHaveLength(1);

    // Уточнение: головной агент докидывает правку работающему субагенту.
    const steer = createRoleSubagentSteerTool(callerContext());
    const steered: any = await steer.execute("steer-2", {
      question_id: questionId,
      text: "Уточнение: бери только последние 10 коммитов.",
    });
    expect(steered.details.applied).toBe(true);
    expect(steered.details.room_chat_id).toBe(roomId);

    // Уточнение видно в переписке комнаты.
    const inRoom = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND text LIKE 'Уточнение от вызывающей роли%'")
      .get(roomId) as { text: string } | undefined;
    expect(inRoom?.text).toContain("последние 10 коммитов");

    // Прерванный ход завершается — роль перезапускается с правкой.
    release("Прервано.");
    await pendingSubagentRuns();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("последние 10 коммитов");
    // Наработка сохраняется: второй ход ПРОДОЛЖАЕТ ту же сессию Pi, а не
    // начинает заново (startChatRun открывает файл сессии по sessionId).
    expect(sessionIds[0] ?? undefined).toBeUndefined();
    expect(sessionIds[1]).toBe("pi-session-stub");

    // Карточка закрыта итоговым ответом.
    const card = db
      .prepare(
        "SELECT steps FROM chat_messages WHERE chat_id=? AND message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?",
      )
      .get(CHAT_ID, questionId) as { steps: string } | undefined;
    const coordination = JSON.parse(card!.steps).coordination;
    expect(coordination.terminal).toBe(true);
    // Текст ответа в карточку не копируется: он лежит в нитке (выжимка),
    // карточка — статус обращения (владелец 29.10.2026, дублирование).
    expect(coordination.answer??"").toBe("");
    expect(coordination.activity).toBe("Ответ получен");
  });

  it("лимит уточнений ограничен", async () => {
    const prompts: string[] = [];
    const runner: SubagentRunner = async (input) => {
      prompts.push(input.prompt);
      return { text: "", sessionId: "pi-session-stub" };
    };
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("steer-limit", { role: "researcher", question: "Вопрос" });
    const steer = createRoleSubagentSteerTool(callerContext());
    for (let i = 0; i < SUBAGENT_STEER_LIMIT + 2; i++) {
      await steer.execute(`steer-limit-${i}`, { question_id: result.details.question_id, text: `Правка ${i}` });
    }
    await pendingSubagentRuns();
    // Первый ход + не больше SUBAGENT_STEER_LIMIT перезапусков.
    expect(prompts.length).toBeLessThanOrEqual(SUBAGENT_STEER_LIMIT + 1);
  });

  it("инструмент уточнения доступен только Помощнику и Оркестратору", () => {
    const has = (role: string) =>
      buildRoleToolCatalog({ role, mode: "work", runId: `steer-matrix-${role}`, chatId: CHAT_ID }).operations.some(
        (tool) => tool.name === ROLE_SUBAGENT_STEER_TOOL,
      );
    expect(has("secretary")).toBe(true);
    expect(has("code_orchestrator")).toBe(true);
    expect(has("researcher")).toBe(false);
    expect(has("builder")).toBe(false);
  });

  it("в каталоге субагента инструмента уточнения нет", () => {
    const catalog = runAsSubagent(
      { requesterRole: "secretary", recipientRole: "secretary" },
      () =>
        buildRoleToolCatalog({
          role: "secretary",
          mode: "work",
          runId: "steer-nested-catalog",
          chatId: CHAT_ID,
        }),
    );
    expect(catalog.operations.some((tool) => tool.name === ROLE_SUBAGENT_STEER_TOOL)).toBe(false);
  });
});
