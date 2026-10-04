// Снимок рабочего состояния слота (владелец 04.10.2026, LOCK-SLOT-SNAPSHOT).
//
// Четыре проверки из плана владельца:
//   1. сохранение — снимок пишется по ходу работы, при сдаче и при блокировке,
//      ДО смены состояния, с привязкой к попытке;
//   2. аварийная остановка — сервер пишет техснимок сам, когда модель не
//      ответила (перезапуск сервера, обрыв);
//   3. защита от устаревшей записи — поздняя запись старой попытки остаётся в
//      истории, но актуальным снимком новой попытки не становится;
//   4. восстановление контекста — блок собирается из снимка и говорит, работает
//      ли слот сейчас и как свежи сведения.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "test-run", completion: Promise.resolve() }) };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { roleUserId } from "../src/roleRouting.js";
import {
  latestSlotSnapshot,
  roleSlotSnapshotsBlock,
  saveSlotSnapshot,
  slotSnapshotBlock,
  slotSnapshotDto,
  slotWorkState,
  technicalSlotSnapshot,
} from "../src/runtime/slotWorkSnapshot.js";
import { recoverInterruptedPlanSubtasks } from "../src/runtime/planSubtaskAdmission.js";

describe("снимок рабочего состояния слота", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  const builderAuth = () => ({ authorization: `Bearer ${app.jwt.sign({ id: roleUserId("builder") })}` });

  /**
   * Карточка с утверждённым планом и одним узлом builder. approve сам ставит
   * узел в работу и заводит ему попытку — ровно тот путь, каким узел попадает
   * в работу по-настоящему, без ручной подгонки строк в БД.
   */
  async function slot(title: string, slotKey = "work"): Promise<{ taskId: string; planId: string; subtaskId: string }> {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth, payload: { title } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "manual",
        nodes: [{ slot_key: slotKey, role_key: "builder", expected_result: "Код" }],
      },
    });
    const planId = plan.json().plan.id as string;
    const approve = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: ownerAuth });
    expect(approve.statusCode).toBe(200);
    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth })).json() as Array<{ id: string; plan_node_key: string }>;
    const subtaskId = subtasks.find((s) => s.plan_node_key === slotKey)!.id;
    expect(currentAttempt(subtaskId)).toBeTruthy();
    return { taskId, planId, subtaskId };
  }

  const currentAttempt = (subtaskId: string): string | null =>
    (db.prepare("SELECT current_attempt_id FROM subtasks WHERE id = ?").get(subtaskId) as { current_attempt_id: string | null }).current_attempt_id;

  /**
   * Состояние «по слоту идёт более новая попытка, чем та, что писала снимок».
   *
   * Даётся прямо в БД, а не через /work: отпускание слота (`state: null`)
   * попытку не закрывает — она остаётся живой, — и повторный запуск узла
   * после этого честно отказывает («Слот уже запущен»). Живая более новая
   * попытка появляется по делу после обрыва и перезапуска сервера, поэтому
   * состояние моделируем здесь, а проверяем ровно то свойство, ради которого
   * оно нужно: поздняя запись старой попытки не становится актуальной.
   */
  function newerAttempt(subtaskId: string): string {
    // Прежняя попытка обрывается — иначе частичный уникальный индекс честно
    // не даст второй живой попытки на слот (инвариант C1).
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted' WHERE subtask_id = ? AND ended_at IS NULL").run(subtaskId);
    const id = `${subtaskId}-attempt-2`;
    db.prepare(
      "INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,heartbeat_at) VALUES(?,(SELECT task_id FROM subtasks WHERE id=?),?,'role_builder',datetime('now'),datetime('now'))",
    ).run(id, subtaskId, subtaskId);
    db.prepare("UPDATE subtasks SET current_attempt_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?").run(id, subtaskId);
    return id;
  }

  const snapshots = (subtaskId: string) =>
    db.prepare("SELECT * FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY created_at, rowid").all(subtaskId) as any[];

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Snapshot owner", email: `snap-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ── 1. Сохранение ──────────────────────────────────────────────────────

  it("снимок по ходу работы сохраняется и виден в GET", async () => {
    const { subtaskId } = await slot("Снимок по ходу работы " + Date.now());
    const post = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/snapshot`,
      headers: builderAuth(),
      payload: { done: "Собран прототип", left: "Остались тесты", next_step: "Прогнать тесты", artifacts: ["docs/proto.md"] },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ сохранён: true, устаревший: false });

    const read = await app.inject({ method: "GET", url: `/api/subtasks/${subtaskId}/snapshot`, headers: builderAuth() });
    expect(read.statusCode).toBe(200);
    const dto = read.json();
    expect(dto.latest).toMatchObject({ done_summary: "Собран прототип", left_summary: "Остались тесты", next_step: "Прогнать тесты" });
    expect(dto.latest.artifacts[0]).toMatchObject({ title: "docs/proto.md" });
    expect(dto.latest.is_complete).toBe(true);
    expect(dto.work.working).toBe(true);
  });

  it("сдача шага сохраняет снимок ДО смены состояния и с привязкой к попытке", async () => {
    const { subtaskId } = await slot("Снимок при сдаче " + Date.now());
    const attemptId = currentAttempt(subtaskId);
    expect(attemptId).toBeTruthy();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: builderAuth(),
      payload: { done: true, result: "Код готов", snapshot: { done: "Код готов", left: "Проверка владельцем", next_step: "Посмотреть диф" } },
    });
    expect(patch.statusCode).toBe(200);

    const rows = snapshots(subtaskId);
    expect(rows).toHaveLength(1);
    // Привязка к той попытке, которая была текущей на момент сдачи: после
    // закрытия `current_attempt_id` уже погашен, и привязать было бы не к чему.
    expect(rows[0].attempt_id).toBe(attemptId);
    expect(rows[0].reason).toBe("done");
    expect(rows[0].is_complete).toBe(1);
    expect(rows[0].done_summary).toBe("Код готов");
    expect((db.prepare("SELECT done FROM subtasks WHERE id = ?").get(subtaskId) as { done: number }).done).toBe(1);
  });

  it("блокировка сохраняет снимок с причиной блока", async () => {
    const { subtaskId } = await slot("Снимок при блокировке " + Date.now());
    const blocked = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: builderAuth(),
      payload: { state: "blocked", result: "Нужен доступ к репозиторию", snapshot: { done: "Разобрался в API", blocker: "Нет доступа к репозиторию", next_step: "Попросить доступ" } },
    });
    expect(blocked.statusCode).toBe(200);
    const rows = snapshots(subtaskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "blocked", blocker: "Нет доступа к репозиторию", next_step: "Попросить доступ" });
    expect(rows[0].attempt_id).toBeTruthy();
  });

  it("новая запись не затирает историю: все версии на месте", async () => {
    const { subtaskId } = await slot("История снимков " + Date.now());
    saveSlotSnapshot({ subtaskId, reason: "progress", done: "первый" });
    saveSlotSnapshot({ subtaskId, reason: "progress", done: "второй" });
    saveSlotSnapshot({ subtaskId, reason: "done", done: "третий" });

    const history = snapshots(subtaskId);
    expect(history.map((r) => r.done_summary)).toEqual(["первый", "второй", "третий"]);
    expect(latestSlotSnapshot(subtaskId)?.done_summary).toBe("третий");
    const dto = slotSnapshotDto(subtaskId)!;
    expect(dto.history).toHaveLength(3);
    expect(dto.latest).toMatchObject({ done_summary: "третий" });
  });

  // ── 2. Аварийная остановка ─────────────────────────────────────────────

  it("обрыв при перезапуске сервера: сервер пишет техснимок сам, с пометкой «неполный»", async () => {
    const { subtaskId } = await slot("Обрыв слота " + Date.now());
    const attemptId = currentAttempt(subtaskId);

    await recoverInterruptedPlanSubtasks();

    const rows = snapshots(subtaskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("stopped");
    // Модель сюда не успевает ответить — её ход умер вместе с процессом, —
    // поэтому снимок всегда неполный и это обязано быть видно.
    expect(rows[0].is_complete).toBe(0);
    expect(rows[0].blocker).toContain("перезапуск");
    expect(rows[0].attempt_id).toBe(attemptId);
  });

  it("техснимок несуществующего слота не падает и ничего не пишет", () => {
    expect(technicalSlotSnapshot("snap-nowhere-" + Date.now(), "stopped")).toBeNull();
  });

  it("сбой запуска узла тоже оставляет снимок с причиной", async () => {
    const { subtaskId } = await slot("Сбой запуска узла " + Date.now());
    const reason = `модель недоступна: ${Date.now()}`;
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'failed', reason = ? WHERE id = ?").run(reason, currentAttempt(subtaskId));
    const saved = technicalSlotSnapshot(subtaskId, "failed", { blocker: reason, attemptId: currentAttempt(subtaskId) });
    expect(saved?.snapshot.is_complete).toBe(0);
    expect(saved?.snapshot.blocker).toBe(reason);
  });

  // ── 3. Защита от устаревшей записи ─────────────────────────────────────

  it("поздняя запись старой попытки остаётся в истории, но не становится актуальной", async () => {
    const { subtaskId } = await slot("Устаревшая запись " + Date.now());
    const oldAttempt = currentAttempt(subtaskId);

    // Роль успела записать снимок, потом попытка оборвалась и слот взяли заново.
    saveSlotSnapshot({ subtaskId, reason: "progress", done: "старая попытка: сделано до обрыва" });
    const newAttempt = newerAttempt(subtaskId);
    expect(newAttempt).not.toBe(oldAttempt);

    // Старый процесс, не зная об этом, пишет снимок с ПРЕЖНИМ attempt_id.
    const late = saveSlotSnapshot({ subtaskId, reason: "progress", done: "опоздалая запись", attemptId: oldAttempt });
    expect(late.stale).toBe(true);

    // В истории она есть…
    expect(snapshots(subtaskId).some((r) => r.done_summary === "опоздалая запись")).toBe(true);
    // …пока новая попытка ничего не записала — показывается последний
    // известный снимок, но с честной пометкой, что он от более ранней попытки.
    expect(slotSnapshotDto(subtaskId)?.latest_from_earlier_attempt).toBe(true);
    // Как только новая попытка пишет свой снимок, он становится актуальным, а
    // поздняя запись старой попытки остаётся в истории.
    saveSlotSnapshot({ subtaskId, reason: "progress", done: "новая попытка: продолжаю" });
    expect(latestSlotSnapshot(subtaskId)?.attempt_id).toBe(newAttempt);
    expect(latestSlotSnapshot(subtaskId)?.done_summary).toBe("новая попытка: продолжаю");
    expect(slotSnapshotDto(subtaskId)?.latest_from_earlier_attempt).toBe(false);
    expect(snapshots(subtaskId).some((r) => r.done_summary === "опоздалая запись")).toBe(true);
  });

  it("HTTP-ответ честно помечает позднюю запись старой попытки", async () => {
    const { subtaskId } = await slot("Поздняя запись через API " + Date.now());
    const oldAttempt = currentAttempt(subtaskId);
    newerAttempt(subtaskId);

    const late = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/snapshot`,
      headers: builderAuth(),
      payload: { done: "из прошлой попытки", attempt_id: oldAttempt },
    });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({ сохранён: true, устаревший: true });
  });

  // ── 4. Восстановление контекста ─────────────────────────────────────────

  it("блок снимка попадает в контекст следующей попытки и говорит о свежести", async () => {
    const { subtaskId } = await slot("Снимок в контексте " + Date.now());
    saveSlotSnapshot({ subtaskId, reason: "stopped", done: "Починил сборку", left: "Осталась интеграция", nextStep: "Свести обе ветки" });
    newerAttempt(subtaskId);

    const block = slotSnapshotBlock(subtaskId)!;
    expect(block).toContain("На чём остановился предыдущий ход");
    expect(block).toContain("Сделано: Починил сборку");
    expect(block).toContain("Осталось: Осталась интеграция");
    expect(block).toContain("Следующий шаг: Свести обе ветки");
    // Свежесть и «работает ли сейчас» — по БД, а не по памяти процесса.
    expect(block).toMatch(/Слот сейчас: в работе/);
    expect(slotWorkState(subtaskId).working).toBe(true);
  });

  it("блок для роли без снимков не появляется — лишнего контекста не создаём", () => {
    expect(roleSlotSnapshotsBlock({ role: "qa", taskId: `пусто-${Date.now()}` })).toBeNull();
  });

  it("перечень слотов в общем контексте короткий и с честной пометкой «снимка нет»", async () => {
    const { taskId, subtaskId } = await slot("Перечень слотов " + Date.now());
    const block = roleSlotSnapshotsBlock({ role: "builder", taskId })!;
    expect(block).toContain("Где остановились мои этапы");
    expect(block).toContain("снимка нет");
    expect(block).toContain("работает сейчас");
    // Узел плана виден по названию этапа, а не абстрактным «слот 1».
    expect(block).toContain((db.prepare("SELECT title FROM subtasks WHERE id = ?").get(subtaskId) as { title: string }).title);
  });
});