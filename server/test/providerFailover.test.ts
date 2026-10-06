// Автопереключение провайдера при лимите (владелец 06.10.2026): ошибка 429 в ответе модели
// узнаётся, провайдер помечается занятым, запуск идёт на запасную модель цепочки роли,
// а после окончания метки возвращается на основную.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  isProviderLimitText,
  lastAssistantLimitError,
  pickFailoverModel,
  pickStartModel,
} from "../src/runtime/providerFailover.js";
import { loadRoleRouting, type RoleRouting } from "../src/roleRouting.js";
import path from "node:path";

const routing = {
  defaults: {},
  models: { builder: "MiniMax-M3" },
  fallbacks: { builder: ["opencode-go/minimax-m3", "opencode-go/deepseek-v4.1-flash"] },
} as unknown as RoleRouting;

describe("Автопереключение провайдера при лимите", () => {
  beforeAll(async () => { await buildApp(); });
  beforeEach(() => {
    db.prepare("DELETE FROM provider_limits WHERE provider IN ('minimax','opencode-go')").run();
  });

  it("узнаёт лимит в тексте ошибки", () => {
    expect(isProviderLimitText('429 {"type":"error","error":{"message":"Token Plan usage limit reached"}}')).toBe(true);
    expect(isProviderLimitText("TypeError: x is not a function")).toBe(false);
  });

  it("узнаёт тихую ошибку в последнем ответе модели", () => {
    const session = { state: { messages: [
      { role: "user" },
      { role: "assistant", stopReason: "error", errorMessage: "429 rate_limit_error: usage limit reached" },
    ] } };
    expect(lastAssistantLimitError(session)).toContain("429");
    expect(lastAssistantLimitError({ state: { messages: [{ role: "assistant", stopReason: "stop" }] } })).toBeNull();
  });

  it("начинает с основной модели, пока лимита нет", () => {
    expect(pickStartModel(routing, "builder")).toBe("MiniMax-M3");
  });

  it("при лимите основного провайдера отдаёт запасную и помнит лимит", () => {
    const next = pickFailoverModel(routing, "builder", "MiniMax-M3", "429");
    expect(next).toBe("opencode-go/minimax-m3");
    // пока метка жива, новые запуски сразу идут на запасную
    expect(pickStartModel(routing, "builder")).toBe("opencode-go/minimax-m3");
  });

  it("если выбиты оба провайдера — запасных нет", () => {
    pickFailoverModel(routing, "builder", "MiniMax-M3", "429");
    expect(pickFailoverModel(routing, "builder", "opencode-go/minimax-m3", "429")).toBeNull();
  });

  it("явно заданная модель шага уважается", () => {
    expect(pickStartModel(routing, "builder", "opencode-go/qwen3.8-flash")).toBe("opencode-go/qwen3.8-flash");
  });

  it("боевой role-routing.yaml читается: основной MiniMax; Критик и QA уходят на minimax-m3, остальные на DeepSeek, потом Qwen", () => {
    const live = loadRoleRouting(path.resolve(__dirname, "../scripts/role-routing.yaml"));
    for (const role of Object.keys(live.models)) {
      expect(live.models[role as keyof typeof live.models]).toBe("MiniMax-M3");
      const chain = live.fallbacks[role as keyof typeof live.fallbacks];
      if (role === "critic_verifier" || role === "qa") {
        expect(chain).toEqual(["opencode-go/minimax-m3", "opencode-go/deepseek-v4.1-flash"]);
      } else {
        expect(chain).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/qwen3.8-flash"]);
      }
    }
  });
});
