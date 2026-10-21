// Короткая аренда слота (карточка c8083c2a, раздел И4 отчёта
// docs/2026-10-21-agent-speed-budget.md): слот освобождается по молчанию хода,
// а не держится вечно потерянной записью о занятости. Прецедент 15.10.2026,
// карточка caecdeee: /restart отвечал «Сессия слота занята», пока не
// перезапустили сервер.
import { describe, it, expect, beforeEach } from "vitest";
import { acquireSlotSession, isSlotSessionHeld, forceReleaseSlotSession } from "../src/runtime/slotSession.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slot = "slot-lease-test";

beforeEach(() => {
  forceReleaseSlotSession(slot);
  process.env.TASKFLOW_SLOT_LEASE_WAIT_MS = "40";
});

describe("аренда слота", () => {
  it("живой держатель: второй ход ждёт его, а не забирает слот", async () => {
    let alive = true;
    const release = await acquireSlotSession(slot, undefined, () => alive);
    expect(isSlotSessionHeld(slot)).toBe(true);
    let acquired = false;
    const second = acquireSlotSession(slot, undefined, () => alive).then(() => {
      acquired = true;
    });
    await wait(150);
    expect(acquired).toBe(false);
    alive = false;
    release();
    await second;
    expect(acquired).toBe(true);
  });

  it("потерянная аренда: живого хода нет — слот забирается, а не висит", async () => {
    // Держатель «умер»: он не отпустил слот, и живого запуска по нему нет.
    await acquireSlotSession(slot, undefined, () => false);
    const started = Date.now();
    const release = await acquireSlotSession(slot, undefined, () => false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(release).toBeTypeOf("function");
  });

  it("отмена ожидания по сигналу не оставляет слот занятым собой", async () => {
    const controller = new AbortController();
    const release = await acquireSlotSession(slot, undefined, () => true);
    const pending = acquireSlotSession(slot, controller.signal, () => true);
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    release();
    forceReleaseSlotSession(slot);
  });
});
