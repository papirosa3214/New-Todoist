// Сторож автослияния: молчит, пока очередь живая, и называет причину,
// когда она тихо встала. Работает только по временному репозиторию.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import db from "../src/db.js";
import { reloadServerSettings, setSetting } from "../src/lib/serverSettings.js";
import { checkWorktreeMerge, LIMITS, MERGE_WATCH_ACTIONS } from "../src/lib/worktreeMergeWatcher.js";

const testEnv = { ...process.env };
for (const key of Object.keys(testEnv)) {
  if (
    key === "GIT_CONFIG_COUNT" ||
    key.startsWith("GIT_CONFIG_KEY_") ||
    key.startsWith("GIT_CONFIG_VALUE_")
  )
    delete testEnv[key];
}
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...testEnv, ...env },
  }).trim();

const previousBase = process.env.TASKFLOW_ROLE_WORKTREES;
const previousLive = process.env.MAK70_LIVE_REPO;
let root = "";
let live = "";

function commit(file: string, content: string, date?: string): string {
  fs.writeFileSync(path.join(live, file), content);
  git(live, ["add", file]);
  const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {};
  git(live, ["commit", "-q", "-m", file], env);
  return git(live, ["rev-parse", "main"]);
}

function row(taskId: string, state: string, hoursAgo: number): void {
  db.prepare(
    `INSERT INTO worktree_merge_queue(task_id, trigger, state, updated_at)
     VALUES (?, 'integration_step', ?, datetime('now', ?))`,
  ).run(taskId, state, `-${hoursAgo} hours`);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-watch-"));
  live = path.join(root, "live");
  const base = path.join(root, "worktrees");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  git(live, ["init", "-q", "-b", "main"]);
  git(live, ["config", "user.email", "t@t"]);
  git(live, ["config", "user.name", "t"]);
  process.env.MAK70_LIVE_REPO = live;
  process.env.TASKFLOW_ROLE_WORKTREES = base;
  commit("a.txt", "1\n");

  db.exec(`CREATE TABLE IF NOT EXISTS worktree_merge_queue (
    task_id TEXT PRIMARY KEY, trigger TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    main_sha_before TEXT, result_sha TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT)`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS server_settings_log (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT, actor_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  );
  reloadServerSettings();
  setSetting("auto_merge_mode", "on", null, "тест сторожа слияния");
});

afterEach(() => {
  db.prepare("DELETE FROM worktree_merge_queue").run();
  setSetting("auto_merge_mode", "on", null, "тест сторожа слияния");
});

afterAll(() => {
  if (previousBase === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  else process.env.TASKFLOW_ROLE_WORKTREES = previousBase;
  if (previousLive === undefined) delete process.env.MAK70_LIVE_REPO;
  else process.env.MAK70_LIVE_REPO = previousLive;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("сторож автослияния", () => {
  it("молчит, когда очередь живая, и не оставляет пробной строки", () => {
    row("fresh-queued", "queued", 0);
    row("just-merged", "merged", 100);
    expect(checkWorktreeMerge()).toEqual({ ok: true, problems: [] });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM worktree_merge_queue").get(),
    ).toEqual({ n: 2 });
  });

  it("видит застрявшие строки: очередь, работа, грязный main, ожидание интегратора", () => {
    row("stuck-queued", "queued", LIMITS.queuedHours + 1);
    row("stuck-running", "running", LIMITS.runningHours + 1);
    row("stuck-dirty", "blocked_dirty_main", LIMITS.dirtyMainHours + 1);
    row("old-conflict", "conflict", LIMITS.awaitingAuthorHours + 1);
    row("new-conflict", "conflict", 1);
    const { ok, problems } = checkWorktreeMerge();
    expect(ok).toBe(false);
    const text = problems.join("\n");
    expect(text).toContain("stuck-qu");
    expect(text).toContain("stuck-ru");
    expect(text).toContain("stuck-di");
    expect(text).toContain("old-conf");
    expect(text).not.toContain("new-conf");
  });

  it("при выключенном автослиянии ничего не проверяет", () => {
    row("stuck-queued", "queued", LIMITS.queuedHours + 1);
    setSetting("auto_merge_mode", "off", null, "тест сторожа слияния");
    expect(checkWorktreeMerge().ok).toBe(true);
  });

  it("видит, что main не доехал до хоста после слияния", () => {
    const file = path.join(
      process.env.TASKFLOW_ROLE_WORKTREES!,
      "push-status.json",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        main_sha: "abcdef1234",
        results: [
          { remote: "origin", state: "pushed" },
          { remote: "github", state: "failed", detail: "Permission denied" },
        ],
      }),
    );
    const { ok, problems } = checkWorktreeMerge();
    expect(ok).toBe(false);
    expect(problems.join("\n")).toContain("github — отказ");
    fs.writeFileSync(
      file,
      JSON.stringify({
        at: "",
        main_sha: "",
        results: [{ remote: "origin", state: "in_sync" }],
      }),
    );
    expect(checkWorktreeMerge().ok).toBe(true);
  });

  it("видит незакрытую ветку роли на хостах после слияния", () => {
    const file = path.join(
      process.env.TASKFLOW_ROLE_WORKTREES!,
      "branch-cleanup.json",
    );
    const entry = (state: string, detail?: string) => ({
      updated_at: new Date().toISOString(),
      entries: [
        {
          at: new Date().toISOString(),
          branch: "roles/abc",
          results: [
            { remote: "origin", branch: "roles/abc", state: "deleted" },
            { remote: "github", branch: "roles/abc", state, detail },
          ],
        },
      ],
    });
    fs.writeFileSync(
      file,
      JSON.stringify(entry("failed", "Permission denied")),
    );
    const { ok, problems } = checkWorktreeMerge();
    expect(ok).toBe(false);
    expect(problems.join("\n")).toContain("roles/abc");
    expect(problems.join("\n")).toContain("github — отказ");

    fs.writeFileSync(file, JSON.stringify(entry("deleted")));
    expect(checkWorktreeMerge().ok).toBe(true);
  });

  it("подсказка про снятие помехи обещает автовозврат, а не ручную правку БД", () => {
    const text = MERGE_WATCH_ACTIONS.join("\n");
    // Раньше здесь было «очередь продолжит сама» — этого не происходило:
    // строка оставалась в стороне до повторной сдачи шага интеграции.
    expect(text).not.toMatch(/очередь продолжит сама/);
    expect(text).not.toMatch(/UPDATE worktree_merge_queue/);
    expect(text).toMatch(/Грязный main/);
    expect(text).toMatch(/вернутся в очередь сами/);
    expect(text).toMatch(/Грязная копия роли/);
    // Ручные разборы так и остаются ручными.
    expect(text).toMatch(/Конфликт \/ красные тесты/);
    expect(text).toMatch(/вернулась автору/);
  });
});
