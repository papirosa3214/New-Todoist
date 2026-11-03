import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { roleUserId } from "../src/roleRouting.js";
import {
  openSecretaryVoiceBranch,
  readVoiceJob,
  shouldMirrorBranchResult,
} from "../src/runtime/secretaryVoiceBranch.js";

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
  for (const member of [OWNER_ID, SECRETARY_ID]) {
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(PARENT_ID, member);
  }
});

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
});
