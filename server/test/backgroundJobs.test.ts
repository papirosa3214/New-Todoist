// Фоновые команды ролей (дизайн docs/2026-11-08-role-background-jobs.md).
//
// Проверяем реестр без базы и без хоста: runner подменён, времени нет —
// часы подменены. Всё, что здесь проверяется, — поведение реестра: старт не
// ждёт, вывод копится, состояние честно называется (done/failed/timeout/
// lost/stopped), дерево не запускает две команды разом, пределы работают.
import { describe, expect, it } from "vitest";
import {
  backgroundStartError,
  createBackgroundJobs,
  type BackgroundRunnerInput,
  type BackgroundRunResult,
} from "../src/runtime/backgroundJobs.js";

type FakeRun = {
  input: BackgroundRunnerInput;
  resolve: (r: BackgroundRunResult) => void;
  reject: (e: Error) => void;
};

function fakeRunner() {
  const runs: FakeRun[] = [];
  const run = (input: BackgroundRunnerInput) =>
    new Promise<BackgroundRunResult>((resolve, reject) => {
      runs.push({ input, resolve, reject });
      input.signal?.addEventListener("abort", () => reject(new Error("вызов отменён")));
    });
  return { run, runs };
}

function setup(options: Record<string, unknown> = {}) {
  const fake = fakeRunner();
  let clock = 1_000_000;
  const changes: string[] = [];
  const activity: string[] = [];
  const jobs = createBackgroundJobs({
    run: fake.run,
    now: () => clock,
    onStateChange: (job) => changes.push(`${job.id}:${job.state}`),
    onActivity: (job) => activity.push(job.id),
    ...options,
  });
  return {
    jobs,
    runs: fake.runs,
    changes,
    activity,
    advance: (ms: number) => {
      clock += ms;
    },
    time: () => clock,
  };
}

function startJob(jobs: ReturnType<typeof setup>["jobs"], extra: Record<string, unknown> = {}) {
  return jobs.start({
    role: "builder",
    worktreeKey: "t1",
    machineId: "mac",
    cwd: "/repo",
    command: "make build",
    timeoutMs: 60_000,
    ...extra,
  });
}

describe("Фоновые команды ролей", () => {
  it("старт не ждёт завершения: задача сразу в работе", async () => {
    const t = setup();
    const job = startJob(t.jobs, { taskId: "t1" });
    expect(job.state).toBe("running");
    expect(t.runs.length).toBe(1);
    expect(t.runs[0].input.command).toBe("make build");
    expect(t.runs[0].input.cwd).toBe("/repo");
    const view = t.jobs.status(job.id);
    expect(view.state).toBe("running");
    expect(view.startedAt).toBe(t.time());
    t.runs[0].resolve({ ok: true, exitCode: 0 });
    await Promise.resolve();
  });

  it("вывод копится кадрами, status отдаёт хвост, output — страницами", async () => {
    const t = setup();
    const job = startJob(t.jobs);
    t.runs[0].input.onChunk({ stream: "stdout", data: "первая строка\n" });
    t.runs[0].input.onChunk({ stream: "stderr", data: "предупреждение\n" });
    expect(t.jobs.status(job.id).tail).toContain("предупреждение");
    const page = t.jobs.output(job.id, 0);
    expect(page.data).toBe("первая строка\nпредупреждение\n");
    // Смещение считается в байтах: кириллица в символах и байтах разной длины.
    expect(page.nextOffset).toBe(Buffer.byteLength(page.data, "utf8"));
    expect(t.jobs.output(job.id, page.nextOffset).data).toBe("");
    t.runs[0].resolve({ ok: true, exitCode: 0 });
    await Promise.resolve();
  });

  it("потолок вывода режется, задача помечается усечённой", () => {
    const t = setup({ maxOutputBytes: 10 });
    const job = startJob(t.jobs);
    t.runs[0].input.onChunk({ stream: "stdout", data: "0123456789abcdef" });
    const view = t.jobs.status(job.id);
    expect(view.truncated).toBe(true);
    expect(Buffer.byteLength(view.tail, "utf8")).toBeLessThanOrEqual(10);
    t.runs[0].resolve({ ok: true, exitCode: 0 });
  });

  it("код 0 — done, ненулевой — failed, оба со временем завершения", async () => {
    const t = setup();
    const first = startJob(t.jobs, { worktreeKey: "a" });
    t.advance(5_000);
    t.runs[0].resolve({ ok: true, exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    const done = t.jobs.status(first.id);
    expect(done.state).toBe("done");
    expect(done.exitCode).toBe(0);
    expect(done.durationMs).toBe(5_000);
    expect(t.changes).toContain(`${first.id}:done`);

    const second = startJob(t.jobs, { worktreeKey: "b" });
    t.runs[1].resolve({ ok: true, exitCode: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.jobs.status(second.id).state).toBe("failed");
    expect(t.jobs.status(second.id).exitCode).toBe(2);
  });

  it("таймаут хоста — это timeout, а не обычная ошибка", async () => {
    const t = setup();
    const job = startJob(t.jobs);
    t.runs[0].reject(new Error("хост не ответил за 60с"));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.jobs.status(job.id).state).toBe("timeout");
  });

  it("обрыв связи с машиной — lost, а не провал команды", async () => {
    const t = setup();
    const job = startJob(t.jobs);
    t.runs[0].reject(new Error("связь с машиной потеряна"));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.jobs.status(job.id).state).toBe("lost");
  });

  it("stop гасит задачу и называет её stopped", async () => {
    const t = setup();
    const job = startJob(t.jobs);
    expect(t.jobs.stop(job.id).state).toBe("stopped");
    expect(t.runs[0].input.signal?.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.jobs.status(job.id).state).toBe("stopped");
  });

  it("пределы: 3 задачи на роль", () => {
    const t = setup();
    for (const key of ["a", "b", "c"]) startJob(t.jobs, { worktreeKey: key });
    expect(() => startJob(t.jobs, { worktreeKey: "d" })).toThrow(/уже 3 фоновые задачи/);
  });

  it("пределы: 6 задач на карточку", () => {
    const t = setup({ maxJobsPerRole: 10 });
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      startJob(t.jobs, { worktreeKey: key, taskId: "t1" });
    }
    expect(() => startJob(t.jobs, { worktreeKey: "g", taskId: "t1" })).toThrow(/карточки уже 6/);
  });

  it("одно дерево — одна команда: вторая встаёт в очередь и стартует после первой", async () => {
    const t = setup();
    const first = startJob(t.jobs);
    const second = startJob(t.jobs);
    expect(t.jobs.status(second.id).state).toBe("queued");
    expect(t.runs.length).toBe(1);

    t.runs[0].resolve({ ok: true, exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.jobs.status(second.id).state).toBe("running");
    expect(t.runs.length).toBe(2);
    expect(t.jobs.status(first.id).state).toBe("done");
    t.runs[1].resolve({ ok: true, exitCode: 0 });
  });

  it("остановка задачи из очереди не запускает её команду", async () => {
    const t = setup();
    startJob(t.jobs);
    const queued = startJob(t.jobs);
    t.jobs.stop(queued.id);
    t.runs[0].resolve({ ok: true, exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.runs.length).toBe(1);
    expect(t.jobs.status(queued.id).state).toBe("stopped");
  });

  it("list показывает задачи своей роли", () => {
    const t = setup();
    startJob(t.jobs, { command: "x".repeat(500) });
    startJob(t.jobs, { role: "critic_verifier", worktreeKey: "z", command: "npm test" });
    const mine = t.jobs.list({ role: "builder" });
    expect(mine.length).toBe(1);
    expect(mine[0].command.length).toBe(200);
    expect(t.jobs.list({ role: "critic_verifier" })[0].command).toBe("npm test");
  });

  it("незавершённая задача считается активностью хода", () => {
    const t = setup();
    const job = startJob(t.jobs);
    t.runs[0].input.onChunk({ stream: "stdout", data: "строка\n" });
    expect(t.activity.length).toBeGreaterThanOrEqual(2);
    expect(t.activity[0]).toBe(job.id);
  });

  it("завершённые задачи убираются через час", async () => {
    const t = setup();
    const job = startJob(t.jobs);
    t.runs[0].resolve({ ok: true, exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    t.advance(30 * 60_000);
    t.jobs.sweep();
    expect(t.jobs.status(job.id).state).toBe("done");
    t.advance(31 * 60_000);
    t.jobs.sweep();
    expect(() => t.jobs.status(job.id)).toThrow(/не найдена/);
  });

  it("неизвестная задача — понятный отказ, а не пустая строка", () => {
    const t = setup();
    expect(() => t.jobs.status("bg_нет")).toThrow(/не найдена/);
  });

  it("ожидающая задача не считается работой дерева после остановки роли", () => {
    const t = setup();
    startJob(t.jobs);
    startJob(t.jobs);
    expect(t.jobs.busyWorktrees()).toEqual(["t1"]);
  });
});

describe("Проверка запуска: сторож и рабочая папка", () => {
  it("остановка процессов по шаблону запрещена", () => {
    expect(backgroundStartError({ command: 'pkill -f "dist/index.js"', cwd: "/repo", allowedRoots: ["/repo"] }))
      .toMatch(/Остановка процессов по шаблону/);
  });

  it("пустая команда отклоняется", () => {
    expect(backgroundStartError({ command: "   ", cwd: "/repo", allowedRoots: ["/repo"] })).toMatch(/Пустая команда/);
  });

  it("рабочая папка вне разрешённых корней отклоняется", () => {
    expect(backgroundStartError({ command: "ls", cwd: "/etc", allowedRoots: ["/repo"] }))
      .toMatch(/выходит за разрешённые корни/);
  });

  it("папка внутри корня и без корней проходит", () => {
    expect(backgroundStartError({ command: "make", cwd: "/repo/wt/1", allowedRoots: ["/repo"] })).toBeNull();
    expect(backgroundStartError({ command: "make", cwd: "/repo", allowedRoots: [] })).toBeNull();
  });
});
