// Интеграционный тест для этапа A (10.10.2026, d3a628eb-…): POST /api/chat
// должен класть сообщение в chat_messages, вызвать agentWake и обновить
// `delivery_state` по результатам решения.
//
// ВАЖНО: чтобы не дёргать реальный `tf_wake_dispatch.py` по SSH на Mac, в
// тесте подменяем раннер через DI. Сам раннер живёт в webhookSubscriptions
// как `defaultRunner` — у `agentWake.getDefaultAgentWakeRunner()` он
// импортируется динамически. Подмены на уровне модуля в JS мы делаем
// через глобальный override `defaultRunner` (см. setDefaultRunnerForTests
// ниже) и сбрасываем в afterEach.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import db, { hashApiToken } from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  setRuntimeDefaultRunner,
  type WakeCommandResult,
} from "../src/lib/webhookSubscriptions.js";

interface FakeRunnerState {
  ok: boolean;
  error?: string | null;
  calls: Array<{ threadId: string; message: string }>;
}
let fakeState: FakeRunnerState = {
  ok: true,
  calls: [],
};

const fakeRunnerFactory = (
  state: FakeRunnerState,
): ((threadId: string, message: string) => Promise<WakeCommandResult>) => {
  return async (threadId: string, message: string) => {
    state.calls.push({ threadId, message });
    return state.ok ? { ok: true } : { ok: false, error: state.error ?? "fake fail" };
  };
};

let app: FastifyInstance;
let ownerToken: string;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(async () => {
  // Регистрируем владельца ЗАНОВО перед каждым тестом: afterEach ниже
  // удаляет всех пользователей кроме u1, а JWT привязан к user.id —
  // иначе INSERT в chat_messages упадёт на FK (from_user_id ссылается
  // на уже удалённую учётку).
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Chat owner",
      email: `chat-owner-${process.pid}-${Date.now()}@test`,
      password: "password123",
    },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json();
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(body.user.id);
  ownerToken = body.token as string;
  fakeState = { ok: true, calls: [] };
  // Свежий fake-state на тест. Подмена раннера не зависит от БД,
  // единственное требование — после прохода теста снять, чтобы
  // соседний файл (если vitest решит параллелить) не подхватил fake.
  setRuntimeDefaultRunner(null);
  setRuntimeDefaultRunner(fakeRunnerFactory(fakeState));
});

afterEach(async () => {
  // Чистим только таблицы этапа A, чтобы не разломать baseline миграций.
  // Порядок важен: сначала дочерние (tasks), потом их родителей
  // (projects), иначе FK на project_id роняет DELETE.
  db.prepare("DELETE FROM chat_messages").run();
  db.prepare("DELETE FROM agent_inbox").run();
  db.prepare("DELETE FROM task_events").run();
  // POST /api/chat/read заводит строку chat_reads на читателя (FK на users),
  // без этой чистки DELETE users ниже падает на FOREIGN KEY.
  db.prepare("DELETE FROM chat_reads").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
  db.prepare("DELETE FROM attachments").run();
  // Уведомления ссылаются на задачу без каскада — убрать раньше tasks.
  db.prepare("DELETE FROM notifications").run();
  db.prepare(
    "DELETE FROM tasks WHERE id NOT IN (SELECT id FROM tasks WHERE id LIKE 'seed-%')",
  ).run();
  db.prepare(
    "DELETE FROM projects WHERE id NOT IN (SELECT id FROM projects WHERE id LIKE 'seed-%')",
  ).run();
  db.prepare("DELETE FROM users WHERE id NOT IN ('u1')").run();
  setRuntimeDefaultRunner(null);
});

function bearer(t: string) {
  return { authorization: `Bearer ${t}` };
}

function makeAgent(name: string): string {
  const id = `u-agent-${name}`;
  db.prepare(
    `INSERT OR REPLACE INTO users (id, name, email, password_hash, role, type, status)
     VALUES (?, ?, ?, 'x', 'agent', 'ai', 'offline')`,
  ).run(id, name, `${id}@test`);
  return id;
}

/** Свежий last_seen_at — адресат считается online (порог 60 с). */
function markOnline(userId: string): void {
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(
    userId,
  );
}

/** Статический api_token агенту: читаем чат от его имени, чтобы проверить
 *  ACK получателя (POST /api/chat/read). */
function setApiToken(userId: string, token: string): void {
  db.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(
    hashApiToken(token),
    userId,
  );
}

function makeProject(id: string): void {
  // Идемпотентно: если проект уже есть, ничего не делаем. Это
  // важно, потому что makeSubscription вызывает makeProject на
  // каждый тест, и к этому моменту на проект могут уже ссылаться
  // только что созданные задачи — DELETE их заблокирует по FK.
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
  ).run(
    opts.id,
    `wake-test-${opts.id}`,
    opts.assigneeId,
    opts.projectId ?? null,
    opts.agentState,
  );
}

function setOwnerProject(taskId: string, projectId: string): void {
  makeProject(projectId);
  db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(
    projectId,
    taskId,
  );
}

function makeSubscription(opts: {
  id: string;
  enabled: boolean;
  threadId: string | null;
  projectId: string | null;
}): void {
  if (opts.projectId) makeProject(opts.projectId);
  db.prepare(
    `INSERT OR REPLACE INTO webhook_subscriptions
     (id, owner_user_id, name, url, secret_hash, secret_preview, enabled, event_kinds,
      project_id, codex_thread_id, created_at, updated_at)
     VALUES (?, 'u1', ?, 'http://test', 'h', '****0000', ?, '[]', ?, ?, datetime('now'), datetime('now'))`,
  ).run(opts.id, `sub-${opts.id}`, opts.enabled ? 1 : 0, opts.projectId, opts.threadId);
}

describe("POST /api/chat → этап A: пробуждение idle-агента", () => {
  it("slot_wake: адресат на слоте in_progress с подпиской → wake_runner вызван, delivery_state='wake_queued'", async () => {
    const addrId = makeAgent("alpha");
    makeTask({ id: "t-wake", assigneeId: addrId, agentState: "in_progress" });
    setOwnerProject("t-wake", "p-wake");
    makeSubscription({
      id: "sub-wake-1",
      enabled: true,
      threadId: "01a120f9-0000-4000-8000-0000000000aa",
      projectId: "p-wake",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer(ownerToken),
      payload: {
        text: "wake up please",
        to_user_id: addrId,
        task_id: "t-wake",
        channel: "agents",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivery_state).toBe("wake_queued");
    expect(fakeState.calls.length).toBe(1);
    expect(fakeState.calls[0].threadId).toBe(
      "01a120f9-0000-4000-8000-0000000000aa",
    );
    expect(fakeState.calls[0].message.startsWith("[wake]")).toBe(true);

    // Событие wake_dispatched в task_events для наблюдаемости.
    const evs = db
      .prepare(
        "SELECT kind, to_value FROM task_events WHERE kind='wake_dispatched'",
      )
      .all() as Array<{ kind: string; to_value: string }>;
    expect(evs.length).toBe(1);
    const payload = JSON.parse(evs[0].to_value);
    expect(payload.thread_id).toBe(
      "01a120f9-0000-4000-8000-0000000000aa",
    );
    expect(payload.to_user_id).toBe(addrId);
  });

  it("unreachable: слот есть, но подписки с thread_id нет → delivery_state='unreachable' и task_events.unreachable_role", async () => {
    const addrId = makeAgent("beta");
    makeTask({ id: "t-no-sub", assigneeId: addrId, agentState: "in_progress" });
    setOwnerProject("t-no-sub", "p-no-sub");
    // Намеренно НЕ создаём подписку для этого проекта.

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer(ownerToken),
      payload: {
        text: "hello?",
        to_user_id: addrId,
        task_id: "t-no-sub",
        channel: "agents",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivery_state).toBe("unreachable");
    expect(fakeState.calls.length).toBe(0);

    const evs = db
      .prepare(
        "SELECT to_value FROM task_events WHERE kind='unreachable_role'",
      )
      .all() as Array<{ to_value: string }>;
    expect(evs.length).toBe(1);
    const payload = JSON.parse(evs[0].to_value);
    expect(payload.reason).toBe("no_slot");
    expect(payload.to_user_id).toBe(addrId);
    expect(payload.chat_message_id).toBe(body.id);
  });

  it("офлайн-адресат вне слота → delivery_state='unreachable', reason='offline'", async () => {
    const addrId = makeAgent("gamma");
    // Адресат никогда не стучался — last_seen_at = NULL → isOnline=false.
    const taskId = "t-gamma";
    makeTask({ id: taskId, assigneeId: addrId, agentState: "in_progress" });
    setOwnerProject(taskId, "p-gamma");

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer(ownerToken),
      payload: {
        text: "ping?",
        to_user_id: addrId,
        task_id: null, // намеренно без задачи → путь general_wake
        channel: "agents",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivery_state).toBe("unreachable");
    expect(fakeState.calls.length).toBe(0);

    const evs = db
      .prepare(
        "SELECT to_value FROM task_events WHERE kind='unreachable_role'",
      )
      .all() as Array<{ to_value: string }>;
    // Без task_id — событие `task_events` не пишется (нет привязки), это
    // сознательно: чтобы уведомление «не доставлено» было привязано к
    // конкретной задаче, в которой адресат не отвечает. Тест держим
    // строго с task_id ниже.
    expect(evs.length).toBe(0);
  });

  it("general_wake: адресат онлайн без слота → wake по общему каналу, delivery_state='wake_queued'", async () => {
    const addrId = makeAgent("delta");
    markOnline(addrId);
    // Общий канал — подписка без привязки к проекту.
    makeSubscription({
      id: "sub-general",
      enabled: true,
      threadId: "01a120f9-0000-4000-8000-0000000000bb",
      projectId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer(ownerToken),
      payload: {
        text: "проснись, общий канал",
        to_user_id: addrId,
        channel: "agents",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivery_state).toBe("wake_queued");
    expect(fakeState.calls.length).toBe(1);
    expect(fakeState.calls[0].threadId).toBe(
      "01a120f9-0000-4000-8000-0000000000bb",
    );
  });

  it("delivered: получатель читает ленту → адресованное сообщение становится 'delivered'", async () => {
    const addrId = makeAgent("epsilon");
    markOnline(addrId);
    setApiToken(addrId, "tf-epsilon-token");
    makeSubscription({
      id: "sub-delivered",
      enabled: true,
      threadId: "01a120f9-0000-4000-8000-0000000000cc",
      projectId: null,
    });

    const sent = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer(ownerToken),
      payload: {
        text: "прочти меня",
        to_user_id: addrId,
        channel: "agents",
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().delivery_state).toBe("wake_queued");

    // Получатель читает ленту: taskflow_chat_read делает GET + POST /read.
    const read = await app.inject({
      method: "POST",
      url: "/api/chat/read",
      headers: { authorization: "Bearer tf-epsilon-token" },
    });
    expect(read.statusCode).toBe(200);

    const row = db
      .prepare("SELECT delivery_state FROM chat_messages WHERE id = ?")
      .get(sent.json().id) as { delivery_state: string };
    expect(row.delivery_state).toBe("delivered");
  });

  it("сообщение 'всем' (to_user_id=all) НЕ запускает wake", async () => {
    // to_user_id='all' — broadcast. routeMessage для роли владельца
    // считает toUserId=null (сторож `if (toUserId && routed.toUserId)`
    // не пускает в блок wake), delivery_state остаётся 'pending'.
    // Этот сценарий важнее «владелец-в-owner»: он не зависит от того,
    // какой пользователь сейчас считается ownerId() (раньше зависело,
    // если сравнение fromUserId===owner решало routing).
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: bearer(ownerToken),
      payload: {
        text: "ко всем",
        to_user_id: "all",
        channel: "agents",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivery_state).toBe("pending");
    expect(fakeState.calls.length).toBe(0);
  });
});
