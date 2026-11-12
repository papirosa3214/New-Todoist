import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// Подсказка «эта тема уже записана» (владелец 08.11.2026).
//
// Проверяем именно детерминированную часть: темы записи и темы вопроса
// считаются одной функцией, поэтому совпадение — равенство строк,
// без модели и без эмбеддингов.
const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner } = await import("./helpers/seedOwner.js");
const { deleteMemory, memoryTopicHint } = await import("../src/lib/memory.js");
const { reindexTopicOf, topicsOf } = await import("../src/lib/memoryTopics.js");

let app: FastifyInstance;
let owner = "";

function seedMemory(input: {
  id: string;
  scope: "team" | "role" | "project";
  roleKey?: string | null;
  title: string;
  text: string;
  pinned?: boolean;
}): void {
  db.prepare(
    `INSERT INTO memories (id, scope, role_key, project_id, kind, title, text, source_kind, created_by, updated_by, pinned)
     VALUES (?, ?, ?, NULL, 'lesson', ?, ?, 'owner', ?, ?, ?)`,
  ).run(
    input.id,
    input.scope,
    input.roleKey ?? null,
    input.title,
    input.text,
    owner,
    owner,
    input.pinned ? 1 : 0,
  );
  reindexTopicOf(input.id, input.title, input.text);
}

function hintCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM memory_hint_log`).get() as { c: number }).c;
}

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  db.prepare("DELETE FROM memories").run();
  db.prepare("DELETE FROM memory_topics").run();
  db.prepare("DELETE FROM memory_hint_log").run();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "HintOwner", email: `hint-${Date.now()}@test`, password: "password123" },
  });
  const body = reg.json() as { token: string; user: { id: string } };
  owner = body.user.id;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner);
});

afterAll(async () => {
  db.prepare(`DELETE FROM memory_topics`).run();
  db.prepare(`DELETE FROM memory_hint_log`).run();
  db.prepare(`DELETE FROM memories`).run();
  await app.close();
});

describe("подсказка по темам памяти", () => {
  it("сводит словоформы к одной теме", () => {
    expect(topicsOf("таблица")).toEqual(topicsOf("таблицы"));
    expect(topicsOf("ширины колонок")).toEqual(topicsOf("шириной колонки"));
    expect(topicsOf("и в на не")).toEqual([]);
  });

  it("подсказывает запись, когда вопрос про то же", () => {
    seedMemory({
      id: "hint-table",
      scope: "team",
      title: "Таблицы в чате: ширины колонок из кэша",
      text: "Ширины колонок считаются один раз на проход таблицы и лежат в общем кэше: измерение текста на каждой строке тормозит прокрутку.",
    });
    const hint = memoryTopicHint({
      roleKey: null,
      query: "hint-почему таблица в чате тормозит при прокрутке, как считаются ширины колонок",
    });
    expect(hint).toContain("Таблицы в чате");
    expect(hint).toContain("hint-table");
    expect(hint).toContain("taskflow_recall");
  });

  it("пишет журнал подсказок", () => {
    const before = hintCount();
    memoryTopicHint({
      roleKey: "role_builder",
      query: "hint-кэш ширин колонок таблицы в чате",
      chatId: "hint-chat",
    });
    expect(hintCount()).toBe(before + 1);
    const row = db
      .prepare(`SELECT role_key, chat_id, hit_count, matched_topics FROM memory_hint_log ORDER BY rowid DESC LIMIT 1`)
      .get() as { role_key: string; chat_id: string; hit_count: number; matched_topics: string };
    expect(row.role_key).toBe("role_builder");
    expect(row.chat_id).toBe("hint-chat");
    expect(row.hit_count).toBeGreaterThan(0);
    expect(row.matched_topics.length).toBeGreaterThan(0);
  });

  it("молчит, когда темы не совпали", () => {
    const before = hintCount();
    const hint = memoryTopicHint({ roleKey: null, query: "hint-сварка труб под давлением на морозе" });
    expect(hint).toBe("");
    expect(hintCount()).toBe(before);
  });

  it("роль не видит чужую ролевую запись", () => {
    seedMemory({
      id: "hint-role-a",
      scope: "role",
      roleKey: "role_a",
      title: "Приём роли А: сначала разобраться",
      text: "Перед правкой цикл проверяется тестом, иначе правка наугад.",
    });
    const mine = memoryTopicHint({ roleKey: "role_a", query: "hint-правка цикла проверяется тестом" });
    const other = memoryTopicHint({ roleKey: "role_b", query: "hint-правка цикла проверяется тестом" });
    expect(mine).toContain("Приём роли А");
    expect(other).not.toContain("Приём роли А");
  });

  it("удалённая запись перестаёт всплывать", () => {
    seedMemory({
      id: "hint-drop",
      scope: "team",
      title: "Устаревшее правило про сборку",
      text: "Сборку запускать через симулятор после каждой правки.",
    });
    expect(memoryTopicHint({ roleKey: null, query: "hint-правило про сборку" })).toContain("Устаревшее правило");
    deleteMemory("hint-drop", { id: owner, kind: "owner" } as never);
    expect(memoryTopicHint({ roleKey: null, query: "hint-правило про сборку" })).toBe("");
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM memory_topics WHERE memory_id = 'hint-drop'`).get() as { c: number }).c,
    ).toBe(0);
  });
});
