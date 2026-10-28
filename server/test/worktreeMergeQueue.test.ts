// Очередь автослияния: main двигается только после зелёных тестов.
//
// Каждому кейсу — СВОЙ временный репозиторий. Общий репозиторий в тестах
// врёт: main уезжает от кейса к кейсу, и «красные тесты» превращаются в
// настоящий конфликт, которого в бою не было бы.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../src/db.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drainMergeQueue, enqueueMerge, hooks, mergeQueueRow, processMerge, recoverStaleRunning, requeueMerge, retryClearedObstructions, sweepMergeScratch, syncPullRequests, worktreeMaintenancePass } from "../src/runtime/worktreeMergeQueue.js";
import { reloadServerSettings, setSetting } from "../src/lib/serverSettings.js";
import { saveBaseline } from "../src/lib/worktree/testGate.js";

// Хук `test/setup.ts` запрещает коммиты в живом репозитории и цепляется
// ко всем git-вызовам прогона через GIT_CONFIG_*. Здесь работа идёт
// исключительно во временных репозиториях из mkdtemp — снимаем эти
// переменные у СВОЕГО git, чтобы заглушка не рубила тестовые коммиты.
// Защита живого репозитория при этом остаётся в силе.
const testEnv = { ...process.env };
delete testEnv.GIT_CONFIG_COUNT;
for (const key of Object.keys(testEnv)) {
  if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete testEnv[key];
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: testEnv }).trim();

const realRunTests = hooks.runTests;
const roots: string[] = [];
let stashedGitConfig: Array<[string, string]> = [];
const previousBase = process.env.TASKFLOW_ROLE_WORKTREES;
const previousLive = process.env.MAK70_LIVE_REPO;

interface Repo {
  live: string;
  base: string;
}

/** Чистый репозиторий с одним коммитом и пустой базой копий. */
function freshRepo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-queue-"));
  roots.push(root);
  const live = path.join(root, "live");
  const base = path.join(root, "worktrees");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "t@t");
  git(live, "config", "user.name", "t");
  fs.writeFileSync(path.join(live, "a.txt"), "1\n");
  git(live, "add", "a.txt");
  git(live, "commit", "-q", "-m", "init");
  process.env.MAK70_LIVE_REPO = live;
  process.env.TASKFLOW_ROLE_WORKTREES = base;
  // База падений main для гейта: в тестах main считается зелёным, иначе
  // гейт запретит слияние раньше, чем проверка регрессии сможет что-то сказать.
  saveBaseline([], git(live, "rev-parse", "main"));
  return { live, base };
}

/** Копия роли на ветке roles/<id> с одним коммитом поверх main. */
function seedBranch(repo: Repo, taskId: string, file = "a.txt", content = "2\n"): string {
  const dir = path.join(repo.base, taskId);
  fs.mkdirSync(dir, { recursive: true });
  git(repo.live, "worktree", "prune");
  git(repo.live, "worktree", "add", "-b", `roles/${taskId}`, dir, "main");
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "commit", "-q", "-am", "работа роли");
  return dir;
}

function seedTask(taskId: string): void {
  db.prepare("INSERT OR REPLACE INTO tasks(id) VALUES (?)").run(taskId);
}

beforeAll(() => {
  // Заглушка `test/setup.ts` вешает hooks (`pre-commit`, `pre-merge-commit`)
  // через GIT_CONFIG_* на весь процесс прогона и рубит ЛЮБОЙ merge —
  // включая слияние внутри временного репозитория. Этот файл работает
  // только по mkdtemp-репозиториям (`MAK70_LIVE_REPO` переопределён), так
  // что гасим заглушку на время файла и возвращаем её в afterAll.
  stashedGitConfig = Object.entries(process.env).filter(
    ([key]) => key === "GIT_CONFIG_COUNT" || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_"),
  );
  for (const [key] of stashedGitConfig) delete process.env[key];

  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, merged_at TEXT, merged_into_commit TEXT, merged_into_branch TEXT, status TEXT DEFAULT 'active', agent_state TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL, field TEXT, from_value TEXT, to_value TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS worktree_merge_queue (
    task_id TEXT PRIMARY KEY, trigger TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    main_sha_before TEXT, result_sha TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT)`);
  // Тестовая БД пустая: таблиц реестра параметров в ней нет, пока миграции
  // не отработали. Создаём их и перечитываем кэш — иначе setSetting падает.
  db.exec(`CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS server_settings_log (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT, actor_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  reloadServerSettings();
  setSetting("auto_merge_mode", "on", null, "тест очереди слияния");
});

afterEach(() => {
  // Тесты не запускаем: крюк подменён на каждом кейсе, где он нужен.
  hooks.runTests = async () => ({ ok: true, output: "ok" });
  db.prepare("DELETE FROM worktree_merge_queue").run();
});

afterAll(() => {
  for (const [key, value] of stashedGitConfig) process.env[key] = value;
  if (previousBase === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  else process.env.TASKFLOW_ROLE_WORKTREES = previousBase;
  if (previousLive === undefined) delete process.env.MAK70_LIVE_REPO;
  else process.env.MAK70_LIVE_REPO = previousLive;
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("очередь автослияния", () => {
  it("грязный main — очередь встаёт, ветка не тронута", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-dirty-main");
    seedTask("t-dirty-main");
    fs.writeFileSync(path.join(repo.live, "черновик.txt"), "чужая правка\n");
    enqueueMerge("t-dirty-main", "integration_step");
    const outcome = await processMerge("t-dirty-main");
    expect(outcome.state).toBe("blocked_dirty_main");
    expect(git(repo.live, "log", "--oneline", "main")).not.toContain("работа роли");
  });

  it("зелёные тесты: ветка переносится в main, копия убрана", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-green");
    seedTask("t-green");
    hooks.runTests = async () => ({ ok: true, output: "1 passed" });
    enqueueMerge("t-green", "integration_step");
    const outcome = await processMerge("t-green");
    expect(outcome.state).toBe("merged");
    expect(fs.readFileSync(path.join(repo.live, "a.txt"), "utf8")).toBe("2\n");
    expect(fs.existsSync(path.join(repo.base, "t-green"))).toBe(false);
    expect(git(repo.live, "branch", "--list", "roles/t-green")).toBe("");
    const task = db.prepare("SELECT merged_at, merged_into_commit FROM tasks WHERE id = ?").get("t-green") as
      | { merged_at: string | null; merged_into_commit: string | null };
    expect(task.merged_at).toBeTruthy();
    expect(task.merged_into_commit).toBe(git(repo.live, "rev-parse", "main"));
  });

  it("красные тесты: main не тронут, ветка и копия остаются", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-red");
    seedTask("t-red");
    hooks.runTests = async () => ({ ok: false, output: " ❯ test/roles.test.ts (2 tests | 1 failed)" });
    const mainBefore = git(repo.live, "rev-parse", "main");
    enqueueMerge("t-red", "integration_step");
    const outcome = await processMerge("t-red");
    expect(outcome.state).toBe("test_failed");
    expect(outcome.error).toContain("новые падения");
    expect(git(repo.live, "rev-parse", "main")).toBe(mainBefore);
    expect(fs.existsSync(path.join(repo.base, "t-red"))).toBe(true);
    expect(git(repo.live, "branch", "--list", "roles/t-red")).not.toBe("");
  });

  it("конфликт: main не тронут, состояние conflict с файлами", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-conflict");
    seedTask("t-conflict");
    // main уходит вперёд и меняет тот же файл, что и роль.
    fs.writeFileSync(path.join(repo.live, "a.txt"), "из main\n");
    git(repo.live, "commit", "-q", "-am", "правка main");
    const mainBefore = git(repo.live, "rev-parse", "main");
    enqueueMerge("t-conflict", "integration_step");
    const outcome = await processMerge("t-conflict");
    expect(outcome.state).toBe("conflict");
    expect(outcome.error).toContain("a.txt");
    expect(git(repo.live, "rev-parse", "main")).toBe(mainBefore);
    expect(fs.existsSync(path.join(repo.base, "t-conflict"))).toBe(true);
    // Следующая попытка после разрешения конфликта возможна.
    expect(mergeQueueRow("t-conflict")?.state).toBe("conflict");
  });

  it("режим dry: считает и проверяет тестами, но main не двигает", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-dry");
    seedTask("t-dry");
    hooks.runTests = async () => ({ ok: true, output: "1 passed" });
    setSetting("auto_merge_mode", "dry", null, "тест пробного режима");
    try {
      const mainBefore = git(repo.live, "rev-parse", "main");
      enqueueMerge("t-dry", "integration_step");
      const outcome = await processMerge("t-dry");
      expect(outcome.state).toBe("dry_run");
      expect(outcome.result_sha).toBeTruthy();
      expect(git(repo.live, "rev-parse", "main")).toBe(mainBefore);
      expect(fs.existsSync(path.join(repo.base, "t-dry"))).toBe(true);
    } finally {
      setSetting("auto_merge_mode", "on", null, "возврат боевого режима");
    }
  });

  it("развертка не стирает диагноз: «красные тесты» остаются видны", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-keep-state");
    seedTask("t-keep-state");
    hooks.runTests = async () => ({ ok: false, output: " ❯ test/worktreeInspect.test.ts (5 tests | 1 failed)" });
    enqueueMerge("t-keep-state", "integration_step");
    await processMerge("t-keep-state");
    expect(mergeQueueRow("t-keep-state")?.state).toBe("test_failed");
    // Следующая развертка не должна возвращать карточку в «queued» и
    // стирать причину: иначе отказ невозможно увидеть и починить.
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-keep-state")?.state).toBe("test_failed");
    expect(mergeQueueRow("t-keep-state")?.error).toContain("новые падения");
  });

  it("снятая помеха в main: проход обслуживания сам возвращает строку в очередь и сливает", async () => {
    const repo = freshRepo();
    const dir = seedBranch(repo, "t-unblock-main");
    seedTask("t-unblock-main");
    fs.writeFileSync(path.join(repo.live, "черновик.txt"), "чужая правка\n");
    enqueueMerge("t-unblock-main", "integration_step");
    expect((await processMerge("t-unblock-main")).state).toBe("blocked_dirty_main");
    // Помеха снята (человек разобрался с чужим незакоммиченным) — роль
    // про это не знает и шаг заново не сдаёт: возвращать должен проход.
    fs.rmSync(path.join(repo.live, "черновик.txt"));
    expect(retryClearedObstructions()).toEqual(["t-unblock-main"]);
    expect(mergeQueueRow("t-unblock-main")?.state).toBe("queued");
    expect(mergeQueueRow("t-unblock-main")?.error).toBeNull();
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-unblock-main")?.state).toBe("merged");
    expect(git(repo.live, "log", "--oneline", "main")).toContain("работа роли");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("очищенная копия роли: строка возвращается в очередь сама", async () => {
    const repo = freshRepo();
    const dir = seedBranch(repo, "t-unblock-copy");
    seedTask("t-unblock-copy");
    fs.writeFileSync(path.join(dir, "заметка.md"), "черновик роли\n");
    enqueueMerge("t-unblock-copy", "integration_step");
    expect((await processMerge("t-unblock-copy")).state).toBe("dirty_worktree");
    // Незакоммиченное в копии закоммитили — помеха снята.
    git(dir, "add", "заметка.md");
    git(dir, "commit", "-q", "-m", "заметка роли");
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-unblock-copy")?.state).toBe("merged");
    expect(fs.existsSync(path.join(repo.live, "заметка.md"))).toBe(true);
  });

  it("пока помеха не снята, строка остаётся в стороне и main не трогается", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-still-dirty");
    seedTask("t-still-dirty");
    fs.writeFileSync(path.join(repo.live, "черновик.txt"), "чужая правка\n");
    enqueueMerge("t-still-dirty", "integration_step");
    await processMerge("t-still-dirty");
    expect(retryClearedObstructions()).toEqual([]);
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-still-dirty")?.state).toBe("blocked_dirty_main");
    expect(mergeQueueRow("t-still-dirty")?.error).toContain("незакоммиченное");
    expect(git(repo.live, "log", "--oneline", "main")).not.toContain("работа роли");
  });

  it("конфликт и красные тесты остаются ручными: проход их не переоформляет", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-manual-conflict");
    seedTask("t-manual-conflict");
    fs.writeFileSync(path.join(repo.live, "a.txt"), "ушёл вперёд\n");
    git(repo.live, "commit", "-q", "-am", "правка main");
    enqueueMerge("t-manual-conflict", "integration_step");
    expect((await processMerge("t-manual-conflict")).state).toBe("conflict");

    saveBaseline([], git(repo.live, "rev-parse", "main"));
    seedBranch(repo, "t-manual-red");
    seedTask("t-manual-red");
    hooks.runTests = async () => ({ ok: false, output: " ❯ test/roles.test.ts (2 tests | 1 failed)" });
    enqueueMerge("t-manual-red", "integration_step");
    expect((await processMerge("t-manual-red")).state).toBe("test_failed");

    const mainBefore = git(repo.live, "rev-parse", "main");
    expect(retryClearedObstructions()).toEqual([]);
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-manual-conflict")?.state).toBe("conflict");
    expect(mergeQueueRow("t-manual-red")?.state).toBe("test_failed");
    expect(git(repo.live, "rev-parse", "main")).toBe(mainBefore);
  });

  it("повторная сдача шага после конфликта возвращает карточку в очередь", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-retry");
    seedTask("t-retry");
    enqueueMerge("t-retry", "integration_step");
    fs.writeFileSync(path.join(repo.live, "a.txt"), "ушёл вперёд\n");
    git(repo.live, "commit", "-q", "-am", "правка main");
    await processMerge("t-retry");
    expect(mergeQueueRow("t-retry")?.state).toBe("conflict");
    // Роль починила конфликт и сдала шаг снова — система переоформляет.
    expect(requeueMerge("t-retry")).toBe(true);
    expect(mergeQueueRow("t-retry")?.state).toBe("queued");
  });

  it("режим off: очередь не наполняется, проход пуст", async () => {
    freshRepo();
    setSetting("auto_merge_mode", "off", null, "тест выключателя");
    try {
      expect(enqueueMerge("t-off", "integration_step")).toBe(false);
      expect(await drainMergeQueue(5)).toEqual([]);
    } finally {
      setSetting("auto_merge_mode", "on", null, "возврат боевого режима");
    }
  });

  it("зависшая в running строка возвращается в очередь сама", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-stuck-running");
    seedTask("t-stuck-running");
    enqueueMerge("t-stuck-running", "integration_step");
    // Сервер упал посреди слияния: строка осталась в `running`.
    db.prepare(
      "UPDATE worktree_merge_queue SET state = 'running', updated_at = datetime('now', '-3 hours') WHERE task_id = ?",
    ).run("t-stuck-running");
    expect(recoverStaleRunning()).toEqual(["t-stuck-running"]);
    expect(mergeQueueRow("t-stuck-running")?.state).toBe("queued");
    expect(mergeQueueRow("t-stuck-running")?.error).toBeNull();
    // Дальше обычный путь: карточка сливается.
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-stuck-running")?.state).toBe("merged");
    expect(git(repo.live, "log", "--oneline", "main")).toContain("работа роли");
  });

  it("свежая строка running не трогается: слияние ещё идёт", async () => {
    freshRepo();
    seedTask("t-live-running");
    enqueueMerge("t-live-running", "integration_step");
    db.prepare("UPDATE worktree_merge_queue SET state = 'running' WHERE task_id = ?").run("t-live-running");
    expect(recoverStaleRunning()).toEqual([]);
    expect(mergeQueueRow("t-live-running")?.state).toBe("running");
  });

  it("временная копия упавшего слияния убирается с диска", async () => {
    const repo = freshRepo();
    seedTask("t-scratch");
    enqueueMerge("t-scratch", "integration_step");
    const scratch = path.join(repo.base, ".merge-t-scratch");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "хвост.txt"), "остаток\n");
    expect(sweepMergeScratch()).toBe(1);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("временная копия живой строки running остаётся на месте", async () => {
    const repo = freshRepo();
    seedTask("t-scratch-live");
    enqueueMerge("t-scratch-live", "integration_step");
    db.prepare("UPDATE worktree_merge_queue SET state = 'running' WHERE task_id = ?").run("t-scratch-live");
    const scratch = path.join(repo.base, ".merge-t-scratch-live");
    fs.mkdirSync(scratch, { recursive: true });
    expect(sweepMergeScratch()).toBe(0);
    expect(fs.existsSync(scratch)).toBe(true);
  });
});


describe("maintenance demand", () => {
  it("does not refresh a stale baseline when the queue is empty", async () => {
    const repo = freshRepo();
    saveBaseline([], "stale");
    let calls = 0;
    hooks.runTests = async () => { calls++; return { ok: true, output: "ok" }; };
    await worktreeMaintenancePass();
    expect(calls).toBe(0);
  });
  it("does not run tests when main is dirty even with queued work", async () => {
    const repo = freshRepo();
    seedTask("t-maint-dirty");
    seedBranch(repo, "t-maint-dirty");
    enqueueMerge("t-maint-dirty", "integration_step");
    saveBaseline([], "stale");
    fs.writeFileSync(path.join(repo.live, "dirty.txt"), "owner work");
    let calls = 0;
    hooks.runTests = async () => { calls++; return { ok: true, output: "ok" }; };
    await worktreeMaintenancePass();
    expect(calls).toBe(0);
  });
});


describe("test process lifecycle", () => {
  it("kills the test descendant on timeout", async () => {
    const repo = freshRepo();
    const pidFile = path.join(repo.live, "child.pid");
    const fixture = path.join(repo.live, "child.cjs");
    fs.writeFileSync(fixture, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000);`);
    const previous = process.env.TASKFLOW_AUTO_MERGE_TEST_CMD;
    process.env.TASKFLOW_AUTO_MERGE_TEST_CMD = `node ${fixture}`;
    let pid: number | undefined;
    try {
      const result = await realRunTests(repo.live, 500);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(result.ok).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 50));
      let running = false;
      try { running = !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z"); } catch {}
      expect(running).toBe(false);
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      if (previous === undefined) delete process.env.TASKFLOW_AUTO_MERGE_TEST_CMD;
      else process.env.TASKFLOW_AUTO_MERGE_TEST_CMD = previous;
    }
  });
});


describe("merge demand and pause", () => {
  it("refreshes stale main only for a ready merge", async () => {
    const repo = freshRepo();
    seedTask("t-ready-refresh"); seedBranch(repo, "t-ready-refresh");
    enqueueMerge("t-ready-refresh", "integration_step");
    saveBaseline([], "stale");
    let calls = 0;
    hooks.runTests = async () => { calls++; return { ok: true, output: "ok" }; };
    expect((await processMerge("t-ready-refresh")).state).toBe("merged");
    expect(calls).toBe(2);
  });
  it("does not move main if disabled during tests", async () => {
    const repo = freshRepo();
    seedTask("t-pause-tests"); seedBranch(repo, "t-pause-tests");
    enqueueMerge("t-pause-tests", "integration_step");
    const before = git(repo.live, "rev-parse", "main");
    hooks.runTests = async () => {
      setSetting("auto_merge_mode", "off", null);
      return { ok: true, output: "ok" };
    };
    try {
      expect((await processMerge("t-pause-tests")).state).toBe("queued");
      expect(git(repo.live, "rev-parse", "main")).toBe(before);
    } finally { setSetting("auto_merge_mode", "on", null); }
  });
});


describe("interrupted validation", () => {
  it("does not accept a timed out baseline as green", async () => {
    const repo = freshRepo();
    seedTask("t-baseline-timeout"); seedBranch(repo, "t-baseline-timeout");
    enqueueMerge("t-baseline-timeout", "integration_step");
    saveBaseline([], "stale");
    const before = git(repo.live, "rev-parse", "main");
    hooks.runTests = async () => ({ ok: false, output: "[прервано по таймауту 20 с]" });
    expect((await processMerge("t-baseline-timeout")).state).toBe("test_failed");
    expect(git(repo.live, "rev-parse", "main")).toBe(before);
  });
  it("does not accept a test startup failure as green", async () => {
    const repo = freshRepo();
    seedTask("t-test-crash"); seedBranch(repo, "t-test-crash");
    enqueueMerge("t-test-crash", "integration_step");
    const before = git(repo.live, "rev-parse", "main");
    hooks.runTests = async () => ({ ok: false, output: "npm: command not found" });
    expect((await processMerge("t-test-crash")).state).toBe("test_failed");
    expect(git(repo.live, "rev-parse", "main")).toBe(before);
  });
});


describe("integration stamp is the only admission",()=>{
  it("does not discover a completed branch on its own",async()=>{
    const repo=freshRepo();seedTask("t-no-stamp");seedBranch(repo,"t-no-stamp");
    db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run("t-no-stamp");
    await worktreeMaintenancePass();
    expect(mergeQueueRow("t-no-stamp")).toBeUndefined();
  });
  it("rejects sweep and final-orchestrator triggers",()=>{
    const repo=freshRepo();seedTask("t-reject-trigger");seedBranch(repo,"t-reject-trigger");
    expect(enqueueMerge("t-reject-trigger","sweep")).toBe(false);
    expect(enqueueMerge("t-reject-trigger","orchestrator_step")).toBe(false);
    expect(mergeQueueRow("t-reject-trigger")).toBeUndefined();
  });
  it("does not validate legacy sweep entries and allows a later integration stamp",async()=>{
    const repo=freshRepo();seedTask("t-legacy");seedBranch(repo,"t-legacy");
    db.prepare("INSERT INTO worktree_merge_queue(task_id,trigger,state) VALUES (?,'sweep','queued')").run("t-legacy");
    let calls=0;hooks.runTests=async()=>{calls++;return {ok:true,output:"ok"};};
    expect((await processMerge("t-legacy")).state).toBe("disabled");
    expect(calls).toBe(0);
    expect(requeueMerge("t-legacy")).toBe(false);
    expect(enqueueMerge("t-legacy","integration_step")).toBe(true);
    expect((await processMerge("t-legacy")).state).toBe("merged");
    expect(calls).toBe(1);
  });
});

// Режим pr (владелец 28.10.2026): ветка роли уходит на GitHub, открывается
// PR, тесты и слияние — CI на GitHub. Сервер main не двигает и тестов не
// гоняет, только следит за исходом PR.
describe("режим pr: слияние через PR на GitHub", () => {
  const real = { pushBranch: hooks.pushBranch, ensurePullRequest: hooks.ensurePullRequest, pullRequestStatus: hooks.pullRequestStatus };
  let pushed: string[] = [];
  let status: ReturnType<typeof hooks.pullRequestStatus>;

  beforeAll(() => {
    for (const column of ["pr_number INTEGER", "pr_url TEXT"]) {
      try { db.exec(`ALTER TABLE worktree_merge_queue ADD COLUMN ${column}`); } catch { /* уже есть */ }
    }
  });
  afterAll(() => {
    Object.assign(hooks, real);
    setSetting("auto_merge_mode", "on", null, "возврат боевого режима");
  });
  afterEach(() => {
    pushed = [];
  });

  function prMode(): void {
    setSetting("auto_merge_mode", "pr", null, "тест режима pr");
    hooks.pushBranch = (_live, branch) => { pushed.push(branch); };
    hooks.ensurePullRequest = () => ({ number: 42, url: "https://github.com/o/r/pull/42" });
    status = { state: "OPEN", mergeable: "MERGEABLE", merge_commit: null, checks_failed: false };
    hooks.pullRequestStatus = () => status;
  }

  it("сдача шага: ветка отправлена, PR открыт, main и тесты не тронуты", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-pr");
    seedTask("t-pr");
    prMode();
    let tests = 0;
    hooks.runTests = async () => { tests++; return { ok: true, output: "ok" }; };
    const mainBefore = git(repo.live, "rev-parse", "main");
    enqueueMerge("t-pr", "integration_step");
    const outcome = await processMerge("t-pr");
    expect(outcome.state).toBe("pr_open");
    expect(pushed).toEqual(["roles/t-pr"]);
    expect(tests).toBe(0);
    expect(git(repo.live, "rev-parse", "main")).toBe(mainBefore);
    expect(mergeQueueRow("t-pr")).toMatchObject({ state: "pr_open", pr_number: 42, pr_url: "https://github.com/o/r/pull/42" });
  });

  it("грязный живой main не мешает: PR всё равно открывается", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-pr-dirty");
    seedTask("t-pr-dirty");
    prMode();
    fs.writeFileSync(path.join(repo.live, "черновик.txt"), "чужая правка\n");
    enqueueMerge("t-pr-dirty", "integration_step");
    expect((await processMerge("t-pr-dirty")).state).toBe("pr_open");
  });

  it("PR влит на GitHub: карточка получает «влито» и коммит слияния", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-pr-merged");
    seedTask("t-pr-merged");
    prMode();
    enqueueMerge("t-pr-merged", "integration_step");
    await processMerge("t-pr-merged");
    expect(syncPullRequests()).toBe(0); // ещё идёт проверка
    status = { state: "MERGED", mergeable: "UNKNOWN", merge_commit: "abc123", checks_failed: false };
    expect(syncPullRequests()).toBe(1);
    expect(mergeQueueRow("t-pr-merged")).toMatchObject({ state: "merged", result_sha: "abc123" });
    const task = db.prepare("SELECT merged_at, merged_into_commit FROM tasks WHERE id = ?").get("t-pr-merged") as
      { merged_at: string | null; merged_into_commit: string | null };
    expect(task.merged_at).toBeTruthy();
    expect(task.merged_into_commit).toBe("abc123");
  });

  it("конфликт в PR: роли на разбор, повторная сдача снова отправляет ветку", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-pr-conflict");
    seedTask("t-pr-conflict");
    prMode();
    enqueueMerge("t-pr-conflict", "integration_step");
    await processMerge("t-pr-conflict");
    status = { state: "OPEN", mergeable: "CONFLICTING", merge_commit: null, checks_failed: false };
    syncPullRequests();
    expect(mergeQueueRow("t-pr-conflict")?.state).toBe("conflict");
    expect(mergeQueueRow("t-pr-conflict")?.error).toContain("PR #42");
    expect(requeueMerge("t-pr-conflict")).toBe(true);
    expect((await processMerge("t-pr-conflict")).state).toBe("pr_open");
    expect(pushed).toEqual(["roles/t-pr-conflict", "roles/t-pr-conflict"]);
  });

  it("красные проверки CI: test_failed с номером PR", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-pr-red");
    seedTask("t-pr-red");
    prMode();
    enqueueMerge("t-pr-red", "integration_step");
    await processMerge("t-pr-red");
    status = { state: "OPEN", mergeable: "MERGEABLE", merge_commit: null, checks_failed: true };
    syncPullRequests();
    expect(mergeQueueRow("t-pr-red")).toMatchObject({ state: "test_failed" });
  });

  it("GitHub недоступен: строка остаётся в очереди для повтора", async () => {
    const repo = freshRepo();
    seedBranch(repo, "t-pr-net");
    seedTask("t-pr-net");
    prMode();
    hooks.pushBranch = () => { throw new Error("сеть"); };
    enqueueMerge("t-pr-net", "integration_step");
    const outcome = await processMerge("t-pr-net");
    expect(outcome.state).toBe("queued");
    expect(outcome.error).toContain("PR не открыт");
  });
});
