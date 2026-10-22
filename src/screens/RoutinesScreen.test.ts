// Экран «Мои рутины»: подпись правила берётся с сервера, время запуска
// выводится в зоне самой рутины (а не зоне устройства).
//
// Проверяется без поднятия DOM: достаточно чистых функций экрана.

import { describe, it, expect } from "vitest";
import { formatWhen, ruleSummary } from "./routinesFormat";
import type { ApiSchedule } from "../api/schedules";

function makeSchedule(over: Partial<ApiSchedule> = {}): ApiSchedule {
  return {
    id: "s1",
    title: "Ежедневный отчёт",
    task_payload: { title: "Ежедневный отчёт" },
    rule_kind: "weekdays",
    rule_expr: null,
    rule_label: "По будням",
    time_local: "09:00",
    timezone: "Europe/Moscow",
    next_run_at: "2026-10-26T06:00:00.000Z",
    last_run_at: null,
    status: "active",
    catch_up: true,
    overlap_policy: "skip",
    current_task_id: null,
    created_at: "",
    updated_at: "",
    ...over,
  } as ApiSchedule;
}

describe("экран «Мои рутины»", () => {
  it("подпись правила берётся с сервера, а не собирается на клиенте", () => {
    const row = makeSchedule({ rule_label: "По дням: Пн, Пт" });
    expect(ruleSummary(row)).toBe("По дням: Пн, Пт в 09:00");
  });

  it("интервал показывается без лишнего времени запуска", () => {
    const row = makeSchedule({
      rule_kind: "interval",
      rule_expr: "15m",
      rule_label: "Каждые 15 минут",
    });
    expect(ruleSummary(row)).toBe("Каждые 15 минут");
  });

  it("время выводится в зоне рутины, а не в зоне устройства", () => {
    // 26.10.2026 09:00 МСК = 06:00 UTC.
    const msk = formatWhen("2026-10-26T06:00:00.000Z", "Europe/Moscow");
    expect(msk).toContain("09:00");
    // Тот же момент в Нью-Йорке — 02:00.
    const ny = formatWhen("2026-10-26T06:00:00.000Z", "America/New_York");
    expect(ny).toContain("02:00");
  });

  it("пустое значение показывается прочерком, а не «Invalid Date»", () => {
    expect(formatWhen(null, "Europe/Moscow")).toBe("—");
    expect(formatWhen("не дата", "Europe/Moscow")).toBe("—");
  });
});
