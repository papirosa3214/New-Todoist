// Тесты реестра серверных параметров (MAK-95).
// Покрывают критерии приёмки:
//  - чтение с дефолтом (ключ пуст → возвращается значение из DEFAULTS);
//  - валидация границ (PUT значения вне min/max → 400);
//  - права (PUT не от владельца → 403);
//  - журнал изменений (PUT пишется в server_settings_log);
//  - применение без перезапуска (подписка получает новое значение).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  getSetting,
  loadServerSettingsFromDb,
  onChange,
  resetSetting,
  setSetting,
} from "../src/lib/serverSettings.js";
import { SERVER_SETTINGS } from "../src/lib/serverSettingsRegistry.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let ownerToken: string;
let nonOwnerToken: string;

async function regUser(name: string, email: string, password = "password123"): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password },
  });
  const body = res.json();
  return { id: body.user.id, token: body.token };
}

async function authHeader(token: string): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${token}` };
}

describe("Реестр серверных параметров (MAK-95)", () => {
  let ownerId = "";
  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts(db);
    db.prepare("UPDATE users SET role='viewer' WHERE role='owner'").run();
    const owner = await regUser("Owner", `owner-${Date.now()}@test`);
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.id);
    ownerId = owner.id;
    ownerToken = owner.token;
    const other = await regUser("Random", `random-${Date.now()}@test`);
    nonOwnerToken = other.token;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Очищаем реестр перед каждым тестом — иначе состояние перетекает.
    db.prepare("DELETE FROM server_settings").run();
    db.prepare("DELETE FROM server_settings_log").run();
    db.prepare("UPDATE users SET task_intake_mode='manual', reviewer_first_default=1 WHERE role='owner'").run();
    loadServerSettingsFromDb();
  });


  it("лимит действий пункта доступен владельцу, сохраняется через API и сбрасывается к 10",async()=>{
    const headers={authorization:`Bearer ${ownerToken}`};
    const snapshot=await app.inject({method:"GET",url:"/api/admin/server-settings",headers});
    const setting=snapshot.json().settings.find((row:any)=>row.key==="chat_item_max_actions");
    expect(setting.default).toBe(100);expect(setting.description).toContain("пункт");
    const update=await app.inject({method:"PUT",url:"/api/admin/server-settings/chat_item_max_actions",headers,payload:{value:15}});
    expect(update.statusCode,update.body).toBe(200);expect(getSetting("chat_item_max_actions")).toBe(15);
    loadServerSettingsFromDb();expect(getSetting("chat_item_max_actions")).toBe(15);
    for(const value of [0,2.5,1001]){
      const bad=await app.inject({method:"PUT",url:"/api/admin/server-settings/chat_item_max_actions",headers,payload:{value}});
      expect(bad.statusCode).toBe(400);expect(getSetting("chat_item_max_actions")).toBe(15);
    }
    const denied=await app.inject({method:"PUT",url:"/api/admin/server-settings/chat_item_max_actions",headers:{authorization:`Bearer ${nonOwnerToken}`},payload:{value:20}});
    expect(denied.statusCode).toBe(403);expect(getSetting("chat_item_max_actions")).toBe(15);
    const reset=await app.inject({method:"POST",url:"/api/admin/server-settings/chat_item_max_actions/reset",headers,payload:{}});
    expect(reset.statusCode).toBe(200);expect(getSetting("chat_item_max_actions")).toBe(100);
  });
  it("отклоняет дробный счётчик без записи", () => {
    expect(() => setSetting("role_run_concurrency", 2.5 as never, ownerId)).toThrow("целое");
    expect(getSetting("role_run_concurrency")).toBe(3);
  });
  it("новый реестр меняет реальный режим приёма и сброс возвращает дефолт", async () => {
    setSetting("task_intake_mode", "automatic" as never, ownerId);
    setSetting("reviewer_first_default", false as never, ownerId);
    const result = await app.inject({method:"GET", url:"/api/task-intake/settings", headers:{authorization:`Bearer ${ownerToken}`}});
    expect(result.json()).toEqual({mode:"automatic", reviewer_first_default:false});
    resetSetting("task_intake_mode", ownerId);
    expect(db.prepare("SELECT task_intake_mode FROM users WHERE id=?").get(ownerId)).toEqual({task_intake_mode:"manual"});
    resetSetting("reviewer_first_default", ownerId);
  });
  it("старый экран обновляет значение нового реестра", async () => {
    const result = await app.inject({method:"PATCH", url:"/api/task-intake/settings", headers:{authorization:`Bearer ${ownerToken}`}, payload:{mode:"automatic", reviewer_first_default:false}});
    expect(result.statusCode).toBe(200);
    expect(getSetting("task_intake_mode")).toBe("automatic");
    expect(getSetting("reviewer_first_default")).toBe(false);
    resetSetting("task_intake_mode", ownerId);
    resetSetting("reviewer_first_default", ownerId);
  });
  it("getSetting возвращает дефолт, когда ключа нет в БД", () => {
    const min = getSetting("stall_after_min");
    expect(min).toBe(10);
    const probe = getSetting("provider_probe_interval_ms");
    expect(probe).toBe(5 * 60_000);
    const mode = getSetting("task_intake_mode");
    expect(mode).toBe("manual");
  });

  it("setSetting записывает значение в БД и журнал", () => {
    setSetting("stall_after_min", 7, ownerId, "проверка");
    expect(getSetting("stall_after_min")).toBe(7);
    const logRows = db
      .prepare("SELECT key, old_value, new_value, reason, actor_id FROM server_settings_log ORDER BY id DESC LIMIT 1")
      .all() as Array<{ key: string; old_value: string | null; new_value: string; reason: string | null; actor_id: string | null }>;
    expect(logRows[0]).toMatchObject({
      key: "stall_after_min",
      reason: "проверка",
      actor_id: ownerId,
    });
    expect(JSON.parse(logRows[0].new_value)).toBe(7);
  });

  it("setSetting валидирует по min/max и бросает", () => {
    expect(() => setSetting("stall_after_min", 0, null)).toThrowError(/минимум/);
    expect(() => setSetting("stall_after_min", 999, null)).toThrowError(/максимум/);
    expect(() => setSetting("task_intake_mode", "weekly" as never, null)).toThrowError();
  });

  it("resetSetting возвращает к дефолту и шлёт событие", () => {
    setSetting("stall_after_min", 3, ownerId);
    expect(getSetting("stall_after_min")).toBe(3);
    let observed = -1;
    const off = onChange("stall_after_min", (v) => {
      observed = v;
    });
    resetSetting("stall_after_min", ownerId);
    expect(getSetting("stall_after_min")).toBe(10);
    expect(observed).toBe(10);
    off();
  });

  it("onChange получает новое значение без перезапуска процесса", () => {
    let calls: number[] = [];
    const off = onChange("provider_probe_interval_ms", (v) => calls.push(v));
    setSetting("provider_probe_interval_ms", 60_000, ownerId);
    setSetting("provider_probe_interval_ms", 90_000, ownerId);
    expect(calls).toEqual([60_000, 90_000]);
    off();
  });

  it("GET /api/admin/server-settings требует владельца", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-settings",
      headers: await authHeader(nonOwnerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET возвращает реестр с дефолтами и метаданными владельцу", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-settings",
      headers: await authHeader(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.length).toBe(SERVER_SETTINGS.length);
    expect(body.values.stall_after_min).toBe(10);
    expect(body.values.task_intake_mode).toBe("manual");
  });

  it("PUT валидирует по min/max — 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/server-settings/stall_after_min",
      headers: await authHeader(ownerToken),
      payload: { value: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/минимум/);
  });

  it("PUT от не-владельца → 403", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/server-settings/stall_after_min",
      headers: await authHeader(nonOwnerToken),
      payload: { value: 3 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PUT записывает значение и попадает в GET", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/server-settings/stall_after_min",
      headers: await authHeader(ownerToken),
      payload: { value: 4, reason: "тест" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: "GET",
      url: "/api/admin/server-settings",
      headers: await authHeader(ownerToken),
    });
    expect(get.json().values.stall_after_min).toBe(4);
  });

  it("POST reset возвращает к дефолту", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/admin/server-settings/stall_after_min",
      headers: await authHeader(ownerToken),
      payload: { value: 4 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/server-settings/stall_after_min/reset",
      headers: await authHeader(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({
      method: "GET",
      url: "/api/admin/server-settings",
      headers: await authHeader(ownerToken),
    });
    expect(get.json().values.stall_after_min).toBe(10);
  });
});