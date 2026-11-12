// Живой черновик хода роли (владелец 31.10.2026).
//
// Проверяем обещание: пока роль отвечает, её текст и ВСЕ размышления уже
// лежат в базе; остановка владельцем или перезапуск сервера не стирают
// написанное. Итоговый ответ по-прежнему ложится в chat_messages, а
// черновик остаётся страховкой/архивом.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ws.js", () => ({
  broadcastToUsers: vi.fn(),
}));

import db, { migrate } from "../src/db.js";
import { restartDelivery } from "../src/runtime/chatDeliveryRetryBudget.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  LIVE_DRAFT_MS,
  beginLiveDraft,
  finishLiveDraft,
  markLiveDraftSaved,
  recoverLiveDrafts,
} from "../src/runtime/chatLiveDraft.js";
import {
  LIVE_BROADCAST_MS,
  _resetLiveTurnsForTests,
  startLiveTurn,
} from "../src/runtime/chatLiveTurn.js";

const CHAT_ID = "draft-test-chat";
const ROLE_ID = "role_builder";

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
  db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES (?, ?, 'direct', 'u1')",
  ).run(CHAT_ID, "Черновик");
});

beforeEach(() => {
  db.prepare("DELETE FROM chat_live_drafts").run();
  db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(CHAT_ID);
  _resetLiveTurnsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  _resetLiveTurnsForTests();
});

function draftRow(turnId: string) {
  return db
    .prepare("SELECT * FROM chat_live_drafts WHERE turn_id = ?")
    .get(turnId) as
    | {
        text: string;
        answer_text: string;
        items_json: string;
        status: string;
        reply_message_id: string | null;
      }
    | undefined;
}

describe("живой черновик хода", () => {
  it.each(['missing', 'other-role', 'system'])("восстановление не теряет обязательство: %s", (kind) => {
    const id = `unanswered-${kind}`;
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,'u1','вопрос','chat',?)").run(id, CHAT_ID);
    db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status) VALUES(?,?,?,?,?,1,'{}','picked')").run(id,CHAT_ID,ROLE_ID,id,id);
    if (kind !== 'missing') db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id,message_type) VALUES(?,?,'уведомление','chat',?,?,?)")
      .run(`${id}-reply`,kind === 'other-role' ? 'u1' : ROLE_ID, CHAT_ID,id,kind === 'system' ? 'system' : null);
    expect(restartDelivery(id, 'server_restarted', 'picked')).toBe('restarted');
  });
  it("сохранённый при рестарте ответ не запускает тот же запрос заново", () => {
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('recovery-trigger','u1','вопрос','chat',?)").run(CHAT_ID);
    db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status) VALUES('recovery-delivery',?,?,'recovery-delivery','recovery-trigger',1,'{}','picked')").run(CHAT_ID, ROLE_ID);
    beginLiveDraft({turnId:'recovery-turn',chatId:CHAT_ID,roleId:ROLE_ID,triggerMessageId:'recovery-trigger',startedAt:new Date().toISOString()});
    finishLiveDraft({turnId:'recovery-turn',chatId:CHAT_ID,roleId:ROLE_ID,text:'сохранённый текст',answerText:'сохранённый текст',items:[]});
    recoverLiveDrafts();
    expect(restartDelivery('recovery-delivery', 'server_restarted', 'picked')).toBe('skipped');
    expect(db.prepare("SELECT status FROM chat_message_queue WHERE id='recovery-delivery'").get()).toEqual({status:'done'});
    expect(restartDelivery('recovery-delivery', 'lease_expired', 'picked')).toBe('skipped');
    expect(db.prepare("SELECT count(*) AS n FROM chat_messages WHERE reply_to_message_id='recovery-trigger'").get()).toEqual({n:1});
  });
  it("текст и размышления попадают в базу до конца хода", () => {
    vi.useFakeTimers();
    const turn = startLiveTurn({
      chatId: CHAT_ID,
      userId: ROLE_ID,
      name: "Builder",
      audience: () => ["u1"],
    });
    turn.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    });
    turn.onEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Сначала проверю память прежнего разговора",
      },
    });
    turn.onEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Готово, продолжаю." },
    });
    vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    // Отложенная запись после троттлинга — без нового события.
    vi.advanceTimersByTime(LIVE_DRAFT_MS + 20);

    const row = draftRow(turn.turnId);
    expect(row?.status).toBe("running");
    expect(row?.text).toContain("Готово, продолжаю.");
    expect(row?.answer_text).toContain("Готово, продолжаю.");
    const items = JSON.parse(row!.items_json) as Array<{ kind: string; text?: string }>;
    expect(items.find((it) => it.kind === "thinking")?.text).toContain(
      "Сначала проверю память прежнего разговора",
    );

    turn.finish();
    expect(draftRow(turn.turnId)?.status).toBe("finished");
  });

  it("итоговый ответ закрывает черновик", () => {
    const turn = startLiveTurn({
      chatId: CHAT_ID,
      userId: ROLE_ID,
      name: "Builder",
      audience: () => ["u1"],
    });
    turn.finish();
    expect(draftRow(turn.turnId)?.status).toBe("finished");
    markLiveDraftSaved(turn.turnId, "final-message");
    const row = draftRow(turn.turnId);
    expect(row?.status).toBe("saved");
    expect(row?.reply_message_id).toBe("final-message");
  });

  it("после перезапуска сервера незакрытый черновик становится частичным ответом", () => {
    // Строка ещё running — как будто процесс убили до finish().
    beginLiveDraft({
      turnId: "turn-crashed",
      chatId: CHAT_ID,
      roleId: ROLE_ID,
      roleName: "Builder",
      startedAt: new Date().toISOString(),
    });
    db.prepare(
      "UPDATE chat_live_drafts SET text=?, answer_text=?, items_json=? WHERE turn_id=?",
    ).run(
      "Успел написать половину",
      "Успел написать половину",
      JSON.stringify([
        {
          kind: "thinking",
          id: "t1",
          tool: "thinking",
          text: "Размышление, которое должно сохраниться",
          status: "done",
          started_at: new Date().toISOString(),
        },
      ]),
      "turn-crashed",
    );

    expect(recoverLiveDrafts()).toBe(1);
    const message = db
      .prepare("SELECT text, stop_reason, partial, steps FROM chat_messages WHERE id = ?")
      .get("draft-turn-crashed") as
      | { text: string; stop_reason: string; partial: number; steps: string }
      | undefined;
    expect(message?.stop_reason).toBe("server_restart");
    expect(message?.partial).toBe(1);
    expect(message?.text).toContain("Успел написать половину");
    expect(message?.text).toContain("перезапуском сервера");
    expect(message?.steps).toContain("Размышление, которое должно сохраниться");
    expect(draftRow("turn-crashed")?.status).toBe("recovered");
    // Повторный проход ничего не дублирует.
    expect(recoverLiveDrafts()).toBe(0);
  });

  it("ход закрылся, но сообщение не успело записаться — восстанавливаем", () => {
    beginLiveDraft({
      turnId: "turn-finished",
      chatId: CHAT_ID,
      roleId: ROLE_ID,
      startedAt: new Date().toISOString(),
    });
    finishLiveDraft({
      turnId: "turn-finished",
      chatId: CHAT_ID,
      roleId: ROLE_ID,
      text: "ответ",
      answerText: "ответ",
      items: [],
    });
    expect(recoverLiveDrafts()).toBe(1);
    expect(
      db
        .prepare("SELECT text FROM chat_messages WHERE id = ?")
        .get("draft-turn-finished"),
    ).toMatchObject({ text: expect.stringContaining("ответ") });
  });

  it("пустой оборванный черновик закрывается без сообщения", () => {
    beginLiveDraft({
      turnId: "turn-empty",
      chatId: CHAT_ID,
      roleId: ROLE_ID,
      startedAt: new Date().toISOString(),
    });
    expect(recoverLiveDrafts()).toBe(0);
    expect(
      db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ?").get(CHAT_ID),
    ).toBeUndefined();
    expect(draftRow("turn-empty")?.status).toBe("recovered");
  });
});
