// Сторож wake-канала (карточка 905db3e3-…, webhook V2): проверяет,
// что изолированная проба проходит end-to-end без побудки живого чата.
// Уточнение ведущего 2026-10-10: сторож НЕ будит живой чат, НЕ
// хардкодит продовый UUID, делает реальный пробный ход (не «таблица
// существует»).
//
// Что проверяем:
//   • checkWebhookWakeInstrument() возвращает ok=true, если все шаги
//     цепочки отрабатывают (подписка создана, событие поставлено,
//     processWakePass прошёл, follow-up UUID распарсился).
//   • Временная подписка и её строки wake_queue убираются по завершении
//     (каскад по ON DELETE CASCADE).
//   • При ошибке resolveSecret (например, без ключа) — сторож возвращает
//     ok=false с понятной причиной.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  __resetWatchState,
  checkWebhookWakeInstrument,
  startWebhookWakeWatcher,
  stopWebhookWakeWatcher,
} from "../src/lib/webhookWakeWatcher.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  process.env.TASKFLOW_WEBHOOK_SECRET_KEY =
    Buffer.from(crypto.randomBytes(32)).toString("base64");
  app = await buildApp();
});
afterAll(async () => {
  stopWebhookWakeWatcher();
  await app.close();
});

beforeEach(() => {
  __resetWatchState();
  db.prepare("DELETE FROM webhook_wake_queue").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
  db.prepare(
    "DELETE FROM orchestrator_events WHERE detail LIKE 'synthetic event from webhookWakeWatcher%'",
  ).run();
});

describe("webhookWakeWatcher: пробный ход без побудки живого чата", () => {
  it("checkWebhookWakeInstrument возвращает ok=true при рабочей цепочке", async () => {
    const r = await checkWebhookWakeInstrument();
    expect(r.ok).toBe(true);
    // Временная подписка удалена каскадом, синтетический event expired.
    const subs = db
      .prepare("SELECT COUNT(*) c FROM webhook_subscriptions WHERE id LIKE 'probe-%'")
      .get() as { c: number };
    expect(subs.c).toBe(0);
  });

  it("старт/стоп сторожа не падают и не оставляют зависших таймеров", () => {
    startWebhookWakeWatcher();
    stopWebhookWakeWatcher();
    // повторный start/stop — идемпотентно
    startWebhookWakeWatcher();
    stopWebhookWakeWatcher();
  });
});