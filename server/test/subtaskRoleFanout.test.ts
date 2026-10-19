// Умная параллелизация (владелец 30.09.2026): подобрать план ИЗ уже
// написанных открытых подзадач через локальный эмбеддинг-классификатор,
// не из шаблона по ключевым словам карточки. Мок embeddingClient —
// тот же детерминированный приём, что и в enrichSemantic.test.ts: тесты
// проверяют логику группировки/порога, а не саму модель.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resetJevSettings, saveJevSettings } from "../src/lib/jev.js";

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

  it("карточка, созданная сразу с подзадачами, получает автоплан ИЗ них (16.10.2026)", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth,
      payload: { title: "Виджеты на маке", subtasks: ["[builder] написать рендер виджетов", "[qa] проверить сценарии виджетов"] } });
    expect(created.statusCode).toBeLessThan(300);
    const taskId = created.json().task.id as string;
    const subtaskIds = (db.prepare("SELECT id FROM subtasks WHERE task_id=? AND collaboration_plan_id IS NULL").all(taskId) as { id: string }[]).map((r) => r.id);
    let nodes: { source_subtask_id: string | null }[] = [];
    for (let i = 0; i < 50 && !nodes.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      nodes = db.prepare("SELECT n.source_subtask_id FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE p.task_id=? AND p.status='draft'").all(taskId) as any[];
    }
    expect(nodes.length).toBe(2);
    expect(nodes.map((n) => n.source_subtask_id).sort()).toEqual([...subtaskIds].sort());
  });

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
    // Подзадача основной роли (builder) тоже стала узлом: после утверждения
    // карточку ведёт план, и вне плана она осталась бы ничьей (19.10.2026).
    expect(plan.nodes.map((n: { role_key: string }) => n.role_key).sort()).toEqual(["builder", "qa", "researcher"]);
    expect(plan.nodes.every((n: { source_subtask_id: string | null }) => n.source_subtask_id)).toBe(true);
    // Порядок по этапам: проверка ждёт всю работу (builder и researcher).
    const slot = (role: string) => plan.nodes.find((n: { role_key: string }) => n.role_key === role).slot_key;
    expect(plan.edges.map((e: { from_slot_key: string; to_slot_key: string }) => `${e.from_slot_key}>${e.to_slot_key}`).sort())
      .toEqual([`${slot("builder")}>${slot("qa")}`, `${slot("researcher")}>${slot("qa")}`].sort());

    const subtasksBefore = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth });
    expect(subtasksBefore.json()).toHaveLength(3); // ещё draft — дубля нет

    const irState=(await app.inject({method:"GET",url:`/api/tasks/${taskId}/integration-responsibility`,headers:ownerAuth})).json();
    expect((await app.inject({method:"PATCH",url:`/api/tasks/${taskId}/integration-responsibility`,headers:ownerAuth,payload:{mode:"manual",owner_id:irState.candidates[0].id}})).statusCode).toBe(200);
    const approved=await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.id}/approve`, headers: ownerAuth });
    expect(approved.statusCode).toBe(200);
    const subtasksAfter = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth })).json() as Array<{ collaboration_plan_id: string | null }>;
    expect(subtasksAfter).toHaveLength(3); // approve тоже не создал дублей — те же 3 строки
    expect(subtasksAfter.filter((s) => s.collaboration_plan_id).length).toBe(3); // все 3 стали узлами плана, ничьих нет
  });

  it("слабый, ни на что не похожий сигнал — подзадача уходит основной роли, а не повисает", async () => {
    const taskId = await makeTaskWithSubtasks("Разное", "builder", ["[qa] нормальный сигнал", "нечто совсем нейтральное без ключевых слов"]);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.nodes.map((n: { role_key: string }) => n.role_key).sort()).toEqual(["builder", "qa"]);
  });

  it("черновик не обходит ручные подзадачи: похожий шаг привязывается, лишняя подзадача становится шагом (19.10.2026)", async () => {
    const taskId = await makeTaskWithSubtasks("Каркас приложения", "builder", ["Основа приложения: токены и две темы", "Купить молоко"]);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: ownerAuth, payload: {
      profile: "manual", rationale: "черновик",
      nodes: [
        { slot_key: "base", role_key: "builder", expected_result: "Основа: приложение, токены и темы" },
        { slot_key: "check", role_key: "qa", expected_result: "Проверить вход и темы" },
      ],
      edges: [{ from_slot_key: "base", to_slot_key: "check", start_condition: "submitted" }],
    } });
    expect(res.statusCode).toBe(201);
    const plan = res.json().plan;
    const subs = db.prepare("SELECT id, title FROM subtasks WHERE task_id=?").all(taskId) as { id: string; title: string }[];
    const idOf = (t: string) => subs.find((x) => x.title === t)!.id;
    const base = plan.nodes.find((n: { slot_key: string }) => n.slot_key === "base");
    expect(base.source_subtask_id).toBe(idOf("Основа приложения: токены и две темы"));
    expect(base.requires_choice).toBe(true); // формулировки разные — выбор за владельцем
    const extra = plan.nodes.find((n: { source_subtask_id: string | null }) => n.source_subtask_id === idOf("Купить молоко"));
    expect(extra.role_key).toBe("builder");
    expect(plan.edges.some((e: { from_slot_key: string; to_slot_key: string }) => e.from_slot_key === extra.slot_key && e.to_slot_key === "check")).toBe(true);
  });

  // Галочка «Роли для подзадач» в разделе JEV (16.10.2026). TypeSafe не
  // зовём: fetch подменён ответом с выбором ролей по каждой подзадаче.
  describe("JEV подбирает роли подзадачам", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
      resetJevSettings();
    });

    function jevAnswers(answers: Record<string, unknown>) {
      return vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 }));
    }

    it("уверенный выбор JEV назначает роль даже там, где эмбеддинги молчат; мелкий пункт остаётся исполнителю", async () => {
      saveJevSettings({ apiKey: "apik_test-1234567890", subtaskRoleEnabled: true });
      globalThis.fetch = jevAnswers({
        role_0: { type: "choice", choice: "designer", confidence: 0.9, probabilities: {} },
        separate_0: { type: "noul", noul: 0.95 },
        role_1: { type: "choice", choice: "qa", confidence: 0.85, probabilities: {} },
        separate_1: { type: "noul", noul: 0.9 },
        role_2: { type: "choice", choice: "researcher", confidence: 0.9, probabilities: {} },
        separate_2: { type: "noul", noul: 0.1 },
      }) as any;
      const taskId = await makeTaskWithSubtasks("Экран настроек", "builder", ["нейтральный пункт раз", "нейтральный пункт два", "нейтральный пункт три"]);
      const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
      expect(res.statusCode).toBe(201);
      const plan = res.json().plan;
      // Мелкий пункт (separate < 0.5) — узел основной роли, а не ничья подзадача.
      expect(plan.nodes.map((n: { role_key: string }) => n.role_key).sort()).toEqual(["builder", "designer", "qa"]);
      expect(plan.rationale).toContain("Роли подобраны JEV: 3 из 3");
    });

    it("JEV не уверен — по этой подзадаче работает прежний подбор по эмбеддингам", async () => {
      saveJevSettings({ apiKey: "apik_test-1234567890", subtaskRoleEnabled: true, subtaskRoleMinConfidence: 0.8 });
      globalThis.fetch = jevAnswers({
        role_0: { type: "choice", choice: "designer", confidence: 0.4, probabilities: {} },
        separate_0: { type: "noul", noul: 0.9 },
        role_1: { type: "choice", choice: "designer", confidence: 0.4, probabilities: {} },
        separate_1: { type: "noul", noul: 0.9 },
      }) as any;
      const taskId = await makeTaskWithSubtasks("Фича", "builder", ["[qa] проверить сценарии", "[researcher] собрать примеры"]);
      const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
      expect(res.json().plan.nodes.map((n: { role_key: string }) => n.role_key).sort()).toEqual(["qa", "researcher"]);
      expect(res.json().plan.rationale).not.toContain("JEV");
    });

    it("JEV упал — всё как раньше; галочка выключена — JEV не зовётся", async () => {
      saveJevSettings({ apiKey: "apik_test-1234567890", subtaskRoleEnabled: true });
      globalThis.fetch = vi.fn(async () => new Response("boom", { status: 529 })) as any;
      const t1 = await makeTaskWithSubtasks("Фича", "builder", ["[qa] проверить", "[researcher] собрать"]);
      const r1 = await app.inject({ method: "POST", url: `/api/tasks/${t1}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
      expect(r1.json().plan.nodes.map((n: { role_key: string }) => n.role_key).sort()).toEqual(["qa", "researcher"]);

      saveJevSettings({ subtaskRoleEnabled: false });
      const spy = vi.fn();
      globalThis.fetch = spy as any;
      const t2 = await makeTaskWithSubtasks("Фича 2", "builder", ["[qa] проверить", "[researcher] собрать"]);
      await app.inject({ method: "POST", url: `/api/tasks/${t2}/collaboration-plans/suggest-from-subtasks`, headers: ownerAuth });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
