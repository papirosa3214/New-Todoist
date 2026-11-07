// Обсуждение карточки и беседа шага искали модель роли по полной записи
// «minimax/MiniMax-M3.1-Flash» как по id — в каталоге id без приставки, и
// ответ всегда был «модель недоступна» (владелец 27.10.2026: «модели ничего
// не могут»). Поиск — через разбор записи, как в запуске роли.
import { describe, expect, it } from "vitest";
import { findRuntimeModel } from "../src/lib/attemptModel.js";

const flash = { id: "MiniMax-M3.1-Flash", provider: "minimax" };
const runtime = {
  getModel: (provider: string, id: string) => (provider === "minimax" && id === flash.id ? flash : undefined),
  getAvailable: async () => [flash],
};

describe("поиск модели роли в рантайме", () => {
  it("запись с приставкой провайдера находит модель", async () => {
    expect(await findRuntimeModel(runtime, "minimax/MiniMax-M3.1-Flash")).toBe(flash);
  });
  it("запись без приставки работает как раньше", async () => {
    expect(await findRuntimeModel(runtime, "MiniMax-M3.1-Flash")).toBe(flash);
  });
  it("нет модели — undefined", async () => {
    expect(await findRuntimeModel(runtime, "minimax/нет-такой")).toBeUndefined();
    expect(await findRuntimeModel(runtime, undefined)).toBeUndefined();
  });
});
