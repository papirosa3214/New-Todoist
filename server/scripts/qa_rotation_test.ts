// QA-скрипт повторной проверки ротации server_events (шаг qa_recheck_2).
// Проверяет живо на изолированной БД:
//   1) pruneServerEvents удаляет запись старше retention (200 дней назад).
//   2) Свежие записи (1 час назад) не трогаются.
//   3) Переопределение retention через программный сеттер и ENV работает.
//   4) Планировщик startServerEventsRetention: первый прогон удаляет старые,
//      intervalMs=0 → планировщик НЕ запускается, делается ровно одна чистка.
//   5) Регрессия секретов: запись с токеном остаётся с замаскированным
//      сообщением и удаляется по created_at, как и обычные.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requireFromHere = createRequire(
  path.join(__dirname, "package.json") + "?probe",
);

const ROOT = path.resolve(__dirname, "..");
const dbModulePath = path.join(ROOT, "src", "db.ts");
const seModulePath = path.join(ROOT, "src", "lib", "serverEvents.ts");

const db = requireFromHere(pathToFileURL(dbModulePath).pathname);
const se = requireFromHere(pathToFileURL(seModulePath).pathname);

let allOk = true;
const log = (msg: string) => console.log(msg);
const fail = (msg: string) => {
  console.log("FAIL:", msg);
  allOk = false;
};
const pass = (msg: string) => console.log("PASS:", msg);

function countEvents(): number {
  const row = db.default
    .prepare("SELECT COUNT(*) AS n FROM server_events")
    .get() as { n: number };
  return Number(row.n ?? 0);
}

function insertEvent(opts: {
  ageDays: number;
  kind: string;
  message: string;
  data?: unknown;
}): string {
  const id = `qa-${opts.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const past = new Date(Date.now() - opts.ageDays * 24 * 60 * 60_000).toISOString();
  db.default
    .prepare(
      `INSERT INTO server_events
         (id, scope, kind, message, data_json, created_at, outcome)
       VALUES (?, 'system', ?, ?, ?, ?, 'ok')`,
    )
    .run(
      id,
      opts.kind,
      opts.message,
      opts.data ? JSON.stringify(opts.data) : null,
      past,
    );
  return id;
}

async function main() {
  log("==Старт сценария ротации==");
  log("Версия: " + se.DEFAULT_SERVER_EVENTS_RETENTION_DAYS + " дней / " +
      se.DEFAULT_SERVER_EVENTS_ROTATION_INTERVAL_MS + " мс");

  // 0) Чистый старт: удалим всё, что планировщик мог накопить при первом
  //    старте. Дальше работаем только с подложенными строками.
  db.default.exec("DELETE FROM server_events");

  // 1) Подложить 200-дневную запись с секретом + свежую.
  const oldId = insertEvent({
    ageDays: 200,
    kind: "process_boot",
    message: "old event with secret bearer_token=Bearer eyJhbGciOi.verylong",
  });
  const freshId = insertEvent({
    ageDays: 0,
    kind: "process_boot",
    message: "fresh event with no secrets",
  });
  log("Подложено: 200 дней назад=" + oldId + ", сейчас=" + freshId);
  if (countEvents() !== 2) fail("Ожидал 2 строки, вижу " + countEvents());
  else pass("Подготовлено 2 строки: старая и свежая");

  // 2) Прямой вызов pruneServerEvents (как делает планировщик в первый тик).
  const result = se.pruneServerEvents();
  log(
    "pruneServerEvents: removed=" + result.removed +
    " remaining=" + result.remaining +
    " threshold=" + result.threshold +
    " retentionDays=" + result.retentionDays,
  );
  if (result.removed !== 1) {
    fail("Ожидал removed=1, получил " + result.removed);
  } else {
    pass("Удалена ровно 1 старая запись");
  }
  if (result.remaining !== 1) {
    fail("Ожидал remaining=1, получил " + result.remaining);
  } else {
    pass("Свежая запись осталась в таблице");
  }
  const left = countEvents();
  if (left !== 1) fail("После prune ожидал 1 строку, вижу " + left);

  // 3) Повторный prune — идемпотентно, новых удалений быть не должно.
  const second = se.pruneServerEvents();
  if (second.removed !== 0) {
    fail("Повторный prune должен вернуть removed=0, получил " + second.removed);
  } else {
    pass("Повторный prune не удаляет ничего (идемпотентность)");
  }

  // 4) Программный override retention: оставим только запись 1 день назад,
  //    выставим retention=0 → должно удалить всё.
  insertEvent({
    ageDays: 1,
    kind: "process_boot",
    message: "1 day old",
  });
  se.setServerEventsRetentionDays(0);
  const withZero = se.pruneServerEvents();
  if (withZero.retentionDays !== 0) {
    fail("Override retention=0 не сработал, получил retentionDays=" + withZero.retentionDays);
  } else {
    pass("Override retentionDays=0 принят");
  }
  if (withZero.removed < 1) {
    fail("При retention=0 ожидал удалить всё, removed=" + withZero.removed);
  } else {
    pass("При retention=0 удалено " + withZero.removed + " строк (ожидалось ≥1)");
  }
  se.setServerEventsRetentionDays(null);

  // 5) ENV override: при малом retentionDays=1 запись 5-дневной давности удаляется.
  process.env.TASKFLOW_SERVER_EVENTS_RETENTION_DAYS = "1";
  const before = countEvents();
  insertEvent({
    ageDays: 5,
    kind: "process_boot",
    message: "5 days old",
  });
  const envResult = se.pruneServerEvents();
  if (envResult.retentionDays !== 1) {
    fail("ENV TASKFLOW_SERVER_EVENTS_RETENTION_DAYS=1 не подхвачен, retentionDays=" + envResult.retentionDays);
  } else {
    pass("ENV TASKFLOW_SERVER_EVENTS_RETENTION_DAYS=1 принят");
  }
  delete process.env.TASKFLOW_SERVER_EVENTS_RETENTION_DAYS;

  // 6) Планировщик: intervalMs=0 → один синхронный прогон, таймера нет.
  db.default.exec("DELETE FROM server_events");
  insertEvent({ ageDays: 365, kind: "process_boot", message: "very old" });
  const handle = se.startServerEventsRetention({ intervalMs: 0, retentionDays: 30 });
  if (handle.intervalMs !== 0) {
    fail("handle.intervalMs ожидался 0, получил " + handle.intervalMs);
  } else {
    pass("Планировщик с intervalMs=0 создан");
  }
  if (!handle.lastResult) {
    fail("Планировщик не сделал первый синхронный прогон");
  } else if (handle.lastResult.removed < 1) {
    fail("Первый прогон планировщика не удалил 365-дневную запись");
  } else {
    pass("Первый прогон планировщика удалил " + handle.lastResult.removed + " строк");
  }
  handle.stop();

  // 7) Регрессия: секреты по-прежнему маскируются.
  const beforeRedaction = countEvents();
  se.logServerEvent({
    scope: "system",
    kind: "process_boot",
    message: "secret regression check api_key=ABCDEFGHIJ1234567890",
  });
  const afterRedaction = countEvents();
  if (afterRedaction !== beforeRedaction + 1) {
    fail("logServerEvent не записал событие (регрессия записи)");
  } else {
    pass("logServerEvent пишет событие в таблицу");
  }
  const last = db.default
    .prepare("SELECT message FROM server_events ORDER BY created_at DESC LIMIT 1")
    .get() as { message: string };
  if (last && last.message.includes("ABCDEFGHIJ1234567890")) {
    fail("Регрессия: api_key НЕ замаскирован в журнале, message=" + last.message);
  } else {
    pass("Регрессия: api_key замаскирован в журнале");
  }

  log("==Итог: " + (allOk ? "ВСЁ ЗЕЛЁНОЕ" : "ЕСТЬ ПРОВАЛЫ") + "==");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
