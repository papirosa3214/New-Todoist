// Отправка main на хосты после автослияния: только fast-forward, с
// бэкапом вершины хоста, расхождение — хост не трогаем. Хосты — локальные
// bare-репозитории во временной папке.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadPushStatus,
  pushMainToHosts,
} from "../src/lib/worktree/pushHosts.js";

const testEnv = { ...process.env };
for (const key of Object.keys(testEnv)) {
  if (
    key === "GIT_CONFIG_COUNT" ||
    key.startsWith("GIT_CONFIG_KEY_") ||
    key.startsWith("GIT_CONFIG_VALUE_")
  )
    delete testEnv[key];
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: testEnv,
  }).trim();

const previousBase = process.env.TASKFLOW_ROLE_WORKTREES;
const stashed: Array<[string, string]> = [];
let root = "";

function commit(repo: string, file: string): string {
  fs.writeFileSync(path.join(repo, file), file + Date.now());
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", file);
  return git(repo, "rev-parse", "HEAD");
}

function fresh(name: string): { live: string; bare: (n: string) => string } {
  const dir = path.join(root, name);
  const live = path.join(dir, "live");
  fs.mkdirSync(live, { recursive: true });
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "t@t");
  git(live, "config", "user.name", "t");
  commit(live, "a.txt");
  const bare = (n: string) => {
    const p = path.join(dir, `${n}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", p], {
      env: testEnv,
    });
    return p;
  };
  return { live, bare };
}

beforeAll(() => {
  // Заглушка test/setup.ts рубит push во всех репозиториях прогона через
  // GIT_CONFIG_*; здесь только временные репозитории — снимаем её на файл.
  for (const [k, v] of Object.entries(process.env)) {
    if (
      k === "GIT_CONFIG_COUNT" ||
      k.startsWith("GIT_CONFIG_KEY_") ||
      k.startsWith("GIT_CONFIG_VALUE_")
    ) {
      stashed.push([k, v as string]);
      delete process.env[k];
    }
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-push-"));
  process.env.TASKFLOW_ROLE_WORKTREES = path.join(root, "worktrees");
});

afterAll(() => {
  for (const [k, v] of stashed) process.env[k] = v;
  if (previousBase === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  else process.env.TASKFLOW_ROLE_WORKTREES = previousBase;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("отправка main на хосты", () => {
  it("пустой хост получает main, следующий сдвиг уходит fast-forward с бэкапом", () => {
    const { live, bare } = fresh("ff");
    const host = bare("host");
    git(live, "remote", "add", "origin", host);

    const first = pushMainToHosts(live);
    expect(first.results).toEqual([
      { remote: "origin", state: "pushed", backup: undefined },
    ]);
    const before = git(host, "rev-parse", "main");

    const sha = commit(live, "b.txt");
    const second = pushMainToHosts(live);
    expect(second.results[0].state).toBe("pushed");
    expect(git(host, "rev-parse", "main")).toBe(sha);
    const backup = second.results[0].backup!;
    expect(git(host, "rev-parse", backup)).toBe(before);

    expect(pushMainToHosts(live).results[0].state).toBe("in_sync");
  });

  it("расхождение: на хосте чужой коммит — хост не тронут, статус для сторожа", () => {
    const { live, bare } = fresh("div");
    const host = bare("host");
    git(live, "remote", "add", "origin", host);
    pushMainToHosts(live);

    const other = path.join(root, "div", "other");
    execFileSync("git", ["clone", "-q", host, other], { env: testEnv });
    git(other, "config", "user.email", "t@t");
    git(other, "config", "user.name", "t");
    const foreign = commit(other, "foreign.txt");
    git(other, "push", "-q", "origin", "main");

    commit(live, "mine.txt");
    const status = pushMainToHosts(live);
    expect(status.results[0].state).toBe("diverged");
    expect(git(host, "rev-parse", "main")).toBe(foreign);
    expect(loadPushStatus()?.results[0].state).toBe("diverged");
  });

  it("два remote с одним адресом — один хост; недоступный хост — отказ, остальные идут", () => {
    const { live, bare } = fresh("multi");
    const host = bare("host");
    git(live, "remote", "add", "origin", host);
    git(live, "remote", "add", "github", host);
    git(
      live,
      "remote",
      "add",
      "dead",
      path.join(root, "multi", "нет-такого.git"),
    );

    const status = pushMainToHosts(live);
    // git remote отдаёт имена по алфавиту: из пары с одним адресом остаётся github.
    expect(status.results.map((r) => r.remote)).toEqual(["dead", "github"]);
    expect(status.results.find((r) => r.remote === "dead")?.state).toBe(
      "failed",
    );
    expect(status.results.find((r) => r.remote === "github")?.state).toBe(
      "pushed",
    );
  });
});
