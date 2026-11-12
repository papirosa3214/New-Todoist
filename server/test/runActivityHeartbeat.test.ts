// Пока инструмент работает, ход не считается молчащим (08.11.2026).
//
// Дыра, которую это закрывает: сторож тишины считает события, а событие
// приходит только на старте инструмента. 40-минутная сборка iOS обрывалась
// зачисткой на 30-й минуте, хотя всё это время работала.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startActivityHeartbeat } from "../src/runtime/runActivityHeartbeat.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Сердцебиение активности", () => {
  it("бьёт по таймеру, а не один раз", () => {
    vi.useFakeTimers();
    let beats = 0;
    startActivityHeartbeat({ onBeat: () => void (beats += 1), everyMs: 1_000 });
    vi.advanceTimersByTime(3_500);
    expect(beats).toBe(3);
  });

  it("остановка прекращает удары", () => {
    vi.useFakeTimers();
    let beats = 0;
    const stop = startActivityHeartbeat({ onBeat: () => void (beats += 1), everyMs: 1_000 });
    vi.advanceTimersByTime(1_500);
    stop();
    vi.advanceTimersByTime(10_000);
    expect(beats).toBe(1);
  });

  it("падение внутри удара не роняет сердцебиение", () => {
    vi.useFakeTimers();
    let calls = 0;
    startActivityHeartbeat({
      onBeat: () => {
        calls += 1;
        throw new Error("журнал недоступен");
      },
      everyMs: 1_000,
    });
    expect(() => vi.advanceTimersByTime(2_500)).not.toThrow();
    expect(calls).toBe(2);
  });
});
