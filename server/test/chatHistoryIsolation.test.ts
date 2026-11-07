// Изоляция личного контекста (владелец 08.11.2026; спецификация
// docs/2026-11-08-role-slot-chat-branches-spec.md §5): карточки обращения и
// служебные метки сессии не попадают в историю, которую читает модель.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { historyBefore, historySince, modelHistorySql } from "../src/lib/chatHistoryModel.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const CHAT = "isolation-chat";

function insertMessage(args: {
  id: string;
  from: string;
  text: string;
  messageType?: string | null;
  steps?: string | null;
  sessionMarker?: number;
}) {
  db.prepare(
    `INSERT INTO chat_messages (id, chat_id, from_user_id, text, channel, message_type, steps, is_session_marker)
     VALUES (?, ?, ?, ?, 'chat', ?, ?, ?)`,
  ).run(
    args.id,
    CHAT,
    args.from,
    args.text,
    args.messageType ?? null,
    args.steps ?? null,
    args.sessionMarker ?? 0,
  );
}

describe("История для модели не содержит отображаемых карточек", () => {
  beforeAll(async () => {
    await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const found = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as
      | { id: string }
      | undefined;
    const owner = found?.id ?? "iso-owner";
    if (!found)
      db.prepare(
        "INSERT INTO users (id, name, role, type, email, password_hash) VALUES (?, 'Владелец','owner','human','iso@test','!test')",
      ).run(owner);
    db.prepare("INSERT INTO chats (id, title, kind, created_by) VALUES (?, 'Личная комната', 'direct', ?)").run(CHAT, owner);
    db.prepare("INSERT INTO chat_members (chat_id, member_id) VALUES (?, 'role_builder')").run(CHAT);
    insertMessage({ id: "iso-1", from: owner, text: "Проверь сборку" });
    insertMessage({
      id: "iso-card",
      from: "role_builder",
      text: "Разработчик → Критик: вопрос в очереди",
      messageType: "system",
      steps: JSON.stringify({
        duration_ms: 0,
        items: [],
        coordination: { question_id: "iso-1", recipient_id: "role_critic_verifier", status: "queued" },
      }),
    });
    insertMessage({ id: "iso-marker", from: "role_builder", text: "метка сессии", sessionMarker: 1 });
    // Чип памяти и уведомление «срок истёк» — тоже карточки интерфейса.
    insertMessage({
      id: "iso-memory",
      from: "taskflow_system",
      text: "Память обновлена · Сборка",
      messageType: "system",
      steps: JSON.stringify({ duration_ms: 0, items: [], memory_update: { title: "Сборка", kind: "note" } }),
    });
    insertMessage({
      id: "iso-timeout",
      from: "taskflow_system",
      text: "@builder срок истёк: ответа нет",
      messageType: "system",
    });
    insertMessage({ id: "iso-answer", from: "role_builder", text: "Собрал, всё зелёное" });
    insertMessage({ id: "iso-trigger", from: owner, text: "Спасибо, дальше" });
  });

  afterAll(() => {
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(CHAT);
    db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(CHAT);
    db.prepare("DELETE FROM chats WHERE id = ?").run(CHAT);
  });

  it("карточка обращения и метка сессии не попадают в первый ход", () => {
    const rows = historyBefore(CHAT, "iso-trigger", 50) as Array<{ id: string }>;
    const ids = rows.map((row) => row.id).sort();
    expect(ids).toEqual(["iso-1", "iso-answer"]);
  });

  it("карточка обращения, чип памяти и уведомление не попадают и в продолжение сессии", () => {
    const rows = historySince(CHAT, "iso-trigger", "role_builder", 50) as Array<{ id: string }>;
    const ids = rows.map((row) => row.id);
    for (const card of ["iso-card", "iso-marker", "iso-memory", "iso-timeout"]) {
      expect(ids).not.toContain(card);
    }
  });

  it("условие отбора работает и как SQL-предикат", () => {
    const rows = db
      .prepare(`SELECT m.id FROM chat_messages m WHERE m.chat_id = ? AND ${modelHistorySql("m")}`)
      .all(CHAT) as Array<{ id: string }>;
    expect(rows.map((row) => row.id).sort()).toEqual(["iso-1", "iso-answer", "iso-trigger"]);
  });
});
