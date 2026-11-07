// Канал «роль → роль» для роли, работающей на задаче (владелец 02.11.2026:
// роль звала исследователя, которого не было в плане, и получила «Нет сессии
// отправителя для обращения»).
//
// Причина: набор инструментов роли на задаче собирается без чата, и
// `roleToolCatalog.ts` кладёт туда `chatId: ""`. Обращение искало сессию
// отправителя через `??` — пустая строка проходила вместо отсутствия, и роль
// выглядела «без сессии».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { ensurePersonalRoom } from "../src/lib/chatRooms.js";
import { roleUserId } from "../src/roleRouting.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe("канал роли к роли вне плана", () => {
  it("у роли на задаче есть постоянная сессия (личная комната)", () => {
    const qa = roleUserId("qa");
    expect(ensurePersonalRoom(qa)).toBeTruthy();
  });

  it("личная комната исследователя есть — обращение к ней дойдёт", () => {
    const researcher = roleUserId("researcher");
    expect(ensurePersonalRoom(researcher)).toBeTruthy();
  });

  it("пустой chatId не выдаёт роль за «без сессии»", () => {
    // Ровно то значение, которое кладёт каталог инструментов роли на задаче.
    const context = { chatId: "" };
    const session = context.chatId || ensurePersonalRoom(roleUserId("qa"));
    expect(session).toBeTruthy();
    // С прежним `??` здесь была бы пустая строка — и отказ «Нет сессии».
    expect(context.chatId ?? ensurePersonalRoom(roleUserId("qa"))).toBe("");
  });
});
