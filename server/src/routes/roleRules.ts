// Экран «Реестр правил»: все правила ролей с флагом «доходит до ролей», пояснением и числом доставок.
// Правка владельца пишется в role_rule_overrides; role-rules.json приложение не переписывает.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { loadRoleRules, loadRuleOverrides, ruleActive, withOverride, type RoleRule, type RuleOverride } from "../lib/roleRules.js";

export const ruleTextHash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function deliveredUses(): Map<string, number> {
  const out = new Map<string, number>();
  const rows = db.prepare("SELECT ids_json, uses FROM role_rules_log").all() as Array<{ ids_json: string; uses: number }>;
  for (const row of rows) {
    let ids: unknown;
    try { ids = JSON.parse(row.ids_json); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    for (const id of new Set(ids)) if (typeof id === "string") out.set(id, (out.get(id) ?? 0) + row.uses);
  }
  return out;
}

function explanations(): Map<string, { text_hash: string; explanation: string }> {
  const rows = db.prepare("SELECT id, text_hash, explanation FROM role_rule_explanations").all() as Array<{ id: string; text_hash: string; explanation: string }>;
  return new Map(rows.map((r) => [r.id, r]));
}

function present(rule: RoleRule, ov: RuleOverride | undefined, uses: Map<string, number>, expl: ReturnType<typeof explanations>) {
  const r = withOverride(rule, ov);
  const e = expl.get(rule.id);
  return {
    id: rule.id,
    text: rule.text,
    category: rule.category,
    roles: r.roles,
    channels: rule.channels ?? [],
    where: rule.where ?? null,
    active: ruleActive(r, ov),
    recommended: ov?.recommended ?? false,
    // Пояснение актуально, пока текст правила не менялся.
    explanation: e && e.text_hash === ruleTextHash(rule.text) ? e.explanation : null,
    delivered_uses: uses.get(rule.id) ?? 0,
  };
}

function listRoles(): Array<{ id: string; name: string }> {
  return db.prepare("SELECT role_key AS id, name FROM users WHERE role_key IS NOT NULL AND archived = 0 ORDER BY name").all() as Array<{ id: string; name: string }>;
}

/** Правит только человек-владелец: роли (type='ai') и помощник сюда не пишут. */
function isHumanOwner(userId: string): boolean {
  const u = db.prepare("SELECT type FROM users WHERE id = ?").get(userId) as { type: string } | undefined;
  return !!u && u.type === "human" && isOwner(userId);
}

export function registerRoleRulesRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get("/api/role-rules", {
    preHandler: authPre,
    handler: async () => {
      const overrides = loadRuleOverrides();
      const uses = deliveredUses();
      const expl = explanations();
      const rules = loadRoleRules().filter((r) => r.kind !== "compose").map((r) => present(r, overrides.get(r.id), uses, expl));
      return { roles: listRoles(), rules };
    },
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean; roles?: "all" | string[]; recommended?: boolean } }>("/api/role-rules/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      if (!isHumanOwner(req.userId)) return reply.code(403).send({ error: "Править реестр правил может только владелец" });
      const rule = loadRoleRules().find((r) => r.id === req.params.id && r.kind !== "compose");
      if (!rule) return reply.code(404).send({ error: "Правило не найдено" });
      const body = req.body ?? {};
      if (body.active !== undefined && typeof body.active !== "boolean") return reply.code(400).send({ error: "active: ожидается true/false" });
      if (body.recommended !== undefined && typeof body.recommended !== "boolean") return reply.code(400).send({ error: "recommended: ожидается true/false" });
      if (body.roles !== undefined && body.roles !== "all" && !(Array.isArray(body.roles) && body.roles.every((x: unknown) => typeof x === "string")))
        return reply.code(400).send({ error: "roles: ожидается \"all\" или массив id ролей" });
      const prev = db.prepare("SELECT active, roles_json, recommended FROM role_rule_overrides WHERE id = ?").get(rule.id) as
        { active: number | null; roles_json: string | null; recommended: number } | undefined;
      const active = body.active === undefined ? (prev?.active ?? null) : (body.active ? 1 : 0);
      const rolesJson = body.roles === undefined ? (prev?.roles_json ?? null) : JSON.stringify(body.roles);
      const recommended = body.recommended === undefined ? (prev?.recommended ?? 0) : (body.recommended ? 1 : 0);
      db.prepare(`INSERT INTO role_rule_overrides(id, active, roles_json, recommended, updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET active=excluded.active, roles_json=excluded.roles_json, recommended=excluded.recommended, updated_at=excluded.updated_at`)
        .run(rule.id, active, rolesJson, recommended, new Date().toISOString());
      return present(rule, loadRuleOverrides().get(rule.id), deliveredUses(), explanations());
    },
  });
}
