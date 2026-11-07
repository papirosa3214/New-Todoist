import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { addClient, broadcast, removeClient } from "../src/ws.js";
import { flushWsStream, setWsLogSink } from "../src/lib/wsDeliveryLog.js";

// Журнал отправки событий по сокетам (владелец 06.11.2026): по нему видно,
// дошло ли событие до телефона, а не только что сервер его сохранил.
const lines: string[] = [];
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => { setWsLogSink(null); lines.length = 0; });

it("logs every event: sockets, sent, device-only skipped", () => {
  setWsLogSink((l) => lines.push(l));
  const got: string[] = [];
  const session = { readyState: 1, send: (s: string) => got.push(s) };
  const device = { readyState: 1, send: (s: string) => got.push(s) };
  addClient("u-wslog", session as any);
  addClient("u-wslog", device as any, "dev-wslog");
  broadcast("u-wslog", { type: "task:updated", task: { id: "t-1" } });
  broadcast("u-wslog", { type: "chat:new", chat_id: "c-1", message: { id: "m-1", text: "привет" } });
  expect(got).toHaveLength(2);
  const out = lines.filter((l) => l.startsWith("[ws-out]"));
  expect(out[0]).toContain("user=u-wslog type=task:updated task=t-1 sockets=2 sent=1 device_skipped=1 not_open=0");
  expect(out[1]).toContain("type=chat:new chat=c-1 sockets=2 sent=1 device_skipped=1 not_open=0");
  expect(lines.some((l) => l.includes("[ws-conn]") && l.includes("open user=u-wslog socket=device:dev-wslog"))).toBe(true);
  removeClient("u-wslog", session as any);
  removeClient("u-wslog", device as any);
});

it("logs an event that had nowhere to go", () => {
  setWsLogSink((l) => lines.push(l));
  broadcast("u-nobody", { type: "chat:new", chat_id: "c-2", message: { id: "m-2", text: "x" } });
  expect(lines[0]).toContain("user=u-nobody type=chat:new chat=c-2 sockets=0 sent=0");
});

it("folds stream patches into one line per recipient/type/chat", () => {
  setWsLogSink((l) => lines.push(l));
  const session = { readyState: 1, send: () => {} };
  addClient("u-stream", session as any);
  for (let i = 0; i < 5; i++) broadcast("u-stream", { type: "chats:live:patch", chat_id: "c-3" });
  expect(lines.filter((l) => l.startsWith("[ws-out]"))).toHaveLength(0);
  flushWsStream();
  const out = lines.filter((l) => l.startsWith("[ws-out]"));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("type=chats:live:patch chat=c-3 count=5 sockets=1 sent=5");
  removeClient("u-stream", session as any);
});
