// Инструменты Mac в чате без задачи работают без task_id (06.11.2026): secretary в личном чате не могла записать файл.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { hostsFile, calls } = vi.hoisted(() => ({
  hostsFile: `${process.env.TMPDIR ?? "/tmp"}/role-host-nt-${process.pid}-${Date.now()}.json`,
  calls: [] as Array<{ op: string; args: any }>,
}));
vi.mock("../src/runtime/roleWorkspace.js", async (orig) => ({ ...(await orig<any>()), HOSTS_CONFIG: hostsFile }));
vi.mock("../src/host/machines.js", async (orig) => ({ ...(await orig<any>()), listMachines: () => [{ id: "mac-1", name: "macbook", revoked_at: null }] }));
vi.mock("../src/host/gateway.js", async (orig) => ({
  ...(await orig<any>()),
  isMachineOnline: () => true,
  resolveMachine: () => ({ id: "mac-1", name: "macbook", allowed_roots: ["/Users/max/Проекты"] }),
  runOperation: async (_m: string, op: string, args: any) => {
    calls.push({ op, args });
    if (op === "git_worktree") return { ok: true, data: { path: `${args.repo}/.worktrees/${args.taskId}` } };
    return { ok: true, data: { entries: [], written: true } };
  },
}));

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { executeRoleHostTool } from "../src/runtime/roleHostAccess.js";

describe("host_* без задачи", () => {
  const owner = `nt-owner-${Date.now()}`, ios = `nt-ios-${Date.now()}`, other = `nt-other-${Date.now()}`;
  beforeAll(async () => {
    await buildApp(); seedRoleAccounts(db);
    db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)").run(owner, "owner", `${owner}@t`, "x", "owner");
    for (const id of [ios, other]) db.prepare("INSERT INTO projects(id,name,owner_id) VALUES(?,?,?)").run(id, id, owner);
    fs.writeFileSync(hostsFile, JSON.stringify({ projects: { "mac-1": { [ios]: "/Users/max/Проекты/repo" } } }));
  });
  afterAll(() => { db.prepare("DELETE FROM projects WHERE id IN (?,?)").run(ios, other); fs.rmSync(hostsFile, { force: true }); });

  it("host_write без task_id (и с пустым, и с чужим task_id) выполняется в контексте чата", async () => {
    for (const task_id of [undefined, "", "no-such-task"]) {
      calls.length = 0;
      await executeRoleHostTool({ role: "secretary" }, { tool: "write", project_id: ios, task_id, arguments: { path: "notes/a.txt", content: "привет" } });
      const wt = calls.find((c) => c.op === "git_worktree")!;
      expect(String(wt.args.taskId), String(task_id)).toMatch(/^host-/);
      expect(calls.some((c) => c.op === "write")).toBe(true);
    }
  });
  it("указанный абсолютный путь внутри разрешённых корней машины — можно; вне — отказ", async () => {
    calls.length = 0;
    await executeRoleHostTool({ role: "secretary" }, { tool: "write", project_id: ios, arguments: { path: "/Users/max/Проекты/other/x.md", content: "z" } });
    expect(calls.some((c) => c.op === "write" && c.args.path === "/Users/max/Проекты/other/x.md")).toBe(true);
    await expect(executeRoleHostTool({ role: "secretary" }, { tool: "write", project_id: ios, arguments: { path: "/etc/passwd", content: "z" } })).rejects.toThrow(/выходит за разрешённую/);
  });
  it("проект без репозитория на машине — отказ как раньше; задача карточки недоступна — как раньше", async () => {
    await expect(executeRoleHostTool({ role: "secretary" }, { tool: "write", project_id: other, arguments: { path: "a", content: "b" } })).rejects.toThrow(/нет репозитория/);
    await expect(executeRoleHostTool({ role: "builder", taskId: "missing-task" }, { tool: "write", arguments: { path: "a", content: "b" } })).rejects.toThrow(/Задача недоступна/);
  });
});
