// Отдельная рабочая копия для роли в репозитории самого сервера (владелец
// 01.10.2026, T05): правка файла роли не должна трогать живую копию, из
// которой запущен сервер.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleBranch, roleWorkspace } from "../src/runtime/roleWorkspace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-ws-"));
const live = path.join(root, "live");
const other = path.join(root, "other");
const base = path.join(root, "worktrees");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const previous = process.env.TASKFLOW_ROLE_WORKTREES;

beforeAll(() => {
  fs.mkdirSync(path.join(live, "server", "node_modules"), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "t@t");
  git(live, "config", "user.name", "t");
  fs.writeFileSync(path.join(live, "server", "a.ts"), "export const a = 1;\n");
  git(live, "add", "server/a.ts");
  git(live, "commit", "-q", "-m", "init");
  process.env.TASKFLOW_ROLE_WORKTREES = base;
});

afterAll(() => {
  process.env.TASKFLOW_ROLE_WORKTREES = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("рабочая копия роли", () => {
  it("чужой проект — как есть", () => {
    expect(roleWorkspace("t1", other, live)).toBe(other);
  });

  it("репозиторий сервера — своя worktree карточки, живая копия не меняется", () => {
    const dir = roleWorkspace("t1", live, live);
    expect(dir).toBe(path.join(base, "t1"));
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(roleBranch("t1"));
    expect(fs.lstatSync(path.join(dir, "server", "node_modules")).isSymbolicLink()).toBe(true);

    fs.writeFileSync(path.join(dir, "server", "a.ts"), "export const a = 2;\n");
    expect(fs.readFileSync(path.join(live, "server", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(git(live, "status", "--short")).toBe("");
  });

  it("повторный запуск той же карточки — та же копия с её правками", () => {
    const dir = roleWorkspace("t1", live, live);
    expect(fs.readFileSync(path.join(dir, "server", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("пустой остаток снятой копии — пересоздаётся, а не отдаётся мёртвым путём", () => {
    // merge/cleanup оставляет пустой каталог без .git: роль получала его как cwd
    // и вместо работы по карточке обходила хост.
    const taskId = "t3";
    const dir = path.join(base, taskId);
    fs.mkdirSync(dir, { recursive: true });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);

    expect(roleWorkspace(taskId, live, live)).toBe(dir);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server", "a.ts"))).toBe(true);
  });

  it("каталог без .git, но с файлами — внятная ошибка, а не тихий битый cwd", () => {
    const taskId = "t4";
    const dir = path.join(base, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "чужое.txt"), "x");
    expect(() => roleWorkspace(taskId, live, live)).toThrow(/не git-worktree/);
  });

  it("выключатель off — без копий", () => {
    process.env.TASKFLOW_ROLE_WORKTREES = "off";
    try {
      expect(roleWorkspace("t2", live, live)).toBe(live);
    } finally {
      process.env.TASKFLOW_ROLE_WORKTREES = base;
    }
  });
});
