import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDeleteBranch, type GitDeleteBranchOutput } from "../src/operations/git_delete_branch.js";
import { BadArgsError, type OperationContext } from "../src/operations/types.js";

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

function bare(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

/** Репозиторий роли: main в двух хостах и ветка `roles/<id>`. */
function репозиторий(слита: boolean): { repo: string; remotes: string[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Тест"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "было\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "база"]);

  const remotes = [bare(), bare()];
  git(repo, ["remote", "add", "origin", remotes[0]!]);
  git(repo, ["remote", "add", "github", remotes[1]!]);
  for (const r of ["origin", "github"]) git(repo, ["push", "-q", "-u", r, "main"]);

  git(repo, ["checkout", "-q", "-b", "roles/abc-123"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "работа роли\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "работа роли"]);
  for (const r of ["origin", "github"]) git(repo, ["push", "-q", r, "roles/abc-123"]);

  if (слита) {
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "-q", "--no-ff", "-m", "слияние", "roles/abc-123"]);
    for (const r of ["origin", "github"]) git(repo, ["push", "-q", r, "main"]);
  }
  return { repo, remotes };
}

describe("git_delete_branch: слитая ветка роли снимается с хостов", () => {
  it("удаляет слитую ветку на обоих хостах", async () => {
    const { repo } = репозиторий(true);
    const r = (await gitDeleteBranch(
      { repo, branch: "roles/abc-123" },
      контекст([repo]),
    )) as GitDeleteBranchOutput;

    expect(r.results.map((x) => x.state)).toEqual(["deleted", "deleted"]);
    expect(git(repo, ["ls-remote", "--heads", "origin", "refs/heads/roles/abc-123"])).toBe("");
    expect(git(repo, ["ls-remote", "--heads", "github", "refs/heads/roles/abc-123"])).toBe("");
  });

  it("повторный вызов видит, что ветки уже нет", async () => {
    const { repo } = репозиторий(true);
    await gitDeleteBranch({ repo, branch: "roles/abc-123" }, контекст([repo]));
    const r = (await gitDeleteBranch(
      { repo, branch: "roles/abc-123" },
      контекст([repo]),
    )) as GitDeleteBranchOutput;
    expect(r.results.map((x) => x.state)).toEqual(["absent", "absent"]);
  });

  it("не трогает ветку, у которой есть коммиты вне main", async () => {
    const { repo } = репозиторий(false);
    const r = (await gitDeleteBranch(
      { repo, branch: "roles/abc-123" },
      контекст([repo]),
    )) as GitDeleteBranchOutput;

    expect(r.results.map((x) => x.state)).toEqual(["skipped", "skipped"]);
    expect(r.results[0]?.detail).toMatch(/коммиты, которых нет в main/);
    expect(git(repo, ["ls-remote", "--heads", "origin", "refs/heads/roles/abc-123"])).not.toBe("");
  });

  it("отказывается удалять основную ветку", async () => {
    const { repo } = репозиторий(true);
    await expect(
      gitDeleteBranch({ repo, branch: "main" }, контекст([repo])),
    ).rejects.toBeInstanceOf(BadArgsError);
  });
});
