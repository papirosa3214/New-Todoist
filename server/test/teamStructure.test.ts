// Состав команды (владелец 14.10.2026): общий блок для всех ролей.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { teamStructureText } from "../src/lib/teamStructure.js";

describe("Состав команды", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("звенья, роли из реестра и отметка себя", () => {
    const text = teamStructureText("builder");
    for (const part of ["Управление", "Проектирование", "Исполнение", "Проверка", "Помощник владельца", "Оркестратор", "Инженер .110", "Критик-проверяющий"]) {
      expect(text).toContain(part);
    }
    expect(text).toContain("Разработчик (это ты)");
    expect(text).not.toContain("Секретарь");
  });
});
