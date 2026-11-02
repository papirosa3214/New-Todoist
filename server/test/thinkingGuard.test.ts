// Сторож повторяющихся рассуждений (владелец 02.11.2026): «если рассуждения
// повторяется, вообще выбрасывать и говорить… подсказку давать, что план
// есть, действуй».
import { describe, expect, it } from "vitest";
import {
  isRepeatedThought,
  THINKING_REPEAT_NUDGE,
  ThinkingGuard,
} from "../src/runtime/thinkingGuard.js";

const THINK_A =
  "I keep looking at the same files. The check is done. Maybe the answer is in the migration. " +
  "The plan says the third step is the summary, but I am still verifying. Decision: read the migration file.";

const THINK_B =
  "Still the same files, nothing new. The check is done. Perhaps the answer is in the migration. " +
  "The plan says the third step is the summary, but I am still verifying. Decision: read the migration file.";

const THINK_OTHER =
  "Now the ports are checked, the diff is reviewed, and the targeted test passed in the worktree. " +
  "Next: run the comparison against the main baseline and record the numbers.";

describe("повтор рассуждений", () => {
  it("одинаковый хвост — повтор", () => {
    expect(isRepeatedThought(THINK_B, THINK_A)).toBe(true);
  });

  it("другая мысль — не повтор", () => {
    expect(isRepeatedThought(THINK_OTHER, THINK_A)).toBe(false);
  });

  it("без предыдущей мысли повтора нет", () => {
    expect(isRepeatedThought(THINK_A, null)).toBe(false);
  });

  it("сторож отдаёт подсказку на втором повторе подряд", () => {
    const guard = new ThinkingGuard(2);
    expect(guard.observe(THINK_A)).toBeNull();
    expect(guard.observe(THINK_B)).toBe(THINKING_REPEAT_NUDGE);
    // После подсказки счётчик сброшен: та же мысль снова не кричит.
    expect(guard.observe(THINK_B)).toBeNull();
  });

  it("подсказка говорит действовать, а не думать дальше", () => {
    expect(THINKING_REPEAT_NUDGE).toMatch(/ДЕЙСТВУЙ/);
    expect(THINKING_REPEAT_NUDGE).toMatch(/план/i);
  });
});
