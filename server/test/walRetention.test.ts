import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, statSync, rmSync } from "node:fs";
import db from "../src/db.js";
import { truncateWal } from "../src/lib/dataRetention.js";

// WAL-файл SQLite не усекается сам: кадры перезаписываются с начала, но
// файл остаётся размером, каким вырос. У нас главная причина — VACUUM в
// выкладке: он переписывает всю базу в WAL (28.10.2026 — WAL 175 МБ при
// базе 174 МБ, живых страниц единицы).
//
// Здесь проверяем сам механизм усечения: после truncateWal() файл WAL
// пустой, а данные на месте. Тест работает на временной БД (setup.ts
// поднимает её в tmp), боевую не трогает.
describe("усечение WAL", () => {
  const wal = `${db.name}-wal`;
  const table = "wal_truncate_probe";

  beforeEach(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, payload TEXT)`);
  });

  afterEach(() => {
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch {
      // таблицы может не быть — не страшно
    }
  });

  it("обрезает WAL-файл до нуля", () => {
    // Много данных, чтобы WAL распух заведомо больше нуля.
    const insert = db.prepare(`INSERT INTO ${table} (payload) VALUES (?)`);
    const blob = "x".repeat(4096);
    db.transaction(() => {
      for (let i = 0; i < 400; i++) insert.run(blob);
    })();
    const sizeBefore = existsSync(wal) ? statSync(wal).size : 0;

    truncateWal();

    const sizeAfter = existsSync(wal) ? statSync(wal).size : 0;
    expect(sizeBefore).toBeGreaterThan(0);
    expect(sizeAfter).toBe(0);
  });

  it("данные после усечения на месте", () => {
    db.prepare(`INSERT INTO ${table} (payload) VALUES (?)`).run("до усечения");
    truncateWal();
    const row = db.prepare(`SELECT payload FROM ${table}`).get() as { payload: string };
    expect(row.payload).toBe("до усечения");
  });

  it("усечение пустого WAL безвредно", () => {
    expect(() => truncateWal()).not.toThrow();
    expect(truncateWal()).toBeGreaterThanOrEqual(0);
  });
});
