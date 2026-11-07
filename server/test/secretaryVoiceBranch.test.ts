import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const wsMock = vi.hoisted(() => ({ broadcastToUsers: vi.fn() }));
vi.mock("../src/ws.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ws.js")>()),
  broadcastToUsers: wsMock.broadcastToUsers,
}));

import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { roleUserId } from "../src/roleRouting.js";
import {
  completeSecretaryBranch,
  openSecretaryVoiceBranch,
  readVoiceJob,
  shouldMirrorBranchResult,
} from "../src/runtime/secretaryVoiceBranch.js";
import { registerVoiceCall, clearVoiceCall } from "../src/lib/voiceCallRegistry.js";
import { ensureSubagentCoordinationCard } from "../src/runtime/chatCoordination.js";
import {
  createRoleSubagentCallTool,
  pendingSubagentRuns,
  resetAllSubagentCallCounters,
  type SubagentRunner,
} from "../src/runtime/roleSubagentCall.js";

const RESEARCHER_ID = roleUserId("researcher");

const SECRETARY_ID = roleUserId("secretary");
const OWNER_ID = "voice-branch-owner";
const PARENT_ID = "voice-branch-parent";
const BRIEF = "Собери план на четверг";

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','owner','human')",
  ).run(OWNER_ID, "Владелец", "voice-branch-owner@test.local");
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','ai')")
    .run(SECRETARY_ID, "Секретарь", "voice-branch-secretary@test.local");
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,?,'direct',?)").run(
    PARENT_ID,
    "Помощник",
    OWNER_ID,
  );
  for (const member of [OWNER_ID, SECRETARY_ID, RESEARCHER_ID]) {
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(PARENT_ID, member);
  }
});

beforeEach(() => {
  resetAllSubagentCallCounters();
  clearVoiceCall(PARENT_ID);
});

function stubRunner(answer = "Разбор готов.") {
  const runner: SubagentRunner = async () => ({ text: answer, sessionId: "pi-session-stub" });
  return runner;
}

const waitFor = async (predicate: () => boolean, ms = 8000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

function secretaryTool(runner: SubagentRunner) {
  return createRoleSubagentCallTool(
    {
      actor: SECRETARY_ID,
      role: "secretary",
      mode: "work",
      runId: "voice-subagent",
      chatId: PARENT_ID,
      messageId: "voice-subagent-message",
    },
    runner,
  );
}

function latestDigest() {
  return db
    .prepare(
      "SELECT id, text FROM chat_messages WHERE chat_id=? AND text LIKE 'Ответ субагента%' ORDER BY rowid DESC LIMIT 1",
    )
    .get(PARENT_ID) as { id: string; text: string } | undefined;
}

function queueStatus(messageId: string) {
  return db
    .prepare("SELECT status FROM chat_message_queue WHERE message_id=?")
    .get(messageId) as { status: string } | undefined;
}

describe("openSecretaryVoiceBranch", () => {
  it("возвращает accepted до конца хода и кладёт бриф в ветку", () => {
    const result = openSecretaryVoiceBranch({
      parentChatId: PARENT_ID,
      brief: BRIEF,
      ownerId: OWNER_ID,
    });
    expect(result.accepted).toBe(true);
    expect(result.branchId).toBeTruthy();
    const copied = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? ORDER BY rowid ASC LIMIT 1")
      .get(result.branchId) as { text: string };
    expect(copied.text).toContain(BRIEF);
    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM chat_message_queue WHERE chat_id=? AND role_id=?")
      .get(result.branchId, SECRETARY_ID) as { n: number };
    expect(queued.n).toBeGreaterThan(0);
  });

  it("в родителе карточка с child_chat_id, без дайджеста Ветка — готово", () => {
    const result = openSecretaryVoiceBranch({
      parentChatId: PARENT_ID,
      brief: BRIEF,
      ownerId: OWNER_ID,
    });
    const rows = db
      .prepare("SELECT steps FROM chat_messages WHERE chat_id=? AND json_valid(steps)")
      .all(PARENT_ID) as Array<{ steps: string }>;
    const card = rows
      .map((row) => JSON.parse(row.steps).coordination)
      .find((c) => c?.child_chat_id === result.branchId);
    expect(card?.child_chat_id).toBe(result.branchId);
    expect(card?.recipient_id).toBe(SECRETARY_ID);
    const digests = db
      .prepare(
        "SELECT text FROM chat_messages WHERE chat_id=? AND text LIKE 'Ветка%' AND text LIKE '%готово%'",
      )
      .all(PARENT_ID) as Array<{ text: string }>;
    expect(digests).toHaveLength(0);
    expect(shouldMirrorBranchResult(result.branchId)).toBe(false);
  });

  it("обычная ветка POST /chats/:id/branch по-прежнему зеркалит итог", () => {
    const sourceId = "manual-branch-src";
    db.prepare(
      "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)",
    ).run(sourceId, OWNER_ID, "Ручная ветка", PARENT_ID);
    const branchId = "manual-branch-chat";
    db.prepare(
      "INSERT INTO chats (id, title, kind, created_by, branch_of_chat_id, branch_of_message_id) VALUES (?, ?, 'direct', ?, ?, ?)",
    ).run(branchId, "Ветка: Ручная ветка", OWNER_ID, PARENT_ID, sourceId);
    db.prepare("INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(branchId, OWNER_ID);
    expect(shouldMirrorBranchResult(branchId)).toBe(true);
  });

  it("readVoiceJob отдаёт пустой spoken_text пока live пуст, без подставной фразы", () => {
    const result = openSecretaryVoiceBranch({
      parentChatId: PARENT_ID,
      brief: BRIEF,
      ownerId: OWNER_ID,
    });
    const job = readVoiceJob(result.questionId);
    expect(job.terminal).toBe(false);
    expect(job.spoken_text).toBe("");
  });

  it("завершение ветки закрывает карточку и ставит результат в очередь родительскому Помощнику", () => {
    const result = openSecretaryVoiceBranch({
      parentChatId: PARENT_ID,
      brief: "Проверь доставку результата ветки",
      ownerId: OWNER_ID,
    });

    expect(completeSecretaryBranch(result.branchId, "Готово: результат опубликован.")).toBe(true);
    expect(readVoiceJob(result.questionId)).toMatchObject({
      terminal: true,
      status: "answered",
      spoken_text: "Готово: результат опубликован.",
    });

    const digest = db.prepare(
      "SELECT id,text FROM chat_messages WHERE chat_id=? AND text LIKE 'Результат фоновой ветки%' ORDER BY rowid DESC LIMIT 1",
    ).get(PARENT_ID) as { id: string; text: string } | undefined;
    expect(digest?.text).toContain("Готово: результат опубликован.");
    expect(queueStatus(digest!.id)?.status).toBe("pending");
    expect(completeSecretaryBranch(result.branchId, "Повтор")).toBe(false);
  });

  it("итог ветки сразу рассылается участникам родительского чата", () => {
    const result = openSecretaryVoiceBranch({
      parentChatId: PARENT_ID,
      brief: "Проверь рассылку итога ветки",
      ownerId: OWNER_ID,
    });
    wsMock.broadcastToUsers.mockClear();

    expect(completeSecretaryBranch(result.branchId, "Итог для открытого чата")).toBe(true);

    const sent = wsMock.broadcastToUsers.mock.calls.find(
      ([, event]) => event?.type === "chat:new" && String(event.message?.text ?? "").includes("Итог для открытого чата"),
    );
    expect(sent?.[0]).toEqual(expect.arrayContaining([OWNER_ID, SECRETARY_ID]));
  });

  it("ответ в обычной комнате не закрывает чужое обращение к Помощнику", () => {
    const roomId = "voice-branch-plain-room";
    const originId = "voice-branch-plain-origin";
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,?,'direct',?)").run(roomId, "Переговорка", OWNER_ID);
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(roomId, SECRETARY_ID);
    db.prepare("INSERT OR IGNORE INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)")
      .run(originId, RESEARCHER_ID, "Вопрос Помощнику", PARENT_ID);
    const questionId = ensureSubagentCoordinationCard({
      chatId: PARENT_ID,
      requesterId: RESEARCHER_ID,
      recipientId: SECRETARY_ID,
      question: "Вопрос Помощнику",
      originMessageId: originId,
      roomChatId: roomId,
    }) ?? "";
    expect(questionId).not.toBe("");

    expect(completeSecretaryBranch(roomId, "Ответ владельцу на другую тему")).toBe(false);
    expect(readVoiceJob(questionId).terminal).toBe(false);
  });
});

describe("выжимка call_role во время звонка", () => {
  it("живой звонок: выжимка call_role не будит текстовый ход", async () => {
    registerVoiceCall(PARENT_ID, "call-1");
    const tool = secretaryTool(stubRunner("Выжимка: план готов."));
    const result: any = await tool.execute("voice-live", { role: "researcher", question: "Собери план?" });
    await pendingSubagentRuns();
    const digest = latestDigest();
    expect(digest).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(queueStatus(digest!.id)?.status).toBe("pending");
    const card = db
      .prepare(
        "SELECT steps FROM chat_messages WHERE chat_id=? AND message_type='system' AND json_extract(steps,'$.coordination.question_id')=?",
      )
      .get(PARENT_ID, result.details.question_id) as { steps: string };
    const coordination = JSON.parse(card.steps).coordination;
    expect(coordination.status === "answered" || coordination.answered === true || coordination.terminal === true).toBe(true);
  });

  it("звонка нет: выжимка по-прежнему будит текстовый ход", async () => {
    clearVoiceCall(PARENT_ID);
    const tool = secretaryTool(stubRunner("Выжимка: план готов."));
    await tool.execute("voice-idle", { role: "researcher", question: "Собери план?" });
    await pendingSubagentRuns();
    const digest = latestDigest();
    expect(digest).toBeTruthy();
    const settled = await waitFor(() => {
      const status = queueStatus(digest!.id)?.status;
      return status !== "pending" && status !== "picked";
    }, 15000);
    expect(settled).toBe(true);
  });
});
