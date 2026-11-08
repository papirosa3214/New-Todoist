/**
 * Одноразовый код привязки телефона — одна точка выдачи.
 *
 * Зовут двое: HTTP-маршрут `POST /api/pairing/code` (уже вошедший владелец) и
 * команда на сервере `scripts/pairing-code.ts` (терминал на .110).
 *
 * Зачем терминалу отдельная дверь: вход без пароля из домашней сети выключен
 * 08.11.2026, а код в HTTP выдаёт только тот, кто уже вошёл. Стоит токену
 * устройства пропасть (переустановка приложения, выход, 401 с очисткой
 * связки ключей) — и выписать QR нечем, остаётся пароль. Команда работает с
 * базой напрямую, под пользователем сервера, то есть требует физического
 * доступа к машине и ничего не открывает в сети.
 *
 * Правила те же, что обещает документ решения (§5, §10 п.2, §11.1): в базе
 * только sha256, код одноразовый и живёт 5 минут, действующий QR один.
 */
import crypto from "node:crypto";
import db, { hashApiToken } from "../db.js";

/** Срок жизни кода — 5 минут (документ решения §5). */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
/** 128 бит энтропии = 32 hex-символа. */
export const PAIRING_CODE_BYTES = 16;
/** Сколько кодов один человек может выписать в час. */
export const PAIRING_CODE_LIMIT_PER_HOUR = 10;

/** Ссылка внутри QR: только адрес и код, пароля в схеме нет вовсе (§10 п.2). */
export function pairingQrUri(code: string, host: string): string {
  return `taskflow://pair?v=1&code=${code}&host=${encodeURIComponent(host)}`;
}

export type IssuedPairingCode = { code: string; expiresAt: string };

/**
 * Выписать код и погасить прежний неиспользованный: на экране всегда ровно
 * один действующий QR. Открытое значение живёт только в возврате функции —
 * в базу уходит хеш.
 */
export function issuePairingCode(
  createdBy: string,
  sourceIp: string | null,
): IssuedPairingCode {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE pairing_codes SET used_at = ? WHERE created_by = ? AND used_at IS NULL",
  ).run(now, createdBy);

  const code = crypto.randomBytes(PAIRING_CODE_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO pairing_codes(id, code_hash, created_by, created_at, expires_at, used_at, source_ip) VALUES (?,?,?,?,?,NULL,?)",
  ).run(crypto.randomUUID(), hashApiToken(code), createdBy, now, expiresAt, sourceIp);

  return { code, expiresAt };
}

/** Сколько кодов выписано за последний час — по этому числу живёт лимит. */
export function issuedCodesLastHour(createdBy: string): number {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM pairing_codes WHERE created_by = ? AND created_at > ?",
    )
    .get(createdBy, hourAgo) as { n: number } | undefined;
  return row?.n ?? 0;
}
