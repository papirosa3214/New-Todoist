import crypto from "node:crypto";

/** Отпечаток тела ответа (ETag).
 *
 * Считается по САМОМУ телу, а не по строкам базы: список показывает
 * счётчики, последнее сообщение и превью — всё это меняется без правки
 * строк. Отпечаток ответа честен по определению: тот же ответ — тот же
 * отпечаток, другой — другой.
 *
 * `salt` — соль по вызывающему (id пользователя или id сессии агента):
 * тело списка у разных людей может совпадать, а без соли один клиент
 * получил бы 304 по чужому отпечатку и не увидел бы своих данных.
 */
export function etagFor(body: string, salt: string | null): string {
  const hash = crypto.createHash("sha1").update(body).digest("hex").slice(0, 16);
  return `W/"${hash}-${salt ?? ""}"`;
}

/** Сравнение ETag по правилам HTTP: список значений и слабая форма `W/""`. */
export function etagMatches(header: string, etag: string): boolean {
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  const target = strip(etag);
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || strip(value) === target);
}
