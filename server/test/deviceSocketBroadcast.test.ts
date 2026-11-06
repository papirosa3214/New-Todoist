// Сокет устройства (`/ws` с токеном устройства) нужен телефону только для
// команд `device_op` и проверки связи. Раньше он получал ещё и весь поток
// событий доски и чатов, включая посимвольный стрим ответа роли, — телефон
// принимал каждое событие дважды (аудит синхронизации 06.11.2026).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import {
  addClient,
  broadcast,
  broadcastToUsers,
  pingAllClients,
  removeClient,
  runDeviceOp,
} from "../src/ws.js";

const USER = "u-device-socket-test";
const DEVICE = "dev-device-socket-test";

function fakeSocket() {
  const sent: string[] = [];
  return { sent, socket: { readyState: 1, send: (data: string) => { sent.push(data); } } };
}

let app: FastifyInstance;
beforeAll(async () => {
  // Поднимаем сервер ради схемы тестовой базы: сокет пишет статус в users.
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const opened: Array<{ socket: any }> = [];
afterEach(() => {
  for (const { socket } of opened.splice(0)) removeClient(USER, socket);
});

describe("сокет устройства не получает общий поток событий", () => {
  it("событие пользователя уходит в обычный сокет и не уходит в сокет устройства", () => {
    const user = fakeSocket();
    const device = fakeSocket();
    opened.push(user, device);
    addClient(USER, user.socket as any);
    addClient(USER, device.socket as any, DEVICE);

    broadcast(USER, { type: "chats:live:patch", chat_id: "c1", text: "при" });
    broadcastToUsers([USER], { type: "task:changed", task_id: "t1" });

    expect(user.sent.map((s) => JSON.parse(s).type)).toEqual(["chats:live:patch", "task:changed"]);
    expect(device.sent).toEqual([]);
  });

  it("проверка связи и команды устройству по-прежнему доходят", async () => {
    const device = fakeSocket();
    opened.push(device);
    addClient(USER, device.socket as any, DEVICE);

    pingAllClients();
    const op = runDeviceOp(DEVICE, "reminder.list", {}, { timeoutMs: 30 }).catch(() => null);
    await op;

    const types = device.sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("ping");
    expect(types).toContain("device_op");
  });
});
