// HTTP-часть реестра машин: список для приложения, заведение машины с выдачей
// ключа, отзыв и вызов операции (тикет 1).
//
// Ключ выдаётся ОДИН раз — вторым запросом его уже не достать, потому что в базе
// лежит только sha256. Это здесь и проверяется: ответ с ключом и последующий
// список должны различаться.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { isMachineOnline, resetHostGatewaysForTests } from "../src/host/gateway.js";

describe("Реестр машин по HTTP", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let wsUrl: string;

  beforeAll(async () => {
    app = await buildApp();
    for (const [tag, роль] of [
      ["owner", "owner@hosts.test"],
      ["agent", "agent@hosts.test"],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: tag, email: роль, password: "password123" },
      });
      db.prepare("UPDATE users SET role = ? WHERE email = ?").run(
        tag === "owner" ? "owner" : "agent",
        роль,
      );
    }
    const владелец = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@hosts.test", password: "password123" },
    });
    ownerToken = владелец.json().token;
    const агент = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "agent@hosts.test", password: "password123" },
    });
    agentToken = агент.json().token;

    // WebSocket нужен живьём: app.inject его не умеет. Слушаем один раз на
    // файл — второй app.listen бросает «Fastify is already listening».
    await app.listen({ port: 0, host: "127.0.0.1" });
    const адрес = app.server.address();
    if (!адрес || typeof адрес === "string") throw new Error("сервер не слушает TCP");
    wsUrl = `ws://127.0.0.1:${адрес.port}/host-ws`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetHostGatewaysForTests();
  });

  const владелец = () => ({ authorization: `Bearer ${ownerToken}` });

  it("заведение машины отдаёт ключ ровно один раз", async () => {
    const ответ = await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: владелец(),
      payload: { name: "mac-http", allowedRoots: ["/Users/max"], platform: "darwin" },
    });

    expect(ответ.statusCode).toBe(200);
    const тело = ответ.json();
    expect(тело.machine.name).toBe("mac-http");
    expect(typeof тело.token).toBe("string");
    expect(тело.token.startsWith("tfh_")).toBe(true);

    // Второй раз ключ уже не отдаётся — в базе его нет.
    const список = await app.inject({ url: "/api/machines", headers: владелец() });
    const строка = список.json().find((м: any) => м.id === тело.machine.id);
    expect(строка).toBeTruthy();
    expect(JSON.stringify(список.json())).not.toContain(тело.token);
  });

  it("список машин виден владельцу и не виден агенту", async () => {
    await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: владелец(),
      payload: { name: "mac-виден", allowedRoots: ["/Users/max"] },
    });

    const владельцу = await app.inject({ url: "/api/machines", headers: владелец() });
    expect(владельцу.statusCode).toBe(200);
    expect(владельцу.json().some((м: any) => м.name === "mac-виден")).toBe(true);

    const агенту = await app.inject({
      url: "/api/machines",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(агенту.statusCode).toBe(403);
  });

  it("без входа список машин недоступен", async () => {
    const безВхода = await app.inject({ url: "/api/machines" });
    expect(безВхода.statusCode).toBe(401);
  });

  it("отзыв по HTTP снимает машину и закрывает её сокет", async () => {
    const заведена = await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: владелец(),
      payload: { name: "mac-отзыв-http", allowedRoots: ["/Users/max"] },
    });
    const { machine, token } = заведена.json();

    const сокет = new WebSocket(`${wsUrl}?key=${token}`);
    await new Promise<void>((resolve, reject) => {
      сокет.once("open", () => resolve());
      сокет.once("error", reject);
    });
    expect(isMachineOnline(machine.id)).toBe(true);

    const отзыв = await app.inject({
      method: "DELETE",
      url: `/api/machines/${machine.id}`,
      headers: владелец(),
      payload: { reason: "проверка" },
    });
    expect(отзыв.statusCode).toBe(200);
    expect(отзыв.json().revoked).toBe(true);

    expect(isMachineOnline(machine.id)).toBe(false);
    await new Promise<void>((resolve) => {
      if (сокет.readyState === WebSocket.CLOSED) return resolve();
      сокет.once("close", () => resolve());
    });
  });

  it("вызов операции по HTTP возвращает результат хоста", async () => {
    const заведена = await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: владелец(),
      payload: { name: "mac-ops-http", allowedRoots: ["/Users/max"] },
    });
    const { machine, token } = заведена.json();

    const сокет = new WebSocket(`${wsUrl}?key=${token}`);
    сокет.on("message", (raw) => {
      const сообщение = JSON.parse(raw.toString());
      if (сообщение.type !== "op") return;
      сокет.send(
        JSON.stringify({
          type: "op_result",
          opId: сообщение.opId,
          ok: true,
          exitCode: 0,
          stdout: "привет",
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      сокет.once("open", () => resolve());
      сокет.once("error", reject);
    });

    const вызов = await app.inject({
      method: "POST",
      url: `/api/machines/${machine.id}/ops`,
      headers: владелец(),
      payload: { op: "bash", args: { command: "echo привет" } },
    });

    expect(вызов.statusCode).toBe(200);
    expect(вызов.json().ok).toBe(true);
    expect(вызов.json().stdout).toBe("привет");
    сокет.close();
  });

  it("вызов офлайн-машины по HTTP — понятная ошибка, а не зависание", async () => {
    const заведена = await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: владелец(),
      payload: { name: "mac-офлайн-http", allowedRoots: ["/Users/max"] },
    });
    const { machine } = заведена.json();

    const вызов = await app.inject({
      method: "POST",
      url: `/api/machines/${machine.id}/ops`,
      headers: владелец(),
      payload: { op: "bash", args: { command: "ls" } },
    });

    expect(вызов.statusCode).toBe(409);
    expect(вызов.json().error).toMatch(/офлайн/i);
  });
});