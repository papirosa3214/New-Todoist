// Повисший держатель слота (поток модели оборвался, completion не
// разрешился) больше не блокирует шаг навсегда: forceReleaseSlotSession
// отпускает слот, и следующий acquire проходит. Карточка caecdeee, 15.10.2026.
import { describe, it, expect } from "vitest";
import { acquireSlotSession, forceReleaseSlotSession, isSlotSessionHeld } from "../src/runtime/slotSession.js";

describe("slot session force release", () => {
  it("повисший держатель не блокирует следующего после forceRelease", async () => {
    const id = "test-slot-" + Math.random();
    await acquireSlotSession(id); // держатель так и не отпустит
    expect(isSlotSessionHeld(id)).toBe(true);
    const blocked = new AbortController();
    setTimeout(() => blocked.abort(new Error("занято")), 50);
    await expect(acquireSlotSession(id, blocked.signal)).rejects.toThrow("занято");
    expect(forceReleaseSlotSession(id)).toBe(true);
    const release = await acquireSlotSession(id);
    release();
    expect(isSlotSessionHeld(id)).toBe(false);
  });
});
