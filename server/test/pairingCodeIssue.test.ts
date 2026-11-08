// Выдача кода привязки — одна точка для HTTP-маршрута и для команды на
// сервере (scripts/pairing-code.ts). Проверяем то, чем эта точка обещает
// быть: в базе только sha256, код живёт 5 минут, прежний неиспользованный
// гаснет, в QR нет ничего кроме адреса и кода.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { hashApiToken, migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  issuePairingCode,
  issuedCodesLastHour,
  pairingQrUri,
  PAIRING_CODE_BYTES,
  PAIRING_CODE_TTL_MS,
} from "../src/lib/pairingCodes.js";

const OWNER = "u-pair-cli-test";

describe("Код привязки: выдача без HTTP-входа", () => {
  // Схему поднимаем сами: файл не поднимает сервер (`buildApp`), а без
  // миграций в тестовой базе нет ни users, ни pairing_codes.
  beforeAll(() => {
    migrate();
    runMigrations();
  });

  const user = () => db.prepare("SELECT id FROM users WHERE id = ?").get(OWNER);
  const codes = () =>
    db
      .prepare("SELECT code_hash, created_at, expires_at, used_at, source_ip FROM pairing_codes WHERE created_by = ? ORDER BY created_at")
      .all(OWNER) as Array<{ code_hash: string; created_at: string; expires_at: string; used_at: string | null; source_ip: string | null }>;

  beforeEach(() => {
    db.prepare("DELETE FROM pairing_codes WHERE created_by = ?").run(OWNER);
    db.prepare("DELETE FROM users WHERE id = ?").run(OWNER);
    db.prepare(
      "INSERT INTO users(id, name, email, password_hash, role, type, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(OWNER, "Максим", "pair-cli@test.local", "x", "owner", "human", new Date().toISOString());
  });

  it("кладёт в базу только sha256 и выдаёт 128 бит энтропии", () => {
    const { code } = issuePairingCode(OWNER, "cli");
    expect(code).toMatch(new RegExp(`^[0-9a-f]{${PAIRING_CODE_BYTES * 2}}$`));

    const rows = codes();
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toBe(hashApiToken(code));
    expect(rows[0].code_hash).not.toBe(code);
    expect(rows[0].used_at).toBeNull();
    expect(rows[0].source_ip).toBe("cli");
  });

  it("даёт коду ровно пять минут жизни", () => {
    const { expiresAt } = issuePairingCode(OWNER, "cli");
    const живёт = Date.parse(expiresAt) - Date.now();
    expect(Math.abs(живёт - PAIRING_CODE_TTL_MS)).toBeLessThan(5_000);
  });

  it("гасит прежний неиспользованный код: действующий QR всегда один", () => {
    const первый = issuePairingCode(OWNER, "cli");
    // Время в базе — ISO-строка с миллисекундами, и два кода подряд могут
    // попасть в одну миллисекунду: ищем строки по хешу, а не по порядку.
    const второй = issuePairingCode(OWNER, "cli");

    const rows = codes();
    expect(rows).toHaveLength(2);
    const поХешу = new Map(rows.map(row => [row.code_hash, row]));
    expect(поХешу.get(hashApiToken(первый.code))?.used_at).not.toBeNull();
    expect(поХешу.get(hashApiToken(второй.code))?.used_at).toBeNull();
  });

  it("считает выписанные коды за час — по ним живёт лимит маршрута", () => {
    issuePairingCode(OWNER, "cli");
    issuePairingCode(OWNER, "cli");
    expect(issuedCodesLastHour(OWNER)).toBe(2);
  });

  it("собирает ссылку для QR без пароля и с адресом в поле host", () => {
    expect(pairingQrUri("abc123", "192.168.1.110:3001")).toBe(
      "taskflow://pair?v=1&code=abc123&host=192.168.1.110%3A3001",
    );
    expect(pairingQrUri("abc123", "")).toBe("taskflow://pair?v=1&code=abc123&host=");
  });
});
