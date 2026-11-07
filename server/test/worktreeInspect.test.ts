// Инспектор рабочей копии: чистый снимок git без сети и без БД.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectWorktree } from "../src/lib/worktree/inspect.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-inspect-"));
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

function seed(taskId: string): void {
  const dir = path.join(base, taskId);
  fs.mkdirSync(dir, { recursive: true });
  git(live, "worktree", "prune");
  git(live, "worktree", "add", "-b", `roles/${taskId}`, dir, "main");
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

describe("инспектор рабочей копии", () => {
  it("карточки без ветки не считает ошибкой: нули вместо падения", () => {
    const state = inspectWorktree("missing", "main", live);
    expect(state.branch_exists).toBe(false);
    expect(state.ahead_count).toBe(0);
    expect(state.dirty).toEqual([]);
    expect(state.tip).toBeNull();
  });

  it("чистая копия без коммитов: ветка есть, ahead=0, сливать нечего", () => {
    seed("t-clean");
    const state = inspectWorktree("t-clean", "main", live);
    expect(state.branch_exists).toBe(true);
    expect(state.worktree_exists).toBe(true);
    expect(state.dirty).toEqual([]);
    expect(state.ahead_count).toBe(0);
    expect(state.merged_into_base).toBe(true);
  });

  it("коммит в копии виден как ahead, живая копия не тронута", () => {
    const id = "t-commit";
    seed(id);
    const dir = path.join(base, id);
    fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
    git(dir, "commit", "-q", "-am", "работа роли");
    const state = inspectWorktree(id, "main", live);
    expect(state.ahead_count).toBe(1);
    expect(state.merged_into_base).toBe(false);
    expect(fs.readFileSync(path.join(live, "a.txt"), "utf8")).toBe("1\n");
  });

  it("незакоммиченные изменения перечислены поимённо", () => {
    const id = "t-dirty";
    seed(id);
    const dir = path.join(base, id);
    fs.writeFileSync(path.join(dir, "a.txt"), "3\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "новый\n");
    const state = inspectWorktree(id, "main", live);
    expect(state.dirty).toHaveLength(2);
    expect(state.dirty.join(" ")).toContain("a.txt");
    expect(state.dirty.join(" ")).toContain("b.txt");
  });

  it("после влития в main ветка помечается слитой", () => {
    const id = "t-merged";
    seed(id);
    const dir = path.join(base, id);
    fs.writeFileSync(path.join(dir, "a.txt"), "4\n");
    git(dir, "commit", "-q", "-am", "работа роли");
    git(dir, "merge", "-q", "--ff-only", "main"); // main не ушёл — коммит остаётся
    git(live, "merge", "-q", "--ff-only", `roles/${id}`);
    const state = inspectWorktree(id, "main", live);
    expect(state.ahead_count).toBe(0);
    expect(state.merged_into_base).toBe(true);
  });
});
