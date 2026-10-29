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
//   5. Ответ субагента доходит до вызывающей роли текстом, карточка
//      координации в чате вызывающей роли закрывается ответом.
//
// Ход субагента в тестах не настоящий: раннер подменяется, поэтому сеть и
// модель не трогаются.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import {
  createRoleSubagentCallTool,
  isSubagentRun,
  resetAllSubagentCallCounters,
  ROLE_SUBAGENT_CALL_TOOL,
  runAsSubagent,
  SUBAGENT_CALL_LIMIT,
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

/** Раннер-заглушка: ход роли не настоящий, ответ задан заранее. */
function stubRunner(answer = "Разбор готов: шаг контракта не меняем.") {
  const calls: Array<{ role: string; roleId: string; chatId: string; prompt: string }> = [];
  const runner: SubagentRunner = async (input) => {
    calls.push({ role: input.role, roleId: input.roleId, chatId: input.chatId, prompt: input.prompt });
    return answer;
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

  it("ответ субагента возвращается вызывающей роли текстом", async () => {
    const { runner, calls } = stubRunner("Считаю: 12 строк, 3 файла.");
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("call-4", { role: "researcher", question: "Сколько строк?" });
    expect(result.content[0].text).toContain("12 строк");
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

  it("в комнате субагента лежат вопрос и ответ, карточка ведёт в комнату", async () => {
    const { runner, calls } = stubRunner("Ответ из комнаты.");
    const tool = toolOf(callerContext(), runner);
    const result: any = await tool.execute("call-room", { role: "researcher", question: "Что в комнате?" });
    const roomId = calls[0].chatId;
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
    expect(coordination.answer).toBe("Ответ из комнаты.");
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
      expect(result.content[0].text).toContain("Разбор готов");
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
    expect(result.content[0].text).toContain("Разбор готов");
  });
});

describe("вызов роли как субагента: карточка координации", () => {
  it("карточка в чате вызывающей роли закрывается ответом субагента", async () => {
    const { runner } = stubRunner("Ответ субагента: всё в порядке.");
    const tool = toolOf(callerContext(), runner);
    await tool.execute("card-1", { role: "researcher", question: "Всё в порядке?" });
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
    expect(coordination.answer).toContain("Ответ субагента");
  });
});

describe("вызов роли как субагента: выжимка", () => {
  it("роли ставится задача собрать данные и вернуть выжимку (владелец 29.10.2026)", async () => {
    // Субагент одноразовый: он сам набирает контекст, сжимает его в выжимку
    // и исчезает. Вызывающая роль первичные источники не перебирает.
    const { runner, calls } = stubRunner();
    const tool = toolOf(callerContext(), runner);
    await tool.execute("call-1", { role: "researcher", question: "Что в последних правках по хранилищу?" });
    const prompt = calls[0].prompt;
    expect(prompt).toContain("Собери нужные данные сам");
    expect(prompt).toMatch(/выжимк/i);
    expect(prompt).not.toMatch(/Ответь по делу/);
  });
});
