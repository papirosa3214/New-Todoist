// Умная параллелизация (владелец 30.09.2026): подобрать план ИЗ уже
// написанных открытых подзадач через локальный эмбеддинг-классификатор,
// не из шаблона по ключевым словам карточки. Мок embeddingClient —
// тот же детерминированный приём, что и в enrichSemantic.test.ts: тесты
// проверяют логику группировки/порога, а не саму модель.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const embeddingClientMock = vi.hoisted(() => ({ getEmbeddings: vi.fn() }));
vi.mock("../src/lib/embeddingClient.js", () => embeddingClientMock);

// unlockReadyPlanSubtasks/startPlanSubtaskRun сами стартуют роль
// (runRoleInProcess) на approve — этот файл проверяет только подбор/
// группировку/занятие существующей строки, не реальный запуск роли, тот же
// приём, что в task-collaboration-plans.test.ts.
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "test-run", completion: Promise.resolve() }) };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

function embeddingFor(text: string): number[] {
  if (text.includes("[qa]")) return [0, 1, 0];
  if (text.includes("[researcher]")) return [0, 0, 1];
  if (text.includes("[builder]")) return [1, 0, 0];
  // Нулевой вектор — cosine() отдаёт 0 против ЛЮБОЙ роли (denom=0), а не
  // просто «маленькое, но какое-то» число: детерминированно ниже порога,
  // без геометрических прикидок на трёх ортах.
  return [0, 0, 0];
}

async function seedRoleEmbeddings() {
  db.prepare("DELETE FROM role_embeddings").run();
  const { getEmbeddings } = await import("../src/lib/embeddingClient.js");
  const rows = [
    { role: "builder", text: "[builder] написать и починить код" },
    { role: "qa", text: "[qa] проверить сценарии и найти дефекты" },
    { role: "researcher", text: "[researcher] собрать факты и источники" },
  ];
  const insert = db.prepare("INSERT INTO role_embeddings (role, embedding, tags) VALUES (?, ?, ?)");
  for (const row of rows) {
    const { embeddings } = await getEmbeddings(row.text);
    insert.run(row.role, Buffer.from(new Float32Array(embeddings as number[]).buffer), "[]");
  }
}

describe("умная параллелизация подзадач (subtaskRoleFanout)", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };

  function setupEmbeddingMock(): void {
    embeddingClientMock.getEmbeddings.mockReset();
    embeddingClientMock.getEmbeddings.mockImplementation(async (input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input];
      const embeddings = texts.map(embeddingFor);
      return { embeddings: Array.isArray(input) ? embeddings : embeddings[0], dim: 3, durationMs: 0 };
    });
  }

  beforeEach(setupEmbeddingMock);

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Fanout owner", email: `fanout-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    // beforeEach ещё не наступил (он перед каждым it, не перед beforeAll) —
    // мок нужен здесь явно, иначе getEmbeddings() ниже вызовет
    // необнастроенный vi.fn() и вернёт undefined.
    setupEmbeddingMock();
    await seedRoleEmbeddings();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function makeTaskWithSubtasks(title: string, assigneeRole: string, subtaskTitles: string[]): Promise<string> {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth, payload: { title, assignee_id: roleUserId(assigneeRole) } });
    const taskId = created.json().task.id as string;
    for (const t of subtaskTitles) {
      await app.inject({ method: "POST", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth, payload: { title: t } });
    }
    return taskId;
  }

  it("меньше двух открытых подзадач — не предлагает план", async () => {
    const taskId = await makeTaskWithSubtasks("Мелкая правка", "builder", ["[builder] один маленький шаг"]);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggested).toBe(false);
  });

  it("все подзадачи совпадают с текущим исполнителем — не предлагает план (нет реального параллелизма)", async () => {
    const taskId = await makeTaskWithSubtasks("Рефакторинг кода", "builder", ["[builder] шаг один", "[builder] шаг два"]);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
    expect(res.json().suggested).toBe(false);
  });

  it("подзадачи с разными ролями — предлагает draft-план, занимающий существующие строки", async () => {
    const taskId = await makeTaskWithSubtasks(
      "Фича с проверкой",
      "builder",
      ["[builder] реализовать логику", "[qa] проверить сценарии", "[researcher] собрать примеры конкурентов"],
    );
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
    expect(res.statusCode).toBe(201);
    const plan = res.json().plan;
    expect(plan.status).toBe("draft");
    expect(plan.profile).toBe("manual");
    // Совпавшая с текущим исполнителем (builder) подзадача НЕ стала узлом —
    // остаётся обычной подзадачей, её делает уже назначенный builder.
    expect(plan.nodes.map((n: { role_key: string }) => n.role_key).sort()).toEqual(["qa", "researcher"]);
    expect(plan.nodes.every((n: { source_subtask_id: string | null }) => n.source_subtask_id)).toBe(true);
    expect(plan.edges).toEqual([]); // без принудительного порядка — оба стартуют сразу параллельно

    const subtasksBefore = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth });
    expect(subtasksBefore.json()).toHaveLength(3); // ещё draft — дубля нет

    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.id}/approve`, headers: ownerAuth });
    const subtasksAfter = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth })).json() as Array<{ collaboration_plan_id: string | null }>;
    expect(subtasksAfter).toHaveLength(3); // approve тоже не создал дублей — те же 3 строки
    expect(subtasksAfter.filter((s) => s.collaboration_plan_id).length).toBe(2); // ровно 2 стали узлами плана
  });

  it("слабый, ни на что не похожий сигнал — подзадача остаётся как есть, не становится узлом", async () => {
    const taskId = await makeTaskWithSubtasks("Разное", "builder", ["[qa] нормальный сигнал", "нечто совсем нейтральное без ключевых слов"]);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.nodes).toHaveLength(1);
    expect(res.json().plan.nodes[0].role_key).toBe("qa");
  });
});
