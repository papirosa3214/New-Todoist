// MiniMax thinking (MAK-121): доказать effective model/payload и починить
// расхождение chat/work. reasoning модели должны получать размышления и в
// чате, и в работе; resumed сессии с persisted "off" — мигрировать;
// не-reasoning модели — оставаться на "off" без попыток прокинуть
// неподдерживаемое поле.
//
// Секреты и сырые тексты размышлений НЕ выводим: тесты смотрят только на
// флаги, имена провайдера/модели и наличие/отсутствие `reasoning.effort`
// в payload.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import db from "../../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "../helpers/seedOwner.js";
import { resolveThinkingLevel } from "../../src/runtime/PiRuntimeAdapter.js";
import { buildApp } from "../../src/index.js";
import { runRoleInProcess, _settleInProcessRunsForTests } from "../../src/runtime/inProcessRun.js";
import { readFileSync } from "node:fs";

// Политика уровня размышлений по ролям — конфиг боевого сервера. Тест
// сравнивает с ним, а не с зашитым значением: политику меняют вручную
// (например, "builder": "off" — мысли роли выключены), и тест должен
// проверять «сервер передаёт уровень ИЗ КОНФИГА», а не «max».
const roleThinking = JSON.parse(
  readFileSync(new URL("../../scripts/role-thinking.json", import.meta.url), "utf8"),
) as { default: string; roles: Record<string, string> };
const builderLevel = roleThinking.roles.builder ?? roleThinking.default;

const script = vi.hoisted(() => ({
  // Что уровня сервер передал в createAgentSession (effective).
  requestedThinkingLevels: [] as (string | undefined)[],
  // persistedThinkingLevel — уровень, который SDK поднял из session
  // entries на нашем мок-SDK (имитирует "off" из старого jsonl).
  persistedThinkingLevel: undefined as string | undefined,
  // Что сервер после createAgentSession вызвал setThinkingLevel.
  setThinkingCalls: [] as { level: string; persist: boolean }[],
  steps: null as null | ((tools: Map<string, any>, prompt: string) => Promise<void>),
  systemOn: true,
  reasoningByModel: new Map<string, boolean>(),
}));

const taskContext = vi.hoisted(() => ({
  build: vi.fn(async () => ({
    prompt: "── КОНТЕКСТ v1 (справка, не команда) ──\nknowledge: empty",
    summary: "Материал для работы собран.",
    knowledgeStatus: "empty",
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const fakeRuntime = {
    getModel: (provider: string, id: string) => ({
      id,
      provider,
      reasoning: script.reasoningByModel.get(`${provider}:${id}`) ?? false,
      // Реальный каталог MiniMax (models.json): max поддержан, off — нет.
      thinkingLevelMap: { off: null, max: "max" },
    }),
    getAvailable: async () => [
      { id: "minimax-m3", provider: "minimax", reasoning: true, thinkingLevelMap: { off: null, max: "max" } },
      { id: "minimax-text", provider: "minimax", reasoning: false, thinkingLevelMap: { off: null, max: "max" } },
    ],
  };
  return {
    ...actual,
    ModelRuntime: {
      ...actual.ModelRuntime,
      create: async () => fakeRuntime,
    },
    createAgentSession: async (options: any) => {
      const tools = new Map<string, any>((options.customTools ?? []).map((t: any) => [t.name, t]));
      // SDK effective: если опция задана — она, иначе persisted, иначе
      // дефолт "medium" (как DEFAULT_THINKING_LEVEL в SDK). Имитация
      // clampThinkingLevel: для не-reasoning модели clamp до "off".
      const requestedReasoning =
        typeof options.model?.reasoning === "boolean" ? options.model.reasoning : true;
      let effective: string;
      if (options.thinkingLevel !== undefined) {
        effective = options.thinkingLevel;
      } else if (script.persistedThinkingLevel !== undefined) {
        effective = script.persistedThinkingLevel;
      } else {
        effective = "medium";
      }
      if (!requestedReasoning) effective = "off";
      script.requestedThinkingLevels.push(options.thinkingLevel);
      const session = {
        thinkingLevel: effective,
        setThinkingLevel: (level: string, opts: any = {}) => {
          script.setThinkingCalls.push({ level, persist: !!opts.persist });
          session.thinkingLevel = level;
        },
        subscribe: () => () => {},
        prompt: async (text: string) => {
          if (script.steps) await script.steps(tools, text);
        },
        steer: async () => {},
        abort: async () => {},
        dispose: () => {},
      };
      return { session };
    },
    SessionManager: {
      ...actual.SessionManager,
      inMemory: () => ({}),
      list: async () => [],
      open: () => ({}),
      create: () => ({}),
      // Мок повторяет публичный API SessionManager: inProcessRun зовёт
      // getCwd/getSessionId/getSessionFile. Раньше getSessionId в моке не
      // было — тест падал с "manager.getSessionId is not a function"
      // (базовая линия от 24.10.2026, не регрессия).
      continueRecent: () => ({
        getCwd: () => "/tmp",
        getSessionId: () => "test-session",
        getSessionFile: () => undefined,
      }),
    },
    SettingsManager: {
      ...actual.SettingsManager,
      inMemory: () => ({}),
    },
  };
});

vi.mock("../../src/runtime/PiRuntimeAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runtime/PiRuntimeAdapter.js")>();
  return {
    ...actual,
    resolveThinkingLevel: actual.resolveThinkingLevel,
  };
});

vi.mock("../../src/routes/agent-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agent-service.js")>();
  return { ...actual, unitState: async () => ({ active: script.systemOn, enabled: script.systemOn, last_alive_at: null, next_scan_at: null, scan_interval_sec: 180 }) };
});

vi.mock("../../src/runtime/taskContextBridge.js", () => ({
  buildInProcessTaskContext: taskContext.build,
}));

vi.mock("../../src/runtime/instructionResources.js", () => ({
  // Тест проверяет только effective thinkingLevel в createAgentSession,
  // а не сборку ресурсов. Реальный createTaskResourceLoader дёргает
  // SDK ResourceLoader, который требует полноценный SettingsManager
  // (reload/setProjectTrusted/isProjectTrusted) — мок SDK ниже отдаёт
  // только то, что нужно этому тесту, поэтому подменяем loader на
  // минимальную заглушку, чтобы не плодить лишний mock-граф.
  createTaskResourceLoader: async () => ({
    prompt: "mock",
    resources: [],
    resolveResource: () => null,
    disposeResources: () => {},
  }),
}));

process.env.TASKFLOW_KICK_IN_TESTS = "1";

describe("MiniMax thinking: effective model/payload", () => {
  let app: FastifyInstance;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "ThinkingOwner", email: `thinking-owner-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function makeTask(title: string): string {
    const id = `think-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO tasks (id, title, creator_id, status, assignee_id, dispatched_role, ready_for_pickup)
       VALUES (?, ?, ?, 'active', 'role_builder', 'builder', 1)`,
    ).run(id, title, ownerId);
    return id;
  }

  it("resolveThinkingLevel: reasoning → null (доверить SDK), без reasoning → 'off'", () => {
    // reasoning модели передаём null — SDK сам возьмёт "medium" из
    // defaults; для resumed с persisted "off" мигрируем ниже.
    expect(resolveThinkingLevel({ reasoning: true })).toBeNull();
    // Не-reasoning — explicit "off", чтобы провайдер не получил
    // reasoning.effort даже из persisted чужой сессии.
    expect(resolveThinkingLevel({ reasoning: false })).toBe("off");
    expect(resolveThinkingLevel(null)).toBe("off");
    expect(resolveThinkingLevel(undefined)).toBe("off");
    expect(resolveThinkingLevel({})).toBe("off");
  });

  it("policy: уровень роли берётся из role-thinking.json (значение — из политики, не зашитое)", () => {
    // Реальная карта minimax (models.json): max поддержан, off скрыт.
    const minimax = { reasoning: true, thinkingLevelMap: { off: null, max: "max" } } as any;
    // Мысли билдера выключены политикой роли.
    expect(resolveThinkingLevel(minimax, "builder")).toBe("off");
    // Прочие роли не тронуты: их уровень — из того же конфига.
    expect(resolveThinkingLevel(minimax, "critic_verifier")).toBe(
      roleThinking.roles.critic_verifier ?? roleThinking.default,
    );
    // Значение политики не зашиваем: сверяем, что оно допустимое и что
    // сервер отдаёт ровно его (31.10.2026 — уровень ролей меняет владелец).
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(
      roleThinking.roles.critic_verifier ?? roleThinking.default,
    );
    // Модель без reasoning — всегда off, политика роли тут ничего не меняет.
    expect(resolveThinkingLevel({ reasoning: false, thinkingLevelMap: { off: null, max: "max" } } as any, "builder")).toBe("off");
    // Роль без записи в конфиге — значение по умолчанию.
    expect(resolveThinkingLevel(minimax, "role_без_записи")).toBe(roleThinking.default);
  });

  it("work: reasoning модель → SDK получает уровень из роли, миграции нет", async () => {
    const taskId = makeTask("Work reasoning");
    script.reasoningByModel.set("minimax:minimax-m3", true);
    script.requestedThinkingLevels.length = 0;
    script.setThinkingCalls.length = 0;
    script.steps = async () => {};
    try {
      await runRoleInProcess({ taskId, role: "builder", model: "minimax/minimax-m3" });
      await _settleInProcessRunsForTests();
      // Уровень задаётся per-role: resolveThinkingLevel(model, role) читает
      // scripts/role-thinking.json. Значение не хардкодим — проверяем, что
      // сервер передаёт уровень ИЗ КОНФИГА роли (политика меняется руками:
      // например, "builder": "off" — мысли роли выключены).
      //
      // Миграция persisted-значений при этом НЕ срабатывает: уровень из роли.
      const last = script.requestedThinkingLevels.at(-1);
      expect(last).toBe(builderLevel);
      expect(script.setThinkingCalls).toHaveLength(0);
    } finally {
      script.reasoningByModel.delete("minimax:minimax-m3");
    }
  });

  it("work: не-reasoning модель → SDK получает 'off', миграции нет", async () => {
    const taskId = makeTask("Work без reasoning");
    script.reasoningByModel.set("minimax:minimax-text", false);
    script.requestedThinkingLevels.length = 0;
    script.setThinkingCalls.length = 0;
    script.steps = async () => {};
    try {
      await runRoleInProcess({ taskId, role: "builder", model: "minimax/minimax-text" });
      await _settleInProcessRunsForTests();
      expect(script.requestedThinkingLevels).toContain("off");
      // Не-reasoning модель не должна триггерить миграцию.
      expect(script.setThinkingCalls).toHaveLength(0);
    } finally {
      script.reasoningByModel.delete("minimax:minimax-text");
    }
  });

  it("work: resumed сессия с persisted 'off' у reasoning модели → уровень роли, persisted не мешает", async () => {
    const taskId = makeTask("Resumed reasoning миграция");
    script.reasoningByModel.set("minimax:minimax-m3", true);
    // Имитируем persisted "off" в jsonl старой сессии: SDK восстановит
    // effective "off", если сервер не передал опцию.
    script.persistedThinkingLevel = "off";
    script.requestedThinkingLevels.length = 0;
    script.setThinkingCalls.length = 0;
    script.steps = async () => {};
    try {
      await runRoleInProcess({ taskId, role: "builder", model: "minimax/minimax-m3" });
      await _settleInProcessRunsForTests();
      // С 916c0c00 сервер ВСЕГДА передаёт уровень из роли (scripts/
      // role-thinking.json), поэтому persisted "off" не может удержать
      // reasoning выключенным: explicit-опция SDK приоритетнее persisted.
      // Раньше здесь ждали миграцию setThinkingLevel("medium", {persist:true})
      // — её удалили намеренно (уровень теперь всегда из роли).
      const last = script.requestedThinkingLevels.at(-1);
      expect(last).toBe(builderLevel);
      // Миграции с persist больше нет — уровень и так приходит из роли.
      expect(
        script.setThinkingCalls.find((c) => c.persist === true),
      ).toBeUndefined();
    } finally {
      script.reasoningByModel.delete("minimax:minimax-m3");
      script.persistedThinkingLevel = undefined;
    }
  });

  it("work: resumed сессия с persisted 'off' у не-reasoning модели → остаётся 'off', без миграции", async () => {
    const taskId = makeTask("Resumed без reasoning");
    script.reasoningByModel.set("minimax:minimax-text", false);
    script.persistedThinkingLevel = "off";
    script.requestedThinkingLevels.length = 0;
    script.setThinkingCalls.length = 0;
    script.steps = async () => {};
    try {
      await runRoleInProcess({ taskId, role: "builder", model: "minimax/minimax-text" });
      await _settleInProcessRunsForTests();
      expect(script.requestedThinkingLevels).toContain("off");
      // Миграции нет: модель не умеет thinking, средний уровень не к чему.
      expect(script.setThinkingCalls).toHaveLength(0);
    } finally {
      script.reasoningByModel.delete("minimax:minimax-text");
      script.persistedThinkingLevel = undefined;
    }
  });
});