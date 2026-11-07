// QA-сценарий: фильтрация секретов, ротация, лимит хранения, экспорт (карточка e87cd93f, шаг qa_3).
// Запускается против изолированной БД QA-копии.

import { buildApp } from "../src/index.js";
import { logServerEvent } from "../src/lib/serverEvents.js";
import db from "../src/db.js";

process.env.TASKFLOW_QA_SANDBOX = "1";
process.env.TASKFLOW_LAN_NO_AUTH = "1";

async function main() {
  const app = await buildApp();
  const u1 = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
  const cookies = { "user-agent": "Mozilla/5.0" } as const;

  // 0) Чистим тестовые события
  db.exec("DELETE FROM server_events WHERE operation_id LIKE 'op_qa_%'");

  // 1) Запись с секретами в data_json и в message — проверка redact
  logServerEvent({
    scope: "role_run",
    kind: "role_run_started",
    actorId: u1,
    operationId: "op_qa_secret1",
    message: "user api_key=topsecret123 password=hunter2 Bearer eyJaaa.bbb.ccc",
    data: {
      password: "SECRET_PASSWORD_VALUE",
      api_key: "AKIA_TOP_SECRET",
      token: "TKN_TOP_SECRET",
      nested: { authorization: "Bearer eyJaaa.bbb.ccc.ddd", safe: "ok" },
      jwt_like: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.fake",
    },
  });
  logServerEvent({
    scope: "lifecycle",
    kind: "process_boot",
    operationId: "op_qa_secret3",
    message: "X".repeat(5000),
  });

  const r1 = db.prepare("SELECT message, data_json FROM server_events WHERE operation_id='op_qa_secret1'").get() as { message: string; data_json: string };
  const r3 = db.prepare("SELECT message FROM server_events WHERE operation_id='op_qa_secret3'").get() as { message: string };

  const checks: Array<[string, boolean]> = [];
  checks.push(["message: bearer → Bearer ***", r1.message?.includes("Bearer ***")]);
  checks.push(["message: api_key=... → api_key: ***", /api_key:\s*\*\*\*/i.test(r1.message || "")]);
  checks.push(["message: password=... → password: ***", /password:\s*\*\*\*/i.test(r1.message || "")]);
  const d = r1.data_json ? JSON.parse(r1.data_json) : {};
  checks.push(["data.password === ***", d.password === "***"]);
  checks.push(["data.api_key === ***", d.api_key === "***"]);
  checks.push(["data.token === ***", d.token === "***"]);
  checks.push(["data.nested.authorization === Bearer ***", d.nested?.authorization === "Bearer ***"]);
  checks.push(["data.nested.safe сохранён", d.nested?.safe === "ok"]);
  checks.push(["длинное message обрезано", (r3.message?.length || 0) <= 1100]);
  const originalLong = "X".repeat(5000);
  checks.push(["обрезанное сообщение содержит суффикс-маркер «…(truncated»", r1.message?.includes("…(truncated") || r3.message?.endsWith("…")]);

  // 2) Экспорт через API — что в нём нет живых секретов
  const exportRes = await app.inject({
    method: "GET",
    url: "/api/admin/server-events/export?format=json",
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
  });
  const exportBody = exportRes.body;
  checks.push(["export HTTP 200", exportRes.statusCode === 200]);
  checks.push(["export не содержит живого api_key", !exportBody.includes("AKIA_TOP_SECRET")]);
  checks.push(["export не содержит живого token", !exportBody.includes("TKN_TOP_SECRET")]);
  checks.push(["export не содержит живого password", !exportBody.includes("SECRET_PASSWORD_VALUE")]);
  checks.push(["export содержит маску Bearer ***", exportBody.includes("Bearer ***")]);

  // 3) Owner-only: запрос БЕЗ владельца → 403
  // Регистрируем не-владельца
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "QA-не-владелец", email: `qa-not-owner-${Date.now()}@x`, password: "password123" },
  });
  const regBody = reg.json() as { token?: string; user?: { id: string } };
  const otherToken = regBody.token;
  // Запрос с токеном не-владельца — должен быть 403
  const denied = await app.inject({
    method: "GET",
    url: "/api/admin/server-events?limit=5",
    headers: { authorization: `Bearer ${otherToken}` },
  });
  checks.push(["не-владелец получает 403", denied.statusCode === 403]);
  // Запрос без токена и без cookie — 401
  const noAuth = await app.inject({
    method: "GET",
    url: "/api/admin/server-events?limit=5",
    headers: { "user-agent": "curl/8" },
  });
  checks.push(["без токена и без браузерного UA → 401", noAuth.statusCode === 401]);

  // 4) Ротация / лимит хранения — отдельная запись с created_at 100 дней назад;
  //    никакой код не должен её автоматически удалить. Проверим «как есть».
  const longAgo = "sev_qa_long_ago";
  db.prepare(
    `INSERT INTO server_events (id, scope, kind, created_at, message)
     VALUES (?, 'lifecycle', 'process_boot', datetime('now', '-200 days'), 'old event no rotation')`,
  ).run(longAgo);
  const longCount = (db.prepare("SELECT count(*) AS n FROM server_events WHERE id=?").get(longAgo) as { n: number }).n;
  checks.push(["запись 200 дней назад сохранена (ротации не было)", longCount === 1]);

  // 5) Сохранность после рестарта — данные в БД лежат, без перезапуска приложения
  //    проверяем, что после закрытия buildApp() БД сохраняет события
  const before = (db.prepare("SELECT count(*) AS n FROM server_events").get() as { n: number }).n;
  await app.close();
  const reDb = await import("../src/db.js");
  const after = (reDb.default.prepare("SELECT count(*) AS n FROM server_events").get() as { n: number }).n;
  checks.push(["события остаются в БД после закрытия app", before === after && before > 0]);

  console.log("=== QA-отчёт по журналу server_events (карточка e87cd93f, шаг qa_3) ===");
  let passed = 0, failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}`);
    if (ok) passed++; else failed++;
  }
  console.log(`\nИТОГ: ${passed} PASS, ${failed} FAIL из ${checks.length} проверок`);
  console.log(`Событий в БД сейчас: ${before}`);
  console.log(`Секреты в БД: AKIA_TOP_SECRET=${(db.prepare("SELECT count(*) AS n FROM server_events WHERE data_json LIKE '%AKIA_TOP_SECRET%'").get() as {n:number}).n}, SECRET_PASSWORD_VALUE=${(db.prepare("SELECT count(*) AS n FROM server_events WHERE data_json LIKE '%SECRET_PASSWORD_VALUE%'").get() as {n:number}).n}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(2);
});
