// Финализация шага: незакоммиченное и «шаг без коммита» — отказ.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeWorktree, finalizeWorktreeError } from "../src/lib/worktree/finalize.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-finalize-"));
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

function commitIn(dir: string, text: string): void {
  fs.writeFileSync(path.join(dir, "a.txt"), text);
  git(dir, "commit", "-q", "-am", "работа роли");
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

describe("финализация шага", () => {
  it("чужой проект без ветки roles/* — пропускает молча", () => {
    expect(finalizeWorktreeError("no-such-card", { live })).toBeNull();
  });

  it("копия чистая, но коммита поверх main нет — шаг нельзя сдать", () => {
    seed("t-no-commit");
    const error = finalizeWorktreeError("t-no-commit", { live });
    expect(error).toContain("должен быть коммит поверх main");
    expect(() => finalizeWorktree("t-no-commit", { live })).toThrow();
  });

  it("незакоммиченное в копии — отказ с перечислением файлов", () => {
    const dir = seed("t-dirty");
    fs.writeFileSync(path.join(dir, "a.txt"), "мусор\n");
    fs.writeFileSync(path.join(dir, "secret.env"), "TOKEN=1\n");
    const error = finalizeWorktreeError("t-dirty", { live });
    expect(error).toContain("зафиксируй изменения");
    expect(error).toContain("a.txt");
    expect(error).toContain("secret.env");
  });

  it("есть коммит и копия чистая — шаг можно сдать", () => {
    const dir = seed("t-ok");
    commitIn(dir, "2\n");
    expect(finalizeWorktreeError("t-ok", { live })).toBeNull();
  });

  it("выключатель off — копий нет, проверка молчит", () => {
    seed("t-off");
    process.env.TASKFLOW_ROLE_WORKTREES = "off";
    try {
      expect(finalizeWorktreeError("t-off", { live })).toBeNull();
    } finally {
      process.env.TASKFLOW_ROLE_WORKTREES = base;
    }
  });
});
