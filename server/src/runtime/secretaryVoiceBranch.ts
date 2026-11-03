import crypto from "node:crypto";
import { Type } from "typebox";
import db from "../db.js";
import { readChatPreferences } from "../lib/chatSessionPreferences.js";
import { roleUserId } from "../roleRouting.js";
import { ensureSubagentCoordinationCard, coordinationCardData } from "./chatCoordination.js";
import { enqueueMessageDelivery } from "./chatQueue.js";
import type { Context, Tool } from "./universalTaskflow.js";

const SECRETARY_ID = roleUserId("secretary");
const uid = () => crypto.randomUUID();

export function isVoiceDelegatedBranch(chatId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM chat_messages m
        WHERE json_valid(m.steps)
          AND json_extract(m.steps, '$.coordination.child_chat_id') = ?
          AND json_extract(m.steps, '$.coordination.recipient_id') = ?
        LIMIT 1`,
    )
    .get(chatId, SECRETARY_ID) as { ok: number } | undefined;
  return !!row;
}

export function shouldMirrorBranchResult(chatId: string): boolean {
  return !isVoiceDelegatedBranch(chatId);
}

export function readVoiceJob(questionId: string): {
  terminal: boolean;
  status: string;
  spoken_text: string;
} {
  const row = db
    .prepare(
      `SELECT steps FROM chat_messages
        WHERE json_valid(steps) AND json_extract(steps, '$.coordination.question_id') = ?
        LIMIT 1`,
    )
    .get(questionId) as { steps: string } | undefined;
  const c = row ? coordinationCardData(row) : undefined;
  if (!c) return { terminal: false, status: "unknown", spoken_text: "" };
  const spoken = String(c.answer ?? "").trim();
  return { terminal: !!c.terminal, status: String(c.status ?? ""), spoken_text: spoken };
}

export function openSecretaryVoiceBranch(input: {
  parentChatId: string;
  brief: string;
  ownerId: string;
  model?: string;
}): { accepted: true; branchId: string; questionId: string; title: string } {
  const brief = input.brief.trim();
  if (!brief) throw new Error("ПУСТОЙ БРИФ: передай brief — формулировку поручения.");
  const parent = db
    .prepare("SELECT kind FROM chats WHERE id = ?")
    .get(input.parentChatId) as { kind: string } | undefined;
  if (!parent) throw new Error("Чат не найден");

  const sourceId = uid();
  const branchId = uid();
  const firstLine =
    brief.split("\n").map((line) => line.replace(/[#*`>_-]/g, "").trim()).find(Boolean) ?? "поручение";
  const title = "Ветка: " + (firstLine.length > 60 ? firstLine.slice(0, 59) + "…" : firstLine);
  const copyId = uid();

  db.transaction(() => {
    db.prepare(
      "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)",
    ).run(sourceId, input.ownerId, brief, input.parentChatId);
    db.prepare(
      "INSERT INTO chats (id, title, kind, created_by, branch_of_chat_id, branch_of_message_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(branchId, title, parent.kind, input.ownerId, input.parentChatId, sourceId);
    db.prepare("INSERT INTO chat_members (chat_id, member_id) SELECT ?, member_id FROM chat_members WHERE chat_id = ?")
      .run(branchId, input.parentChatId);
    db.prepare("INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(branchId, input.ownerId);
    db.prepare(
      "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)",
    ).run(copyId, input.ownerId, brief, branchId);
    const prefs = readChatPreferences(input.parentChatId);
    if (prefs.configured) {
      db.prepare(
        "INSERT INTO chat_session_preferences(chat_id,model,thinking_level) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET model=excluded.model,thinking_level=excluded.thinking_level",
      ).run(branchId, input.model ?? prefs.model, prefs.thinkingLevel);
    } else if (input.model) {
      db.prepare(
        "INSERT INTO chat_session_preferences(chat_id,model,thinking_level) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET model=excluded.model,thinking_level=excluded.thinking_level",
      ).run(branchId, input.model, null);
    }
  })();

  const questionId =
    ensureSubagentCoordinationCard({
      chatId: input.parentChatId,
      requesterId: SECRETARY_ID,
      recipientId: SECRETARY_ID,
      question: brief,
      originMessageId: sourceId,
      roomChatId: branchId,
    }) ?? "";

  const queued = enqueueMessageDelivery({
    chatId: branchId,
    roleId: SECRETARY_ID,
    deliveryId: copyId,
    messageId: copyId,
    payload: { mode: "work", hop: 0, chatOnly: true, text: brief },
  });
  if (queued.created && !process.env.VITEST) {
    import("../routes/chats.js")
      .then(({ recoverAgentDelivery }) =>
        recoverAgentDelivery({ chatId: branchId, roleId: SECRETARY_ID, queueRowId: queued.id }),
      )
      .catch((error) => console.warn("[voice-branch] ход не поехал:", error));
  }

  return { accepted: true, branchId, questionId, title };
}

export function createSecretaryOpenBranchTool(context: Context): Tool {
  return {
    name: "taskflow_chat_open_branch",
    description:
      "Открыть ветку текущего разговора и запустить в ней этого же помощника по брифу. " +
      "Возвращает сразу accepted — не ждать конца хода. Свою длинную работу делай так, не в этом звонке.",
    parameters: Type.Object({
      brief: Type.String({ description: "Формулировка поручения, собранная из разговора." }),
      model: Type.Optional(Type.String({ description: "Модель только для этого хода ветки." })),
    }),
    execute: async (_id, args) => {
      const brief = String(args?.brief ?? "").trim();
      const chatId = context.chatId ?? "";
      if (!chatId) throw new Error("НУЖЕН ЧАТ: ветка открывается из текущего разговора.");
      const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (!owner) throw new Error("нет владельца");
      const result = openSecretaryVoiceBranch({
        parentChatId: chatId,
        brief,
        ownerId: owner.id,
        model: typeof args?.model === "string" && args.model.trim() ? args.model.trim() : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...result, question_id: result.questionId }),
          },
        ],
      };
    },
  };
}
