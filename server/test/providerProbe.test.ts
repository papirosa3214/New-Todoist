// Возврат на основную модель по факту сброса лимита (владелец 07.10.2026): пробный запрос к
// помеченному провайдеру; ответил — метка снимается, лимит ещё действует — остаётся.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markProviderLimited, providerAvailable } from "../src/lib/modelLadder.js";
import { modelForProvider, runProviderProbe } from "../src/runtime/providerProbe.js";
import { pickStartModel } from "../src/runtime/providerFailover.js";
import type { RoleRouting } from "../src/roleRouting.js";

const routing = {
  defaults: {},
  models: { builder: "MiniMax-M3" },
  fallbacks: { builder: ["opencode-go/minimax-m3", "opencode-go/deepseek-v4.1-flash"] },
} as unknown as RoleRouting;

describe("Проба сброса лимита провайдера", () => {
  beforeAll(async () => { await buildApp(); });
  beforeEach(() => {
    db.prepare("DELETE FROM provider_limits WHERE provider IN ('minimax','opencode-go')").run();
  });

  it("берёт для пробы модель именно этого провайдера", () => {
    expect(modelForProvider(routing, "minimax")).toBe("MiniMax-M3");
    expect(modelForProvider(routing, "opencode-go")).toBe("opencode-go/minimax-m3");
    expect(modelForProvider(routing, "anthropic")).toBeNull();
  });

  it("лимит сброшен — метка снята, запуск снова берёт основную модель", async () => {
    markProviderLimited("minimax", null, "429 rate limit");
    expect(providerAvailable("minimax")).toBe(false);
    expect(pickStartModel(routing, "builder")).toBe("opencode-go/minimax-m3");

    const restored = await runProviderProbe(async () => "ok", routing);

    expect(restored).toEqual(["minimax"]);
    expect(providerAvailable("minimax")).toBe(true);
    expect(pickStartModel(routing, "builder")).toBe("MiniMax-M3");
  });

  it("лимит ещё действует или проба недоступна — метка остаётся", async () => {
    markProviderLimited("minimax", null, "429 rate limit");
    expect(await runProviderProbe(async () => "limited", routing)).toEqual([]);
    expect(await runProviderProbe(async () => "unknown", routing)).toEqual([]);
    expect(await runProviderProbe(async () => { throw new Error("сеть"); }, routing)).toEqual([]);
    expect(providerAvailable("minimax")).toBe(false);
  });

  it("без пометок ничего не пробует", async () => {
    let calls = 0;
    await runProviderProbe(async () => { calls++; return "ok"; }, routing);
    expect(calls).toBe(0);
  });
});
