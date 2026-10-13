import { describe, expect, it, vi } from "vitest";

// session.ts тянет за собой БД и next/headers — для проверки чистой разбора
// схемы они не нужны, поэтому заглушаем: иначе импорт создал бы файл БД.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { isSecureProto } from "../src/lib/session";

describe("isSecureProto — флаг Secure по схеме запроса", () => {
  it("http остаётся без Secure", () => {
    expect(isSecureProto("http")).toBe(false);
  });

  it("https получает Secure", () => {
    expect(isSecureProto("https")).toBe(true);
  });

  it("берёт схему исходного клиента из списка прокси", () => {
    expect(isSecureProto("https,http")).toBe(true);
    expect(isSecureProto("http,https")).toBe(false);
  });

  it("не боится регистра и пробелов", () => {
    expect(isSecureProto("HTTPS")).toBe(true);
    expect(isSecureProto(" https ")).toBe(true);
  });

  it("отсутствующий заголовок трактует как небезопасный", () => {
    // Неизвестная схема безопаснее для входа: Secure-cookie на http браузер
    // выбросит и владелец снова останется на форме логина.
    expect(isSecureProto(null)).toBe(false);
    expect(isSecureProto(undefined)).toBe(false);
    expect(isSecureProto("")).toBe(false);
  });
});