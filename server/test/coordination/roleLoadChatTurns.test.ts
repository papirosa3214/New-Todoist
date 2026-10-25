// Ходы ролей в чате без карточки на экране «Загрузка ролей»:
//   1. название работы берётся из отчёта роли по ходу (report.result);
//   2. приоритет: result → work → обычный heading → первая строка текста;
//   3. вежливые подтверждения названием работы не считаются;
//   4. интервал хода — picked_at → finished_at из очереди чата;
//   5. ход вне окна в выборку не попадает.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/index.js";
import type { FastifyInstance } from "fastify";
import db from "../../src/db.js";
import {
  readChatTurns,
  titleFromEnvelope,
  titleFromText,
} from "../../src/lib/roleLoadChatTurns.js";
import { seedRoleAccounts } from "../helpers/seedOwner.js";

const uid = (): string => crypto.randomUUID();

let chatId: string;
let serverApp: FastifyInstance;

function insertQueue(opts: {
  roleId: string;
  pickedAt: string;
  finishedAt: string;
  status?: string;
}): string {
  const id = `cmq_${uid()}`;
  const messageId = `msg_${uid()}`;
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, text, chat_id, channel, created_at)
     VALUES (?, ?, 'поручение', ?, 'chat', ?)`,
  ).run(messageId, opts.roleId, chatId, opts.pickedAt);
  db.prepare(
    `INSERT INTO chat_message_queue
       (id, chat_id, role_id, delivery_id, message_id, payload_json, status, picked_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    chatId,
    opts.roleId,
    `dlv_${uid()}`,
    messageId,
    opts.status ?? "done",
    opts.pickedAt,
    opts.finishedAt,
    opts.pickedAt,
    opts.finishedAt,
  );
  return id;
}

function insertRoleAnswer(roleId: string, at: string, envelope: unknown, text = "ответ"):
  void {
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, text, chat_id, channel, created_at, role_envelope_json)
     VALUES (?, ?, ?, ?, 'chat', ?, ?)`,
  ).run(
    `msg_${uid()}`,
    roleId,
    text,
    chatId,
    at,
    envelope === null ? null : JSON.stringify(envelope),
  );
}

beforeAll(async () => {
  // Схема таблиц очереди чата появляется после миграций, которые сервер
  // применяет при подъёме (buildApp), — без него таблиц нет.
  serverApp = await buildApp();
  await serverApp.ready();
  seedRoleAccounts(db);
  chatId = `chat_${uid()}`;
  db.prepare(
    `INSERT INTO chats (id, title, kind, created_at, updated_at)
     VALUES (?, 'Чат про TaskFlow', 'group', datetime('now'), datetime('now'))`,
  ).run(chatId);
});

afterAll(async () => {
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
  if (serverApp) await serverApp.close();
});

describe("название работы из отчёта роли", () => {
  it("берёт заголовок раздела result", () => {
    const title = titleFromEnvelope(
      JSON.stringify({
        schema_version: 1,
        output: [
          {
            type: "report",
            sections: {
              result: [{ type: "heading", text: "Причина промаха найдена" }],
              work: [{ type: "heading", text: "Разбор маршрута" }],
            },
          },
        ],
      }),
    );
    expect(title).toBe("Причина промаха найдена");
  });

  it("при отсутствии заголовка result берёт текст result", () => {
    const title = titleFromEnvelope(
      JSON.stringify({
        schema_version: 1,
        output: [
          {
            type: "report",
            sections: {
              result: [{ type: "text", text: "Сервер отдаёт чатовые интервалы" }],
            },
          },
        ],
      }),
    );
    expect(title).toBe("Сервер отдаёт чатовые интервалы");
  });

  it("падает на обычный заголовок ответа", () => {
    const title = titleFromEnvelope(
      JSON.stringify({
        schema_version: 1,
        output: [{ type: "heading", text: "TaskFlow на iPhone" }],
      }),
    );
    expect(title).toBe("TaskFlow на iPhone");
  });

  it("снимает вежливые префиксы", () => {
    const title = titleFromEnvelope(
      JSON.stringify({
        schema_version: 1,
        output: [{ type: "heading", text: "Принято, беру задачу" }],
      }),
    );
    expect(title).toBe("беру задачу");
  });

  it("берёт первую строку текста, если заголовков нет", () => {
    expect(titleFromText("Первая строка\nвторая строка")).toBe("Первая строка");
    expect(titleFromText("## Заголовок\nтекст")).toBe("Заголовок");
    expect(titleFromText(null)).toBeNull();
  });
});

describe("выборка чатовых ходов", () => {
  it("отдаёт интервал хода и название из отчёта", () => {
    const pickedAt = "2026-10-25 10:00:00";
    const finishedAt = "2026-10-25 10:30:00";
    insertQueue({ roleId: "role_builder", pickedAt, finishedAt });
    insertRoleAnswer(
      "role_builder",
      "2026-10-25 10:20:00",
      {
        schema_version: 1,
        output: [
          {
            type: "report",
            sections: { result: [{ type: "heading", text: "Экран загрузки ролей готов" }] },
          },
        ],
      },
    );

    const turns = readChatTurns(
      db,
      "2026-10-25T00:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    );
    const mine = turns.find((t) => t.role_key === "builder" && t.started_at === pickedAt);
    expect(mine).toBeTruthy();
    expect(mine!.ended_at).toBe(finishedAt);
    expect(mine!.title).toBe("Экран загрузки ролей готов");
    expect(mine!.chat_title).toBe("Чат про TaskFlow");
  });

  it("ход вне окна не попадает", () => {
    insertQueue({
      roleId: "role_builder",
      pickedAt: "2026-10-01 10:00:00",
      finishedAt: "2026-10-01 10:30:00",
    });
    const turns = readChatTurns(
      db,
      "2026-10-25T00:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    );
    expect(turns.some((t) => t.started_at === "2026-10-01 10:00:00")).toBe(false);
  });

  it("незавершённый ход не попадает", () => {
    insertQueue({
      roleId: "role_builder",
      pickedAt: "2026-10-25 11:00:00",
      finishedAt: "2026-10-25 11:30:00",
      status: "picked",
    });
    const turns = readChatTurns(
      db,
      "2026-10-25T00:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    );
    expect(turns.some((t) => t.started_at === "2026-10-25 11:00:00")).toBe(false);
  });
});
