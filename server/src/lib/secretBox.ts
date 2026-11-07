// Симметричное шифрование секретов webhook-подписок для durable storage.
// Карточка 905db3e3-…: секрет HMAC обязан переживать restart сервера
// (раньше лежал в `Map<hash,secret>` в памяти процесса и на cold start
// подменялся на предсказуемый `fallback-secret:<hash>`).
//
// Алгоритм: AES-256-GCM через node:crypto (уже в стеке, без новых
// зависимостей). 12-байтовый random nonce, имитовставка 16 байт —
// стандартный выбор для секретов такого размера.
//
// Ключ — 32 байта из `TASKFLOW_WEBHOOK_SECRET_KEY` (base64 или hex),
// генерируется на стороне владельца при первом старте сервера. Если
// ключа нет — конкретные операции (подпись доставки, тест-ручка,
// bootstrap подписок) fail-closed: понятная ошибка наверх, никакого
// `fallback-secret:` (это и был D-1).
//
// Формат контейнера: `v1:<base64(nonce|ciphertext|tag)>` — версия
// нужна, чтобы будущая ротация алгоритма не сломала чтение старых
// строк.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;
let cachedKeyError: Error | null = null;
let warnedMissing = false;

export function getWebhookSecretBoxKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (cachedKeyError) throw cachedKeyError;

  const raw = process.env.TASKFLOW_WEBHOOK_SECRET_KEY;
  if (!raw || raw.length === 0) {
    cachedKeyError = new Error(
      "TASKFLOW_WEBHOOK_SECRET_KEY не задан в окружении; шифрование секретов webhook недоступно. " +
        "Сгенерируйте 32 случайных байта (base64 или hex) и пропишите в .env. " +
        "Без ключа сервер не сможет подписывать доставку, тестовую ручку и bootstrap подписок — fail-closed.",
    );
    throw cachedKeyError;
  }
  // Поддержим оба формата: base64 (по умолчанию) и hex.
  let key: Buffer;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      key = Buffer.from(raw, "hex");
    } else {
      key = Buffer.from(raw, "base64");
    }
  } catch {
    cachedKeyError = new Error(
      `TASKFLOW_WEBHOOK_SECRET_KEY задан, но не парсится как base64/hex (длина=${raw.length})`,
    );
    throw cachedKeyError;
  }
  if (key.length !== 32) {
    cachedKeyError = new Error(
      `TASKFLOW_WEBHOOK_SECRET_KEY имеет длину ${key.length}, ожидается 32 (256 бит)`,
    );
    throw cachedKeyError;
  }
  cachedKey = key;
  return key;
}

/**
 * Сбрасывает кешированный ключ и ошибку. Нужно только для тестов,
 * чтобы перечитать env после явного изменения.
 */
export function __resetWebhookSecretBox(): void {
  cachedKey = null;
  cachedKeyError = null;
  warnedMissing = false;
}

export function encryptWebhookSecret(plain: string): Buffer {
  const key = getWebhookSecretBoxKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([nonce, ct, tag]);
  return Buffer.concat([Buffer.from(`${VERSION}:`, "utf8"), payload]);
}

export function decryptWebhookSecret(blob: Buffer): string {
  const header = blob.subarray(0, 3).toString("utf8");
  if (header !== VERSION + ":") {
    throw new Error(`неизвестная версия секретбокса: ${header || "<empty>"}`);
  }
  const payload = blob.subarray(3);
  if (payload.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error(`повреждённый blob: длина ${payload.length} байт`);
  }
  const nonce = payload.subarray(0, NONCE_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ct = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES);
  const key = getWebhookSecretBoxKey();
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Сообщает в лог один раз за процесс, что ключа нет. Не падает — это
 * сигнал оператору, что конкретные операции (подпись/тест/расшифровка)
 * будут отбиваться до установки ключа.
 */
export function warnMissingKeyOnce(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    "[webhook-secret-box] TASKFLOW_WEBHOOK_SECRET_KEY не задан; " +
      "создание/ротация подписок, подпись доставки и тест-ручка будут fail-closed.",
  );
}