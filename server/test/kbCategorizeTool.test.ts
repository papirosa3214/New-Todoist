import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

// Разметка базы знаний должна быть возможна без токена роли и без правки
// заметки по HTTP: автор и дата правки у разметки остаются прежними, иначе
// «срез по роли» (runtime/roleSlice.ts) уезжает с заметок, которые писали
// роли. Инструмент доступен каждой роли без профиля, в том числе
// Помощнику владельца, — на то он и добавлен.
describe("инструмент разметки базы знаний", () => {
  const tool = () => (taskflowTools("secretary", null) as any[]).find((t) => t.name === "taskflow_kb_categorize");
  // Инструмент отдаёт JSON строкой в content[0].text — так модель его видит.
  const call = async (p: Record<string, unknown>) => {
    const out = (await tool().execute("t-1", p)) as { content: { text: string }[] };
    return JSON.parse(out.content[0].text) as any;
  };
  let NOTE = "";
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'kc-t-%'").run();
    await app.close();
  });

  beforeEach(() => {
    NOTE = `kc-t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    db.prepare(
      "INSERT INTO user_notes (id, title, content, updated_by, updated_at) VALUES (?,?,?,?,datetime('now','-2 days'))",
    ).run(NOTE, "Заметка под разбор (автор — владелец u1)",
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), "u1");
    db.prepare("UPDATE user_notes SET kb_temp_category = 'Из задачи: ждёт разбора' WHERE id = ?").run(NOTE);
  });
  afterAll(async () => {
    await app.close();
  });

  it("ставит категорию, снимает временную метку и не трогает автора с датой", async () => {
    const res = await call({ note_id: NOTE, category: "Knowledge Base" });
    expect(res.категория).toBe("Knowledge Base");
    expect(res.пометка).toBeNull();
    expect(res.автор_не_менялся).toBe(true);
    const row = db.prepare("SELECT kb_category AS c, kb_temp_category AS t, updated_by AS b FROM user_notes WHERE id = ?").get(NOTE) as any;
    expect(row.c).toBe("Knowledge Base");
    expect(row.t).toBeNull();
    expect(row.b).toBe("u1");
  });

  it("одноразовую помечает мусором, постоянную категорию снимает", async () => {
    await call({ note_id: NOTE, category: "Workflows" });
    const res = await call({ note_id: NOTE, mark: "мусор" });
    expect(res.пометка).toBe("мусор");
    expect(res.категория).toBeNull();
    const row = db.prepare("SELECT kb_category AS c FROM user_notes WHERE id = ?").get(NOTE) as any;
    expect(row.c).toBeNull();
  });

  it("отказывает в чужой категории и не пишет её в базу", async () => {
    await expect(call({ note_id: NOTE, category: "мизер из подвала" })).rejects.toThrow(/неизвестная категория/);
    const row = db.prepare("SELECT kb_category AS c, kb_temp_category AS t FROM user_notes WHERE id = ?").get(NOTE) as any;
    expect(row.c).toBeNull();
    expect(row.t).toBe("Из задачи: ждёт разбора");
  });

  it("без note_id отдаёт очередь разбора", async () => {
    const res = await call({});
    expect(res.ждут_разбора).toBeGreaterThanOrEqual(1);
    expect(res.заметки.some((n: any) => n.id === NOTE)).toBe(true);
  });

  it("повторный вызов по одной заметке не ломает разметку", async () => {
    await call({ note_id: NOTE, category: "Norms" });
    await call({ note_id: NOTE, category: "Norms" });
    const row = db.prepare("SELECT kb_category AS c FROM user_notes WHERE id = ?").get(NOTE) as any;
    expect(row.c).toBe("Norms");
  });

  it("неизвестную заметку не выдумывает", async () => {
    await expect(call({ note_id: "kc-t-нет-такой", category: "Roles" })).rejects.toThrow(/не найдена/);
  });
});