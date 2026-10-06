// Возврат на основную модель после лимита (владелец 07.10.2026):
//  • провайдер работал и упёрся — пять часов от этого момента + 5 минут, без прощупываний (timer);
//  • упёрлись сразу при старте — остаток неизвестен, метку снимает пробный запрос (probe).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markProviderLimited, providerAvailable } from "../src/lib/modelLadder.js";
import { modelForProvider, runProviderProbe } from "../src/runtime/providerProbe.js";
import { pickFailoverModel, pickStartModel, providerWorkedRecently } from "../src/runtime/providerFailover.js";
import type { RoleRouting } from "../src/roleRouting.js";

const routing = {
  defaults: {},
  models: { builder: "MiniMax-M3" },
  fallbacks: { builder: ["opencode-go/minimax-m3", "opencode-go/deepseek-v4.1-flash"] },
} as unknown as RoleRouting;

function clear() {
  db.prepare("DELETE FROM provider_limits WHERE provider IN ('minimax','opencode-go')").run();
  db.prepare("DELETE FROM attempts WHERE id LIKE 'probe-test-%'").run();
}

/** Попытка на minimax, начатая `minutesAgo` минут назад. */
function attemptAt(minutesAgo: number, reasonCode: string | null = null) {
  const owner = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  const task = db.prepare("SELECT id FROM tasks LIMIT 1").get() as { id: string } | undefined;
  const taskId = task?.id ?? (() => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('probe-test-task', 'проба')").run();
    return "probe-test-task";
  })();
  db.prepare(
    // ended_at задан: на задачу допускается только одна незакрытая попытка.
    `INSERT INTO attempts (id, task_id, executor_id, provider, model, started_at, ended_at, reason_code)
     VALUES (?, ?, ?, 'minimax', 'MiniMax-M3', datetime('now', ?), datetime('now', '-1 minutes'), ?)`,
  ).run(`probe-test-${crypto.randomUUID()}`, taskId, owner.id, `-${minutesAgo} minutes`, reasonCode);
}

const untilMinutes = (provider: string) =>
  (db.prepare("SELECT (julianday(unavailable_until) - julianday('now')) * 1440 AS m FROM provider_limits WHERE provider = ?").get(provider) as { m: number }).m;

describe("Лимит провайдера: работал → таймер, упёрся сразу → проба", () => {
  beforeAll(async () => { await buildApp(); });
  beforeEach(clear);

  it("берёт для пробы модель именно этого провайдера", () => {
    expect(modelForProvider(routing, "minimax")).toBe("MiniMax-M3");
    expect(modelForProvider(routing, "opencode-go")).toBe("opencode-go/minimax-m3");
    expect(modelForProvider(routing, "anthropic")).toBeNull();
  });

  it("«работал» — попытка на провайдере, начатая 10+ минут назад и не упавшая на лимите", () => {
    expect(providerWorkedRecently("minimax")).toBe(false);
    attemptAt(3);
    expect(providerWorkedRecently("minimax")).toBe(false); // только что стартовала — упёрлись сразу
    attemptAt(40, "provider_limit");
    expect(providerWorkedRecently("minimax")).toBe(false); // та попытка сама упала на лимите
    attemptAt(40);
    expect(providerWorkedRecently("minimax")).toBe(true);
  });

  it("работал и упёрся → режим timer: 5 часов 5 минут, проба его не трогает", async () => {
    attemptAt(40);
    pickFailoverModel(routing, "builder", "MiniMax-M3", "429 rate limit");
    const row = db.prepare("SELECT mode FROM provider_limits WHERE provider = 'minimax'").get() as { mode: string };
    expect(row.mode).toBe("timer");
    expect(untilMinutes("minimax")).toBeGreaterThan(5 * 60 + 3);
    expect(untilMinutes("minimax")).toBeLessThan(5 * 60 + 6);

    let calls = 0;
    await runProviderProbe(async () => { calls++; return "ok"; }, routing);
    expect(calls).toBe(0);
    expect(providerAvailable("minimax")).toBe(false);
  });

  it("упёрся сразу при старте → режим probe: лимит сброшен — метка снята, основная модель вернулась", async () => {
    pickFailoverModel(routing, "builder", "MiniMax-M3", "429 rate limit");
    const row = db.prepare("SELECT mode FROM provider_limits WHERE provider = 'minimax'").get() as { mode: string };
    expect(row.mode).toBe("probe");
    expect(pickStartModel(routing, "builder")).toBe("opencode-go/minimax-m3");

    expect(await runProviderProbe(async () => "ok", routing)).toEqual(["minimax"]);

    expect(providerAvailable("minimax")).toBe(true);
    expect(pickStartModel(routing, "builder")).toBe("MiniMax-M3");
  });

  it("probe: лимит ещё действует или проба недоступна — метка остаётся", async () => {
    markProviderLimited("minimax", null, "429 rate limit", "probe");
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
