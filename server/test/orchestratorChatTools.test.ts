import {beforeAll,it,expect} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {allRoles} from "../src/roleRouting.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";

// Авария 18.10.2026: оркестратор не отвечал в чате владельца вторые сутки.
// Каждый ход падал мгновенно: createUniversalTaskflow бросает «Duplicate
// operation: taskflow_slot_restart» — перезапуск слота зарегистрирован
// дважды (chatTools.ts и orchestratorTools.ts). Исключение знали только для
// секретаря; оркестратор с правом orchestrate остался с дублем.
//
// Условие аварии — три вещи сразу: роль с orchestrate, ход в чате
// (ownerContext) и отсутствие роли в allRoles() — в реестре yaml её нет,
// поэтому прежний тест «у каждой роли один инструмент» этот случай не видел.
const ORCHESTRATOR_ROLE = "code_orchestrator";
const ORCHESTRATOR_USER = "role_code_orchestrator";

const duplicates = (names: string[]) => [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  // Боевые права: orchestrate включает инструменты управления планом, и
  // без него дубль не появляется — тест был бы зелёным на сломанном коде.
  db.prepare(
    `INSERT INTO users (id, name, email, password_hash, role, type, permissions, status, is_system_bot)
     VALUES (?, 'Оркестратор', ?, '', 'agent', 'ai', '{"orchestrate":true}', 'offline', 1)
     ON CONFLICT(id) DO UPDATE SET permissions='{"orchestrate":true}', type='ai'`,
  ).run(ORCHESTRATOR_USER, "orchestrator@taskflow.local");
});

const orchestratorInChat = () =>
  buildRoleToolCatalog({ role: ORCHESTRATOR_ROLE, mode: "work", runId: "test", chatId: "chat", messageId: "msg" });

it("оркестратор в чате не падает на дубле инструментов", () => {
  const catalog = orchestratorInChat();
  expect(duplicates(catalog.operations.map((t) => t.name))).toEqual([]);
});

it("перезапуск слота у оркестратора один и в чате, и в работе", () => {
  const inChat = orchestratorInChat();
  const inWork = buildRoleToolCatalog({
    role: ORCHESTRATOR_ROLE, mode: "work", runId: "test", taskId: "task", subtaskId: "slot",
  });
  expect(inChat.operations.filter((t) => t.name === "taskflow_slot_restart")).toHaveLength(1);
  expect(inWork.operations.filter((t) => t.name === "taskflow_slot_restart")).toHaveLength(1);
});

it("перезапуск слота остаётся доступен оркестратору из чата", () => {
  expect(orchestratorInChat().operations.some((t) => t.name === "taskflow_slot_restart")).toBe(true);
});

it("в чате у каждой зарегистрированной роли нет двух одинаковых инструментов", () => {
  for (const role of allRoles()) {
    const catalog = buildRoleToolCatalog({
      role: role.key, mode: "work", runId: "test", chatId: "chat", messageId: "msg",
    });
    expect(duplicates(catalog.operations.map((t) => t.name)), "дубль у роли " + role.key).toEqual([]);
  }
});