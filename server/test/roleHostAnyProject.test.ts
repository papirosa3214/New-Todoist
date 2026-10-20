// Владелец 20.10.2026: инструменты Mac были привязаны только к проекту
// карточки. Карточка веба не могла заглянуть в iOS-репозиторий для сверки —
// Архитектор трижды получил отказ, Критик четыре раза вернул на доработку.
// Теперь роль передаёт project_id любого доступного ей проекта на машине.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// vi.mock поднимается в начало файла — общие значения через vi.hoisted.
const { hostsFile, calls } = vi.hoisted(() => ({
  hostsFile: `${process.env.TMPDIR ?? "/tmp"}/role-host-${process.pid}-${Date.now()}.json`,
  calls: [] as Array<{ op: string; args: any; opts?: any }>,
}));

vi.mock("../src/runtime/roleWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  HOSTS_CONFIG: hostsFile,
}));
vi.mock("../src/host/machines.js", async (orig) => ({
  ...(await orig<any>()),
  listMachines: () => [{ id: "mac-1", name: "macbook", revoked_at: null }],
}));
vi.mock("../src/host/gateway.js", async (orig) => ({
  ...(await orig<any>()),
  isMachineOnline: () => true,
  resolveMachine: () => ({ id: "mac-1", name: "macbook" }),
  runOperation: async (_m: string, op: string, args: any, opts?: any) => {
    calls.push({ op, args, opts });
    if (op === "git_worktree")
      return {
        ok: true,
        data: { path: `${args.repo}/.worktrees/${args.taskId}` },
      };
    return { ok: true, data: { entries: [] } };
  },
}));

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { executeRoleHostTool } from "../src/runtime/roleHostAccess.js";
import { BASH_DEFAULT_TIMEOUT_MS, hostBashOperations } from "../src/runtime/hostOperations.js";

describe("инструменты Mac: любой доступный роли проект", () => {
  const owner = `rh-owner-${Date.now()}`;
  const web = `rh-web-${Date.now()}`;
  const ios = `rh-ios-${Date.now()}`;
  const task = `rh-task-${Date.now()}`;

  beforeAll(async () => {
    await buildApp();
    seedRoleAccounts(db);
    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)",
    ).run(owner, "owner", `${owner}@t`, "x", "owner");
    db.prepare("INSERT INTO projects(id,name,owner_id) VALUES(?,?,?)").run(
      web,
      "Web",
      owner,
    );
    db.prepare("INSERT INTO projects(id,name,owner_id) VALUES(?,?,?)").run(
      ios,
      "iOS",
      owner,
    );
    db.prepare(
      "INSERT INTO tasks(id,title,creator_id,project_id) VALUES(?,?,?,?)",
    ).run(task, "Сверка веба с iPhone", owner, web);
    fs.writeFileSync(
      hostsFile,
      JSON.stringify({
        projects: { "mac-1": { [ios]: "/Users/max/ios-repo" } },
      }),
    );
  });

  afterAll(() => {
    db.prepare("DELETE FROM tasks WHERE id=?").run(task);
    db.prepare("DELETE FROM projects WHERE id IN (?,?)").run(web, ios);
    db.prepare("DELETE FROM users WHERE id=?").run(owner);
  });

  it("без project_id — проект карточки, отказ с подсказкой про taskflow_hosts", async () => {
    await expect(
      executeRoleHostTool(
        { role: "architect", taskId: task },
        { tool: "ls", arguments: {} },
      ),
    ).rejects.toThrow(/taskflow_hosts.*project_id/);
  });

  it("с project_id iOS-проекта — рабочая копия в iOS-репозитории", async () => {
    calls.length = 0;
    await executeRoleHostTool(
      { role: "architect", taskId: task },
      { tool: "ls", project_id: ios, arguments: {} },
    ).catch(() => undefined);
    const worktree = calls.find((c) => c.op === "git_worktree");
    expect(worktree?.args.repo).toBe("/Users/max/ios-repo");
  });

  it("bash на хосте: время команды доходит до хоста, без него — 40 минут", async () => {
    calls.length = 0;
    const bash = hostBashOperations("mac-1", "/wt");
    await bash.exec("xcodebuild test", "/wt", { onData: () => {}, timeout: 1500 });
    await bash.exec("ls", "/wt", { onData: () => {} });
    const [long, plain] = calls.filter((c) => c.op === "bash");
    expect(long.args.timeoutMs).toBe(1_500_000);
    expect(long.opts.timeoutMs).toBe(1_530_000);
    expect(plain.args.timeoutMs).toBe(BASH_DEFAULT_TIMEOUT_MS);
  });
});
