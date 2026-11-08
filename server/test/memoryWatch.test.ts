import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));
import { logMemoryAccess, memoryAgentStats, memoryBanksInUse, roleKeyOfBank } from "../src/lib/memoryAccessLog.js";

/**
 * Журнал обращений к памяти и «что лежит» (владелец 08.11.2026: «хочу видеть
 * количество раз по конкретным агентам, кто туда обращается»).
 *
 * Проверяем агрегаты, которые отдаёт `/api/memory/agents`, и то, что журнал не
 * роняет обращение, если таблицы нет.
 */
const ROLE = "mw-test-role";
const MEMORY_ID = "mw-test-memory";

function cleanup() {
  db.prepare(`DELETE FROM memory_access_log WHERE role_key = ? OR id LIKE 'mw-%'`).run(ROLE);
  db.prepare(`DELETE FROM memory_mnemo_ids WHERE memory_id = ?`).run(MEMORY_ID);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(MEMORY_ID);
}

describe("memory access log", () => {
  // Тестовая база пустая: схему поднимает сборка приложения, как и в живом
  // запуске (миграции идут на старте сервера).
  beforeAll(async () => {
    await buildApp();
  });
  beforeEach(cleanup);
  afterAll(cleanup);

  it("считает обращения по агентам", () => {
    logMemoryAccess({ roleKey: ROLE, query: "первый", hits: 3 });
    logMemoryAccess({ roleKey: ROLE, query: "второй", hits: 0 });
    const row = memoryAgentStats().find((stat) => stat.role_key === ROLE);
    expect(row?.calls).toBe(2);
    expect(row?.calls_week).toBe(2);
    expect(row?.last_at).toBeTruthy();
  });

  it("старое обращение не попадает в неделю, но попадает в общий счёт", () => {
    logMemoryAccess({ roleKey: ROLE, query: "давнее", hits: 1 });
    db.prepare(
      `UPDATE memory_access_log SET at = datetime('now', '-30 days') WHERE role_key = ?`,
    ).run(ROLE);
    const row = memoryAgentStats().find((stat) => stat.role_key === ROLE);
    expect(row?.calls).toBe(1);
    expect(row?.calls_week).toBe(0);
  });

  it("роль без обращений видна со своими записями", () => {
    // Берём настоящую роль из базы: список «молчащих» строится по users, а не
    // по журналу — иначе «не спрашивал» выглядит как «нет памяти».
    const role = db
      .prepare(`SELECT role_key FROM users WHERE COALESCE(role_key, '') <> '' AND COALESCE(archived, 0) = 0 LIMIT 1`)
      .get() as { role_key: string } | undefined;
    expect(role).toBeTruthy();
    const row = memoryAgentStats().find((stat) => stat.role_key === role?.role_key);
    expect(row).toBeTruthy();
    expect(row?.calls).toBe(0);
    expect(row?.last_at).toBeNull();
  });

  it("журнал не роняет вызов, если таблицы нет", () => {
    db.exec(`ALTER TABLE memory_access_log RENAME TO memory_access_log_gone`);
    try {
      expect(() => logMemoryAccess({ roleKey: ROLE, query: "тихо", hits: 0 })).not.toThrow();
    } finally {
      db.exec(`ALTER TABLE memory_access_log_gone RENAME TO memory_access_log`);
    }
  });

  it("банки берутся из связей частей записи", () => {
    db.prepare(
      `INSERT INTO memories (id, kind, scope, role_key, text, source_kind, created_at, updated_at)
       VALUES (?, 'lesson', 'role', ?, 'тело записи', 'role', datetime('now'), datetime('now'))`,
    ).run(MEMORY_ID, ROLE);
    db.prepare(
      `INSERT INTO memory_mnemo_ids (memory_id, bank, mnemo_id, chunk_no) VALUES (?, 'tf-role-mw-test', 'mw-part-1', 0)`,
    ).run(MEMORY_ID);
    expect(memoryBanksInUse()).toContain("tf-role-mw-test");
    expect(roleKeyOfBank("tf-role-mw-test")).toBe("mw-test");
    expect(roleKeyOfBank("tf-team")).toBeNull();
  });
});
