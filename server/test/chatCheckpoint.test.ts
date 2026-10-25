// Этап 2 плана карточки 252c400e: выжимка чата.
//
// Проверяем то, что обещано приёмкой:
//   • ровно три раздела в фиксированном порядке;
//   • блоки thinking в выжимку не попадают никогда;
//   • действия превращаются в факты, незавершённое действие — в явную
//     неопределённость, а не в молчание;
//   • выжимка привязана к поколению: поколение уехало — выжимка устарела;
//   • текст без трёх заголовков НЕ принимается (сырой fallback запрещён).

import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import db from "../src/db.js";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  buildCheckpointSections,
  planChatResume,
  buildCheckpointForChat,
  clearCheckpoint,
  freshCheckpoint,
  parseCheckpointSections,
  readCheckpoint,
  renderCheckpointPrompt,
  saveCheckpoint,
  stepsToFacts,
} from "../src/runtime/chatCheckpoint.js";
import { bumpChatGeneration, currentChatGeneration } from "../src/runtime/chatQueue.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

beforeAll(() => {
  migrate();
  runMigrations();
});

beforeEach(() => {
  seedRoleAccounts(db);
  db.prepare("DELETE FROM chat_checkpoints").run();
});

describe("выжимка чата", () => {
  it("ровно три раздела в фиксированном порядке", () => {
    const sections = buildCheckpointSections({
      ownerMessages: [{ text: "сделай отчёт" }],
      roleMessages: [{ text: "отчёт готов" }],
    });
    const prompt = renderCheckpointPrompt(sections);
    expect(prompt).toContain("1. Что было");
    expect(prompt).toContain("2. Цель и задача");
    expect(prompt).toContain("3. Что выполнить");
    expect(prompt.indexOf("1. Что было")).toBeLessThan(prompt.indexOf("2. Цель и задача"));
    expect(prompt.indexOf("2. Цель и задача")).toBeLessThan(prompt.indexOf("3. Что выполнить"));
  });

  it("размышления модели в выжимку не попадают", () => {
    const facts = stepsToFacts({
      items: [
        { kind: "thinking", tool: "thinking", text: "СЫРОЕ РАЗМЫШЛЕНИЕ", status: "done" },
        { kind: "step", tool: "read", status: "done", output: "файл.ts" },
      ],
    });
    expect(JSON.stringify(facts)).not.toContain("СЫРОЕ РАЗМЫШЛЕНИЕ");
    expect(facts[0].text).toContain("read");
  });

  it("незавершённое действие — явная неопределённость, а не молчание", () => {
    const facts = stepsToFacts({
      items: [{ kind: "step", tool: "bash", status: "running" }],
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].uncertain).toBe(true);
    expect(facts[0].text).toContain("результат неизвестен");
  });

  it("текст без трёх заголовков не принимается", () => {
    expect(parseCheckpointSections("просто текст без разделов")).toBeNull();
    expect(parseCheckpointSections("1. Что было\n- было")).toBeNull();
    const good = parseCheckpointSections(
      "1. Что было\n- было\n2. Цель и задача\n- цель\n3. Что выполнить\n- шаг",
    );
    expect(good).not.toBeNull();
    expect(good!.goal).toBe("- цель");
  });

  it("выжимка устаревает вместе с поколением", () => {
    db.prepare("INSERT INTO chats(id, kind, created_at) VALUES('c1','direct',datetime('now'))").run();
    db.prepare("INSERT INTO users(id, name, email, password_hash, type) VALUES('role_x','X','x@example.test','x','ai')").run();
    const sections = buildCheckpointSections({
      ownerMessages: [{ text: "задача" }],
      roleMessages: [{ text: "сделано" }],
    });
    saveCheckpoint({ chatId: "c1", roleId: "role_x", generation: currentChatGeneration("c1", "role_x"), sections });
    expect(freshCheckpoint("c1", "role_x")).not.toBeNull();
    // Поколение уехало — выжимка прежняя больше не годится.
    bumpChatGeneration({ chatId: "c1", roleId: "role_x", reason: "test" });
    expect(freshCheckpoint("c1", "role_x")).toBeNull();
    expect(readCheckpoint("c1", "role_x", 1)).not.toBeNull();
  });

  it("выжимка по истории чата: сообщения владельца дословно, размышления выброшены", () => {
    db.prepare("INSERT INTO chats(id, kind, created_at) VALUES('c2','direct',datetime('now'))").run();
    db.prepare("INSERT INTO users(id, name, email, password_hash, type) VALUES('role_y','Y','y@example.test','y','ai')").run();
    db.prepare(
      "INSERT INTO chat_messages(id, from_user_id, text, channel, chat_id, created_at) VALUES('m1','u1','Сделай отчёт по проекту','chat','c2',datetime('now'))",
    ).run();
    db.prepare(
      "INSERT INTO chat_messages(id, from_user_id, text, channel, chat_id, steps, created_at) VALUES('m2','role_y','Отчёт готов','chat','c2',?,datetime('now'))",
    ).run(
      JSON.stringify({
        items: [
          { kind: "thinking", tool: "thinking", text: "СЫРОЕ РАЗМЫШЛЕНИЕ", status: "done" },
          { kind: "step", tool: "read", status: "done", output: "отчёт.md" },
        ],
      }),
    );
    const checkpoint = buildCheckpointForChat({ chatId: "c2", roleId: "role_y" });
    expect(checkpoint.goal).toContain("Сделай отчёт по проекту");
    expect(checkpoint.was).toContain("read");
    expect(checkpoint.was).not.toContain("СЫРОЕ РАЗМЫШЛЕНИЕ");
    // Выжимка сохранена на текущее поколение.
    expect(readCheckpoint("c2", "role_y", currentChatGeneration("c2", "role_y"))).not.toBeNull();
    clearCheckpoint("c2", "role_y", currentChatGeneration("c2", "role_y"));
    expect(freshCheckpoint("c2", "role_y")).toBeNull();
  });
});

describe("план продолжения хода", () => {
  it("совпавшее поколение — продолжаем ту же сессию", () => {
    expect(planChatResume({ savedGeneration: 3, currentGeneration: 3, hasCheckpoint: false }).mode).toBe("continue");
    expect(planChatResume({ savedGeneration: null, currentGeneration: 2, hasCheckpoint: false }).mode).toBe("continue");
  });

  it("уехавшее поколение — свежий ход с выжимкой", () => {
    const plan = planChatResume({ savedGeneration: 1, currentGeneration: 2, hasCheckpoint: true });
    expect(plan.mode).toBe("fresh");
    expect(plan.reason).toContain("выжимк");
  });

  it("уехавшее поколение без выжимки — ход не идёт (сырой fallback запрещён)", () => {
    const plan = planChatResume({ savedGeneration: 1, currentGeneration: 2, hasCheckpoint: false });
    expect(plan.mode).toBe("blocked");
    expect(plan.reason).toContain("сырая история запрещена");
  });
});
