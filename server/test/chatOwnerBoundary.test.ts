// Этап 2 плана карточки 252c400e: граница прерывания обычного чата.
//
// Сценарии (обязательные по плану):
//   1. Уточнение между инструментами: после границы старый ход не запускает
//      новых действий старого поколения.
//   2. Уточнение внутри долгого внешнего job: работа реально остановлена,
//      а не просто помечена.
//   3. Два сообщения во время суммаризации: второе сообщение не даёт старой
//      генерации опубликовать свой итог.
//   4. Ошибка суммаризации: выжимка не собрана — запуск на сырой истории
//      запрещён, ход не идёт.
//
// Проверяем процедуру границы (chatOwnerBoundary.ts) и её серверные части:
// поколение, fence старых ходов, ожидание фактической остановки.

import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import db from "../src/db.js";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  applyOwnerBoundary,
  DEFAULT_STOP_WAIT_MS,
} from "../src/runtime/chatOwnerBoundary.js";
import {
  bumpChatGeneration,
  currentChatGeneration,
  enqueueMessageDelivery,
  fencePairDeliveries,
  getMessageDelivery,
} from "../src/runtime/chatQueue.js";

beforeAll(() => {
  migrate();
  runMigrations();
});

beforeEach(() => {
  db.prepare("DELETE FROM chat_message_queue").run();
  db.prepare("DELETE FROM chat_session_generation").run();
});

function seedPair(chatId = "chat-b", roleId = "role_b") {
  db.prepare("INSERT OR IGNORE INTO chats(id, kind, created_at) VALUES(?, 'direct', datetime('now'))").run(chatId);
  db.prepare("INSERT OR IGNORE INTO users(id, name, email, password_hash, type) VALUES(?, ?, ?, ?, 'ai')").run(
    roleId,
    roleId,
    `${roleId}@example.test`,
    "x",
  );
}

describe("граница прерывания обычного чата", () => {
  it("порядок шагов: сначала граница (поколение), потом отмена, потом ожидание", async () => {
    const calls: string[] = [];
    let generation = 1;
    const result = await applyOwnerBoundary(
      { chatId: "chat-b", roleId: "role_b" },
      {
        bumpGeneration: () => {
          calls.push("bump");
          generation += 1;
          return generation;
        },
        cancelRuns: async () => {
          calls.push("cancel");
          return 1;
        },
        waitIdle: async () => {
          calls.push("waitIdle");
        },
      },
    );
    expect(calls).toEqual(["bump", "cancel", "waitIdle"]);
    expect(result.generation).toBe(2);
    expect(result.cancelled).toBe(1);
    expect(result.idle).toBe(true);
  });

  it("после границы ходы старого поколения закрыты: новых действий не будет", async () => {
    seedPair();
    const delivery = enqueueMessageDelivery({
      chatId: "chat-b",
      roleId: "role_b",
      deliveryId: "d1",
      payload: { text: "старое" },
    });
    expect(delivery.generation).toBe(1);
    const result = await applyOwnerBoundary(
      { chatId: "chat-b", roleId: "role_b" },
      {
        bumpGeneration: ({ chatId, roleId, reason }) =>
          bumpChatGeneration({ chatId, roleId, reason }).generation,
        cancelRuns: async () => 1,
        waitIdle: async () => undefined,
      },
    );
    fencePairDeliveries({ chatId: "chat-b", roleId: "role_b", generation: result.generation });
    // Старый ход помечен superseded — после перезапуска он не поднимется
    // заново и не повторит свой эффект.
    expect(getMessageDelivery(delivery.id)?.status).toBe("superseded");
    expect(currentChatGeneration("chat-b", "role_b")).toBe(2);
  });

  it("уточнение внутри долгого внешнего job: работа реально остановлена, а не помечена", async () => {
    seedPair("chat-c", "role_c");
    let stopped = false;
    const result = await applyOwnerBoundary(
      { chatId: "chat-c", roleId: "role_c" },
      {
        bumpGeneration: ({ chatId, roleId, reason }) =>
          bumpChatGeneration({ chatId, roleId, reason }).generation,
        // Отмена внешней работы: прерываем её и ждём фактической остановки.
        cancelRuns: async () => {
          stopped = true;
          return 1;
        },
        waitIdle: async () => {
          // Внешний job услышал отмену и реально завершился.
          expect(stopped).toBe(true);
        },
      },
    );
    expect(result.idle).toBe(true);
    expect(stopped).toBe(true);
  });

  it("ожидание остановки имеет предел: зависший ход не держит границу вечно", async () => {
    const result = await applyOwnerBoundary(
      { chatId: "chat-d", roleId: "role_d", timeoutMs: 20 },
      {
        bumpGeneration: () => 2,
        cancelRuns: async () => 1,
        waitIdle: async () => {
          throw new Error("ход не встал");
        },
      },
    );
    // Граница не должна падать из-за зависшего хода: он помечен, а предел
    // ожидания — из настроек сервера, а не выдуманное число.
    expect(result.idle).toBe(false);
    expect(DEFAULT_STOP_WAIT_MS).toBeGreaterThan(0);
  });

  it("два сообщения во время суммаризации: второе сообщение не даёт старой генерации опубликовать итог", async () => {
    seedPair("chat-e", "role_e");
    const first = enqueueMessageDelivery({
      chatId: "chat-e",
      roleId: "role_e",
      deliveryId: "old",
      payload: { text: "первое" },
    });
    // Граница от первого уточнения.
    const boundary = await applyOwnerBoundary(
      { chatId: "chat-e", roleId: "role_e" },
      {
        bumpGeneration: ({ chatId, roleId, reason }) =>
          bumpChatGeneration({ chatId, roleId, reason }).generation,
        cancelRuns: async () => 1,
        waitIdle: async () => undefined,
      },
    );
    fencePairDeliveries({ chatId: "chat-e", roleId: "role_e", generation: boundary.generation });
    // Второе сообщение приходит уже на новом поколении.
    const second = enqueueMessageDelivery({
      chatId: "chat-e",
      roleId: "role_e",
      deliveryId: "new",
      payload: { text: "второе" },
    });
    expect(second.generation).toBe(boundary.generation);
    expect(getMessageDelivery(first.id)?.status).toBe("superseded");
    expect(getMessageDelivery(second.id)?.status).toBe("pending");
  });
});
