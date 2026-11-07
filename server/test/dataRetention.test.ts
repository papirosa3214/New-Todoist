// Уборка разросшихся таблиц (аудит 24.10.2026).
//
// Две таблицы:
//
// 1. role_tool_requests — журнал идемпотентности инструментов ролей.
//    Ключ request_id формируется как `runId + ":" + id`, то есть
//    уникален ВНУТРИ одного хода роли. Ход длится минуты-часы, поэтому
//    повтор с тем же request_id после недели невозможен. Срок: 7 дней.
//
// 2. chat_messages.steps — снимок хода роли. Размышления модели
//    (kind:"thinking") копятся до 750 КБ на сообщение (19 МБ суммарно),
//    но UI их не читает: ни веб-клиент, ни iOS. Шаги (kind:"step")
//    не трогаем — в них аргументы и ответы инструментов, по ним владелец
//    разбирает сбой конкретного шага.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../src/db.js";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  pruneToolRequests,
  runRetention,
  THINKING_ITEMS_LIMIT,
  THINKING_TEXT_LIMIT,
  TOOL_REQUEST_RETENTION_DAYS,
  trimStoredThinking,
  trimThinkingItems,
} from "../src/lib/dataRetention.js";

const USER_ID = "retention-test-user";
const CHAT_ID = "retention-test-chat";

function reset() {
  db.exec("DELETE FROM role_tool_requests");
  db.exec("DELETE FROM chat_messages WHERE chat_id = ?");
}

// Схема: role_tool_requests заводится версионной миграцией, а не базовой
// схемой из db.ts — без runMigrations таблицы нет.
beforeAll(() => {
  migrate();
  runMigrations();
  // chat_messages ссылается на users и chats — нужны записи-заглушки.
  db.prepare(
    "INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type) VALUES (?, 'Тест', ?, '!no-login', 'owner', 'human')",
  ).run(USER_ID, `${USER_ID}@test.local`);
  db.prepare(
    "INSERT OR IGNORE INTO chats (id, kind, created_by) VALUES (?, 'direct', ?)",
  ).run(CHAT_ID, USER_ID);
});

describe("Уборка разросшихся таблиц (аудит 24.10.2026)", () => {
  beforeEach(reset);
  afterEach(reset);

  // ─── role_tool_requests ────────────────────────────────────────────────

  it("старые записи журнала удаляются", () => {
    db.prepare(
      "INSERT INTO role_tool_requests (actor,id,scope,hash,operation,state,instance,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "role_a",
      "старая",
      "s",
      "h",
      "op",
      "succeeded",
      "i",
      JSON.stringify({ ok: true }),
      new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "),
    );
    const удалено = pruneToolRequests();
    expect(удалено).toBeGreaterThan(0);
    const осталось = db
      .prepare("SELECT COUNT(*) AS n FROM role_tool_requests")
      .get() as { n: number };
    expect(осталось.n).toBe(0);
  });

  it("свежие записи журнала остаются", () => {
    db.prepare(
      "INSERT INTO role_tool_requests (actor,id,scope,hash,operation,state,instance,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "role_a",
      "свежая",
      "s",
      "h",
      "op",
      "succeeded",
      "i",
      JSON.stringify({ ok: true }),
      new Date().toISOString().slice(0, 19).replace("T", " "),
    );
    pruneToolRequests();
    const осталось = db
      .prepare("SELECT COUNT(*) AS n FROM role_tool_requests")
      .get() as { n: number };
    expect(осталось.n).toBe(1);
  });

  it("срок хранения журнала — неделя", () => {
    expect(TOOL_REQUEST_RETENTION_DAYS).toBe(7);
  });

  it("запись на границе срока ещё жива", () => {
    // 6 дней — внутри окна. 8 дней — уже нет.
    const внутрь = new Date(Date.now() - 6 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    db.prepare(
      "INSERT INTO role_tool_requests (actor,id,scope,hash,operation,state,instance,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("role_a", "на-границе", "s", "h", "op", "succeeded", "i", "{}", внутрь);
    pruneToolRequests();
    const осталось = db
      .prepare("SELECT COUNT(*) AS n FROM role_tool_requests")
      .get() as { n: number };
    expect(осталось.n).toBe(1);
  });

  // ─── chat_messages.steps ───────────────────────────────────────────────

  it("длинное размышление обрезается, помечается как обрезанное", () => {
    const шаги = {
      duration_ms: 1000,
      items: [
        { kind: "thinking", id: "t0", tool: "thinking", text: "я".repeat(50_000), status: "done" },
      ],
    };
    const обрезанный = trimThinkingItems(шаги) as any;
    const item = обрезанный.items[0];
    expect(item.text.length).toBe(THINKING_TEXT_LIMIT);
    // Пометка: видно, что текст не полный (не путать с полным).
    expect(item.text_truncated).toBe(true);
    expect(item.text_original_length).toBe(50_000);
  });

  it("короткое размышление не трогается", () => {
    const шаги = {
      duration_ms: 1000,
      items: [{ kind: "thinking", id: "t0", tool: "thinking", text: "короткая мысль", status: "done" }],
    };
    const обрезанный = trimThinkingItems(шаги) as any;
    expect(обрезанный.items[0].text).toBe("короткая мысль");
    expect(обрезанный.items[0].text_truncated).toBeUndefined();
  });

  it("шаги (kind:step) не трогаются — по ним разбирают сбой", () => {
    const шаги = {
      duration_ms: 1000,
      items: [
        {
          kind: "step",
          id: "s0",
          tool: "taskflow_comment",
          detail: "шаг",
          args: "x".repeat(50_000),
          output: "y".repeat(50_000),
          status: "done",
        },
      ],
    };
    const обрезанный = trimThinkingItems(шаги) as any;
    expect(обрезанный.items[0].args.length).toBe(50_000);
    expect(обрезанный.items[0].output.length).toBe(50_000);
  });

  it("накопленные в БД размышления обрезаются", () => {
    const большой = {
      duration_ms: 1000,
      items: [
        { kind: "thinking", id: "t0", tool: "thinking", text: "я".repeat(200_000), status: "done" },
        { kind: "step", id: "s0", tool: "op", detail: "d", status: "done" },
      ],
    };
    db.prepare(
      "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, steps) VALUES (?, ?, 'ответ', 'chat', ?, ?)",
    ).run("m1", USER_ID, CHAT_ID, JSON.stringify(большой));

    const обрезано = trimStoredThinking();
    expect(обрезано).toBeGreaterThan(0);

    const сохранено = db
      .prepare("SELECT steps FROM chat_messages WHERE id='m1'")
      .get() as { steps: string };
    const parsed = JSON.parse(сохранено.steps);
    expect(parsed.items[0].text.length).toBe(THINKING_TEXT_LIMIT);
    // Шаг цел.
    expect(parsed.items[1].kind).toBe("step");
    // Запись стала заметно меньше.
    expect(сохранено.steps.length).toBeLessThan(большой.items[0].text.length);
  });

  it("лишние размышления отбрасываются, остаются первые", () => {
    const items = Array.from({ length: 85 }, (_, i) => ({
      kind: "thinking",
      id: `t${i}`,
      tool: "thinking",
      text: `мысль ${i}`,
      status: "done",
    }));
    const шаги = { duration_ms: 1000, items };
    const обрезанный = trimThinkingItems(шаги) as any;
    const осталось = обрезанный.items.filter((i: any) => i.kind === "thinking");
    expect(осталось.length).toBe(THINKING_ITEMS_LIMIT);
    // Первые — сохранены, порядок не нарушен.
    expect(осталось[0].id).toBe("t0");
    // Видно, что список неполный.
    expect(обрезанный.thinking_items_dropped).toBe(85 - THINKING_ITEMS_LIMIT);
    expect(обрезанный.thinking_items_total).toBe(85);
  });

  it("шаги не отбрасываются вместе с размышлениями", () => {
    const items = [
      ...Array.from({ length: 85 }, (_, i) => ({
        kind: "thinking",
        id: `t${i}`,
        tool: "thinking",
        text: "м",
        status: "done",
      })),
      { kind: "step", id: "s0", tool: "op", detail: "d", status: "done" },
    ];
    const обрезанный = trimThinkingItems({ duration_ms: 1, items }) as any;
    const шаги = обрезанный.items.filter((i: any) => i.kind === "step");
    expect(шаги.length).toBe(1);
    expect(шаги[0].id).toBe("s0");
  });

  it("битый JSON в steps не роняет уборку", () => {
    db.prepare(
      "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, steps) VALUES (?, ?, 'ответ', 'chat', ?, ?)",
    ).run("m2", USER_ID, CHAT_ID, "{это не json");
    expect(() => trimStoredThinking()).not.toThrow();
    const осталось = db
      .prepare("SELECT steps FROM chat_messages WHERE id='m2'")
      .get() as { steps: string };
    expect(осталось.steps).toBe("{это не json");
  });

  it("полный проход уборки отрабатывает без ошибок", () => {
    db.prepare(
      "INSERT INTO role_tool_requests (actor,id,scope,hash,operation,state,instance,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "role_a",
      "старая",
      "s",
      "h",
      "op",
      "succeeded",
      "i",
      "{}",
      new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "),
    );
    const итог = runRetention();
    expect(итог.toolRequests).toBeGreaterThan(0);
    expect(typeof итог.thinkingTrimmed).toBe("number");
  });
});
