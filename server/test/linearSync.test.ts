import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import crypto from "node:crypto";
import {
  runLinearSyncPass,
  notifyLinearSyncStale,
  setLinearSyncEnabled,
  linearSyncState,
  linearSyncHealth,
  desiredLinearState,
  LINEAR_SYNC_STALE_MS,
} from "../src/lib/linearSync.js";

const uuid = () => crypto.randomUUID();

const STATES = [
  { id: "st-progress", name: "In Progress", type: "started" },
  { id: "st-review", name: "In Review", type: "started" },
  { id: "st-done", name: "Done", type: "completed" },
];

function fakeWriter() {
  const calls = { updates: [] as Array<{ issueId: string; stateId: string }>, comments: [] as Array<{ issueId: string; body: string }>, teamStates: 0 };
  let states = STATES;
  return {
    calls,
    setStates(next: typeof STATES) { states = next; },
    writer: {
      async updateIssueState(issueId: string, stateId: string) { calls.updates.push({ issueId, stateId }); },
      async createComment(issueId: string, body: string) { calls.comments.push({ issueId, body }); },
      async fetchTeamStates() { calls.teamStates += 1; return states; },
    },
  };
}

describe("обратная синхронизация TaskFlow → Linear", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;

  beforeAll(async () => {
    app = await buildApp();
    const r = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "owner", email: `${uuid()}@sync.test`, password: "password123" } })).json();
    owner = r.user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  });
  afterAll(async () => { await app.close(); });

  const makeTask = (over: { status?: string; agent_state?: string | null; blocked_reason?: string | null; blocked_at?: string | null } = {}) => {
    const id = uuid();
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,created_at) VALUES(?,?,?,?,datetime('now'))")
      .run(id, "Карточка", over.status ?? "active", owner);
    if (over.agent_state !== undefined || over.blocked_reason) {
      db.prepare("UPDATE tasks SET agent_state=?, blocked_reason=?, blocked_at=? WHERE id=?")
        .run(over.agent_state ?? null, over.blocked_reason ?? null, over.blocked_at ?? null, id);
    }
    return id;
  };

  const map = (task: string, source = uuid(), team = "team-1", remoteState = "Backlog") => {
    db.prepare("INSERT INTO linear_import_tasks(owner_id,workspace_id,source_id,task_id,source_url,snapshot,applied_fields) VALUES(?,?,?,?,?,?,?)")
      .run(owner, "ws-1", source, task, `https://linear.app/test/issue/${source}`,
        JSON.stringify({ team: { id: team }, state: { name: remoteState, type: "backlog" } }),
        JSON.stringify({ title: "x", description: null, priority: 4, due_date: null, status: "active", parent_id: null }));
    return source;
  };

  it("маппинг статусов: in_progress → In Progress, review → In Review, completed → Done", () => {
    expect(desiredLinearState({ status: "active", agent_state: "in_progress" })?.name).toBe("In Progress");
    expect(desiredLinearState({ status: "active", agent_state: "review" })?.name).toBe("In Review");
    expect(desiredLinearState({ status: "completed", agent_state: null })?.name).toBe("Done");
    expect(desiredLinearState({ status: "active", agent_state: null })).toBeNull();
  });

  it("смена уходит только по привязанным задачам, статус резолвится по имени", async () => {
    const mapped = makeTask({ agent_state: "in_progress" });
    const issue = map(mapped);
    const orphan = makeTask({ agent_state: "in_progress" });
    const fake = fakeWriter();
    const r = await runLinearSyncPass(owner, { writer: fake.writer });
    expect(r.sent).toBe(1);
    expect(fake.calls.updates).toEqual([{ issueId: issue, stateId: "st-progress" }]);
    expect((db.prepare("SELECT COUNT(*) n FROM linear_sync_queue WHERE task_id=?").get(orphan) as any).n).toBe(0);
    // Привязка запомнила отправленный статус.
    expect(db.prepare("SELECT last_state FROM linear_sync_tasks WHERE task_id=?").get(mapped)).toEqual({ last_state: "In Progress" });
  });

  it("review и завершение ведут в In Review и Done", async () => {
    const review = makeTask({ agent_state: "review" });
    const reviewIssue = map(review);
    const done = makeTask({ status: "completed" });
    const doneIssue = map(done);
    const fake = fakeWriter();
    await runLinearSyncPass(owner, { writer: fake.writer });
    expect(fake.calls.updates).toEqual(expect.arrayContaining([
      { issueId: reviewIssue, stateId: "st-review" },
      { issueId: doneIssue, stateId: "st-done" },
    ]));
  });

  it("возврат из Done обратно в работу снова отправляет In Progress", async () => {
    const task = makeTask({ agent_state: "in_progress" });
    const issue = map(task);
    await runLinearSyncPass(owner, { writer: fakeWriter().writer });
    db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(task);
    await runLinearSyncPass(owner, { writer: fakeWriter().writer });
    db.prepare("UPDATE tasks SET status='completed', agent_state=NULL WHERE id=?").run(task);
    await runLinearSyncPass(owner, { writer: fakeWriter().writer });
    db.prepare("UPDATE tasks SET status='active', agent_state='in_progress' WHERE id=?").run(task);
    const reopen = fakeWriter();
    const r = await runLinearSyncPass(owner, { writer: reopen.writer });
    expect(r.sent).toBe(1);
    expect(reopen.calls.updates).toEqual([{ issueId: issue, stateId: "st-progress" }]);
  });

  it("повторный проход идемпотентен и не шлёт мутацию второй раз", async () => {
    const task = makeTask({ agent_state: "in_progress" });
    const issue = map(task);
    const first = fakeWriter();
    await runLinearSyncPass(owner, { writer: first.writer });
    expect(first.calls.updates).toEqual([{ issueId: issue, stateId: "st-progress" }]);
    const second = fakeWriter();
    const r = await runLinearSyncPass(owner, { writer: second.writer });
    expect(r.queued).toBe(0);
    expect(second.calls.updates).toEqual([]);
  });

  it("задача уже в нужном статусе — мутация не отправляется", async () => {
    const task = makeTask({ agent_state: "in_progress" });
    map(task, uuid(), "team-1", "In Progress");
    const fake = fakeWriter();
    await runLinearSyncPass(owner, { writer: fake.writer });
    expect(fake.calls.updates).toEqual([]);
    expect(db.prepare("SELECT last_state FROM linear_sync_tasks WHERE task_id=?").get(task)).toEqual({ last_state: "In Progress" });
  });

  it("блокировка держит In Progress и добавляет комментарий один раз на эпизод", async () => {
    const task = makeTask({ agent_state: "blocked", blocked_reason: "Жду доступ к стенду", blocked_at: "2026-10-06 12:00:00" });
    const issue = map(task);
    const fake = fakeWriter();
    await runLinearSyncPass(owner, { writer: fake.writer });
    expect(fake.calls.updates).toEqual([{ issueId: issue, stateId: "st-progress" }]);
    expect(fake.calls.comments).toHaveLength(1);
    expect(fake.calls.comments[0].body).toContain("Жду доступ к стенду");
    const again = fakeWriter();
    await runLinearSyncPass(owner, { writer: again.writer });
    expect(again.calls.comments).toEqual([]);
  });

  it("сбой Linear не трогает карточку: задание остаётся в очереди с повтором", async () => {
    const task = makeTask({ agent_state: "in_progress" });
    const issue = map(task);
    const failing = {
      updateIssueState: async () => { throw new Error("Linear недоступен"); },
      createComment: async () => {},
      fetchTeamStates: async () => STATES,
    };
    const t0 = Date.now();
    const r = await runLinearSyncPass(owner, { writer: failing as any, now: t0 });
    expect(r.sent).toBe(0);
    const pending = db.prepare("SELECT status,attempts,next_attempt_at,last_error FROM linear_sync_queue WHERE task_id=? AND operation='state'").get(task) as any;
    expect(pending.status).toBe("pending");
    expect(pending.attempts).toBe(1);
    expect(Date.parse(pending.next_attempt_at.replace(" ", "T") + "Z")).toBeGreaterThan(t0);
    expect(pending.last_error).toContain("Linear недоступен");
    // Карточка не изменилась.
    expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(task)).toEqual({ agent_state: "in_progress" });

    // Раньше времени повтор не идёт.
    const early = fakeWriter();
    await runLinearSyncPass(owner, { writer: early.writer, now: t0 + 1000 });
    expect(early.calls.updates).toEqual([]);
    // После выдержки — уходит.
    const late = fakeWriter();
    await runLinearSyncPass(owner, { writer: late.writer, now: t0 + 10 * 60 * 1000 });
    expect(late.calls.updates).toEqual([{ issueId: issue, stateId: "st-progress" }]);
  });

  it("выключатель останавливает проход", async () => {
    const task = makeTask({ agent_state: "in_progress" });
    map(task);
    setLinearSyncEnabled(owner, false);
    const fake = fakeWriter();
    const r = await runLinearSyncPass(owner, { writer: fake.writer });
    expect(r.skipped).toBe("disabled");
    expect(fake.calls.updates).toEqual([]);
    setLinearSyncEnabled(owner, true);
    expect(linearSyncState(owner).enabled).toBe(1);
  });

  it("нет статуса с нужным именем — постоянный отказ, уведомление и без долбёжки", async () => {
    const task = makeTask({ agent_state: "in_progress" });
    map(task, uuid(), "team-no");
    const fake = fakeWriter();
    fake.setStates([{ id: "st-done-only", name: "Done", type: "completed" }]);
    const r = await runLinearSyncPass(owner, { writer: fake.writer });
    expect(r.failed).toBe(1);
    expect(db.prepare("SELECT status FROM linear_sync_queue WHERE task_id=? AND operation='state'").get(task)).toEqual({ status: "failed" });
    expect((db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='linear_sync_failed'").get(owner) as any).n).toBe(1);
    const again = fakeWriter();
    await runLinearSyncPass(owner, { writer: again.writer });
    expect(again.calls.updates).toEqual([]);
    // Ручной проход с retryFailed возвращает постоянный отказ в очередь.
    const recover = fakeWriter();
    const recovered = await runLinearSyncPass(owner, { writer: recover.writer, retryFailed: true });
    expect(recovered.sent).toBe(1);
    expect(recover.calls.updates).toEqual([{ issueId: (db.prepare("SELECT source_id FROM linear_import_tasks WHERE task_id=?").get(task) as any).source_id, stateId: "st-progress" }]);
  });

  it("простой отправки дольше 30 минут даёт уведомление, повтор — не чаще часа", () => {
    const task = makeTask({ agent_state: "in_progress" });
    const old = new Date(Date.now() - LINEAR_SYNC_STALE_MS - 60_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare("INSERT INTO linear_sync_queue(id,owner_id,workspace_id,task_id,issue_id,team_id,operation,payload,desired_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?, 'pending', ?)")
      .run(uuid(), owner, "ws-1", task, uuid(), "team-1", "state", "{}", "Застрявший", old);
    const before = (db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='linear_sync_stale'").get(owner) as any).n;
    expect(notifyLinearSyncStale(owner)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='linear_sync_stale'").get(owner) as any).n).toBe(before + 1);
    expect(notifyLinearSyncStale(owner)).toBe(false);
  });

  it("ручки синхронизации — только владельцу, выключатель и здоровье очереди отдаются", async () => {
    const member = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "member", email: `${uuid()}@sync.test`, password: "password123" } })).json();
    const asMember = { authorization: `Bearer ${member.token}` };
    const ownerEmail = (db.prepare("SELECT email FROM users WHERE id=?").get(owner) as any).email;
    const ownerToken = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ownerEmail, password: "password123" } })).json().token;
    const asOwner = { authorization: `Bearer ${ownerToken}` };
    expect((await app.inject({ method: "GET", url: "/api/integrations/linear/sync", headers: asMember })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/integrations/linear/sync", headers: asOwner, payload: { enabled: "да" } })).statusCode).toBe(422);
    const off = (await app.inject({ method: "PATCH", url: "/api/integrations/linear/sync", headers: asOwner, payload: { enabled: false } })).json();
    expect(off.enabled).toBe(false);
    const health = (await app.inject({ method: "GET", url: "/api/integrations/linear/sync", headers: asOwner })).json();
    expect(health.enabled).toBe(false);
    expect(health).toHaveProperty("pending");
    expect(health).toHaveProperty("oldest_pending_age_sec");
    await app.inject({ method: "PATCH", url: "/api/integrations/linear/sync", headers: asOwner, payload: { enabled: true } });
    expect(linearSyncHealth(owner).enabled).toBe(true);
  });
});
