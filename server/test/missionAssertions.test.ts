import crypto from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("../src/runtime/inProcessRun.js", async original => ({ ...(await original<any>()), runRoleInProcess: vi.fn(async () => ({ runId: "mc-run", completion: Promise.resolve() })) }));
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts, demoteSeededOwner } from "./helpers/seedOwner.js";

/**
 * Контракт ассерций миссии (владелец 01.11.2026).
 *
 * «Готово» определено ДО работы: контракт — список ассерций, работа (узел
 * плана) закрывает их полем `fulfills`. Инвариант — ровно одна работа на
 * ассерцию. Дыра в покрытии отменяет утверждение плана.
 */
describe("контракт ассерций миссии", { timeout: 60000 }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let auth: any;
  let appOwner: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    appOwner = crypto.randomUUID();
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,type,task_intake_mode) VALUES(?,'MC owner',?,'!','owner','human','automatic')").run(appOwner, `${appOwner}@test`);
    auth = { authorization: `Bearer ${app.jwt.sign({ id: appOwner })}` };
  });
  afterAll(async () => {
    await app.close();
  });

  async function task(title: string) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,status,project_id) VALUES(?,?,?,NULL,'active',(SELECT project_id FROM tasks WHERE id IS NOT NULL LIMIT 1))").run(id, title, appOwner);
    return id;
  }

  async function contract(id: string, ids: string[]) {
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/mission-assertions`,
      headers: auth,
      payload: { assertions: ids.map(a => ({ assertion_id: a, title: `Проверка ${a}`, behavior: `Поведение ${a}`, tool: "browser.mjs" })) },
    });
    expect(r.statusCode).toBe(200);
    return r.json().assertions as Array<{ assertion_id: string }>;
  }

  async function planWithFulfills(id: string, nodes: Array<{ slot_key: string; role_key: string; fulfills: string[] }>) {
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/collaboration-plans`,
      headers: auth,
      payload: {
        profile: "manual",
        nodes: nodes.map(n => ({ slot_key: n.slot_key, role_key: n.role_key, expected_result: `Результат ${n.slot_key}`, fulfills: n.fulfills })),
        edges: [],
      },
    });
    expect(r.statusCode).toBe(201);
    return r.json().plan.id as string;
  }

  const approve = (id: string, planId: string) =>
    app.inject({ method: "POST", url: `/api/tasks/${id}/collaboration-plans/${planId}/approve`, headers: auth, payload: {} });

  const ids12 = () => Array.from({ length: 12 }, (_, i) => `VAL-${String(i + 1).padStart(3, "0")}`);

  it("контракт из 12 ассерций раскладывается на 5 шагов — approve проходит", async () => {
    const id = await task("Миссия: контракт покрыт");
    const ids = ids12();
    await contract(id, ids);
    const planId = await planWithFulfills(id, [
      { slot_key: "auth", role_key: "builder", fulfills: ids.slice(0, 3) },
      { slot_key: "session", role_key: "builder", fulfills: ids.slice(3, 6) },
      { slot_key: "cart", role_key: "builder", fulfills: ids.slice(6, 9) },
      { slot_key: "ui", role_key: "designer", fulfills: ids.slice(9, 11) },
      { slot_key: "qa", role_key: "qa", fulfills: ids.slice(11, 12) },
    ]);
    const r = await approve(id, planId);
    expect(r.statusCode).toBe(200);
  });

  it("дыра в покрытии блокирует утверждение плана и называет ассерцию", async () => {
    const id = await task("Миссия: дыра в покрытии");
    const ids = ids12();
    await contract(id, ids);
    // VAL-012 не заявлена ни одной работой.
    const planId = await planWithFulfills(id, [
      { slot_key: "auth", role_key: "builder", fulfills: ids.slice(0, 3) },
      { slot_key: "session", role_key: "builder", fulfills: ids.slice(3, 6) },
      { slot_key: "cart", role_key: "builder", fulfills: ids.slice(6, 9) },
      { slot_key: "ui", role_key: "designer", fulfills: ids.slice(9, 11) },
    ]);
    const r = await approve(id, planId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("VAL-012");
  });

  it("ассерция, заявленная в двух работах, блокирует утверждение", async () => {
    const id = await task("Миссия: ассерция продублирована");
    const ids = ids12();
    await contract(id, ids);
    const planId = await planWithFulfills(id, [
      { slot_key: "auth", role_key: "builder", fulfills: [...ids.slice(0, 6), "VAL-007"] },
      { slot_key: "cart", role_key: "builder", fulfills: ids.slice(6, 12) },
    ]);
    const r = await approve(id, planId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("VAL-007");
  });

  it("ссылка на несуществующую ассерцию блокирует утверждение", async () => {
    const id = await task("Миссия: ссылка в пустоту");
    const ids = ids12();
    await contract(id, ids);
    const planId = await planWithFulfills(id, [
      { slot_key: "auth", role_key: "builder", fulfills: [...ids, "VAL-999"] },
    ]);
    const r = await approve(id, planId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("VAL-999");
  });

  it("карточка без контракта утверждается как раньше", async () => {
    const id = await task("Обычная карточка без контракта");
    const planId = await planWithFulfills(id, [{ slot_key: "work", role_key: "builder", fulfills: [] }]);
    const r = await approve(id, planId);
    expect(r.statusCode).toBe(200);
  });

  it("контракт пишется владельцем, читается и переписывается целиком", async () => {
    const id = await task("Миссия: контракт пишется и читается");
    await contract(id, ["VAL-AAA", "VAL-BBB"]);
    const read = await app.inject({ url: `/api/tasks/${id}/mission-assertions`, headers: auth });
    expect(read.statusCode).toBe(200);
    expect(read.json().assertions.map((a: any) => a.assertion_id)).toEqual(["VAL-AAA", "VAL-BBB"]);

    // Перезапись — полная замена, не дополнение.
    await contract(id, ["VAL-CCC"]);
    const after = await app.inject({ url: `/api/tasks/${id}/mission-assertions`, headers: auth });
    expect(after.json().assertions.map((a: any) => a.assertion_id)).toEqual(["VAL-CCC"]);
  });

  it("кривой контракт отклоняется с понятным сообщением", async () => {
    const id = await task("Миссия: кривой контракт");
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/mission-assertions`,
      headers: auth,
      payload: { assertions: [{ assertion_id: "VAL-001", title: "", behavior: "что-то" }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("VAL-001");
  });

  it("покрытие видно без нажатия approve", async () => {
    const id = await task("Миссия: сухая проверка покрытия");
    const ids = ids12();
    await contract(id, ids);
    const planId = await planWithFulfills(id, [{ slot_key: "auth", role_key: "builder", fulfills: ids.slice(0, 11) }]);
    const r = await app.inject({ url: `/api/tasks/${id}/collaboration-plans/${planId}/assertion-coverage`, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(false);
    expect(r.json().total).toBe(12);
    expect(r.json().violations.some((v: any) => v.assertion_id === "VAL-012")).toBe(true);
  });

  it("правка графа плана не теряет заявленные ассерции", async () => {
    const id = await task("Миссия: правка графа");
    const ids = ids12();
    await contract(id, ids);
    const planId = await planWithFulfills(id, [{ slot_key: "auth", role_key: "builder", fulfills: ids.slice(0, 12) }]);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}/collaboration-plans/${planId}`,
      headers: auth,
      payload: { nodes: [{ slot_key: "auth", role_key: "builder", expected_result: "Уточнённый результат" }], edges: [] },
    });
    expect(patch.statusCode).toBe(200);
    const view = await app.inject({ url: `/api/tasks/${id}/collaboration-plans`, headers: auth });
    const node = view.json().plans[0].nodes[0];
    expect(node.fulfills).toEqual(ids);
  });

  it("операция add_step умеет заявлять ассерции", async () => {
    const id = await task("Миссия: add_step с ассерциями");
    const ids = ids12();
    await contract(id, ids);
    const planId = await planWithFulfills(id, [{ slot_key: "auth", role_key: "builder", fulfills: ids.slice(0, 6) }]);
    const ops = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/collaboration-plans/${planId}/ops`,
      headers: auth,
      payload: { ops: [{ op: "add_step", slot_key: "cart", role_key: "builder", expected_result: "Корзина", fulfills: ids.slice(6, 12) }] },
    });
    expect(ops.statusCode).toBe(200);
    const r = await approve(id, planId);
    expect(r.statusCode).toBe(200);
  });
});
