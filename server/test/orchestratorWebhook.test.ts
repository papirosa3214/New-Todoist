// Вебхук оркестратора (владелец 06.10.2026): важные события кладутся в очередь,
// доставляются пачкой в зарегистрированный приёмник с токеном, без приёмника
// ждут, повтор доставки не дублирует, слишком старые не доставляются.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { FastifyInstance } from "fastify";

const hook = vi.hoisted(() => {
  const file = `/tmp/orchestrator-hook-test-${process.pid}.json`;
  process.env.TASKFLOW_ORCHESTRATOR_HOOK_FILE = file;
  return { file };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { logEvent } from "../src/agentState.js";
import { deliverOrchestratorEvents, queueOrchestratorEvent } from "../src/lib/orchestratorWebhook.js";

let app: FastifyInstance;
let taskId: string;
let received: any[] = [];
let server: http.Server;
let port = 0;
const TOKEN = "test-token-123";

beforeAll(async () => {
  app = await buildApp();
  taskId = `hook-task-${process.pid}`;
  db.prepare("INSERT OR IGNORE INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Тестовая карточка вебхука");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end(); return; }
      received.push(JSON.parse(body));
      res.statusCode = 200; res.end("ok");
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
});
afterAll(async () => {
  server.close();
  try { fs.unlinkSync(hook.file); } catch { /* нет файла */ }
  await app.close();
});
beforeEach(() => {
  db.prepare("DELETE FROM orchestrator_events").run();
  received = [];
  try { fs.unlinkSync(hook.file); } catch { /* нет файла */ }
});
const register = (token = TOKEN) =>
  fs.writeFileSync(hook.file, JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, token, pid: process.pid }));
const pending = () => db.prepare("SELECT count(*) n FROM orchestrator_events WHERE delivered_at IS NULL").get() as { n: number };

describe("очередь событий для оркестратора", () => {
  it("важный вид события попадает в очередь через logEvent, неважный нет", () => {
    logEvent({ taskId, actorId: null, kind: "step_outcome", field: "executor", toValue: "{\"outcome\":\"succeeded\"}" });
    logEvent({ taskId, actorId: null, kind: "description_changed" });
    const rows = db.prepare("SELECT kind FROM orchestrator_events").all() as { kind: string }[];
    expect(rows.map(r => r.kind)).toEqual(["step_outcome"]);
  });

  it("без приёмника события ждут и не теряются", async () => {
    queueOrchestratorEvent({ taskId, kind: "review_recorded", toValue: "2:approved" });
    const r = await deliverOrchestratorEvents();
    expect(r.skipped).toBe("no_receiver");
    expect(pending().n).toBe(1);
  });

  it("с приёмником: пачка уходит с токеном, события помечаются доставленными, повтора нет", async () => {
    queueOrchestratorEvent({ taskId, kind: "step_outcome", field: "qa", toValue: "x" });
    queueOrchestratorEvent({ taskId, kind: "review_recorded", toValue: "1:approved" });
    register();
    const r = await deliverOrchestratorEvents();
    expect(r.sent).toBe(2);
    expect(received).toHaveLength(1);
    expect(received[0].events.map((e: any) => e.kind)).toEqual(["step_outcome", "review_recorded"]);
    expect(pending().n).toBe(0);
    const again = await deliverOrchestratorEvents();
    expect(again.sent).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("неверный токен: приёмник отказал, события остаются в очереди", async () => {
    queueOrchestratorEvent({ taskId, kind: "step_outcome", toValue: "x" });
    register("чужой-токен");
    const r = await deliverOrchestratorEvents();
    expect(r.skipped).toBe("failed");
    expect(pending().n).toBe(1);
  });

  it("мёртвый приёмник (процесса из реестра нет) считается отсутствующим", async () => {
    queueOrchestratorEvent({ taskId, kind: "step_outcome", toValue: "x" });
    fs.writeFileSync(hook.file, JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, token: TOKEN, pid: 999999 }));
    const r = await deliverOrchestratorEvents();
    expect(r.skipped).toBe("no_receiver");
  });

  it("события старше часа не доставляются, а помечаются просроченными", async () => {
    queueOrchestratorEvent({ taskId, kind: "step_outcome", toValue: "старое" });
    db.prepare("UPDATE orchestrator_events SET created_at = datetime('now','-2 hours')").run();
    register();
    const r = await deliverOrchestratorEvents();
    expect(r.sent).toBe(0);
    expect(received).toHaveLength(0);
    const row = db.prepare("SELECT expired FROM orchestrator_events").get() as { expired: number };
    expect(row.expired).toBe(1);
  });
});
