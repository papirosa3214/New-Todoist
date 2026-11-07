// Интеграционная проверка серверного журнала (карточка e87cd93f):
//   -5xx ответ маршрута пишет строку в журнал;
//   - 4xx — НЕ пишет (это нормальная работа, а не сбой);
//   - onError-хук ловит throw внутри маршрута и пишет в журнал.
// Через тот же buildApp, что и остальные тесты — нет реального сетевого
// стека, но Fastify поднимается полностью (до первого listen).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe("журнал при 5xx-ответе Fastify маршрута", () => {
  it("пишет route_error в общий журнал с request_id и url", async () => {
    // Маршрут, который намеренно кидает 500 — нужно завести временный
    // маршрут с уникальным путём, чтобы не задеть существующие хендлеры.
    app.get(
      "/api/__server_journal_test_500__",
      async () => {
        throw new Error("boom for journal");
      },
    );

    db.exec(
      "DELETE FROM server_events WHERE message LIKE '%server_journal_test_500%' OR data_json LIKE '%server_journal_test_500%'",
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/__server_journal_test_500__",
      headers: { "x-request-id": "journal-it-1" },
    });
    expect(res.statusCode).toBe(500);

    const row = db
      .prepare(
        `SELECT scope, kind, outcome, data_json
           FROM server_events
          WHERE message LIKE '%server_journal_test_500%'
             OR data_json LIKE '%journal-it-1%'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as
      | {
          scope: string;
          kind: string;
          outcome: string | null;
          data_json: string;
        }
      | undefined;
    // Fastify в onError ставит мой код; при Fastify 5 встроенный обработчик
    // заменяет тело на "{"error":"Internal Server Error"}" без нашего
    // префикса в message, но data_json всё равно должен содержать url.
    expect(row?.kind).toMatch(/route_(error|throw)/);
    expect(row?.scope).toBe("http_error");
    expect(row?.data_json).toContain("journal-it-1");
    expect(row?.data_json).toContain("server_journal_test_500");
  });

  it("4xx-ответ обычной 404 не пишется в журнал", async () => {
    db.exec(
      "DELETE FROM server_events WHERE message LIKE '%api/no-such-%' OR data_json LIKE '%api/no-such-%'",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/no-such-route-journal",
    });
    expect(res.statusCode).toBe(404);
    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM server_events WHERE data_json LIKE '%no-such-route-journal%'",
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});
