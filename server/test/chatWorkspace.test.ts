// Рабочая папка чата: выбор из проектов, копия для репозитория сервера.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatWorkspaceDir, listChatWorkspaces, validChatWorkspace } from "../src/lib/chatWorkspace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-ws-"));
const projects = path.join(root, "Проекты");
const live = path.join(projects, "New-Todoist");
const worktrees = path.join(root, "worktrees");
// Как в worktreeInspect.test.ts: заглушку test/setup.ts снимаем только у
// своего git во временном репозитории.
const testEnv = { ...process.env };
delete testEnv.GIT_CONFIG_COUNT;
for (const key of Object.keys(testEnv)) {
  if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete testEnv[key];
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: testEnv }).trim();
const previous = { root: process.env.TASKFLOW_PROJECTS_ROOT, wt: process.env.TASKFLOW_ROLE_WORKTREES };

beforeAll(() => {
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(path.join(projects, "CRM", ".git"), { recursive: true });
  fs.mkdirSync(path.join(projects, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projects, "_archive"), { recursive: true });
  fs.writeFileSync(path.join(projects, "file.txt"), "x");
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "t@t");
  git(live, "config", "user.name", "t");
  fs.writeFileSync(path.join(live, "a.txt"), "1\n");
  git(live, "add", ".");
  git(live, "commit", "-qm", "base");
  process.env.TASKFLOW_PROJECTS_ROOT = projects;
  process.env.TASKFLOW_ROLE_WORKTREES = worktrees;
});
afterAll(() => {
  process.env.TASKFLOW_PROJECTS_ROOT = previous.root;
  process.env.TASKFLOW_ROLE_WORKTREES = previous.wt;
  if (previous.root === undefined) delete process.env.TASKFLOW_PROJECTS_ROOT;
  if (previous.wt === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("chat workspace", () => {
  it("lists project folders only, server repo marked as copy", () => {
    const list = listChatWorkspaces(live);
    expect(list.map((w) => [w.name, w.git, w.copy])).toEqual([
      ["CRM", true, false],
      ["New-Todoist", true, true],
      ["notes", false, false],
    ]);
  });

  it("accepts only listed names", () => {
    expect(validChatWorkspace("CRM", live)).toBe(true);
    expect(validChatWorkspace("_archive", live)).toBe(false);
    expect(validChatWorkspace("../etc", live)).toBe(false);
    expect(validChatWorkspace("file.txt", live)).toBe(false);
  });

  it("plain project — the folder itself; server repo — own copy on roles/chat-<id>", () => {
    expect(chatWorkspaceDir("c1", "CRM", live)).toEqual({ cwd: path.join(projects, "CRM"), name: "CRM", branch: null });
    const copy = chatWorkspaceDir("c1", "New-Todoist", live);
    expect(copy?.cwd).toBe(path.join(worktrees, "chat-c1"));
    expect(copy?.branch).toBe("roles/chat-c1");
    expect(git(copy!.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("roles/chat-c1");
    expect(chatWorkspaceDir("c1", null, live)).toBeNull();
    expect(chatWorkspaceDir("c1", "gone", live)).toBeNull();
  });
});
