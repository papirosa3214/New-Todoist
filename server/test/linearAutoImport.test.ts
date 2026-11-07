import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import crypto from "node:crypto";
import type { LinearIssue, LinearSnapshot } from "../src/lib/linearSource.js";
import {
  runLinearAutoImportPass,
  notifyLinearAutoImportStale,
  setLinearAutoImportEnabled,
  linearAutoImportState,
} from "../src/lib/linearAutoImport.js";
import { getSetting } from "../src/lib/serverSettings.js";
const LINEAR_AUTOIMPORT_STALE_MS = getSetting("linear_autoimport_stale_ms");
import {
  fetchLinearSnapshot,
  findLinearProjectsByLabel,
  listLinearProjectIssues,
} from "../src/lib/linearSource.js";

vi.mock("../src/lib/linearSource.js", async original => ({
  ...(await original<any>()),
  fetchLinearSnapshot: vi.fn(),
  findLinearProjectsByLabel: vi.fn(),
  listLinearProjectIssues: vi.fn(),
}));

const uuid = () => crypto.randomUUID();

const issue = (id = uuid(), parent: string | null = null, over: Partial<LinearIssue> = {}): LinearIssue => ({
  id, identifier: "TF-1", title: "Внешняя задача", description: "## Работа\nСделать", url: `https://linear.app/test/issue/${id}`,
  priority: 2, dueDate: null, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T11:00:00Z", archivedAt: null,
  parent: parent ? { id: parent } : null, state: { id: "state", name: "In Progress", type: "started" },
  children: [], labels: [], comments: [], history: [], attachments: [], documents: [], relations: [], inverseRelations: [],
  assignee: null, project: { id: "project", name: "Проект" }, team: { id: "team", name: "Команда" },
  ...over,
});

const snapshot = (issues: LinearIssue[]): LinearSnapshot => ({
  workspace: { id: "ws-1", name: "Личное" },
  selected_ids: issues.map(i => i.id),
  issues,
  fetched_at: new Date().toISOString(),
});

const nowProject = { id: "prov-now", name: "Сейчас-проект", url: "https://linear.app/project/now", state: "started", labels: [{ id: "lbl", name: "Сейчас" }] };

describe("фоновый автоимпорт Linear", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;

  beforeAll(async () => {
    app = await buildApp();
    const r = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "owner", email: `${uuid()}@auto.test`, password: "password123" } })).json();
    owner = r.user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  });
  afterAll(async () => { await app.close(); });

  it("создаёт один раз карточку проекта и дочернюю задачу, повторный проход дублей не плодит", async () => {
    const a = issue();
    vi.mocked(findLinearProjectsByLabel).mockResolvedValue({ workspace: { id: "ws-1", name: "Личное" }, projects: [nowProject] });
    vi.mocked(listLinearProjectIssues).mockResolvedValue([{ id: a.id, identifier: a.identifier, title: a.title, description: a.description, url: a.url, priority: a.priority, dueDate: a.dueDate, createdAt: a.createdAt, updatedAt: a.updatedAt, archivedAt: null, parent: null, state: a.state }]);
    vi.mocked(fetchLinearSnapshot).mockResolvedValue(snapshot([a]));

    const first = await runLinearAutoImportPass(owner);
    expect(first.created).toBe(1);
    const tasks = db.prepare("SELECT id,parent_id,assignee_id FROM tasks WHERE creator_id=? ORDER BY title").all(owner) as any[];
    expect(tasks).toHaveLength(2);
    const projectCard = tasks.find(t => t.parent_id === null)!;
    const issueCard = tasks.find(t => t.parent_id === projectCard.id)!;
    expect(issueCard.parent_id).toBe(projectCard.id);
    // Автоимпорт НЕ ставит черновик плана и не запускает работу.
    expect(db.prepare("SELECT COUNT(*) n FROM task_collaboration_plans WHERE task_id=?").get(issueCard.id)).toEqual({ n: 0 });

    const second = await runLinearAutoImportPass(owner);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE creator_id=?").get(owner) as any).n).toBe(2);
  });

  it("изменённую задачу обновляет, а по карточке с начатой работой сохраняет локальные поля", async () => {
    const a = issue();
    vi.mocked(findLinearProjectsByLabel).mockResolvedValue({ workspace: { id: "ws-1", name: "Личное" }, projects: [nowProject] });
    const list = (updatedAt: string) => ([{ id: a.id, identifier: a.identifier, title: a.title, description: a.description, url: a.url, priority: a.priority, dueDate: a.dueDate, createdAt: a.createdAt, updatedAt, archivedAt: null, parent: null, state: a.state }]);
    vi.mocked(listLinearProjectIssues).mockResolvedValue(list(a.updatedAt));
    vi.mocked(fetchLinearSnapshot).mockResolvedValue(snapshot([a]));
    await runLinearAutoImportPass(owner);

    vi.mocked(listLinearProjectIssues).mockResolvedValue(list("2026-10-02T10:00:00Z"));
    vi.mocked(fetchLinearSnapshot).mockResolvedValue(snapshot([{ ...a, updatedAt: "2026-10-02T10:00:00Z", title: "Новое название" }]));
    const r = await runLinearAutoImportPass(owner);
    expect(r.updated).toBe(1);
    const card = db.prepare("SELECT t.id,t.title FROM linear_import_tasks m JOIN tasks t ON t.id=m.task_id WHERE m.owner_id=? AND m.source_id=?").get(owner, a.id) as any;
    expect(card.title).toBe("Новое название");

    // Работа началась: локальное название важнее внешнего.
    db.prepare("UPDATE tasks SET agent_state='in_progress', title='Моя правка' WHERE id=?").run(card.id);
    vi.mocked(listLinearProjectIssues).mockResolvedValue(list("2026-10-03T10:00:00Z"));
    vi.mocked(fetchLinearSnapshot).mockResolvedValue(snapshot([{ ...a, updatedAt: "2026-10-03T10:00:00Z", title: "Ещё одно внешнее" }]));
    await runLinearAutoImportPass(owner);
    expect((db.prepare("SELECT title FROM tasks WHERE id=?").get(card.id) as any).title).toBe("Моя правка");
  });

  it("отменённые задачи не импортирует", async () => {
    const a = issue(uuid(), null, { state: { id: "c", name: "Canceled", type: "canceled" } });
    vi.mocked(findLinearProjectsByLabel).mockResolvedValue({ workspace: { id: "ws-1", name: "Личное" }, projects: [nowProject] });
    vi.mocked(listLinearProjectIssues).mockResolvedValue([{ id: a.id, identifier: a.identifier, title: a.title, description: a.description, url: a.url, priority: a.priority, dueDate: a.dueDate, createdAt: a.createdAt, updatedAt: a.updatedAt, archivedAt: null, parent: null, state: a.state }]);
    const before = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE creator_id=?").get(owner) as any).n;
    const r = await runLinearAutoImportPass(owner);
    expect(r.created).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE creator_id=?").get(owner) as any).n).toBe(before);
  });

  it("выключатель владельца останавливает службу", async () => {
    setLinearAutoImportEnabled(owner, false);
    const r = await runLinearAutoImportPass(owner);
    expect(r.skipped).toBe("disabled");
    setLinearAutoImportEnabled(owner, true);
    expect(linearAutoImportState(owner).enabled).toBe(1);
  });

  it("простой дольше 30 минут даёт владельцу уведомление, повтор — не чаще часа", () => {
    const state = linearAutoImportState(owner);
    const old = new Date(Date.now() - LINEAR_AUTOIMPORT_STALE_MS - 60_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare("UPDATE linear_autoimport_state SET last_success_at=?, notified_at=NULL, last_error='Composio недоступен' WHERE owner_id=?").run(old, owner);
    const before = (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='linear_autoimport_stale'").get(owner) as any).n;
    expect(notifyLinearAutoImportStale(owner)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='linear_autoimport_stale'").get(owner) as any).n).toBe(before + 1);
    expect(notifyLinearAutoImportStale(owner)).toBe(false);
    // Свежий успех — уведомления нет.
    db.prepare("UPDATE linear_autoimport_state SET last_success_at=datetime('now') WHERE owner_id=?").run(owner);
    expect(notifyLinearAutoImportStale(owner)).toBe(false);
  });

  it("ручки автоимпорта — только владельцу, выключатель сохраняется", async () => {
    const member = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "member", email: `${uuid()}@auto.test`, password: "password123" } })).json();
    const asMember = { authorization: `Bearer ${member.token}` };
    const ownerToken = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: (db.prepare("SELECT email FROM users WHERE id=?").get(owner) as any).email, password: "password123" } })).json().token;
    const asOwner = { authorization: `Bearer ${ownerToken}` };
    expect((await app.inject({ method: "GET", url: "/api/integrations/linear/autoimport", headers: asMember })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/integrations/linear/autoimport", headers: asOwner, payload: { enabled: false } })).json()).toEqual({ enabled: false });
    expect((await app.inject({ method: "GET", url: "/api/integrations/linear/autoimport", headers: asOwner })).json().enabled).toBe(false);
    expect((await app.inject({ method: "PATCH", url: "/api/integrations/linear/autoimport", headers: asOwner, payload: { enabled: "да" } })).statusCode).toBe(422);
    await app.inject({ method: "PATCH", url: "/api/integrations/linear/autoimport", headers: asOwner, payload: { enabled: true } });
  });
});
