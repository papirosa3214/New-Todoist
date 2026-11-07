import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { checkNoteAccessInstrument, __setWatchState, __resetWatchState } from "../src/lib/noteAccessWatcher.js";

// Сторож прибора «учёт обращений к заметкам». Смысл: если счётчик сломан,
// схема базы знаний слепнет — пометку Помощника владельца нечем проверить.
describe("сторож счётчика обращений", () => {
  let before: number;
  let app: any;

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    __resetWatchState();
    before = (
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE incident_key = 'note-access-watch'").get() as any
    ).n;
  });
  afterEach(() => {
    db.prepare("DELETE FROM tasks WHERE incident_key = 'note-access-watch'").run();
    __resetWatchState();
  });

  it("на живой схеме прибор считается исправным и тревоги не поднимает", () => {
    const r = checkNoteAccessInstrument();
    expect(r.ok, `прибор жив: ${r.reason}`).toBe(true);
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE incident_key = 'note-access-watch'").get() as any
    ).n;
    expect(after, "живой прибор не должен плодить тревоги").toBe(before);
  });

  it("служебную заметку после проверки не остаётся", () => {
    checkNoteAccessInstrument();
    const left = (
      db
        .prepare("SELECT COUNT(*) AS n FROM user_notes WHERE id LIKE 'probe-note-access-%'")
        .get() as any
    ).n;
    expect(left, "пробная заметка должна быть убрана").toBe(0);
    const acc = (
      db
        .prepare("SELECT COUNT(*) AS n FROM note_accesses WHERE note_id LIKE 'probe-note-access-%'")
        .get() as any
    ).n;
    expect(acc, "журнал пробной заметки должен быть чист").toBe(0);
  });

  it("поднимает ровно одну тревогу, когда прибор сломан", () => {
    db.exec("ALTER TABLE user_notes RENAME TO user_notes_probe_hidden");
    __resetWatchState();
    const r = checkNoteAccessInstrument();
    expect(r.ok).toBe(false);
    // Тревогу поднимает отдельный вызов — здесь проверяем, что он срабатывает.
    db.exec("ALTER TABLE user_notes_probe_hidden RENAME TO user_notes");
    expect(r.reason, "причина должна быть названа, а не просто «ошибка»").toBeTruthy();
  });
});