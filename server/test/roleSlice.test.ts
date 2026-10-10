import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { collectRoleSlice, buildRoleSliceText } from "../src/runtime/roleSlice.js";

// Срез знаний роли. Смысл один: роль не просыпается в вакуум и видит,
// где уже есть работа по этим вопросам.
describe("срез знаний роли", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    // Изолированная база: авторов заметок в ней нет, а user_notes.updated_by
    // на них ссылается. Создаём тех, кого использует срез.
    for (const id of ["role_builder", "role_qa", "role_designer"]) {
      db.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type, created_at)
         VALUES (?,?,?,?,'agent','ai',datetime('now'))`,
      ).run(id, id, `${id}@slice.test`, "x");
    }
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'rs-%'").run();
  });

  function note(id: string, opts: {
    author: string; category: string | null; temp?: string | null; title?: string;
  }) {
    db.prepare(
      `INSERT INTO user_notes (id, title, content, updated_by, kb_category, kb_temp_category, created_at, updated_at)
       VALUES (?,?,?,?,?,?,datetime('now','-${Math.floor(Math.random() * 5)} hours'),datetime('now','-${Math.floor(Math.random() * 5)} hours'))`,
    ).run(id, opts.title ?? `Заметка ${id}`, JSON.stringify({ type: "doc", content: [] }),
      opts.author, opts.category, opts.temp ?? null);
  }

  it("показывает только заметки этой роли", () => {
    note("rs-a", { author: "role_builder", category: "Workflows", title: "Очередь роли" });
    note("rs-b", { author: "role_qa", category: "Norms", title: "Проверка приёмки" });

    const mine = collectRoleSlice("role_builder");
    expect(mine.items.map((i) => i.title)).toEqual(["Очередь роли"]);

    const other = collectRoleSlice("role_qa");
    expect(other.items.map((i) => i.title)).toEqual(["Проверка приёмки"]);
  });

  it("не подсовывает мусор и неразобранное", () => {
    note("rs-c", { author: "role_builder", category: "Knowledge Base", title: "Ценная" });
    note("rs-d", { author: "role_builder", category: "мусор", title: "Одноразовый отчёт" });
    note("rs-e", { author: "role_builder", category: null, temp: "Из задачи: Координация", title: "Неразобранная" });

    const titles = collectRoleSlice("role_builder").items.map((i) => i.title);
    expect(titles).toContain("Ценная");
    expect(titles).not.toContain("Одноразовый отчёт");
    expect(titles).not.toContain("Неразобранная");
  });

  it("исключает заметки текущей задачи — срез это прошлое", () => {
    note("rs-f", { author: "role_builder", category: "Roles", title: "Из прошлой" });
    note("rs-g", { author: "role_builder", category: "Roles", title: "Из этой задачи" });

    const all = collectRoleSlice("role_builder").items.map((i) => i.title);
    expect(all).toHaveLength(2);

    const cut = collectRoleSlice("role_builder", ["rs-g"]).items.map((i) => i.title);
    expect(cut).toContain("Из прошлой");
    expect(cut).not.toContain("Из этой задачи");
  });

  it("даёт ссылку на заметку, чтобы было куда пойти", () => {
    note("rs-h", { author: "role_builder", category: "Workflows", title: "Очередь роли" });
    const text = buildRoleSliceText(collectRoleSlice("role_builder"), "Разработчик");
    expect(text).toContain("Очередь роли");
    expect(text).toContain("Workflows");
    expect(text, "в срезе должна быть ссылка на заметку").toMatch(/#/);
    expect(text).toContain("taskflow_kb_search");
  });

  it("у роли без заметок блок пустой, а не пустая строка", () => {
    const slice = collectRoleSlice("role_designer");
    expect(buildRoleSliceText(slice, "Дизайнер"), "пустой срез не вставляется в промт").toBe("");
  });

  it("один смысловой материал — одна строка, сколько бы ни переписывали", () => {
    note("rs-i", { author: "role_builder", category: "Workflows", title: "Очередь роли" });
    note("rs-j", { author: "role_builder", category: "Workflows", title: "Очередь роли" });
    const titles = collectRoleSlice("role_builder").items.map((i) => i.title);
    expect(titles.filter((t) => t === "Очередь роли")).toHaveLength(1);
  });
});