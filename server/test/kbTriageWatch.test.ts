import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { SECRETARY_CHAT_ID } from "../src/lib/secretaryReply.js";
import {
  kbPendingCount,
  kbTriageState,
  __raiseKbTriage,
  __resetKbTriageState,
  __setKbTriageState,
} from "../src/lib/kbTriageWatcher.js";

// Порог разбора: рутина не должна гоняться впустую, но и зависнуть не
// должна. Ниже порога — молчим, выше — заводим ОДНУ карточку Помощнику
// владельца и один раз сигналим ему в личный чат (решение владельца
// 16.10.2026: тринадцать одинаковых карточек больше не копятся).
describe("триггер разбора накопившихся заметок", () => {
  let app: FastifyInstance;
  let noteSeq = 0;

  beforeAll(async () => {
    app = await buildApp();
    // Изолированная база: владельца и проекта в ней нет — создаём.
    db.prepare("INSERT OR IGNORE INTO users (id, name, type, role, created_at) VALUES (?,?,?,?,datetime('now'))")
      .run("u1", "Владелец", "human", "owner");
    db.prepare("INSERT OR IGNORE INTO projects (id, name, owner_id, position, created_at) VALUES (?,?,?,0,datetime('now'))")
      .run("c2fcbcdb-951f-449f-a1bd-123ea2a46a58", "TaskFlow - NewTodoist", "u1");
    // Личный чат Помощника владельца есть и на свежей базе (миграция 105),
    // но тест не должен падать красным от того, что миграция когда-то
    // перестанет её заводить: чат нужен именно для проверки сигнала.
    db.prepare("INSERT OR IGNORE INTO chats (id, title, kind, created_by, task_id) VALUES (?, 'Секретарь', 'direct', 'u1', NULL)")
      .run(SECRETARY_CHAT_ID);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, 'u1')")
      .run(SECRETARY_CHAT_ID);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, 'u-secretary')")
      .run(SECRETARY_CHAT_ID);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    __resetKbTriageState();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'kb-triage-%'").run();
    db.prepare("DELETE FROM chat_messages WHERE from_user_id = 'taskflow_system' AND chat_id = ?")
      .run(SECRETARY_CHAT_ID);
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'kbp-%'").run();
    noteSeq = 0;
  });

  function seedPending(n: number, mark = "Из задачи: Координация") {
    for (let i = 0; i < n; i++) {
      db.prepare(
        "INSERT INTO user_notes (id, title, content, kb_temp_category, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))",
      ).run(`kbp-${Date.now()}-${noteSeq++}`, `Заметка ${i}`,
        JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), mark);
    }
  }

  function triageCards(): Array<{ id: string; title: string; description: string }> {
    return db
      .prepare("SELECT id, title, description FROM tasks WHERE id LIKE 'kb-triage-%' ORDER BY created_at")
      .all() as Array<{ id: string; title: string; description: string }>;
  }

  function secretarySignals(): Array<{ id: string; text: string; task_id: string | null }> {
    return db
      .prepare(
        "SELECT id, text, task_id FROM chat_messages WHERE chat_id = ? AND from_user_id = 'taskflow_system' ORDER BY rowid",
      )
      .all(SECRETARY_CHAT_ID) as Array<{ id: string; text: string; task_id: string | null }>;
  }

  it("ниже порога задачу не заводит — работа не гоняется впустую", () => {
    seedPending(5);
    expect(kbPendingCount()).toBe(5);
    __raiseKbTriage();
    expect(triageCards().length, "при пяти заметках разбор не нужен").toBe(0);
    expect(secretarySignals().length, "и сигнала в чате тоже нет").toBe(0);
  });

  it("порог достигнут — заводит задачу и она сразу у Помощника владельца", () => {
    seedPending(20);
    expect(kbPendingCount()).toBe(20);
    __raiseKbTriage();
    const t = triageCards()[0];
    expect(t, "задача на разбор должна появиться").toBeTruthy();
    expect(t.title, "заголовок постоянный — счётчика в нём нет").toBe("Разобрать накопившиеся заметки");
    expect(t.description, "счётчик живёт в описании").toContain("Ждут разбора: 20");
    const row = db
      .prepare("SELECT project_id, owner_selected_role AS role FROM tasks WHERE id = ?")
      .get(t.id) as { project_id: string; role: string };
    expect(row.role).toBe("secretary");
    expect(t.description).toContain("не удалять");
    expect(t.description).toContain("Workflows");
  });

  it("разбор идёт в основной проект, а не в «Серверные уведомления»", () => {
    seedPending(20);
    __raiseKbTriage();
    const t = db.prepare("SELECT project_id AS p FROM tasks WHERE id LIKE 'kb-triage-%'").get() as any;
    const p = db.prepare("SELECT name FROM projects WHERE id = ?").get(t.p) as any;
    expect(p?.name, "разбор — рутина, а не поломка").not.toBe("Серверные уведомления");
  });

  it("достижение порога сигналит Помощнику владельца в личный чат", () => {
    seedPending(20);
    __raiseKbTriage();
    const card = triageCards()[0];
    const signals = secretarySignals();
    expect(signals.length, "сигнал должен уйти в личный чат Помощника").toBe(1);
    expect(signals[0].text).toContain("20");
    expect(signals[0].text, "в сообщении есть ссылка на карточку разбора").toContain(card.id);
    expect(signals[0].text, "и что именно делать").toContain("взять карточку");
    expect(signals[0].task_id, "карточка привязана к сообщению").toBe(card.id);
  });

  it("карточка жива — повторный порог обновляет счётчик, а не плодит дубль", () => {
    seedPending(20);
    __raiseKbTriage();
    const first = triageCards()[0];

    // Порог достигнут снова, заметок уже больше, а карточка не закрыта.
    seedPending(11);
    __raiseKbTriage();
    __raiseKbTriage();

    const cards = triageCards();
    expect(cards.length, "пока карточка жива, вторая не заводится").toBe(1);
    expect(cards[0].id, "обновляется та же карточка").toBe(first.id);
    expect(cards[0].title, "заголовок не меняется от счётчика").toBe("Разобрать накопившиеся заметки");
    expect(cards[0].description, "и в описании").toContain("Ждут разбора: 31");
    expect(cards[0].description, "инструкция разбора не потеряна").toContain("Workflows");
    expect(secretarySignals().length, "повторно по живой карточке не сигналим").toBe(1);
  });

  it("карточка закрыта — следующий порог возвращает ту же, а не заводит новую", () => {
    seedPending(20);
    __raiseKbTriage();
    const first = triageCards()[0];
    db.prepare("UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(first.id);

    seedPending(5);
    __raiseKbTriage();

    // Владелец 11.11.2026: «должна быть создана только одна задача,
    // изменять можно». Разбор не сделан — карточка та же, снова в работе.
    const cards = triageCards();
    expect(cards.length, "карточка разбора одна на всё время").toBe(1);
    expect(cards[0].id, "вернулась та же карточка").toBe(first.id);
    const row = db
      .prepare("SELECT status, completed_at FROM tasks WHERE id = ?")
      .get(first.id) as { status: string; completed_at: string | null };
    expect(row.status, "карточка снова в работе").toBe("active");
    expect(row.completed_at, "отметка закрытия снята").toBeNull();
    expect(cards[0].description, "счётчик переписан в ней же").toContain("Ждут разбора: 25");
    expect(secretarySignals().length, "по той же карточке повторно не сигналим").toBe(1);
  });

  it("лишние живые карточки разбора убираются в архив, остаётся одна", () => {
    seedPending(20);
    __raiseKbTriage();
    const first = triageCards()[0];
    // Дубль от прежней версии сторожа: живая карточка рядом, работу по ней
    // никто не начинал (жалоба владельца 11.11.2026 — их было больше десяти).
    db.prepare(
      `INSERT INTO tasks (id, title, description, priority, creator_id, status, project_id, owner_selected_role, created_at, updated_at)
       VALUES ('kb-triage-duplicate', 'Разобрать накопившиеся заметки: 21 ждут разбора', NULL, 2, 'u1', 'active',
               (SELECT project_id FROM tasks WHERE id = ?), 'secretary', datetime('now'), datetime('now'))`,
    ).run(first.id);

    __raiseKbTriage();

    const alive = db
      .prepare("SELECT id FROM tasks WHERE id LIKE 'kb-triage-%' AND status = 'active' AND archived_at IS NULL")
      .all() as Array<{ id: string }>;
    expect(alive.map((r) => r.id), "живая карточка только одна").toEqual([first.id]);
    const dup = db.prepare("SELECT archived_at FROM tasks WHERE id = 'kb-triage-duplicate'").get() as { archived_at: string | null };
    expect(dup.archived_at, "дубль не удалён, а убран в архив").toBeTruthy();
    db.prepare("DELETE FROM tasks WHERE id = 'kb-triage-duplicate'").run();
  });

  it("ниже порога живые дубли всё равно убираются в архив", () => {
    // На живом сервере заметок осталось меньше порога, а живые дубли прежней
    // версии сторожа висят. Ждать следующего порога, чтобы это исправить,
    // незачем: карточка разбора одна (владелец 11.11.2026).
    const insert = db.prepare(
      `INSERT INTO tasks (id, title, description, priority, creator_id, status, owner_selected_role, created_at, updated_at)
       VALUES (?, 'Разобрать накопившиеся заметки: 21 ждут разбора', NULL, 2, 'u1', 'active', 'secretary', ?, datetime('now'))`,
    );
    insert.run("kb-triage-old-a", "2026-10-12 09:00:00");
    insert.run("kb-triage-old-b", "2026-10-14 09:00:00");
    __setKbTriageState({ raised_task_id: "kb-triage-old-b" });
    seedPending(3);

    __raiseKbTriage();

    const alive = db
      .prepare("SELECT id FROM tasks WHERE id LIKE 'kb-triage-%' AND status = 'active' AND archived_at IS NULL")
      .all() as Array<{ id: string }>;
    expect(alive.map((r) => r.id), "живая карточка осталась одна").toEqual(["kb-triage-old-b"]);
    const old = db.prepare("SELECT archived_at FROM tasks WHERE id = 'kb-triage-old-a'").get() as
      | { archived_at: string | null }
      | undefined;
    expect(old?.archived_at, "лишний дубль в архиве, а не удалён").toBeTruthy();
  });

  it("по одной карточке сигнал не повторяется чаще раза в сутки", () => {
    seedPending(20);
    __raiseKbTriage();
    expect(secretarySignals().length).toBe(1);

    // Сутки прошли (отметка вчера) — сигнал по той же карточке повторяется.
    __setKbTriageState({ notified_at_epoch: Date.now() - 25 * 60 * 60 * 1000 });
    __raiseKbTriage();
    expect(secretarySignals().length, "карточка та же, сигнал второй").toBe(2);
    expect(triageCards().length, "и карточка при этом не задвоилась").toBe(1);
  });

  it("перезапуск сервера не заводит ни карточек, ни сообщений", async () => {
    seedPending(20);
    __raiseKbTriage();
    expect(triageCards().length).toBe(1);
    expect(secretarySignals().length).toBe(1);

    // Перезапуск = свежий импорт модуля: всё, что помнит процесс, забыто,
    // остаётся только диск и база.
    vi.resetModules();
    const fresh = await import("../src/lib/kbTriageWatcher.js");
    fresh.__raiseKbTriage();

    expect(triageCards().length, "перезапуск не плодит карточки").toBe(1);
    expect(secretarySignals().length, "и не дублирует сигнал").toBe(1);
  });

  it("помеченные «мусор» в счётчик не входят — очередь доходит до нуля и карточка не заводится", () => {
    // 30 «мусоров» держали счётчик выше порога 20: очередь не доходила до
    // нуля, и сторож заводил карточку разбора сразу после закрытия предыдущей.
    seedPending(30, "мусор");
    expect(kbPendingCount(), "по «мусору» решение уже принято — ждать нечего").toBe(0);
    __raiseKbTriage();
    expect(triageCards().length, "карточка разбора не заводится").toBe(0);
    expect(secretarySignals().length, "и Помощника владельца не будят").toBe(0);
    expect(kbTriageState().pending, "на экране состояния честный ноль").toBe(0);
  });

  it("обычная временная метка по-прежнему попадает в счётчик", () => {
    seedPending(30, "мусор");
    seedPending(3, "Из задачи: Координация");
    expect(kbPendingCount(), "настоящая очередь считается целиком").toBe(3);
    seedPending(2, "Из задачи: Координация");
    expect(kbPendingCount(), "и продолжает расти").toBe(5);
  });

  it("«мусор» не попадает в очередь, даже когда порог достигнут на живых заметках", () => {
    seedPending(20, "Из задачи: Координация");
    seedPending(30, "мусор");
    __raiseKbTriage();
    expect(triageCards()[0].description, "в счётчике ровно живые 20, а не 50").toContain("Ждут разбора: 20");
    expect(triageCards()[0].description, "и в описании то же число").toContain("Ждут разбора: 20");
    expect(triageCards()[0].description, "инструкция про «мусор» осталась").toContain("мусор");
  });

  it("состояние сторожа точное: сколько ждёт и какая карточка жива", () => {
    seedPending(20);
    __raiseKbTriage();
    const card = triageCards()[0];
    // Подмешиваем чужую заметку в базе — сторож обязан считать по факту.
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'kbp-%'").run();
    __raiseKbTriage();
    const state = kbTriageState();
    expect(state.pending, "счётчик без карточек честно ноль").toBe(0);
    expect(state.threshold).toBe(20);
    expect(state.task_id, "карточка остаётся живой, даже когда разбирать нечего").toBe(card.id);
    expect(state.active, "сторож только что проверил").toBe(true);
  });
});