import { describe, expect, it } from "vitest";
import { clockLine } from "../src/lib/clockLine.js";

describe("Текущее время для ролей", () => {
  it("московское время и пометка про UTC в данных", () => {
    const line = clockLine(new Date("2026-10-14T13:22:00Z"));
    expect(line).toContain("14.10.2026");
    expect(line).toContain("16:22 по Москве");
    expect(line).toContain("в UTC");
  });
});
