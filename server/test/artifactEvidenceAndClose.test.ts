// 07.10.2026, «Разработчик не стартовал»: дизайнер сдавал идентификатор документа как доказательство,
// получал отказ «нужны path-ссылки» и закрывал шаг простой отметкой — следующий шаг ждал молча.
// 1) ссылка на документ (строка или doc_id) принимается как доказательство;
// 2) роль не может закрыть узел с контрактом на результат без сданного результата.
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("результат шага плана: доказательства и закрытие", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let analystAuth: string;
  let taskId: string;
  let analysisId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Artifact owner", email: `artifact-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    analystAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "Результат шага " + crypto.randomUUID() } });
    taskId = created.json().task.id as string;
    const plan = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
        profile: "manual",
        nodes: [
          { slot_key: "analysis", role_key: "analyst", output_artifact: { key: "feature_spec", type: "specification", format: "json", required_fields: ["scope"] } },
          { slot_key: "delivery", role_key: "builder" },
        ],
        edges: [{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "artifact_ready", artifact_key: "feature_spec" }],
      },
    });
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().plan.id}/approve`, headers: { authorization: ownerAuth } });
    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<{ id: string; plan_node_key: string }>;
    analysisId = subtasks.find((s) => s.plan_node_key === "analysis")!.id;
  });

  it("роль не закрывает узел с контрактом простой отметкой, пока результат не сдан", async () => {
    const res = await app.inject({ method: "PATCH", url: `/api/subtasks/${analysisId}`, headers: { authorization: analystAuth }, payload: { done: true, result: "готово" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("feature_spec");
    expect((db.prepare("SELECT done FROM subtasks WHERE id = ?").get(analysisId) as { done: number }).done).toBe(0);
  });

  async function deliveryNode() {
    const plans = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth } })).json().plans as Array<{ status: string; nodes: Array<{ slot_key: string; execution_state: string; waiting_for: Array<{ from_slot_key: string; artifact_key: string; reason: string }> }> }>;
    return plans.find((p) => p.status === "approved")!.nodes.find((n) => n.slot_key === "delivery")!;
  }

  it("ожидающий шаг называет, чего ждёт: от кого и какой результат", async () => {
    const node = await deliveryNode();
    expect(node.execution_state).toBe("waiting");
    expect(node.waiting_for).toEqual([{ from_slot_key: "analysis", artifact_key: "feature_spec", reason: "результат ещё не сдан" }]);
  });

  it("мусорное доказательство по-прежнему отклоняется, понятным текстом", async () => {
    const res = await app.inject({ method: "POST", url: `/api/subtasks/${analysisId}/artifact`, headers: { authorization: analystAuth }, payload: { summary: "Спека", payload: { scope: "в рамках" }, evidence: [{ note: "без ссылки" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("ссылка на файл или документ");
  });

  it("идентификатор документа принимается как доказательство и приводится к path", async () => {
    const res = await app.inject({ method: "POST", url: `/api/subtasks/${analysisId}/artifact`, headers: { authorization: analystAuth }, payload: { summary: "Спека", payload: { scope: "в рамках" }, evidence: [{ doc_id: "22ff1691-aae0-40cc-9c16-00c80964de5f" }, "docs/spec.md"] } });
    expect(res.statusCode).toBe(201);
    const stored = JSON.parse((db.prepare("SELECT evidence_json FROM subtask_artifact_versions WHERE subtask_id = ?").get(analysisId) as { evidence_json: string }).evidence_json);
    expect(stored.map((e: { path: string }) => e.path)).toEqual(["22ff1691-aae0-40cc-9c16-00c80964de5f", "docs/spec.md"]);
  });

  it("после сдачи результата шаг больше ничего не ждёт", async () => {
    const node = await deliveryNode();
    expect(node.waiting_for).toEqual([]);
  });
});
