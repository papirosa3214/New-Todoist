import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { taskChatBrief } from "../src/lib/taskChatBrief.js";
import { ownerNamedItems, resolutionHandoff, slotTeamMap } from "../src/lib/taskChatScope.js";
import { scopeTaskChatOperations } from "../src/runtime/taskChatTools.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";

// Владелец 05.11.2026: роль в чате задачи знает свой кусок и карту команды, пришла
// только отчитаться и ничего не меняет. Чужое открывает лишь по его слову.
const LONG_RESULT = "Решение архитектора: " + "кэш держим на сервере, курсор отдаём клиенту. ".repeat(20);

function addPlan(taskId: string, title: string, nodes: Array<[string, string]>, edges: Array<[string, string]>) {
  db.prepare("INSERT INTO tasks(id,title,description,creator_id,status) VALUES(?,?,?,'u1','active')").run(taskId, title, "Описание " + title);
  const planId = taskId + "_plan";
  db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by,approved_by) VALUES(?,?,1,'approved','manual','test','u1','u1')").run(planId, taskId);
  nodes.forEach(([slot, role], position) => {
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,?,?,?,1,?)").run(`${taskId}_n_${slot}`, planId, slot, role, `Итог ${slot}`);
    db.prepare("INSERT INTO subtasks(id,task_id,title,position,agent_id,collaboration_plan_id,plan_node_key) VALUES(?,?,?,?,?,?,?)").run(`${taskId}_${slot}`, taskId, `Шаг ${slot}`, position, "role_" + role, planId, slot);
  });
  edges.forEach(([from, to]) => {
    db.prepare("INSERT INTO task_collaboration_plan_edges(id,plan_id,from_slot_key,to_slot_key,start_condition) VALUES(?,?,?,?,'submitted')").run(`${taskId}_e_${from}_${to}`, planId, from, to);
  });
}

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  addPlan("scope_team", "Синхронизация заметок", [["arch", "architect"], ["dev1", "builder"], ["dev2", "builder"], ["qa", "qa"], ["critic", "critic_verifier"]],
    [["arch", "dev1"], ["arch", "dev2"], ["dev1", "qa"], ["dev2", "qa"], ["qa", "critic"]]);
  db.prepare("UPDATE subtasks SET done=1, result=? WHERE id='scope_team_arch'").run(LONG_RESULT);
  db.prepare("UPDATE subtasks SET done=1, result='Чужой кусок: сделал индексы' WHERE id='scope_team_dev2'").run();
  db.prepare("UPDATE subtasks SET agent_state='blocked' WHERE id='scope_team_dev1'").run();
  db.prepare("INSERT INTO subtask_work_plans(subtask_id,revision,items_json,author_id,updated_at) VALUES('scope_team_dev1',1,?,'role_builder',datetime('now'))").run(JSON.stringify([{ id: "a", title: "Поправить запрос", state: "done" }, { id: "b", title: "Догон по курсору", state: "in_progress" }]));
  db.prepare("INSERT INTO slot_work_snapshots(id,task_id,subtask_id,role_key,plan_node_key,reason,done_summary,blocker) VALUES('snap1','scope_team','scope_team_dev1','builder','dev1','progress','Запрос готов','Нет доступа к базе')").run();
  addPlan("scope_solo", "Одиночная правка", [["work", "builder"]], []);
  addPlan("scope_foreign", "Выгрузка отчёта бухгалтерии", [["work", "builder"]], []);
  db.prepare("INSERT INTO chats(id,title,kind,created_by,task_id) VALUES('scope_chat','Тема','group','u1','scope_team')").run();
});

describe("карта команды", () => {
  const map = () => slotTeamMap("scope_team_dev1");

  it("показывает, где роль, откуда получает, кто параллельно и кому сдаёт", () => {
    const line = map().split("\n").find((l) => l.includes("← ТЫ ЗДЕСЬ"));
    expect(line).toContain("Разработчик 1");
    expect(map()).toContain("Получаешь от: Архитектор");
    expect(map()).toContain("Параллельно с тобой: Разработчик 2");
    expect(map()).toContain("Сдаёшь: Лайф-тестировщик");
    expect(map()).toContain("отвечаешь лично ты");
    expect(map()).toContain("Итог dev1");
  });

  it("состояние этапа берётся из того же разбора, что и в Координации", () => {
    const line = map().split("\n").find((l) => l.includes("Архитектор"));
    expect(line).toContain("сдан");
    expect(map()).not.toContain("undefined");
  });

  it("проверяющий дальше по плану: с роли только минимальная проверка", () => {
    expect(map()).toContain("Проверят дальше: Лайф-тестировщик, Критик-проверяющий");
    expect(map()).toContain("глубокие тесты");
  });

  it("проверяющего в плане нет: проверка на самой роли", () => {
    const solo = slotTeamMap("scope_solo_work");
    expect(solo).toContain("Проверяющего дальше по плану нет");
    expect(solo).not.toContain("Проверят дальше");
  });

  it("сам проверяющий не получает совета не тестировать", () => {
    const qa = slotTeamMap("scope_team_qa");
    expect(qa).toContain("Проверка — твоя работа на этом этапе");
    expect(qa).not.toContain("глубокие тесты");
  });
});

describe("первый блок в чате задачи", () => {
  const brief = () => taskChatBrief("scope_team", "builder", "scope_team_dev1", "scope_chat");

  it("итог предыдущего этапа копируется как есть, чужой параллельный итог не показан", () => {
    expect(brief()).toContain(LONG_RESULT);
    expect(brief()).not.toContain("Чужой кусок: сделал индексы");
  });

  it("выжимка своей работы: чек-лист и снимок", () => {
    expect(brief()).toContain("Поправить запрос");
    expect(brief()).toContain("Догон по курсору");
    expect(brief()).toContain("Нет доступа к базе");
  });

  it("чат только для отчёта", () => {
    expect(brief()).toContain("только для отчёта");
    expect(brief()).toContain("Описание Синхронизация заметок");
  });

  it("чужих задач в блоке нет", () => {
    expect(brief()).not.toContain("Выгрузка отчёта бухгалтерии");
  });

  it("владелец назвал чужую карточку: сервер подсказывает её id", () => {
    const named = taskChatBrief("scope_team", "builder", "scope_team_dev1", "scope_chat", "посмотри как сделали выгрузку отчёта у бухгалтерии");
    expect(named).toContain("scope_foreign");
  });

  it("роли без этапа сказано, что своего этапа нет; нет задачи — пусто", () => {
    expect(taskChatBrief("scope_team", "designer")).toContain("Своего этапа в плане у тебя нет");
    expect(taskChatBrief("no_such_task", "builder")).toBe("");
  });
});

describe("слова владельца", () => {
  it("находит карточку по словам из разных падежей и не цепляется за одно общее слово", () => {
    expect(ownerNamedItems("зайди в выгрузку отчёта", "scope_team").tasks.map((t) => t.id)).toContain("scope_foreign");
    expect(ownerNamedItems("почему отчёт пустой", "scope_team").tasks.map((t) => t.id)).not.toContain("scope_foreign");
  });
});

describe("инструменты чата задачи", () => {
  const names = () => buildRoleToolCatalog({ role: "builder", mode: "task_chat", runId: "t", taskId: "scope_team", subtaskId: "scope_team_dev1", chatId: "scope_chat", messageId: "m_none" }).registeredNames;

  it("чат задачи получает тот же полный набор (владелец 07.11.2026)", () => {
    for (const name of ["taskflow_task", "taskflow_plan_read", "taskflow_doc_read", "taskflow_subtask_done", "taskflow_doc_write"]) expect(names()).toContain(name);
  });

  it("обычный режим роли не сужается", () => {
    const work = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "t", taskId: "scope_team", subtaskId: "scope_team_dev1" }).registeredNames;
    expect(work).toContain("taskflow_subtask_done");
  });

  function guarded(name: string, messageText: string) {
    db.prepare("INSERT OR REPLACE INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id) VALUES('guard_msg','u1',?,'chat','scope_chat','scope_team')").run(messageText);
    const calls: unknown[] = [];
    const [tool] = scopeTaskChatOperations([{ name, execute: async (_id: string, args: unknown) => { calls.push(args); return { ok: true }; } } as any], { taskId: "scope_team", messageId: "guard_msg", role: "builder" });
    return { tool, calls };
  }

  it("свою карточку открывает всегда, чужую только если владелец её назвал", async () => {
    const own = guarded("taskflow_task", "как дела");
    await own.tool.execute("1", { id: "scope_team" });
    expect(own.calls).toHaveLength(1);

    const refused = guarded("taskflow_task", "как дела");
    await expect(refused.tool.execute("1", { id: "scope_foreign" })).rejects.toThrow("владелец");
    expect(refused.calls).toHaveLength(0);

    const named = guarded("taskflow_task", "посмотри выгрузку отчёта бухгалтерии");
    await named.tool.execute("1", { id: "scope_foreign" });
    expect(named.calls).toHaveLength(1);
  });

  it("коллеге пишет только по слову владельца и только в своей задаче", async () => {
    const silent = guarded("taskflow_topic_send", "как дела");
    await expect(silent.tool.execute("1", { to: "qa", text: "вопрос" })).rejects.toThrow("владельца");

    const asked = guarded("taskflow_topic_send", "спроси у тестировщика, что он видел");
    await asked.tool.execute("1", { to: "qa", text: "вопрос" });
    expect(asked.calls).toHaveLength(1);

    const elsewhere = guarded("taskflow_topic_send", "спроси у тестировщика");
    await expect(elsewhere.tool.execute("1", { to: "qa", text: "вопрос", task_id: "scope_foreign" })).rejects.toThrow("этой задач");
  });
});

describe("кнопка «Продолжить»", () => {
  it("уносит в рабочий запуск план и разговор, потому что сессии теперь разные", () => {
    const insert = db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,subtask_id,recipient_subtask_id,reply_to_message_id) VALUES(?,?,?,'chat','scope_chat','scope_team',?,?,?)");
    insert.run("talk_1", "u1", "Почему встал?", null, "scope_team_dev1", null);
    insert.run("talk_2", "role_builder", "Нет доступа.\n```plan\n1. Взять ключ из хранилища\n```", "scope_team_dev1", null, null);
    insert.run("talk_3", "u1", "Согласен с планом, продолжай по нему.", null, "scope_team_dev1", "talk_2");
    const handoff = resolutionHandoff("talk_3");
    expect(handoff).toContain("Взять ключ из хранилища");
    expect(handoff).toContain("Почему встал?");
    expect(resolutionHandoff("talk_1")).toBe("");
  });
});
