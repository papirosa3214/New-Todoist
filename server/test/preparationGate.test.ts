// Когда подготовка плана мешает утвердить план (владелец 07.10.2026): упавшая или пропущенная
// фоновая подготовка не мешает; мешает идущая, ждущая уточнения и устаревший план.
import { describe, expect, it } from "vitest";
import { preparationBlocker } from "../src/lib/preparationGate.js";

const card = { title: "Карточка", description: "Описание", project_id: "p1" };
const snap = (over: object = {}) => JSON.stringify({ ...card, ...over });
const job = (status: string, plan_id: string | null = "plan1", snapshot = snap()) => ({ status, plan_id, snapshot });

describe("preparationBlocker", () => {
  it("нет задания подготовки — можно", () => expect(preparationBlocker(undefined, "plan1", card)).toBeNull());

  it("упавшая, пропущенная и заменённая подготовка плану не мешают", () => {
    for (const status of ["failed", "skipped", "superseded"]) {
      expect(preparationBlocker(job(status, null, "{}"), "plan1", card)).toBeNull();
    }
  });

  it("идущая подготовка мешает и называет причину", () => {
    expect(preparationBlocker(job("queued"), "plan1", card)).toContain("ещё готовится");
    expect(preparationBlocker(job("running"), "plan1", card)).toContain("ещё готовится");
  });

  it("подготовка ждёт уточнения — мешает", () => {
    expect(preparationBlocker(job("needs_clarification"), "plan1", card)).toContain("уточнения");
  });

  it("готовая подготовка этого плана, карточка не менялась — можно", () => {
    expect(preparationBlocker(job("ready"), "plan1", card)).toBeNull();
  });

  it("готовая подготовка другого плана — мешает", () => {
    expect(preparationBlocker(job("ready", "plan2"), "plan1", card)).toContain("более свежий");
  });

  it("карточку изменили после подготовки — мешает, причина названа", () => {
    expect(preparationBlocker(job("ready", "plan1", snap({ title: "Другое" })), "plan1", card)).toContain("изменились");
    expect(preparationBlocker(job("ready", "plan1", snap({ project_id: "p2" })), "plan1", card)).toContain("изменились");
  });

  it("повреждённый снимок не роняет проверку", () => {
    expect(preparationBlocker(job("ready", "plan1", "{не json"), "plan1", card)).toContain("Не удалось сверить");
  });
});
