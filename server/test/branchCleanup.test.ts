// Закрытие ветки роли на хостах после подтверждённого слияния.
//
// Ветку создаёт хост (`git_worktree`), роль пушит её в общий remote
// (`git_push`) — и до 10.11.2026 её никто не убирал: `cleanupWorktree` снимает
// только локальную копию, а на GitHub и Gitea за месяцы накопилась сотня
// ветвей `roles/*`. Владелец 10.11.2026: «сервер сам закрывает ветку, когда
// роль закончила работу» — триггер выбран владельцем: после зелёного слияния.
//
// Каждому кейсу — свои временные репозитории и свои bare-хосты.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeRoleBranchOnHosts,
  loadBranchCleanup,
} from "../src/lib/worktree/branchCleanup.js";

// Хук `test/setup.ts` цепляется ко всем git-вызовам прогона через
// GIT_CONFIG_*. Здесь работа идёт только во временных репозиториях из
// mkdtemp — снимаем эти переменные у СВОЕГО git, защита живого репо остаётся.
const testEnv = { ...process.env };
delete testEnv.GIT_CONFIG_COUNT;
for (const key of Object.keys(testEnv)) {
  if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete testEnv[key];
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: testEnv }).trim();

const roots: string[] = [];
const previousBase = process.env.TASKFLOW_ROLE_WORKTREES;

afterEach(() => {
  if (previousBase === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  else process.env.TASKFLOW_ROLE_WORKTREES = previousBase;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Hosts {
  live: string;
  hostA: string;
  hostB: string;
}

/** Живой репозиторий и два bare-хоста: «GitHub» и «Gitea». */
function freshHosts(): Hosts {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-close-"));
  roots.push(root);
  process.env.TASKFLOW_ROLE_WORKTREES = path.join(root, "worktrees");
  const live = path.join(root, "live");
  const hostA = path.join(root, "host-a.git");
  const hostB = path.join(root, "host-b.git");
  fs.mkdirSync(live, { recursive: true });
  for (const bare of [hostA, hostB]) git(root, "init", "-q", "--bare", bare);
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "test@example.invalid");
  git(live, "config", "user.name", "test");
  fs.writeFileSync(path.join(live, "README.md"), "main\n");
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "init");
  git(live, "remote", "add", "a", hostA);
  git(live, "remote", "add", "b", hostB);
  return { live, hostA, hostB };
}

/** Ветка роли с одним коммитом, отправленная в оба хоста. */
function pushedRoleBranch({ live }: Hosts, branch = "roles/t1"): void {
  git(live, "checkout", "-q", "-b", branch);
  fs.writeFileSync(path.join(live, "role.txt"), "работа роли\n");
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "работа роли");
  git(live, "push", "-q", "a", branch);
  git(live, "push", "-q", "b", branch);
  git(live, "checkout", "-q", "main");
}

const hostHasBranch = (host: string, branch: string): boolean =>
  git(host, "for-each-ref", "--format=%(refname:short)", "refs/heads") .split("\n")
    .filter(Boolean)
    .includes(branch);

describe("closeRoleBranchOnHosts", () => {
  it("снимает слитую ветку с обоих хостов и второй проход видит absent", () => {
    const hosts = freshHosts();
    pushedRoleBranch(hosts);
    git(hosts.live, "merge", "--no-ff", "-q", "-m", "merge roles/t1", "roles/t1");

    const first = closeRoleBranchOnHosts(hosts.live, "roles/t1");
    expect(first.map((row) => row.state)).toEqual(["deleted", "deleted"]);
    expect(first.map((row) => row.remote)).toEqual(["a", "b"]);
    expect(hostHasBranch(hosts.hostA, "roles/t1")).toBe(false);
    expect(hostHasBranch(hosts.hostB, "roles/t1")).toBe(false);

    const second = closeRoleBranchOnHosts(hosts.live, "roles/t1");
    expect(second.map((row) => row.state)).toEqual(["absent", "absent"]);
  });

  it("оставляет ветку, если на хосте есть коммиты вне main", () => {
    const hosts = freshHosts();
    pushedRoleBranch(hosts);
    // Хост ушёл дальше: работа, которой в main нет. Удалять нельзя.
    git(hosts.live, "checkout", "-q", "roles/t1");
    fs.writeFileSync(path.join(hosts.live, "late.txt"), "не слито\n");
    git(hosts.live, "add", "-A");
    git(hosts.live, "commit", "-q", "-m", "не слитый коммит");
    git(hosts.live, "push", "-q", "a", "roles/t1");
    git(hosts.live, "checkout", "-q", "main");
    git(hosts.live, "branch", "-D", "roles/t1");
    git(hosts.live, "update-ref", "-d", "refs/taskflow-close/roles/t1");

    const results = closeRoleBranchOnHosts(hosts.live, "roles/t1");
    const onA = results.find((row) => row.remote === "a")!;
    expect(onA.state).toBe("skipped");
    expect(onA.detail).toMatch(/нет в main/);
    expect(hostHasBranch(hosts.hostA, "roles/t1")).toBe(true);
  });

  it("пишет итог в журнал branch-cleanup.json", () => {
    const hosts = freshHosts();
    pushedRoleBranch(hosts);
    git(hosts.live, "merge", "--no-ff", "-q", "-m", "merge roles/t1", "roles/t1");
    closeRoleBranchOnHosts(hosts.live, "roles/t1");
    const status = loadBranchCleanup();
    expect(status?.entries.at(-1)?.branch).toBe("roles/t1");
    expect(status?.entries.at(-1)?.results.map((row) => row.state)).toEqual(["deleted", "deleted"]);
  });
});
