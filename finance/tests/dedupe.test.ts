import { describe, it, expect } from "vitest";
import { deterministicExternalId } from "../src/lib/dedupe";

describe("deterministicExternalId", () => {
  it("одинаковый вход → одинаковый ключ", () => {
    const a = deterministicExternalId({
      source: "csv",
      accountId: "acc1",
      date: "2026-10-05",
      amount: -100.5,
      description: "кофе",
    });
    const b = deterministicExternalId({
      source: "csv",
      accountId: "acc1",
      date: "2026-10-05",
      amount: -100.5,
      description: "кофе",
    });
    expect(a).toBe(b);
  });

  it("разные суммы → разные ключи", () => {
    const a = deterministicExternalId({
      source: "csv",
      accountId: "acc1",
      date: "2026-10-05",
      amount: -100,
      description: "x",
    });
    const b = deterministicExternalId({
      source: "csv",
      accountId: "acc1",
      date: "2026-10-05",
      amount: -101,
      description: "x",
    });
    expect(a).not.toBe(b);
  });

  it("нормализует пробелы и регистр в описании", () => {
    const a = deterministicExternalId({
      source: "csv",
      accountId: "acc1",
      date: "2026-10-05",
      amount: -100,
      description: "Кофейня",
    });
    const b = deterministicExternalId({
      source: "csv",
      accountId: "acc1",
      date: "2026-10-05",
      amount: -100,
      description: "  кофейня ",
    });
    expect(a).toBe(b);
  });
});