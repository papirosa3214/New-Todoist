// Роли — данные (владелец 23.09.2026): состав задаёт таблица roles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { default: db } = await import("../src/db.js");
const { buildApp } = await import("../src/index.js");
const { ROLE_NAMES, refreshRoles, roleTitle, loadRoleRouting } = await import("../src/roleRouting.js");
const { buildDictationSystemPrompt } = await import("../src/routes/ai.js");

describe("реестр ролей", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("начальный состав — восемь ролей с Секретарём, без Синтезатора", () => {
    expect(ROLE_NAMES).toHaveLength(8);
    expect(ROLE_NAMES).toContain("secretary");
    expect(ROLE_NAMES).not.toContain("synthesizer");
    expect(roleTitle("builder")).toBe("Разработчик");
  });

  it("новая роль из таблицы сразу видна списку, Секретарю и маршрутам", () => {
    db.prepare(
      "INSERT INTO roles (key, title, summary, enabled, position) VALUES ('writer', 'Редактор', 'пишет и правит тексты.', 1, 50)",
    ).run();
    refreshRoles();
    expect(ROLE_NAMES).toContain("writer");
    expect(roleTitle("writer")).toBe("Редактор");
    expect(buildDictationSystemPrompt("")).toContain("- writer — пишет и правит тексты.");
    // В файле моделей роли нет — сервер не падает, подставляет значения по умолчанию.
    const routing = loadRoleRouting();
    expect(routing.models.writer).toBeTruthy();
    expect(routing.fallbacks.writer).toEqual([]);
  });

  it("отключённая роль пропадает из списка и из инструкции Секретаря", () => {
    db.prepare("UPDATE roles SET enabled = 0 WHERE key = 'writer'").run();
    refreshRoles();
    expect(ROLE_NAMES).not.toContain("writer");
    expect(buildDictationSystemPrompt("")).not.toContain("- writer —");
    db.prepare("DELETE FROM roles WHERE key = 'writer'").run();
    refreshRoles();
  });
});
