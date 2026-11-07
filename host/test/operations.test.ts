import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bash } from "../src/operations/bash.js";
import { edit } from "../src/operations/edit.js";
import { find } from "../src/operations/find.js";
import { gitWorktree, roleBranch } from "../src/operations/git_worktree.js";
import { grep } from "../src/operations/grep.js";
import { ls } from "../src/operations/ls.js";
import { read } from "../src/operations/read.js";
import { write } from "../src/operations/write.js";
import { PathDeniedError } from "../src/pathSafety.js";
import { BadArgsError, CancelledError, LimitError, NotFoundError } from "../src/operations/types.js";
import type { ReadResult } from "../src/operations/read.js";
import type { BashResult } from "../src/operations/bash.js";
import type { LsResult } from "../src/operations/ls.js";
import type { GrepResult } from "../src/operations/grep.js";
import type { FindResult } from "../src/operations/find.js";
import { collectStream, makeContext, waitFor } from "./helpers.js";

describe("операции хоста", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-ops-")));
    fs.mkdirSync(path.join(root, "Проекты", "TaskFlowNativeBuild", "Sources"), { recursive: true });
    fs.writeFileSync(path.join(root, "Проекты", "TaskFlowNativeBuild", "Package.swift"), "let a = 1\nlet b = 2\nlet c = 3\n");
    fs.writeFileSync(path.join(root, "Проекты", "TaskFlowNativeBuild", "Sources", "Screen.swift"), "import SwiftUI\nstruct Screen { let title = \"дом\" }\n");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("bash", () => {
    it("отдаёт вывод потоком и возвращает код возврата", async () => {
      const stream = collectStream();
      const result = (await bash(
        { command: "printf 'строка-1\\n'; printf 'ошибка\\n' >&2; printf 'строка-2\\n'" },
        makeContext({ roots: [root], emit: stream.emit }),
      )) as BashResult;

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.truncated).toBe(false);
      expect(stream.text("stdout")).toBe("строка-1\nстрока-2\n");
      expect(stream.text("stderr")).toBe("ошибка\n");
      expect(result.stdoutBytes).toBeGreaterThan(0);
    });

    it("ненулевой код возврата не ошибка — его читает роль", async () => {
      const result = (await bash({ command: "exit 3" }, makeContext({ roots: [root] }))) as BashResult;
      expect(result.exitCode).toBe(3);
    });

    it("превышение лимита вывода убивает команду и помечает результат", async () => {
      const stream = collectStream();
      const context = makeContext({ roots: [root], emit: stream.emit, limits: { bashTimeoutMs: 8_000, bashOutputLimitBytes: 2048 } });
      // yes-подобный цикл без внешних команд: печатает, пока не убьют.
      const result = (await bash({ command: "i=0; while [ $i -lt 100000 ]; do printf 'xxxxxxxxxxxxxxxx\\n'; i=$((i+1)); done" }, context)) as BashResult;

      expect(result.truncated).toBe(true);
      expect(stream.text().length).toBeGreaterThan(0);
    });

    it("отмена по AbortSignal прерывает длинную команду и приходит ошибкой, а не успехом", async () => {
      const controller = new AbortController();
      const stream = collectStream();
      const promise = bash({ command: "echo начало; sleep 30" }, makeContext({ roots: [root], emit: stream.emit, signal: controller.signal }));
      await waitFor(() => stream.text().includes("начало"), 5_000, "первый вывод");
      controller.abort("проверка отмены");

      await expect(promise).rejects.toBeInstanceOf(CancelledError);
      // Уже напечатанное остаётся в потоке: роль должна видеть, до чего команда дошла.
      expect(stream.text()).toContain("начало");
    });

    it("уже отменённая операция не запускает команду", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(bash({ command: "echo нельзя" }, makeContext({ roots: [root], signal: controller.signal }))).rejects.toBeInstanceOf(CancelledError);
    });

    it("cwd вне корня отклоняется до запуска", async () => {
      await expect(bash({ command: "echo x", cwd: "/etc" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(PathDeniedError);
    });

    it("таймаут команды помечается в результате", async () => {
      const result = (await bash({ command: "sleep 5", timeoutMs: 300 }, makeContext({ roots: [root] }))) as BashResult;
      expect(result.timedOut).toBe(true);
    });

    it("таймаут из аргументов не может превысить потолок хоста", async () => {
      // Просим час при потолке хоста 400 мс — отработать должен потолок,
      // а не аргумент. sleep 30 иначе пережил бы проверку.
      const started = Date.now();
      const result = (await bash(
        { command: "sleep 30", timeoutMs: 3_600_000 },
        makeContext({ roots: [root], limits: { bashTimeoutMs: 400, bashOutputLimitBytes: 4096 } }),
      )) as BashResult;
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  describe("read", () => {
    it("читает файл с нумерацией строк и по частям", async () => {
      const all = (await read({ path: path.join(root, "Проекты/TaskFlowNativeBuild/Package.swift") }, makeContext({ roots: [root] }))) as ReadResult;
      expect(all.totalLines).toBe(3);
      expect(all.content).toBe("let a = 1\nlet b = 2\nlet c = 3");

      const part = (await read(
        { path: path.join(root, "Проекты/TaskFlowNativeBuild/Package.swift"), offset: 2, limit: 1 },
        makeContext({ roots: [root] }),
      )) as ReadResult;
      expect(part.content).toBe("let b = 2");
      expect(part.startLine).toBe(2);
      expect(part.truncated).toBe(true);
    });

    it("путь вне корня — path_denied", async () => {
      await expect(read({ path: "/etc/hosts" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(PathDeniedError);
    });

    it("отсутствующий файл — not_found", async () => {
      await expect(read({ path: path.join(root, "нет.swift") }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("write", () => {
    it("создаёт файл вместе с промежуточными папками", async () => {
      const target = path.join(root, "Проекты/TaskFlowNativeBuild/Sources/Features/Новый/View.swift");
      const result = (await write({ path: target, content: "struct View {}\n" }, makeContext({ roots: [root] }))) as { created: boolean; createdDirs: string[] };

      expect(result.created).toBe(true);
      expect(result.createdDirs.length).toBeGreaterThan(0);
      expect(fs.readFileSync(target, "utf8")).toBe("struct View {}\n");
    });

    it("перезаписывает существующий файл и не оставляет временных", async () => {
      const target = path.join(root, "Проекты/TaskFlowNativeBuild/Package.swift");
      const result = (await write({ path: target, content: "let z = 9\n" }, makeContext({ roots: [root] }))) as { created: boolean };
      expect(result.created).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe("let z = 9\n");
      expect(fs.readdirSync(path.dirname(target)).filter((name) => name.includes("taskflow"))).toEqual([]);
    });

    it("путь вне корня отклоняется", async () => {
      await expect(write({ path: "/tmp/чужой-файл", content: "x" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(PathDeniedError);
    });

    it("слишком большое содержимое отклоняется, а не обрезается", async () => {
      const context = makeContext({ roots: [root], limits: { bashTimeoutMs: 1000, bashOutputLimitBytes: 16 } });
      await expect(write({ path: path.join(root, "big.txt"), content: "x".repeat(100) }, context)).rejects.toBeInstanceOf(LimitError);
      expect(fs.existsSync(path.join(root, "big.txt"))).toBe(false);
    });
  });

  describe("edit", () => {
    it("заменяет единственное вхождение", async () => {
      const target = path.join(root, "Проекты/TaskFlowNativeBuild/Sources/Screen.swift");
      const result = (await edit(
        { path: target, oldText: 'let title = "дом"', newText: 'let title = "экран"' },
        makeContext({ roots: [root] }),
      )) as { occurrences: number };

      expect(result.occurrences).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toContain('let title = "экран"');
    });

    it("неоднозначное вхождение требует replaceAll, а не выбирает первое молча", async () => {
      const target = path.join(root, "Проекты/TaskFlowNativeBuild/repeat.swift");
      fs.writeFileSync(target, "let a\nlet a\n");
      await expect(edit({ path: target, oldText: "let a", newText: "let b" }, makeContext({ roots: [root] }))).rejects.toThrow(/встречается 2 раза/);

      const result = (await edit({ path: target, oldText: "let a", newText: "let b", replaceAll: true }, makeContext({ roots: [root] }))) as { occurrences: number };
      expect(result.occurrences).toBe(2);
      expect(fs.readFileSync(target, "utf8")).toBe("let b\nlet b\n");
    });

    it("отсутствующий фрагмент — понятная ошибка, а не «записал пустое»", async () => {
      const target = path.join(root, "Проекты/TaskFlowNativeBuild/Package.swift");
      await expect(edit({ path: target, oldText: "нет такого", newText: "x" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(NotFoundError);
      expect(fs.readFileSync(target, "utf8")).toContain("let a = 1");
    });

    it("старый и новый текст совпадают — отказ", async () => {
      const target = path.join(root, "Проекты/TaskFlowNativeBuild/Package.swift");
      await expect(edit({ path: target, oldText: "let a = 1", newText: "let a = 1" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(BadArgsError);
    });
  });

  describe("ls", () => {
    it("перечисляет содержимое папки, сначала папки", async () => {
      const result = (await ls({ path: path.join(root, "Проекты/TaskFlowNativeBuild") }, makeContext({ roots: [root] }))) as LsResult;
      expect(result.path).toBe(path.join(root, "Проекты/TaskFlowNativeBuild"));
      expect(result.entries.map((entry) => entry.name)).toEqual(["Sources", "Package.swift"]);
      expect(result.entries[0]!.type).toBe("dir");
      expect(result.entries[1]!.size).toBeGreaterThan(0);
    });

    it("путь вне корня — path_denied", async () => {
      await expect(ls({ path: "/etc" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(PathDeniedError);
    });

    it("несуществующая папка — not_found", async () => {
      await expect(ls({ path: path.join(root, "нет") }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("grep", () => {
    it("находит совпадения по содержимому с номерами строк", async () => {
      const result = (await grep(
        { pattern: "let title", path: root },
        makeContext({ roots: [root] }),
      )) as GrepResult;

      expect(result.matches.length).toBe(1);
      expect(result.matches[0]!.path.endsWith("Screen.swift")).toBe(true);
      expect(result.matches[0]!.line).toBe(2);
    });

    it("учитывает регистр и фильтр по имени файла", async () => {
      const sensitive = (await grep({ pattern: "LET TITLE", path: root }, makeContext({ roots: [root] }))) as GrepResult;
      expect(sensitive.matches.length).toBe(0);

      const insensitive = (await grep({ pattern: "LET TITLE", path: root, ignoreCase: true, glob: "**/*.swift" }, makeContext({ roots: [root] }))) as GrepResult;
      expect(insensitive.matches.length).toBe(1);
    });

    it("битое регулярное выражение — bad_args, а не падение", async () => {
      await expect(grep({ pattern: "(", path: root }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(BadArgsError);
    });

    it("путь вне корня — path_denied", async () => {
      await expect(grep({ pattern: "x", path: "/etc" }, makeContext({ roots: [root] }))).rejects.toBeInstanceOf(PathDeniedError);
    });
  });

  describe("find", () => {
    it("ищет по имени, отдаёт только файлы", async () => {
      const result = (await find({ pattern: ".swift", path: root, type: "file" }, makeContext({ roots: [root] }))) as FindResult;
      const names = result.entries.map((entry) => path.basename(entry.path)).sort();
      expect(names).toEqual(["Package.swift", "Screen.swift"]);
    });

    it("корень поиска не попадает в выдачу", async () => {
      const result = (await find({ path: root, type: "dir" }, makeContext({ roots: [root] }))) as FindResult;
      expect(result.entries.some((entry) => entry.path === root)).toBe(false);
    });
  });

  describe("git_worktree", () => {
    let repo: string;

    beforeEach(() => {
      repo = path.join(root, "repo");
      fs.mkdirSync(repo, { recursive: true });
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "Тест",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Тест",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "file.txt"), "первый\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "первый"], { cwd: repo, env });
    });

    it("ветка роли имеет тот же вид, что на .110", () => {
      expect(roleBranch("3e27dafe")).toBe("roles/3e27dafe");
    });

    it("создаёт worktree ветки роли и переиспользует её при повторе", async () => {
      const worktreesBase = path.join(root, "worktrees");
      const context = makeContext({ roots: [root, worktreesBase], worktreesBase });

      const created = (await gitWorktree({ action: "create", repo, taskId: "3e27dafe" }, context)) as { path: string; branch: string; changed: boolean };
      expect(created.branch).toBe("roles/3e27dafe");
      expect(created.changed).toBe(true);
      expect(fs.existsSync(path.join(created.path, "file.txt"))).toBe(true);

      const again = (await gitWorktree({ action: "create", repo, taskId: "3e27dafe" }, context)) as { path: string; changed: boolean };
      expect(again.changed).toBe(false);
      expect(again.path).toBe(created.path);
    });

    it("убирает worktree и не падает, если его уже нет", async () => {
      const worktreesBase = path.join(root, "worktrees");
      const context = makeContext({ roots: [root, worktreesBase], worktreesBase });
      const created = (await gitWorktree({ action: "create", repo, taskId: "3e27dafe" }, context)) as { path: string };

      const removed = (await gitWorktree({ action: "remove", repo, taskId: "3e27dafe" }, context)) as { changed: boolean };
      expect(removed.changed).toBe(true);
      expect(fs.existsSync(created.path)).toBe(false);

      const again = (await gitWorktree({ action: "remove", repo, taskId: "3e27dafe" }, context)) as { changed: boolean };
      expect(again.changed).toBe(false);
    });

    it("кириллица в id карточки отвергается: имя ветки и папки должны быть предсказуемыми", async () => {
      const worktreesBase = path.join(root, "worktrees");
      const context = makeContext({ roots: [root, worktreesBase], worktreesBase });
      await expect(gitWorktree({ action: "create", repo, taskId: "карточка" }, context)).rejects.toBeInstanceOf(BadArgsError);
    });

    it("worktree заводится, даже если база папок ещё не создана", async () => {
      const worktreesBase = path.join(root, "глубоко", "вложенная", "база");
      const context = makeContext({ roots: [root, worktreesBase], worktreesBase });
      expect(fs.existsSync(worktreesBase)).toBe(false);

      const created = (await gitWorktree({ action: "create", repo, taskId: "3e27dafe" }, context)) as { path: string };
      expect(fs.existsSync(created.path)).toBe(true);
    });

    it("id карточки с косой чертой не превращается в путь", async () => {
      const worktreesBase = path.join(root, "worktrees");
      await expect(
        gitWorktree({ action: "create", repo, taskId: "../../escape" }, makeContext({ roots: [root, worktreesBase], worktreesBase })),
      ).rejects.toBeInstanceOf(BadArgsError);
    });

    it("репозиторий вне корня отклоняется", async () => {
      const worktreesBase = path.join(root, "worktrees");
      await expect(
        gitWorktree({ action: "create", repo: "/etc", taskId: "abc" }, makeContext({ roots: [root, worktreesBase], worktreesBase })),
      ).rejects.toBeInstanceOf(PathDeniedError);
    });
  });
});