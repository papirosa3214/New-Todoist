import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  pauseChatWork,
  noteOwnerMessageWhilePaused,
  finishPausedWork,
  duePausedWork,
  CHAT_PAUSE_QUIET_MS,
} from "../src/lib/chatPausedWork.js";

// Владелец 23.10.2026: пока роль занята, новое сообщение останавливает её ход,
// чат встаёт на паузу; после минуты тишины роль сама возвращается к работе.

const owner = "owner-pause";
const role = "role_builder_pause";

describe("пауза работы в личном чате", () => {
  let app: any;
  let chatId: string;

  beforeAll(async () => {
    app = await buildApp();
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'x','owner','human')").run(owner, "Владелец", "pause@test.local");
    db.prepare("INSERT OR IGNORE INTO roles(key,title,summary) VALUES('builder_pause','Разработчик','')").run();
    db.prepare(
      "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type,role_key,is_system_bot) VALUES(?,?,'pause-role@test.local','x','agent','ai','builder_pause',1)",
    ).run(role, "Разработчик");
    chatId = "chat-pause-test";
    db.prepare("INSERT OR IGNORE INTO chats(id,kind,created_by) VALUES(?,'direct',?)").run(chatId, owner);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("пауза не возвращает работу, пока владелец пишет", () => {
    pauseChatWork(chatId, role, owner);
    expect(duePausedWork(Date.now())).toHaveLength(0);
    noteOwnerMessageWhilePaused(chatId);
    expect(duePausedWork(Date.now())).toHaveLength(0);
  });

  it("через минуту тишины работа возвращается", () => {
    pauseChatWork(chatId, role, owner);
    const later = Date.now() + CHAT_PAUSE_QUIET_MS + 1_000;
    const due = duePausedWork(later);
    expect(due.map((item) => item.chatId)).toContain(chatId);
    finishPausedWork(due[0].id);
    expect(duePausedWork(later)).toHaveLength(0);
  });

  it("повторная пауза не плодит строки", () => {
    pauseChatWork(chatId, role, owner);
    pauseChatWork(chatId, role, owner);
    const rows = db
      .prepare("SELECT count(*) n FROM chat_paused_work WHERE chat_id=? AND resumed_at IS NULL")
      .get(chatId) as { n: number };
    expect(rows.n).toBe(1);
    const open = db
      .prepare("SELECT id FROM chat_paused_work WHERE chat_id=? AND resumed_at IS NULL")
      .all(chatId) as Array<{ id: string }>;
    for (const row of open) finishPausedWork(row.id);
  });
});
