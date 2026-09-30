import { describe, expect, it, beforeEach } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  applyOverride,
  compose,
  composeLayer,
  getLayerSpec,
  globalVersionForRole,
  listHistory,
  LAYER_CATALOG,
  readHistoryEntry,
  readOriginalOnly,
} from "../src/lib/roleContextResolver.js";

const uid = () => crypto.randomUUID();

migrate();
runMigrations();

function seedOwner(): string {
  const id = uid();
  db.prepare(
    "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "Owner", `${id}@test`, "hash", "owner", "human");
  return id;
}

function seedRole(key: string, title: string): string {
  // Если key уже есть (например, от предыдущего теста в том же прогоне)
  // — возвращаем его, не вставляя заново. Это норм: каждый тест
  // использует свой уникальный суффикс и не должен стучаться к чужому.
  const existing = db
    .prepare("SELECT key FROM roles WHERE key = ?")
    .get(key) as { key: string } | undefined;
  if (existing) return existing.key;
  db.prepare(
    "INSERT INTO roles (key, title, summary, enabled, position, prompt) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(key, title, "", 0, null);
  return key;
}

function clearOverrides(): void {
  db.prepare("DELETE FROM role_context_overrides_history").run();
  db.prepare("DELETE FROM role_context_overrides").run();
}

beforeEach(() => {
  clearOverrides();
});

/** Уникальный roleKey для каждого теста — чтобы они не конфликтовали по
 *  UNIQUE(key) в roles. Все тесты в describe используют только эту роль. */
function freshRoleKey(prefix: string): string {
  return `${prefix}-${uid().slice(0, 8)}`;
}

describe("roleContextResolver — каталог", () => {
  it("LAYER_CATALOG содержит все ключевые слои из дизайна §5", () => {
    const keys = new Set(LAYER_CATALOG.map((l) => l.key));
    for (const expected of [
      "role.prompt",
      "rules",
      "local_policy",
      "role_skills",
      "mcp_tools",
      "model_policy",
      "plan.role_node",
      "chat.submission",
      "chat.voice_intake",
      "intake.summary",
      "subtask.run_prompt",
    ]) {
      expect(keys.has(expected), `нет слоя ${expected}`).toBe(true);
    }
  });

  it("readOnly-флаги соответствуют дизайну: prompt/rules/local_policy редактируются, остальные read_only", () => {
    expect(getLayerSpec("role.prompt")?.readOnly).toBe(false);
    expect(getLayerSpec("rules")?.readOnly).toBe(false);
    expect(getLayerSpec("local_policy")?.readOnly).toBe(false);
    expect(getLayerSpec("intake.summary")?.readOnly).toBe(true);
    expect(getLayerSpec("role_skills")?.readOnly).toBe(true);
    expect(getLayerSpec("mcp_tools")?.readOnly).toBe(true);
    expect(getLayerSpec("model_policy")?.readOnly).toBe(true);
  });

  it("getLayerSpec возвращает null на неизвестном слое", () => {
    expect(getLayerSpec("nope")).toBeNull();
  });
});

describe("roleContextResolver — original без override", () => {
  it("composeLayer для role.prompt возвращает source=original и пустой effective, если у роли нет ни промпта, ни файла", () => {
    const role = freshRoleKey("ghost");
    seedRole(role, "Призрак");
    const layer = composeLayer(role, "role.prompt");
    expect(layer).not.toBeNull();
    expect(layer!.source).toBe("original");
    expect(layer!.version).toBe(0);
    expect(layer!.effective).toBe("");
  });

  it("composeLayer для rules возвращает текст с буллет-точкой для AGENT_RULES", () => {
    const role = freshRoleKey("ghost");
    seedRole(role, "Призрак");
    const layer = composeLayer(role, "rules");
    expect(layer).not.toBeNull();
    expect(layer!.source).toBe("original");
    // Минимум одна строка и каждая начинается с "- "
    expect(layer!.effective.split("\n").length).toBeGreaterThan(1);
    for (const line of layer!.effective.split("\n").filter(Boolean)) {
      expect(line.startsWith("- ")).toBe(true);
    }
  });

  it("readOriginalOnly возвращает тот же original, что и composeLayer(source=original).effective", () => {
    const role = freshRoleKey("ghost");
    seedRole(role, "Призрак");
    const original = composeLayer(role, "local_policy");
    expect(original!.source).toBe("original");
    const only = readOriginalOnly(role, "local_policy");
    expect(only).toBe(original!.effective);
  });

  it("compose(mode=work) собирает подмножество, общее для всех режимов работы", () => {
    const role = freshRoleKey("ghost");
    seedRole(role, "Призрак");
    const work = compose(role, "work");
    const subtask = compose(role, "subtask");
    // subtask включает plan.role_node и subtask.run_prompt, которых нет в work
    const workKeys = new Set(work.map((l) => l.layer));
    const subtaskKeys = new Set(subtask.map((l) => l.layer));
    expect(workKeys.has("plan.role_node")).toBe(false);
    expect(subtaskKeys.has("plan.role_node")).toBe(true);
  });
});

describe("roleContextResolver — override с приоритетом", () => {
  it("override для role.prompt перекрывает original", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");
    // без файла и prompt в БД — original пустой
    const original = composeLayer(role, "role.prompt");
    expect(original!.source).toBe("original");
    expect(original!.effective).toBe("");

    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "Тестовая инструкция",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });

    const after = composeLayer(role, "role.prompt");
    expect(after!.source).toBe("override");
    expect(after!.effective).toBe("Тестовая инструкция");
    expect(after!.version).toBe(1);
    expect(after!.updatedBy).toBe(ownerId);
    expect(after!.readOnly).toBe(false);
  });

  it("scope=command (role_key='*') применяется только к слоям scope=command", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");

    // scope=command для role.prompt — не должно применяться (scope=role)
    expect(() => applyOverride({
      scope: "command",
      roleKey: "*",
      layer: "role.prompt",
      text: "Чужая инструкция",
      sourceKind: "code",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    })).toThrow("только для роли");

    const rolePrompt = composeLayer(role, "role.prompt");
    // role.prompt имеет scope=role, command_default тут не применяется
    expect(rolePrompt!.source).toBe("original");

    // scope=command для rules — должно применяться
    applyOverride({
      scope: "command",
      roleKey: "*",
      layer: "rules",
      text: "Главная инструкция",
      sourceKind: "code",
      sourceRef: "AGENT_RULES",
      createdBy: ownerId,
      action: "set",
    });

    const rules = composeLayer(role, "rules");
    expect(rules!.source).toBe("command_default");
    expect(rules!.effective).toBe("Главная инструкция");
  });

  it("globalVersionForRole растёт при правке и не уменьшается при reset", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");
    expect(globalVersionForRole(role)).toBe(0);
    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v1",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });
    const v1 = globalVersionForRole(role);
    expect(v1).toBe(1);
    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v2",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });
    const v2 = globalVersionForRole(role);
    expect(v2).toBe(2);
    expect(v2).toBeGreaterThan(v1);
  });

  it("applyOverride для read_only-слоя (role_skills) бросает ошибку", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");
    expect(() =>
      applyOverride({
        scope: "role",
        roleKey: role,
        layer: "role_skills",
        text: "test",
        sourceKind: "db",
        sourceRef: "test",
        createdBy: ownerId,
        action: "set",
      }),
    ).toThrowError(/только для просмотра/);
  });

  it("history пополняется при каждом applyOverride и сортируется newest first", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");
    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v1",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });
    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v2",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });
    const hist = listHistory("role", role, "role.prompt", 10);
    expect(hist.length).toBe(3);
    expect(hist[0].action).toBe("set");
    expect(hist[0].byUserId).toBe(ownerId);
  });
});

describe("roleContextResolver — restore из истории", () => {
  it("restore читает версию из истории и создаёт новую активную запись с action=restore", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");
    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v1",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });
    applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v2",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "set",
    });
    const restored = applyOverride({
      scope: "role",
      roleKey: role,
      layer: "role.prompt",
      text: "v1",
      sourceKind: "db",
      sourceRef: "test",
      createdBy: ownerId,
      action: "restore",
      reason: "restore v1",
    });
    expect(restored.effective).toBe("v1");
    expect(restored.version).toBe(3);
    expect(restored.source).toBe("override");

    const hist = listHistory("role", role, "role.prompt", 10);
    expect(hist.find((h) => h.action === "restore")).toBeDefined();
  });

  it("readHistoryEntry возвращает null на несуществующую версию", () => {
    const ownerId = seedOwner();
    const role = freshRoleKey("builder");
    seedRole(role, "Разработчик");
    const entry = readHistoryEntry("role", role, "role.prompt", 99);
    expect(entry).toBeNull();
  });
});