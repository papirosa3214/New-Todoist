// Производительность и целостность данных (аудит 24.10.2026).
//
// Каждая проверка — на настоящей БД: не «функция вернула число», а что
// реально происходит с данными и сколько они занимают.
//
// Закрытые дефекты:
//  1. GET /api/tasks вычитывал полный system prompt роли (composed_prompt_snapshot,
//     ~28 КБ на задачу) через `t.*` — 4,3 МБ на список, которые тут же
//     выбрасывались.
//  2. Миграция 133 пересобирала chat_messages через DROP TABLE и убивала
//     четыре индекса таблицы — выборки лент читались полным сканом.
//  3. Событие instruction_snapshot хранило полный манифест инструкций
//     (18 КБ в среднем) — 2 831 событие на 48 МБ при 530 уникальных
//     манифестах.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  storeInstructionManifest,
  loadInstructionManifest,
  instructionSnapshotValue,
} from "../src/lib/instructionManifestStore.js";
import { purgeTasks } from "../src/lib/taskPurge.js";

describe("Производительность и целостность (аудит 24.10.2026)", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    const владелец = db
      .prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")
      .get() as { id: string } | undefined;
    if (!владелец) throw new Error("в тестовой БД нет владельца");
    ownerToken = app.jwt.sign({ id: владелец.id });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── 1: тяжёлая колонка не вычитывается в списке ───────────────────────

  it("в списке задач нет composed_prompt_snapshot", async () => {
    // Кладём тяжёлый снапшот в задачу — список не должен его ни вычитывать,
    // ни отдавать.
    const задача = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Аудит: тяжёлая колонка" },
    });
    const id = задача.json().task.id as string;
    db.prepare("UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?").run(
      "ТЯЖЁЛЫЙ".repeat(20_000),
      id,
    );

    const ответ = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ответ.statusCode).toBe(200);

    const список = JSON.parse(ответ.body) as any[];
    const наша = список.find((t) => t.id === id);
    expect(наша, "задача не попала в список").toBeTruthy();
    // Ключа нет вовсе — значит, колонка не вычитывалась и не выдавалась.
    expect("composed_prompt_snapshot" in наша).toBe(false);

    // В БД снимок остался — он нужен для разбора «что модель получила».
    const вБд = db
      .prepare("SELECT composed_prompt_snapshot AS s FROM tasks WHERE id = ?")
      .get(id) as { s: string };
    expect(вБд.s.length).toBe(20_000 * "ТЯЖЁЛЫЙ".length);

    // Уборка — штатной функцией purgeTasks: у задачи есть журнал
    // (task_events), на который ссылается FK без каскада, и сырой
    // DELETE FROM tasks падает с FOREIGN KEY constraint failed.
    purgeTasks([id]);
  });

  it("карточка задачи тоже не отдаёт тяжёлую колонку", async () => {
    const задача = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Аудит: карточка" },
    });
    const id = задача.json().task.id as string;
    db.prepare("UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?").run(
      "ТЯЖЁЛЫЙ".repeat(5_000),
      id,
    );
    const ответ = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ответ.statusCode).toBe(200);
    const тело = ответ.json();
    const задачаОтвет = тело.task ?? тело;
    expect(задачаОтвет.composed_prompt_snapshot).toBeUndefined();
    purgeTasks([id]);
  });

  // ─── 2: индексы chat_messages на месте ─────────────────────────────────

  it("индексы chat_messages восстановлены", () => {
    const индексы = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages'")
      .all() as Array<{ name: string }>;
    const имена = индексы.map((i) => i.name);
    for (const нужно of [
      "idx_chat_messages_to",
      "idx_chat_messages_task",
      "idx_chat_messages_channel",
      "idx_chat_messages_chat",
    ]) {
      expect(имена, `индекс ${нужно} отсутствует`).toContain(нужно);
    }
  });

  it("планировщик выборки использует индекс по chat_id", () => {
    // EXPLAIN QUERY PLAN: выборка ленты чата не должна сканировать таблицу
    // целиком (TABLE SCAN).
    const план = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM chat_messages WHERE chat_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 50",
      )
      .all("x", "2000-01-01") as Array<{ detail: string }>;
    const текст = план.map((p) => p.detail).join(" | ");
    expect(текст).not.toContain("SCAN chat_messages");
    expect(текст).toContain("idx_chat_messages_chat");
  });

  // ─── 3: манифест инструкций дедуплицирован ─────────────────────────────

  it("манифест кладётся в справочник один раз на содержимое", () => {
    const манифест = [
      { blockId: "role.prompt", scope: "original", version: 0, source: "AGENTS.md", sha256: "a".repeat(64) },
    ];
    const первый = storeInstructionManifest(манифест);
    const второй = storeInstructionManifest(манифест);
    // Тот же манифест — та же ссылка, одна строка в справочнике.
    expect(первый).toBe(второй);
    const строк = db
      .prepare("SELECT COUNT(*) AS n FROM instruction_manifests WHERE sha256 = ?")
      .get(первый) as { n: number };
    expect(строк.n).toBe(1);
    // По ссылке манифест восстанавливается — аудит не потерян.
    expect(loadInstructionManifest(первый)).toEqual(манифест);
  });

  it("разные манифесты — разные ссылки", () => {
    const a = storeInstructionManifest([{ blockId: "x", version: 1 }]);
    const b = storeInstructionManifest([{ blockId: "x", version: 2 }]);
    expect(a).not.toBe(b);
  });

  it("событие instruction_snapshot хранит ссылку, а не полный манифест", () => {
    const большойМанифест = Array.from({ length: 50 }, (_, i) => ({
      blockId: `block.${i}`,
      scope: "original",
      version: i,
      source: `source-${i}`,
      sha256: "b".repeat(64),
    }));
    const значение = instructionSnapshotValue({
      mode: "work",
      resumed: false,
      manifest: большойМанифест,
    });
    // Событие компактное…
    expect(значение.length).toBeLessThan(500);
    const parsed = JSON.parse(значение);
    expect(parsed.mode).toBe("work");
    expect(parsed.resumed).toBe(false);
    expect(parsed.manifest_sha256).toBeTruthy();
    // …а полный манифест — в справочнике.
    const вСправочнике = db
      .prepare("SELECT manifest FROM instruction_manifests WHERE sha256 = ?")
      .get(parsed.manifest_sha256) as { manifest: string };
    expect(JSON.parse(вСправочнике.manifest)).toHaveLength(50);
  });

  it("выдача события отдаёт только mode и resumed", async () => {
    // Потребитель briefInstructionSnapshot не должен ломаться на новом
    // формате события (ссылка вместо полного манифеста).
    const задача = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Аудит: событие снимка" },
    });
    const id = задача.json().task.id as string;

    const значение = instructionSnapshotValue({
      mode: "work",
      resumed: true,
      manifest: [{ blockId: "z", version: 1 }],
    });
    db.prepare(
      "INSERT INTO task_events (id, task_id, actor_id, kind, field, to_value) VALUES (?, ?, NULL, 'instruction_snapshot', 'run-1', ?)",
    ).run(crypto.randomUUID(), id, значение);

    const ответ = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const тело = ответ.json();
    const карточка = тело.task ?? тело;
    const событие = (карточка.events ?? []).find(
      (e: { kind: string }) => e.kind === "instruction_snapshot",
    );
    expect(событие, "событие не отдалось").toBeTruthy();
    expect(JSON.parse(событие.to_value)).toEqual({ mode: "work", resumed: true });

    purgeTasks([id]);
  });
});
