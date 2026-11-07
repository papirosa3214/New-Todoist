// Этап 3 плана карточки 252c400e: независимое read-only обсуждение.
//
// Проверяем то, что обещано приёмкой:
//   • обсуждение — отдельная комната с own-жизненным циклом;
//   • gateway технически запрещает запись в режиме обсуждения
//     (режим «task_discussion»), чтение остаётся;
//   • промежуточные реплики обсуждения в работу НЕ уходят;
//   • рабочая сессия исполнителя продолжает работу: аренда слота не
//     берётся, статус этапа и его session_id не меняются;
//   • второй рабочий исполнитель не создаётся.
//
// Модель и работа Пи замоканы: проверяется серверная часть.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  delivered: [] as Array<{ taskId: string; role: string; text: string }>,
  calls: 0,
  registered: [] as string[],
  active: [] as string[],
}));
vi.mock("../src/runtime/inProcessRun.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/inProcessRun.js")>()),
  deliverTopicToWork: async (taskId: string, role: string, messageId: string, text: string) => {
    harness.delivered.push({ taskId, role, text });
    return "idle" as const;
  },
  deliverChatToWork: async (role: string, chatId: string, messageId: string, text: string) => {
    harness.delivered.push({ taskId: chatId, role, text });
    return "idle" as const;
  },
}));
vi.mock("../src/runtime/PiRuntimeAdapter.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/PiRuntimeAdapter.js")>()),
  getModelRuntime: async () => ({ getModel: (_provider: string, id: string) => ({ id }) }),
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      harness.calls += 1;
      harness.registered = options.tools;
      let listener = (event: any) => {};
      return {
        session: {
          setActiveToolsByName: (names: string[]) => {harness.active=names;},
          subscribe: (fn: any) => {
            listener = fn;
          },
          abort: async () => {},
          dispose: () => {},
          state: { messages: [] },
          prompt: async (text: string) => {
            options.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
            const answer = {
              role: "assistant",
              content: [{ type: "text", text: "Разъяснил: порядок такой." }],
              stopReason: "stop",
              api: "test",
              provider: "test",
              model: "test",
              usage: {},
              timestamp: Date.now(),
            };
            options.sessionManager.appendMessage(answer);
            listener({ type: "agent_end", messages: [answer] });
            return answer;
          },
        },
      };
    },
  };
});

import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { operationRestriction } from "../src/runtime/universalTaskflow.js";
import {
  acceptsReplies,
  buildDiscussionSummary,
  closeDiscussion,
  isDiscussionChat,
  openDiscussion,
  readDiscussion,
} from "../src/runtime/taskDiscussion.js";
import { runDiscussionTurn } from "../src/runtime/taskDiscussionSession.js";
import { acquireDiscussionSession } from "../src/runtime/slotSession.js";

const TASK = "task_discussion_stage3";
const SLOT = "slot_discussion_stage3";

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,'Обсуждение','u1')").run(TASK);
  db.prepare(
    "INSERT INTO subtasks(id,task_id,title,agent_id,agent_state) VALUES(?,?,'Работа','role_builder','in_progress')",
  ).run(SLOT, TASK);
});

// test/setup owns the disposable DB, including guard-created audit/snapshot rows.


beforeEach(() => {
  harness.delivered.length = 0;
  db.prepare("DELETE FROM chat_messages WHERE chat_id IN (SELECT chat_id FROM task_discussions)").run();
  db.prepare("DELETE FROM task_discussion_handoffs").run();
  db.prepare("DELETE FROM task_discussions").run();
});

function newDiscussion() {
  const { discussion, chatId } = openDiscussion({
    taskId: TASK,
    subtaskId: SLOT,
    role: "builder",
    ownerUserId: "u1",
  });
  return { discussion, chatId };
}

describe("обсуждение карточки: read-only и изоляция", () => {
  it("gateway запрещает запись в режиме обсуждения, чтение оставляет", () => {
    const ctx = { role: "builder", mode: "task_discussion", runId: "r" } as any;
    expect(operationRestriction("taskflow_comment", ctx)?.code).toBe("MODE_RESTRICTED");
    expect(operationRestriction("taskflow_subtask_done", ctx)?.code).toBe("MODE_RESTRICTED");
    expect(operationRestriction("taskflow_host_bash", ctx)?.code).toBe("MODE_RESTRICTED");
    expect(operationRestriction("taskflow_doc_write", ctx)?.code).toBe("MODE_RESTRICTED");
    expect(operationRestriction("taskflow_task", ctx)).toBeUndefined();
    expect(operationRestriction("taskflow_doc_read", ctx)).toBeUndefined();
    // Обычный чат в режиме «discussion» — работа по задаче без
    // ограничений (владелец 20.10.2026): его политика не меняется.
    const chatCtx = { role: "builder", mode: "discussion", runId: "r" } as any;
    expect(operationRestriction("taskflow_comment", chatCtx)).toBeUndefined();
  });

  it("обсуждение — отдельная комната и принимает реплики только в состоянии open", () => {
    const { discussion, chatId } = newDiscussion();
    expect(isDiscussionChat(chatId)).toBe(true);
    expect(discussion.state).toBe("open");
    expect(acceptsReplies(discussion.discussion_id)).toBe(true);
    expect(isDiscussionChat("chat-common")).toBe(false);
  });

  it("ответ в обсуждении не доходит до работы и не трогает этап", async () => {
    const { discussion, chatId } = newDiscussion();
    const slotBefore = db.prepare("SELECT * FROM subtasks WHERE id=?").get(SLOT);
    const result = await runDiscussionTurn({
      discussionId: discussion.discussion_id,
      role: "builder",
      prompt: "Почему так?",
      cwd: "/tmp",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Разъяснил");
    // Никакой доставки в рабочий ход.
    expect(harness.delivered).toHaveLength(0);
    // Этап и его состояние не изменились.
    expect(db.prepare("SELECT * FROM subtasks WHERE id=?").get(SLOT)).toEqual(slotBefore);
    // Ответ лежит в комнате обсуждения.
    const messages = db
      .prepare("SELECT from_user_id,text FROM chat_messages WHERE chat_id=? ORDER BY rowid")
      .all(chatId) as Array<{ from_user_id: string; text: string }>;
    expect(messages.some((m) => m.text === "Разъяснил: порядок такой.")).toBe(true);
  });

  it("обсуждение не берёт аренду рабочего слота: работа может идти параллельно", async () => {
    const { discussion } = newDiscussion();
    // Аренда обсуждения — отдельная: рабочий слот свободен.
    const release = await acquireDiscussionSession(discussion.discussion_id);
    expect(db.prepare("SELECT agent_state FROM subtasks WHERE id=?").get(SLOT)).toEqual({
      agent_state: "in_progress",
    });
    release();
  });

  it("после закрытия новые реплики не принимаются", async () => {
    const { discussion } = newDiscussion();
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('close1','u1','Вопрос','chat',?)",
    ).run(discussion.chat_id);
    const closed = await closeDiscussion({ discussionId: discussion.discussion_id, actorUserId: "u1" });
    expect(closed.discussion.state).toBe("closed");
    expect(acceptsReplies(discussion.discussion_id)).toBe(false);
    const rejected = await runDiscussionTurn({
      discussionId: discussion.discussion_id,
      role: "builder",
      prompt: "Ещё вопрос",
      cwd: "/tmp",
    });
    expect(rejected.rejected).toBe("closed");
  });

  it("итог обсуждения — три раздела по полному разговору", () => {
    const { discussion, chatId } = newDiscussion();
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('sum1','u1','Что делаем?','chat',?)",
    ).run(chatId);
    db.prepare(
      "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('sum2','role_builder','Делаем так','chat',?)",
    ).run(chatId);
    const summary = buildDiscussionSummary(chatId);
    expect(summary.goal).toContain("Что делаем?");
    expect(summary.was).toContain("Делаем так");
    expect(summary.next.length).toBeGreaterThan(0);
  });
  it("integration: discussion rejects unclassified infrastructure tools", () => {
    expect(operationRestriction("mcp__infra__exec", {role:"builder", mode:"task_discussion", runId:"test"} as any)?.code).toBe("MODE_RESTRICTED");
  });

  it("integration: close waits for reply preparation and saved answer", async () => {
    const {discussion}=newDiscussion();
    const running=runDiscussionTurn({discussionId:discussion.discussion_id,role:"builder",prompt:"Поясни",cwd:"/tmp"});
    const closing=closeDiscussion({discussionId:discussion.discussion_id,actorUserId:"u1",waitForAnswerMs:1000});
    expect(readDiscussion(discussion.discussion_id)!.state).toBe("closing");
    await running;
    const closed=await closing;
    expect(closed.summary!.was).toContain("Разъяснил");
  });
  it("integration: discussion uses current native catalog registration", async () => {
    const {discussion}=newDiscussion();
    harness.active=[];
    const result=await runDiscussionTurn({discussionId:discussion.discussion_id,role:"builder",prompt:"Поясни",cwd:"/tmp"});
    expect(result.ok).toBe(true);
    expect(harness.registered).toContain("taskflow_projects");
    expect(harness.active).toContain("taskflow_batch");
    expect(harness.active).not.toContain("taskflow_tools");
  });

  for (const native of [false,true]) it(`integration: discussion error guard never blocks work (${native ? "native" : "gateway"})`, async () => {
    const attemptId="discussion-isolation";
    db.prepare("INSERT OR IGNORE INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,'role_builder',datetime('now'))").run(attemptId,TASK,SLOT);
    db.prepare("UPDATE attempts SET ended_at=NULL,outcome=NULL WHERE id=?").run(attemptId);
    db.prepare("UPDATE subtasks SET current_attempt_id=?,agent_state='in_progress' WHERE id=?").run(attemptId,SLOT);
    const before=db.prepare("SELECT agent_state,current_attempt_id FROM subtasks WHERE id=?").get(SLOT);
    const stopped=vi.fn();
    const catalog=buildRoleToolCatalog({role:"builder",mode:"task_discussion",runId:attemptId,taskId:TASK,subtaskId:SLOT,onErrorLoop:stopped} as any);
    try {
      for(let i=0;i<3;i++) {
        if(native)catalog.onToolExecutionEnd({type:"tool_execution_end",toolCallId:"isolated-"+i,toolName:"taskflow_task",isError:true,result:{content:[{type:"text",text:"  - /id: Expected string, received number"}]}});
        else {
          const universal=catalog.customTools.find(tool=>tool.name==="taskflow")!;
          const result=await universal.execute("isolated-"+i,{action:"invoke",operation:"taskflow_task",version:1,arguments:{id:42},request_id:attemptId+":"+i});
          expect(JSON.parse(result.content[0].text).error.code).toBe("INVALID_ARGUMENTS");
        }
      }
      await new Promise(resolve=>setTimeout(resolve,30));
      expect(db.prepare("SELECT agent_state,current_attempt_id FROM subtasks WHERE id=?").get(SLOT)).toEqual(before);
      expect(db.prepare("SELECT ended_at FROM attempts WHERE id=?").get(attemptId)).toEqual({ended_at:null});
      expect(stopped).toHaveBeenCalled();
    } finally {
      db.prepare("UPDATE subtasks SET current_attempt_id=NULL,agent_state='in_progress' WHERE id=?").run(SLOT);
    }
  });

});
