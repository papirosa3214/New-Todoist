import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitPush } from "../src/operations/git_push.js";
import type { OperationContext } from "../src/operations/types.js";

/** Контекст операции: корни и база worktree — всё во временной папке. */
function контекст(roots: string[]): OperationContext {
  const worktreesBase = fs.mkdtempSync(path.join(os.tmpdir(), "wt-base-"));
  return {
    roots,
    worktreesBase,
    limits: { bashOutputLimitBytes: 1_048_576, bashTimeoutMs: 15_000 },
    now: () => Date.now(),
    hostname: "test-mac",
    platform: "darwin",
  } as unknown as OperationContext;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Пустой bare-репозиторий — в нём живёт «remote». */
function пустойRemote(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

describe("git_push: ветка роли уезжает в общий remote", () => {
  it("пушит ветку роли в remote", async () => {
    const корень = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
    git(корень, ["init", "-b", "main"]);
    git(корень, ["config", "user.email", "t@example.com"]);
    git(корень, ["config", "user.name", "Тест"]);
    fs.writeFileSync(path.join(корень, "a.txt"), "было\n");

    const remote = пустойRemote();
    git(корень, ["remote", "add", "gitea", remote]);
    git(корень, ["add", "."]);
    git(корень, ["commit", "-m", "база"]);
    git(корень, ["push", "-u", "gitea", "main"]);

    // Ветка роли с коммитом — то, что должна уехать.
    const taskId = "abc-123";
    git(корень, ["checkout", "-b", `roles/${taskId}`]);
    fs.writeFileSync(path.join(корень, "a.txt"), "стало\n");
    git(корень, ["add", "."]);
    git(корень, ["commit", "-m", "работа роли"]);

    const r = (await gitPush(
      { repo: корень, taskId },
      контекст([корень]),
    )) as { branch: string; remote: string; pushed: number; unchanged: boolean };

    expect(r.branch).toBe(`roles/${taskId}`);
    expect(r.remote).toBe("gitea");
    expect(r.pushed).toBe(1);
    expect(r.unchanged).toBe(false);

    // И главное: ветка действительно есть в remote, а не только «пушилось».
    expect(git(remote, ["branch", "--list", `roles/${taskId}`])).toContain(`roles/${taskId}`);
  });

  it("повторный пуш без новых коммитов — успех, а не отказ", async () => {
    const корень = fs.mkdtempSync(path.join(os.tmpdir(), "repo2-"));
    git(корень, ["init", "-b", "main"]);
    git(корень, ["config", "user.email", "t@example.com"]);
    git(корень, ["config", "user.name", "Тест"]);
    fs.writeFileSync(path.join(корень, "a.txt"), "x\n");

    const remote = пустойRemote();
    git(корень, ["remote", "add", "gitea", remote]);
    git(корень, ["add", "."]);
    git(корень, ["commit", "-m", "база"]);
    git(корень, ["push", "-u", "gitea", "main"]);

    const taskId = "def-456";
    git(корень, ["checkout", "-b", `roles/${taskId}`]);

    const r = (await gitPush(
      { repo: корень, taskId },
      контекст([корень]),
    )) as { pushed: number; unchanged: boolean };

    // Ветка без коммитов поверх main: пустить нечего, но и ошибки быть не
    // должно — иначе роль перепишет работу вместо сдачи.
    expect(r.pushed).toBe(0);
    expect(r.unchanged).toBe(true);
  });

  it("отказывает на пути вне корней", async () => {
    const корень = fs.mkdtempSync(path.join(os.tmpdir(), "repo3-"));
    const чужой = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    git(чужой, ["init", "-b", "main"]);

    await expect(
      gitPush({ repo: чужой, taskId: "x-1" }, контекст([корень])),
    ).rejects.toThrow();
  });
});
