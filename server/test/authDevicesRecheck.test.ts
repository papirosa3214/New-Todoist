import { describe, expect, it } from "vitest";
import { DEVICES_TABLE_RECHECK_MS, devicesCheckSkipped } from "../src/lib/devicesCheck.js";

describe("память о том, что таблицы devices нет", () => {
  it("пока таблица есть, запрос в базу не пропускается никогда", () => {
    expect(devicesCheckSkipped(false, 0, 10_000)).toBe(false);
  });

  it("сразу после ошибки не ходит в базу повторно", () => {
    expect(devicesCheckSkipped(true, 1_000, 1_000)).toBe(true);
    expect(devicesCheckSkipped(true, 1_000, 1_000 + DEVICES_TABLE_RECHECK_MS - 1)).toBe(true);
  });

  it("через окно база спрашивается снова — разовая ошибка не закрывает вход", () => {
    expect(devicesCheckSkipped(true, 1_000, 1_000 + DEVICES_TABLE_RECHECK_MS)).toBe(false);
    expect(devicesCheckSkipped(true, 1_000, 1_000 + 10 * DEVICES_TABLE_RECHECK_MS)).toBe(false);
  });
});
