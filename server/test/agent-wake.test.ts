// Юнит-тесты для resolveAgentWake: проверяем три сценария из
// implementation_pack (10.10.2026, d3a628eb-…). Это «чистая» часть
// (без side-effects на стороне раннера) — на ней самые дешёвые тесты
// и главная развилка решений. Поведение `applyAgentWake` и
// `dispatchAgentWake` проверяется в chat-wake-integration.test.ts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { resolveAgentWake, applyAgentWake } from "../src/lib/agentWake.js";

function makeUser(opts: {
  id: string;
  lastSeenAt: string | null;
  role?: string;
  type?: "human" | "ai";
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO users (id, name, email, password_hash, role, type, status, last_seen_at)
     VALUES (?, ?, ?, 'x', ?, ?, 'offline', ?)`,
  ).run(
    opts.id,
    `u-${opts.id}`,
    `${opts.id}@test`,
    opts.role ?? "agent",
    opts.type ?? "ai",
    opts.lastSeenAt,
  );
}

function makeOwner(): void {
  // u1 живёт ещё с миграции 039_seed_owner и на него ссылается масса
  // таблиц (tasks/webhook_subscriptions/...). Поэтому НЕ удаляем его,
  // а перезаписываем поля. INSERT OR IGNORE перебивает существующую
  // строку при (id) коллизии через REPLACE — но это выкинуло бы
  // зависимые ссылки. Ограничиваемся безопасным UPDATE: role всегда
  // owner, имя фиксированное. Этого хватает: реальный owner-токен
  // для тестов создаёт buildApp+/api/auth/register в интеграционном
  // файле, а здесь нам важен лишь факт наличия строки.
  db.prepare(
    `UPDATE users SET role='owner', name='owner', email='u1@test'
      WHERE id='u1'`,
  ).run();
  // Если u1 нет (миграция почему-то не отработала) — добавляем.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type, status)
     VALUES ('u1','owner','u1@test','x','owner','human','online')`,
  ).run();
}

function makeProject(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, owner_id) VALUES (?, ?, NULL)",
  ).run(id, `p-${id}`);
}

function makeTask(opts: {
  id: string;
  assigneeId: string;
  agentState: string | null;
  projectId?: string | null;
}): void {
  if (opts.projectId) makeProject(opts.projectId);
  db.prepare(
    `INSERT OR REPLACE INTO tasks (id, title, assignee_id, project_id, agent_state)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.id, `task-${opts.id}`, opts.assigneeId, opts.projectId ?? null, opts.agentState);
}

function makeSubscription(opts: {
  id: string;
  enabled: boolean;
  threadId: string | null;
  projectId: string | null;
  ownerId?: string;
}): void {
  if (opts.projectId) makeProject(opts.projectId);
  db.prepare(
    `INSERT OR REPLACE INTO webhook_subscriptions
     (id, owner_user_id, name, url, secret_hash, secret_preview, enabled, event_kinds,
      project_id, codex_thread_id, created_at, updated_at)
     VALUES (?, ?, ?, 'http://test', 'h', '****0000', ?, '[]', ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    opts.id,
    opts.ownerId ?? "u1",
    `sub-${opts.id}`,
    opts.enabled ? 1 : 0,
    opts.projectId,
    opts.threadId,
  );
}

beforeAll(() => {
  // Поднимаем БД до финальной схемы (включая миграцию 130 с
  // delivery_state). В buildApp() это делается автоматически, но мы
  // тестируем БЕЗ приложения — поэтому обе миграции вызываем сами.
  migrate();
  runMigrations();
});

beforeEach(() => {
  // Миграции уже прогнаны setup.ts → runMigrations на старте. Но
  // каждый тест работает с собственным набором строк, поэтому
  // подчищаем только то, что сами насадим.
  db.prepare("DELETE FROM chat_messages").run();
  db.prepare("DELETE FROM task_events").run();
  db.prepare("DELETE FROM agent_inbox").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
  db.prepare(
    "DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks WHERE id LIKE 'seed-%')",
  ).run();
  db.prepare("DELETE FROM users WHERE id NOT IN ('u1')").run();
});

describe("resolveAgentWake: слот в работе + подписка с thread_id", () => {
  it("адресат на слоте этой задачи in_progress, thread_id найден → slot_wake", () => {
    makeOwner();
    makeUser({ id: "u-addr", lastSeenAt: null, role: "agent", type: "ai" });
    makeTask({
      id: "t-slot",
      assigneeId: "u-addr",
      agentState: "in_progress",
      projectId: "p-1",
    });
    makeSubscription({
      id: "s-1",
      enabled: true,
      threadId: "01a120f9-0000-4000-8000-000000000001",
      projectId: "p-1",
    });
    const decision = resolveAgentWake({
      toUserId: "u-addr",
      taskId: "t-slot",
      chatMessageId: "m-1",
    });
    expect(decision.action).toBe("slot_wake");
    if (decision.action === "slot_wake") {
      expect(decision.threadId).toBe(
        "01a120f9-0000-4000-8000-000000000001",
      );
      expect(decision.message.startsWith("[wake]")).toBe(true);
      expect(decision.chatMessageId).toBe("m-1");
    }
  });

  it("review на слоте — всё ещё slot_wake (В3: «спящий» включает review)", () => {
    makeOwner();
    makeUser({ id: "u-addr", lastSeenAt: null, role: "agent", type: "ai" });
    makeTask({
      id: "t-review",
      assigneeId: "u-addr",
      agentState: "review",
      projectId: "p-2",
    });
    makeSubscription({
      id: "s-review",
      enabled: true,
      threadId: "01a120f9-0000-4000-8000-000000000002",
      projectId: "p-2",
    });
    const decision = resolveAgentWake({
      toUserId: "u-addr",
      taskId: "t-review",
      chatMessageId: "m-r",
    });
    expect(decision.action).toBe("slot_wake");
  });

  it("blocked на слоте — НЕ slot_wake; проверяется общий online (тут — offline)", () => {
    makeOwner();
    makeUser({ id: "u-addr", lastSeenAt: null, role: "agent", type: "ai" });
    makeTask({
      id: "t-blocked",
      assigneeId: "u-addr",
      agentState: "blocked",
      projectId: "p-3",
    });
    const decision = resolveAgentWake({
      toUserId: "u-addr",
      taskId: "t-blocked",
      chatMessageId: "m-b",
    });
    expect(decision.action).toBe("unreachable");
    if (decision.action === "unreachable") {
      expect(decision.reason).toBe("offline");
    }
  });

  it("задача не на слоте этого исполнителя — проверяется общий online", () => {
    makeOwner();
    makeUser({ id: "u-addr", lastSeenAt: null, role: "agent", type: "ai" });
    makeUser({ id: "u-OTHER", lastSeenAt: null, role: "agent", type: "ai" });
    makeTask({
      id: "t-other",
      assigneeId: "u-OTHER",
      agentState: "in_progress",
      projectId: "p-4",
    });
    const decision = resolveAgentWake({
      toUserId: "u-addr",
      taskId: "t-other",
      chatMessageId: "m-other",
    });
    expect(decision.action).toBe("unreachable");
    if (decision.action === "unreachable") {
      expect(decision.reason).toBe("offline");
    }
  });
});

describe("resolveAgentWake: нет подписки / нет пользователя", () => {
  it("слот есть, но ни одной активной подписки с thread_id на проект — no_slot", () => {
    makeOwner();
    makeUser({ id: "u-addr", lastSeenAt: null, role: "agent", type: "ai" });
    makeTask({
      id: "t-no-sub",
      assigneeId: "u-addr",
      agentState: "in_progress",
      projectId: "p-no-sub",
    });
    // Намеренно НЕ создаём подписку.
    const decision = resolveAgentWake({
      toUserId: "u-addr",
      taskId: "t-no-sub",
      chatMessageId: "m-ns",
    });
    expect(decision.action).toBe("unreachable");
    if (decision.action === "unreachable") {
      expect(decision.reason).toBe("no_slot");
    }
  });

  it("несуществующий адресат — no_user (не «offline»)", () => {
    const decision = resolveAgentWake({
      toUserId: "u-ghost",
      taskId: "t-1",
      chatMessageId: "m-g",
    });
    expect(decision.action).toBe("unreachable");
    if (decision.action === "unreachable") {
      expect(decision.reason).toBe("no_user");
    }
  });
});

describe("resolveAgentWake: общий online (для general_wake В6)", () => {
  it("адресат офлайн (last_seen_at старше 60 с) — offline", () => {
    makeOwner();
    const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
    makeUser({ id: "u-stale", lastSeenAt: staleIso, role: "agent", type: "ai" });
    const decision = resolveAgentWake({
      toUserId: "u-stale",
      taskId: null,
      chatMessageId: "m-stale",
    });
    expect(decision.action).toBe("unreachable");
    if (decision.action === "unreachable") {
      expect(decision.reason).toBe("offline");
    }
  });

  it("адресат online, без слота, есть общий wake-тред — general_wake по общему каналу (В6 закрыт)", () => {
    makeOwner();
    const freshIso = new Date().toISOString();
    makeUser({ id: "u-fresh", lastSeenAt: freshIso, role: "agent", type: "ai" });
    makeSubscription({
      id: "s-general",
      enabled: true,
      threadId: "01a120f9-0000-4000-8000-0000000000aa",
      projectId: null,
    });
    const decision = resolveAgentWake({
      toUserId: "u-fresh",
      taskId: null,
      chatMessageId: "m-fresh",
    });
    expect(decision.action).toBe("general_wake");
    if (decision.action === "general_wake") {
      expect(decision.threadId).toBe(
        "01a120f9-0000-4000-8000-0000000000aa",
      );
      expect(decision.message.startsWith("[wake]")).toBe(true);
      expect(decision.chatMessageId).toBe("m-fresh");
    }
  });

  it("адресат online, но wake-канала нет — no_slot (пробуждать нечем)", () => {
    makeOwner();
    const freshIso = new Date().toISOString();
    makeUser({ id: "u-fresh2", lastSeenAt: freshIso, role: "agent", type: "ai" });
    const decision = resolveAgentWake({
      toUserId: "u-fresh2",
      taskId: null,
      chatMessageId: "m-fresh2",
    });
    expect(decision.action).toBe("unreachable");
    if (decision.action === "unreachable") {
      expect(decision.reason).toBe("no_slot");
    }
  });
});

describe("applyAgentWake: side-effects в БД", () => {
  it("unreachable → пишет task_events.kind='unreachable_role' и delivery_state='unreachable'", () => {
    makeOwner();
    makeUser({ id: "u-x", lastSeenAt: null, role: "agent", type: "ai" });
    // Чтобы событие записалось — нужна задача. Создаём минимальную.
    makeTask({
      id: "t-evt",
      assigneeId: "u-x",
      agentState: "blocked",
      projectId: null,
    });
    // Вставим чат-сообщение иначе UPDATE на нём не сработает (chat_messages
    // требует from_user_id). INSERT сделаем заранее.
    db.prepare("DELETE FROM chat_messages WHERE id = 'm-evt'").run();
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, to_user_id, task_id, kind, text, channel, delivery_state)
       VALUES ('m-evt', 'u1', 'u-x', 't-evt', NULL, 'ping', 'agents', 'pending')`,
    ).run();

    const decision = resolveAgentWake({
      toUserId: "u-x",
      taskId: "t-evt",
      chatMessageId: "m-evt",
    });
    expect(decision.action).toBe("unreachable");

    const result = applyAgentWake(decision, "u-x", "t-evt", {
      runner: async () => ({ ok: true }),
      recordDispatchEvent: false,
    });
    expect(result.deliveryState).toBe("unreachable");
    expect(result.wakeAttempted).toBe(false);
    expect(result.unreachableEventRecorded).toBe(true);

    // Колонка в чате должна стоять.
    const cmRow = db
      .prepare("SELECT delivery_state FROM chat_messages WHERE id='m-evt'")
      .get() as { delivery_state: string };
    expect(cmRow.delivery_state).toBe("unreachable");

    // Событие в task_events.
    const ev = db
      .prepare(
        "SELECT kind, to_value FROM task_events WHERE kind='unreachable_role'",
      )
      .all() as Array<{ kind: string; to_value: string }>;
    expect(ev.length).toBe(1);
    const payload = JSON.parse(ev[0].to_value);
    expect(payload.chat_message_id).toBe("m-evt");
    expect(payload.to_user_id).toBe("u-x");
    expect(payload.reason).toBe("offline");
  });

  it("повторный apply с тем же chatMessageId — не плодит дублей", () => {
    makeOwner();
    makeUser({ id: "u-y", lastSeenAt: null, role: "agent", type: "ai" });
    makeTask({
      id: "t-y",
      assigneeId: "u-y",
      agentState: "blocked",
      projectId: null,
    });
    db.prepare("DELETE FROM chat_messages WHERE id = 'm-y'").run();
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, to_user_id, task_id, kind, text, channel, delivery_state)
       VALUES ('m-y', 'u1', 'u-y', 't-y', NULL, 'ping', 'agents', 'pending')`,
    ).run();

    const decision = resolveAgentWake({
      toUserId: "u-y",
      taskId: "t-y",
      chatMessageId: "m-y",
    });
    for (let i = 0; i < 3; i++) {
      applyAgentWake(decision, "u-y", "t-y", {
        runner: async () => ({ ok: true }),
        recordDispatchEvent: false,
      });
    }
    const events = db
      .prepare(
        "SELECT 1 FROM task_events WHERE kind='unreachable_role' AND task_id='t-y'",
      )
      .all();
    expect(events.length).toBe(1);
  });
});
