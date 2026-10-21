// Карточка 1d2ad736: пустой ответ модели (content без текста, usage 0/0,
// без ошибки провайдера) больше не проходит как успешный ход.
//
// Проверяем три вещи:
//   1) детект пустого ответа отличает его от обычного ответа, от вызова
//      инструмента и от ошибки модели;
//   2) рабочий ход роли с пустым ответом закрывает попытку как failed, а
//      причина видна в attempts.reason и в ленте карточки;
//   3) живой ход в чате узнаёт пустой ответ и не молчит.
//
// Ответ модели подменён: createAgentSession отдаёт сессию, в которую
// prompt() кладёт заранее заданное сообщение ассистента.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

const script = vi.hoisted(() => ({
  steps: null as null | ((tools: Map<string, any>, prompt: string) => Promise<void>),
  assistant: null as null | Record<string, unknown>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      const tools = new Map<string, any>((options.customTools ?? []).map((t: any) => [t.name, t]));
      const state = { messages: [] as any[] };
      return {
        session: {
          subscribe: () => () => {},
          prompt: async (text: string) => {
            if (script.steps) await script.steps(tools, text);
            if (script.assistant) state.messages.push(script.assistant);
          },
          steer: async () => {},
          abort: async () => {},
          dispose: () => {},
          state,
        },
      };
    },
  };
});

vi.mock("../src/runtime/PiRuntimeAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/PiRuntimeAdapter.js")>();
  return {
    ...actual,
    getModelRuntime: async () => ({ getModel: (_p: string, id: string) => ({ id, provider: "minimax" }) }),
  };
});

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { runRoleInProcess } = await import("../src/runtime/inProcessRun.js");
const { emptyAssistantAnswer, lastAssistantEmptyAnswer } = await import("../src/runtime/providerFailover.js");
const { startLiveTurn, _resetLiveTurnsForTests } = await import("../src/runtime/chatLiveTurn.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");

const uid = () => crypto.randomUUID();

/** Ответ ассистента без текста: провайдер вернул пустой content и usage 0/0. */
const EMPTY_ANSWER = {
  role: "assistant",
  content: [] as { type: string; text?: string }[],
  usage: { input: 0, output: 0 },
  stopReason: "stop",
};

/** Обычный ответ: есть текст и потраченные токены. */
const NORMAL_ANSWER = {
  role: "assistant",
  content: [{ type: "text", text: "Готово" }],
  usage: { input: 120, output: 25 },
  stopReason: "stop",
};

describe("детект пустого ответа модели", () => {
  it("пустой content и usage 0/0 — сбой, а не ответ", () => {
    expect(emptyAssistantAnswer(EMPTY_ANSWER)).toContain("пустой ответ");
    expect(lastAssistantEmptyAnswer({ state: { messages: [{ role: "user" }, EMPTY_ANSWER] } })).toContain(
      "пустой ответ",
    );
  });

  it("обычный ответ с текстом и usage > 0 — не сбой", () => {
    expect(emptyAssistantAnswer(NORMAL_ANSWER)).toBeNull();
    expect(lastAssistantEmptyAnswer({ state: { messages: [NORMAL_ANSWER] } })).toBeNull();
  });

  it("вызов инструмента — ход ещё идёт, ответ будет следующим", () => {
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
      usage: { input: 120, output: 0 },
      stopReason: "toolUse",
    };
    expect(emptyAssistantAnswer(toolCall)).toBeNull();
  });

  it("ошибка модели и отмена ловятся своим путём, а не как пустой ответ", () => {
    expect(emptyAssistantAnswer({ role: "assistant", content: [], stopReason: "error", errorMessage: "429" })).toBeNull();
    expect(emptyAssistantAnswer({ role: "assistant", content: [], stopReason: "aborted" })).toBeNull();
  });
});

describe("живой ход в чате", () => {
  it("пустой ответ ассистента виден как сбой, обычный ответ — нет", () => {
    _resetLiveTurnsForTests();
    const turn = startLiveTurn({
      chatId: "c-empty",
      userId: "role_builder",
      name: "Разработчик",
      audience: () => ["u1"],
    });
    turn.onEvent({ type: "message_end", message: EMPTY_ANSWER });
    expect(turn.emptyAnswerReason()).toContain("пустой ответ");
    _resetLiveTurnsForTests();
  });

  it("после обычного ответа сбойом не считается", () => {
    _resetLiveTurnsForTests();
    const turn = startLiveTurn({
      chatId: "c-normal",
      userId: "role_builder",
      name: "Разработчик",
      audience: () => ["u1"],
    });
    turn.onEvent({ type: "message_end", message: NORMAL_ANSWER });
    expect(turn.emptyAnswerReason()).toBeNull();
    _resetLiveTurnsForTests();
  });
});

describe("рабочий ход роли с пустым ответом", () => {
  let app: FastifyInstance;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "EmptyOwner", email: `empty-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Карточка с планом, узлом роли и открытой попыткой — как в бою. */
  function seedSlot(title: string): { taskId: string; stepId: string; attemptId: string } {
    const taskId = `empty-${uid()}`;
    db.prepare(
      `INSERT INTO tasks (id, title, creator_id, assignee_id, status, dispatched_role, ready_for_pickup)
       VALUES (?, ?, ?, 'role_builder', 'active', 'builder', 1)`,
    ).run(taskId, title, ownerId);
    const planId = uid();
    db.prepare(
      `INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by)
       VALUES (?, ?, 1, 'approved', 'manual', 'тест пустого ответа', 'role_builder')`,
    ).run(planId, taskId);
    const stepId = uid();
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, position, collaboration_plan_id, plan_node_key, done)
       VALUES (?, ?, 'Сделать', 1, ?, 'work', 0)`,
    ).run(stepId, taskId, planId);
    db.prepare(
      `INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result)
       VALUES (?, ?, 'work', 'builder', 1, 'результат')`,
    ).run(uid(), planId);
    const attemptId = uid();
    db.prepare(
      `INSERT INTO attempts (id, task_id, subtask_id, executor_id, runner, model, provider, started_at)
       VALUES (?, ?, ?, 'role_builder', 'pi', 'minimax/MiniMax-M3.1-Flash', 'minimax', datetime('now'))`,
    ).run(attemptId, taskId, stepId);
    db.prepare(
      `UPDATE subtasks SET agent_state='in_progress', agent_id='role_builder', current_attempt_id=?,
        collaboration_plan_id=?, plan_node_key='work' WHERE id=?`,
    ).run(attemptId, planId, stepId);
    return { taskId, stepId, attemptId };
  }

  async function runSlot(taskId: string, stepId: string): Promise<void> {
    const run = await runRoleInProcess({ taskId, role: "builder", subtaskId: stepId, mode: "work" });
    await run.completion.catch(() => {});
    // settle шага стартует макрозадачей после завершения хода.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  it("пустой ответ: попытка failed с причиной, причина в ленте карточки", async () => {
    const { taskId, stepId, attemptId } = seedSlot("Пустой ответ модели");
    script.assistant = EMPTY_ANSWER;
    try {
      await runSlot(taskId, stepId);
    } finally {
      script.assistant = null;
    }
    const attempt = db.prepare("SELECT outcome, reason FROM attempts WHERE id=?").get(attemptId) as
      { outcome: string | null; reason: string | null };
    expect(attempt.outcome).toBe("failed");
    expect(String(attempt.reason)).toContain("пустой ответ");
    const notes = db
      .prepare("SELECT text FROM comments WHERE task_id=?")
      .all(taskId)
      .map((row: any) => String(row.text))
      .join(" | ");
    expect(notes).toContain("пустой ответ");
  });

  it("обычный ответ: ход не считается сбоем", async () => {
    const { taskId, stepId, attemptId } = seedSlot("Обычный ответ модели");
    script.assistant = NORMAL_ANSWER;
    try {
      await runSlot(taskId, stepId);
    } finally {
      script.assistant = null;
    }
    const attempt = db.prepare("SELECT outcome, reason FROM attempts WHERE id=?").get(attemptId) as
      { outcome: string | null; reason: string | null };
    expect(attempt.outcome).not.toBe("failed");
    expect(String(attempt.reason)).not.toContain("пустой ответ");
  });
});
