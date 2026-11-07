// Ротация счётчика расхода моделей (24.10.2026, аудит качества данных).
//
// Проверяется поведение, а не «функция вернула число»:
//  - протухшие строки удаляются;
//  - живая (в окне отчёта) строка остаётся;
//  - самая ранняя строка по каждой паре (provider, model) НЕ удаляется —
//    иначе «учёт с» (trackingSince = min(occurred_at)) сдвинулся бы и
//    владелец увидел бы неверную дату начала наблюдения за расходом.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { ensureModelUsageSchema } from "../src/lib/modelUsage.js";
import { pruneModelUsage } from "../src/lib/modelUsageRetention.js";

function строка(
  id: string,
  provider: string,
  model: string,
  daysAgo: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO model_usage
       (id, occurred_at, provider, model, input_tokens, output_tokens,
        cache_read, cache_write, estimated_cost_usd, source)
     VALUES (?, datetime('now', ?), ?, ?, 10, 5, 0, 0, 0.01, 'test')`,
  ).run(id, `-${daysAgo} days`, provider, model);
}

describe("ротация счётчика расхода моделей", () => {
  beforeAll(() => {
    migrate();
    runMigrations();
    ensureModelUsageSchema();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM model_usage WHERE id LIKE 'rot-%'").run();
  });

  it("удаляет протухшие строки и оставляет живые", () => {
    строка("rot-old-1", "testprov", "testmodel", 90);
    строка("rot-old-2", "testprov", "testmodel", 60);
    строка("rot-fresh-1", "testprov", "testmodel", 3);

    pruneModelUsage(30);

    const остались = db
      .prepare("SELECT id FROM model_usage WHERE id LIKE 'rot-%' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(остались.map((r) => r.id)).toEqual(["rot-fresh-1"]);
  });

  it("НЕ удаляет самую раннюю строку по паре (provider, model) — иначе сдвинулся бы «учёт с»", () => {
    строка("rot-anchor", "testprov", "testmodel", 200);

    pruneModelUsage(30);

    const якорь = db
      .prepare("SELECT id FROM model_usage WHERE id = 'rot-anchor'")
      .get() as { id: string } | undefined;
    expect(якорь, "ранняя строка по паре удалена — trackingSince сдвинется").toBeTruthy();
  });

  it("чистит каждую пару отдельно", () => {
    строка("rot-a-old", "provA", "modelA", 90);
    строка("rot-a-new", "provA", "modelA", 5);
    строка("rot-b-only", "provB", "modelB", 90);

    pruneModelUsage(30);

    const остались = db
      .prepare("SELECT id FROM model_usage WHERE id LIKE 'rot-%' ORDER BY id")
      .all() as Array<{ id: string }>;
    // Пара provB/modelB имеет единственную (старую) строку — она якорь.
    expect(остались.map((r) => r.id)).toEqual(["rot-a-new", "rot-b-only"]);
  });

  it("повторный запуск ничего не удаляет (идемпотентно)", () => {
    строка("rot-idem-1", "testprov", "testmodel", 90);
    строка("rot-idem-2", "testprov", "testmodel", 80);

    const первый = pruneModelUsage(30);
    const второй = pruneModelUsage(30);

    expect(первый).toBe(1);
    expect(второй).toBe(0);
  });
});
