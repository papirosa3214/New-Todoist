// Уборка: только подтверждённое слияние и только чистая копия.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupWorktree, sweepTestLeftovers } from "../src/lib/worktree/cleanup.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cleanup-"));
const live = path.join(root, "live");
const base = path.join(root, "worktrees");
// Хук `test/setup.ts` запрещает коммиты в живом репозитории и цепляется
// ко всем git-вызовам прогона через GIT_CONFIG_*. Здесь работа идёт
// исключительно во временном репозитории из mkdtemp — снимаем эти
// переменные у СВОЕГО git, чтобы заглушка не рубила тестовые коммиты.
// Защита живого репозитория при этом остаётся в силе.
const testEnv = { ...process.env };
delete testEnv.GIT_CONFIG_COUNT;
for (const key of Object.keys(testEnv)) {
  if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete testEnv[key];
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: testEnv }).trim();
const previousBase = process.env.TASKFLOW_ROLE_WORKTREES;

function seed(taskId: string): string {
  const dir = path.join(base, taskId);
  fs.mkdirSync(dir, { recursive: true });
  git(live, "worktree", "prune");
  git(live, "worktree", "add", "-b", `roles/${taskId}`, dir, "main");
  return dir;
}

beforeAll(() => {
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "t@t");
  git(live, "config", "user.name", "t");
  fs.writeFileSync(path.join(live, "a.txt"), "1\n");
  git(live, "add", "a.txt");
  git(live, "commit", "-q", "-m", "init");
  process.env.TASKFLOW_ROLE_WORKTREES = base;
});

afterAll(() => {
  if (previousBase === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  else process.env.TASKFLOW_ROLE_WORKTREES = previousBase;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("уборка рабочих копий", () => {
  it("без подтверждённого слияния не убирает ничего", async () => {
    const dir = seed("t-unmerged");
    fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
    git(dir, "commit", "-q", "-am", "работа роли");
    const result = await cleanupWorktree("t-unmerged", { live, mergedAt: null, skipRemote: true });
    expect(result.skipped).toBe("слияние не подтверждено");
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("грязная копия не убирается даже при подтверждённом слиянии", async () => {
    const dir = seed("t-dirty");
    fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
    git(dir, "commit", "-q", "-am", "работа роли");
    git(live, "merge", "-q", "--ff-only", "roles/t-dirty");
    fs.writeFileSync(path.join(dir, "черновик.txt"), "незакоммичено\n");
    const result = await cleanupWorktree("t-dirty", { live, mergedAt: "2026-10-19 00:00:00", skipRemote: true });
    expect(result.skipped).toContain("незакоммиченное");
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("слитая и чистая копия исчезает вместе с веткой", async () => {
    const dir = seed("t-merged");
    fs.writeFileSync(path.join(dir, "a.txt"), "3\n");
    git(dir, "commit", "-q", "-am", "работа роли");
    git(live, "merge", "-q", "--ff-only", "roles/t-merged");
    const result = await cleanupWorktree("t-merged", { live, mergedAt: "2026-10-19 00:00:00", skipRemote: true });
    expect(result.removed_worktree).toBe(true);
    expect(result.removed_branch).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(live, "branch", "--list", "roles/t-merged")).toBe("");
  });

  it("тестовые каталоги iso-test-* без .git убираются, другие — нет", () => {
    fs.mkdirSync(path.join(base, "iso-test-abc"), { recursive: true });
    fs.writeFileSync(path.join(base, "iso-test-abc", "x"), "x");
    fs.mkdirSync(path.join(base, "чужое-имя"), { recursive: true });
    expect(sweepTestLeftovers()).toBe(1);
    expect(fs.existsSync(path.join(base, "iso-test-abc"))).toBe(false);
    expect(fs.existsSync(path.join(base, "чужое-имя"))).toBe(true);
  });
});
