// Серверная логика версионированного манифеста правил (Этап B карточки
// 51763de5-…). Контракт зафиксирован в `45d948af-…` (Аналитик) и
// `4ec246d6-…` (Архитектор); этот файл проверяет, что миграция подняла
// таблицы, эндпоинты валидируют вход, манифест суперсэссит старые версии,
// а инструкция агенту получает блок `rules.pending_acknowledgement` ровно
// для неподтверждённых активных правил.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  pendingRulesForRole,
  publishRule,
  rulesForOwner,
} from "../src/lib/agentRules.js";
import { composeLayer } from "../src/lib/roleContextResolver.js";
import { ROLE_NAMES } from "../src/roleRouting.js";

const OWNER_ID = "rules-owner";
const ORCH_ID = "rules-orch";
const BUILDER_ID = "role_builder"; // ID привязан к role_key триггером 058

async function ensureUser(
  id: string,
  name: string,
  email: string,
  authority: "owner" | "agent" | "orchestrator",
  roleKey: string | null,
) {
  // Триггер 058 предъявляет к users.role_key жёсткие требования:
  // type='ai', role='agent' (или совпадающий authority у owner/orchestrator),
  // is_system_bot=1, id совпадает с role_<key>. У нас тестовая роль
  // 'role_builder' уже заведена миграцией 057; владельца/оркестратора
  // заводим как system_bot, чтобы сработала привязка. Для owner role_key
  // остаётся NULL.
  const isRoleAgent = authority === "agent";
  const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
  if (!exists) {
    db.prepare(
      `INSERT INTO users
         (id, name, email, password_hash, role, type, role_key, is_system_bot)
       VALUES (?, ?, ?, '!', ?, 'ai', ?, ?)`,
    ).run(
      id,
      name,
      email,
      authority,
      isRoleAgent ? roleKey : null,
      isRoleAgent ? 1 : 1,
    );
  } else {
    db.prepare(
      `UPDATE users SET role = ?, role_key = ?, type = 'ai', is_system_bot = 1
        WHERE id = ?`,
    ).run(authority, isRoleAgent ? roleKey : null, id);
  }
}

async function issueToken(app: FastifyInstance, id: string): Promise<string> {
  // Эти пользователи заведены вручную в DB; токен подписываем тем же
  // секретом, что и в проде — JWT_SECRET выставлен setup.ts до импорта db.
  return app.jwt.sign({ id }, { expiresIn: "5m" });
}

function chatRuleCount(): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'rule'`,
  ).get() as { n: number }).n;
}

function chatRuleAckCount(): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'rule' AND text LIKE '✅%'`,
  ).get() as { n: number }).n;
}

function chatRowCount(ref: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE rule_ref = ?`,
  ).get(ref) as { n: number }).n;
}

describe("rules manifest (Этап B)", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let orchToken: string;
  let builderToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await ensureUser(OWNER_ID, "Rules Owner", "rules-owner@rules", "owner", null);
    await ensureUser(ORCH_ID, "Rules Orchestrator", "rules-orch@rules", "orchestrator", null);
    await ensureUser(BUILDER_ID, "Rules Builder", "rules-builder@rules", "agent", "builder");
    ownerToken = await issueToken(app, OWNER_ID);
    orchToken = await issueToken(app, ORCH_ID);
    builderToken = await issueToken(app, BUILDER_ID);
  });

  afterAll(async () => {
    db.prepare("DELETE FROM chat_messages WHERE from_user_id IN (?, ?, ?)").run(OWNER_ID, ORCH_ID, BUILDER_ID);
    db.prepare("DELETE FROM task_events WHERE actor_id IN (?, ?, ?)").run(OWNER_ID, ORCH_ID, BUILDER_ID);
    db.prepare("DELETE FROM rule_acknowledgements WHERE role IN ('builder', 'orchestrator')").run();
    db.prepare("DELETE FROM agent_rules_manifests WHERE rule_id LIKE 'rules.%'").run();
    db.prepare("DELETE FROM users WHERE id IN (?, ?, ?)").run(OWNER_ID, ORCH_ID, BUILDER_ID);
    await app.close();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM chat_messages WHERE from_user_id IN (?, ?, ?)").run(OWNER_ID, ORCH_ID, BUILDER_ID);
    db.prepare("DELETE FROM task_events WHERE actor_id IN (?, ?, ?)").run(OWNER_ID, ORCH_ID, BUILDER_ID);
    db.prepare("DELETE FROM rule_acknowledgements WHERE role IN ('builder', 'orchestrator')").run();
    db.prepare("DELETE FROM agent_rules_manifests WHERE rule_id LIKE 'rules.%'").run();
  });

  it("AC-1 publish → manifest row + chat_messages + pending list for *", async () => {
    const publish = await app.inject({
      method: "POST",
      url: "/api/agent/rules/publish",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        rule_id: "rules.demo_a",
        version: 1,
        content: "Тестовое правило А. Длинное описание для проверки превью.",
      },
    });
    expect(publish.statusCode).toBe(200);
    const body = publish.json();
    expect(body).toMatchObject({ ok: true, existed: false, ref: "rules.demo_a@v1" });
    expect(body.chat_message_id).toBeTruthy();

    const manifest = db
      .prepare(
        `SELECT status, role_scope FROM agent_rules_manifests
          WHERE rule_id = 'rules.demo_a' AND version = 1`,
      )
      .get() as { status: string; role_scope: string } | undefined;
    expect(manifest).toEqual({ status: "active", role_scope: "*" });

    const chatRow = db
      .prepare(
        `SELECT kind, rule_ref, channel FROM chat_messages WHERE id = ?`,
      )
      .get(body.chat_message_id) as
      | { kind: string; rule_ref: string; channel: string }
      | undefined;
    expect(chatRow).toMatchObject({
      kind: "rule", rule_ref: "rules.demo_a@v1", channel: "agents",
    });

    expect(pendingRulesForRole("builder")).toEqual([
      expect.objectContaining({ ref: "rules.demo_a@v1", ruleId: "rules.demo_a", version: 1 }),
    ]);
    expect(pendingRulesForRole("designer")).toEqual([
      expect.objectContaining({ ref: "rules.demo_a@v1" }),
    ]);
  });

  it("AC-1 instruction snapshot отдаёт блок с preview и required_for_step_start", async () => {
    publishRule({
      ruleId: "rules.snapshot_a", version: 1, content: "Снимок",
      roleScope: "builder,designer", publishedBy: OWNER_ID,
    });
    const layer = composeLayer("builder", "rules.pending_acknowledgement");
    expect(layer).toBeTruthy();
    expect(layer!.effective).toMatch(/required_for_step_start: true/);
    expect(layer!.effective).toMatch(/rules\.snapshot_a@v1/);
    expect(layer!.title).toBe("Требуется подтверждение правил");
  });

  it("AC-1 acknowledge → блок исчезает + строка в чате + rule_acknowledgements row", async () => {
    publishRule({
      ruleId: "rules.ack_a", version: 1, content: "Подтверждаемое правило",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    const ack = await app.inject({
      method: "POST",
      url: "/api/agent/rules/acknowledge",
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { rule_id: "rules.ack_a", version: 1, role: "builder" },
    });
    expect(ack.statusCode).toBe(200);
    const ackBody = ack.json();
    expect(ackBody.ok).toBe(true);
    expect(ackBody.ref).toBe("rules.ack_a@v1");
    expect(ackBody.acknowledged_at).toBeTruthy();

    expect(pendingRulesForRole("builder")).toEqual([]);

    const ruleAckRow = db
      .prepare(
        `SELECT role, version FROM rule_acknowledgements
          WHERE role = 'builder' AND rule_id = 'rules.ack_a'`,
      )
      .get() as { role: string; version: number } | undefined;
    expect(ruleAckRow).toEqual({ role: "builder", version: 1 });

    // В чате должна лежать строка kind='rule' вида "✅ ... подтвердил".
    const ackLines = db
      .prepare(
        `SELECT text FROM chat_messages WHERE kind = 'rule' AND rule_ref = 'rules.ack_a@v1' ORDER BY created_at`,
      )
      .all() as Array<{ text: string }>;
    const ackLineTexts = ackLines.map((r) => r.text);
    expect(ackLineTexts.some((t) => t.startsWith("✅"))).toBe(true);
  });

  it("AC-1 пустой блок не появляется: pendingRulesForRole -> [] слой composeLayer возвращает null", () => {
    // Без publish — нет правил для этой роли.
    expect(pendingRulesForRole("qa")).toEqual([]);
    const layer = composeLayer("qa", "rules.pending_acknowledgement");
    expect(layer).toBeNull();
  });

  it("AC-2 publish новой версии → прежняя active становится superseded, появляется task_events rule_superseded", () => {
    publishRule({
      ruleId: "rules.ver", version: 1, content: "Версия 1",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    publishRule({
      ruleId: "rules.ver", version: 2, content: "Версия 2 — обновление",
      roleScope: "*", publishedBy: OWNER_ID,
    });

    const rows = db
      .prepare(
        `SELECT version, status, superseded_by FROM agent_rules_manifests
          WHERE rule_id = 'rules.ver' ORDER BY version`,
      )
      .all() as Array<{ version: number; status: string; superseded_by: string | null }>;
    expect(rows).toEqual([
      { version: 1, status: "superseded", superseded_by: "rules.ver@v2" },
      { version: 2, status: "active", superseded_by: null },
    ]);

    const ev = db
      .prepare(
        `SELECT kind, from_value, to_value FROM task_events
          WHERE kind = 'rule_superseded' AND actor_id = ?`,
      )
      .get(OWNER_ID) as
      | { kind: string; from_value: string; to_value: string }
      | undefined;
    expect(ev).toBeTruthy();
    expect(ev!.from_value).toBe("rules.ver@v1");
    expect(ev!.to_value).toBe("rules.ver@v2");
  });

  it("AC-2 подтверждение устаревшей версии → 409 rule_version_superseded", async () => {
    publishRule({
      ruleId: "rules.super", version: 1, content: "v1",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    publishRule({
      ruleId: "rules.super", version: 2, content: "v2",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    const ack = await app.inject({
      method: "POST",
      url: "/api/agent/rules/acknowledge",
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { rule_id: "rules.super", version: 1, role: "builder" },
    });
    expect(ack.statusCode).toBe(409);
    expect(ack.json()).toEqual({
      error: "rule_version_superseded",
      current_version: 2,
    });
  });

  it("AC-3 publish: пустой rule_id / неверная маска / version ≤ 0 / пустой контент → 400", async () => {
    for (const bad of [
      { rule_id: "", version: 1, content: "x" },
      { rule_id: "1abc", version: 1, content: "x" },
      { rule_id: "ABC.def", version: 1, content: "x" },
      { rule_id: "ok.id", version: 0, content: "x" },
      { rule_id: "ok.id", version: 1, content: "" },
      { rule_id: "ok.id", version: 1, content: "   \n  " },
    ]) {
      const resp = await app.inject({
        method: "POST",
        url: "/api/agent/rules/publish",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: bad,
      });
      expect(resp.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM agent_rules_manifests").get(),
    ).toEqual({ n: 0 });
  });

  it("AC-4 точечный role_scope: правило адресовано только builder, другие роли его не видят", () => {
    publishRule({
      ruleId: "rules.builder_only", version: 1, content: "Только для builder",
      roleScope: "builder", publishedBy: OWNER_ID,
    });
    expect(pendingRulesForRole("builder")).toEqual([
      expect.objectContaining({ ref: "rules.builder_only@v1" }),
    ]);
    expect(pendingRulesForRole("designer")).toEqual([]);
    expect(pendingRulesForRole("analyst")).toEqual([]);
  });

  it("AC-4 acknowledge чужой роли → 403 cannot_acknowledge_for_other_role", async () => {
    publishRule({
      ruleId: "rules.builder_only2", version: 1, content: "Только для builder",
      roleScope: "builder", publishedBy: OWNER_ID,
    });
    const ack = await app.inject({
      method: "POST",
      url: "/api/agent/rules/acknowledge",
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { rule_id: "rules.builder_only2", version: 1, role: "designer" },
    });
    expect(ack.statusCode).toBe(403);
    expect(ack.json()).toEqual({ error: "cannot_acknowledge_for_other_role" });
  });

  it("AC-5 повторный acknowledge идемпотентен: тот же acknowledged_at, без новой строки в чате", async () => {
    publishRule({
      ruleId: "rules.idem", version: 1, content: "Идемпотентное",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/agent/rules/acknowledge",
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { rule_id: "rules.idem", version: 1, role: "builder" },
    });
    expect(first.statusCode).toBe(200);
    const firstAck = first.json().acknowledged_at;

    const second = await app.inject({
      method: "POST",
      url: "/api/agent/rules/acknowledge",
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { rule_id: "rules.idem", version: 1, role: "builder" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().acknowledged_at).toBe(firstAck);
    expect(second.json().chat_message_id).toBeNull();
    expect(chatRuleAckCount()).toBe(1);
  });

  it("AC-5 publish идемпотентен по (rule_id, version): повтор с тем же контентом → existed=true, без новой записи в чате", () => {
    const first = publishRule({
      ruleId: "rules.republish", version: 1, content: "Стабильный текст",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    const second = publishRule({
      ruleId: "rules.republish", version: 1, content: "Стабильный текст",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    expect(second.existed).toBe(true);
    expect(second.chatMessageId).toBeNull();
    expect(first.chatMessageId).toBeTruthy();
    expect(chatRowCount("rules.republish@v1")).toBe(1);
  });

  it("AC-5 publish с тем же (rule_id, version), но другим контентом → 400 rule_version_exists_with_different_payload", () => {
    publishRule({
      ruleId: "rules.diverge", version: 1, content: "Раз",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    expect(() =>
      publishRule({
        ruleId: "rules.diverge", version: 1, content: "Два",
        roleScope: "*", publishedBy: OWNER_ID,
      }),
    ).toThrow(/rule_version_exists_with_different_payload/);
  });

  it("AC-6 обычный пользователь (не owner/orchestrator) не может publish", async () => {
    publishRule({
      ruleId: "rules.guard", version: 1, content: "Гард",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    const resp = await app.inject({
      method: "POST",
      url: "/api/agent/rules/publish",
      headers: { authorization: `Bearer ${builderToken}` },
      payload: { rule_id: "rules.guard", version: 2, content: "Гард 2" },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json()).toEqual({ error: "owner_or_orchestrator_required" });
  });

  it("AC-6 список правил через /api/agent/rules/list отдаёт manifest и pending для роли", async () => {
    publishRule({
      ruleId: "rules.list_a", version: 1, content: "Список",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    const resp = await app.inject({
      method: "GET",
      url: "/api/agent/rules/list?role=builder",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "rules.list_a", version: 1, status: "active" }),
      ]),
    );
    expect(body.pending_for_role?.builder).toEqual([
      expect.objectContaining({ ref: "rules.list_a@v1" }),
    ]);
  });

  it("AC-6 publish через оркестратора тоже разрешён (оркестратор — равный владельцу по праву)", async () => {
    const resp = await app.inject({
      method: "POST",
      url: "/api/agent/rules/publish",
      headers: { authorization: `Bearer ${orchToken}` },
      payload: {
        rule_id: "rules.orch_pub",
        version: 1,
        content: "От оркестратора",
        role_scope: ["builder"],
      },
    });
    expect(resp.statusCode).toBe(200);
    expect(rulesForOwner()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "rules.orch_pub", publishedBy: ORCH_ID }),
      ]),
    );
  });

  it("AC-6 schema не сломана: chat_messages.rule_ref и индекс существуют", () => {
    const cols = db
      .prepare("PRAGMA table_info(chat_messages)")
      .all()
      .map((c: { name: string }) => c.name);
    expect(cols).toContain("rule_ref");
    const idx = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_chat_messages_rule_ref'",
      )
      .get();
    expect(idx).toBeTruthy();
  });

  it("AC-6 ROLE_NAMES жив, и role_scope отвергает несуществующие ключи", () => {
    expect(ROLE_NAMES).toContain("builder");
    expect(() =>
      publishRule({
        ruleId: "rules.scope_check", version: 1, content: "Scope",
        roleScope: "builder,nonexistent-role", publishedBy: OWNER_ID,
      }),
    ).toThrow(/unknown_role_in_scope/);
  });

  it("AC-6 chat_send валидного сообщения правила с rule_ref сохраняет строку и связывает", async () => {
    // Само объявление делается через API publish; здесь — попутная проверка,
    // что в чате появилась запись kind='rule' с правильным rule_ref.
    publishRule({
      ruleId: "rules.chat_save", version: 1, content: "Чат-save",
      roleScope: "*", publishedBy: OWNER_ID,
    });
    expect(chatRowCount("rules.chat_save@v1")).toBe(1);
    expect(chatRuleCount()).toBeGreaterThan(0);
  });
});
