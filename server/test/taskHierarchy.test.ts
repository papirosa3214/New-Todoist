// Вложенность задач — ровно один уровень (владелец 02.10.2026: «чтобы не
// просто в приложении закрыто, а сломаться не могло никак»). Проверяем все
// слои: API, сама база в обход API, импорт Linear.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

vi.mock("../src/runtime/roleRunQueue.js", async original => ({
  ...(await original<any>()), enqueueRoleRunJob: vi.fn(),
}));
vi.mock("../src/lib/linearSource.js", async (original) => ({
  ...(await original<any>()),
  fetchLinearSnapshot: vi.fn(),
  listLinearIssues: vi.fn(),
}));

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { createLinearPreview, commitLinearPreview } = await import("../src/lib/linearImport.js");
const { hierarchyViolations } = await import("../src/lib/taskHierarchy.js");
type LinearIssue = import("../src/lib/linearSource.js").LinearIssue;

const uuid = () => crypto.randomUUID();

describe("произвольная вложенность задач без циклов", () => {
  let app: FastifyInstance;
  let owner: { authorization: string };
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "TreeOwner", email: `tree-${uuid()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    owner = { authorization: `Bearer ${reg.json().token}` };
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  async function create(title: string, parent_id?: string) {
    return app.inject({ method: "POST", url: "/api/tasks", headers: owner, payload: { title, ...(parent_id ? { parent_id } : {}) } });
  }
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/tasks/${id}`, headers: owner, payload });

  it("API: разрешены дети у дочерних задач", async () => {
    const root = (await create("Корень")).json().task.id;
    const child = await create("Дочерняя", root);
    expect(child.statusCode).toBe(200);
    const grandchild = await create("Внучка", child.json().task.id);
    expect(grandchild.statusCode).toBe(200);
    expect((await create("Четвёртый уровень", grandchild.json().task.id)).statusCode).toBe(200);
  });

  it("API: перенос поддерева разрешён, циклы запрещены", async () => {
    const a = (await create("A")).json().task.id;
    const b = (await create("B")).json().task.id;
    await create("Дочь B", b);

    const bUnderA = await patch(b, { parent_id: a });
    expect(bUnderA.statusCode).toBe(200);
    expect((await patch(a, {parent_id:b})).statusCode).toBe(400);
    const self = await patch(a, { parent_id: a });
    expect(self.statusCode).toBe(400);

    // Законные ходы: перевесить дочь на другой корень и отвязать.
    const child = (await create("Дочь A", a)).json().task.id;
    expect((await patch(child, { parent_id: b })).statusCode).toBe(200);
    expect((await patch(child, { parent_id: null })).statusCode).toBe(200);
    expect((db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(child) as { parent_id: string | null }).parent_id).toBeNull();
  });

  it("база в обход API: глубокое дерево разрешено, циклы запрещены", async () => {
    const root = (await create("Корень БД")).json().task.id;
    const child = (await create("Дочь БД", root)).json().task.id;
    const other = (await create("Другая")).json().task.id;
    const insert = () =>
      db.prepare("INSERT INTO tasks (id, title, creator_id, parent_id) VALUES (?, 'Внучка', ?, ?)").run(uuid(), ownerId, child);
    expect(insert).not.toThrow();
    expect(() => db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(child, other)).not.toThrow();
    // Корень с дочерними нельзя повесить под другую задачу.
    expect(() => db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(other, root)).toThrow(/task_hierarchy/);
    expect(() => db.prepare("UPDATE tasks SET parent_id = id WHERE id = ?").run(other)).toThrow(/task_hierarchy/);
    expect(hierarchyViolations()).toEqual([]);
  });

  it("запуск вложенного поддерева допускает только листья, приёмка поднимается по одному уровню", async () => {
    const root = (await create("Корень запуска")).json().task.id;
    const branch = (await create("Ветка запуска", root)).json().task.id;
    const leaf = (await create("Лист запуска", branch)).json().task.id;
    const worker = (await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"Worker",email:`worker-${uuid()}@test`,password:"password123"}})).json().user.id;
    db.prepare("UPDATE tasks SET assignee_id=? WHERE id=?").run(worker,leaf);
    const {startDraftTree} = await import("../src/lib/ownerDraft.js");
    expect((await startDraftTree(branch, ownerId))?.started).toBe(1);
    const ready = (id:string) => (db.prepare("SELECT ready_for_pickup FROM tasks WHERE id=?").get(id) as any).ready_for_pickup;
    expect(ready(leaf)).toBe(1); expect(ready(branch)).toBe(0); expect(ready(root)).toBe(0);
    expect((await patch(leaf,{status:'completed'})).statusCode).toBe(200);
    const state = (id:string) => (db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id) as any).agent_state;
    expect(state(branch)).toBe('review'); expect(state(root)).not.toBe('review');
    expect((await patch(branch,{status:'completed'})).statusCode).toBe(200);
    expect(state(root)).toBe('review');
  });

  it("импорт Linear: трёхуровневое дерево сохраняет непосредственного родителя", () => {
    const issue = (parent: string | null = null): LinearIssue => ({
      id: uuid(), identifier: "TF-9", title: "Из Linear", description: "", url: "https://linear.app/t/issue/TF-9",
      priority: 2, dueDate: null, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", archivedAt: null,
      parent: parent ? { id: parent } : null, state: { id: "s", name: "Todo", type: "unstarted" },
      children: [], labels: [], comments: [], history: [], attachments: [], documents: [], relations: [], inverseRelations: [],
      assignee: null, project: null, team: { id: "team", name: "Команда" },
    } as unknown as LinearIssue);
    const root = issue();
    const child = issue(root.id);
    const grand = issue(child.id);
    root.children = [{ id: child.id }] as any;
    child.children = [{ id: grand.id }] as any;
    const source = {
      workspace: { id: "ws-tree", name: "WS" }, selected_ids: [grand.id], issues: [root, child, grand], fetched_at: new Date().toISOString(),
    } as any;
    const result = commitLinearPreview(ownerId, createLinearPreview(ownerId, source, null).preview_id);
    const idOf = (sourceId: string) => result.task_ids.find((t: any) => t.source_id === sourceId).task_id;
    const parentOf = (id: string) => (db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(id) as { parent_id: string | null }).parent_id;
    expect(parentOf(idOf(root.id))).toBeNull();
    expect(parentOf(idOf(child.id))).toBe(idOf(root.id));
    expect(parentOf(idOf(grand.id))).toBe(idOf(child.id));
  });
});
