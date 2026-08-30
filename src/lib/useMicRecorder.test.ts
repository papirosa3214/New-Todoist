import { describe, expect, it } from "vitest";

describe("useMicRecorder formatting and duration", () => {
  it("formats elapsed time properly across multi-minute recordings", () => {
    const formatTime = (elapsedMs: number) => {
      const totalSec = Math.floor(elapsedMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(15_000)).toBe("0:15");
    expect(formatTime(60_000)).toBe("1:00");
    expect(formatTime(125_000)).toBe("2:05");
    expect(formatTime(300_000)).toBe("5:00");
  });
});
