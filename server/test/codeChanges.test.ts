// Изменения кода карточки: разбор unified diff и выбор диапазона ветки роли.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUnifiedDiff, taskCodeChanges } from "../src/lib/worktree/codeChanges.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-changes-"));
const live = path.join(root, "live");
// Как в worktreeInspect.test.ts: снимаем заглушку test/setup.ts только у
// своего git во временном репозитории.
const testEnv = { ...process.env };
delete testEnv.GIT_CONFIG_COUNT;
for (const key of Object.keys(testEnv)) {
  if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete testEnv[key];
}
const git = (...args: string[]) => execFileSync("git", ["-C", live, ...args], { encoding: "utf8", env: testEnv }).trim();

beforeAll(() => {
  fs.mkdirSync(live, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(live, "a.txt"), "1\n2\n3\n");
  fs.writeFileSync(path.join(live, "gone.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "roles/t1");
  fs.writeFileSync(path.join(live, "a.txt"), "1\nдва\n3\n");
  fs.writeFileSync(path.join(live, "new.txt"), "n\n");
  fs.rmSync(path.join(live, "gone.txt"));
  git("add", "-A");
  git("commit", "-qm", "role work");
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(live, "main-only.txt"), "m\n");
  git("add", ".");
  git("commit", "-qm", "main moved on");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("parseUnifiedDiff", () => {
  it("files, statuses, counts and numbered lines", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " 1",
      "-2",
      "+два",
      " 3",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+n",
      "diff --git a/old.png b/old.png",
      "deleted file mode 100644",
      "Binary files a/old.png and /dev/null differ",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["new.txt", "added", 1, 0],
      ["old.png", "deleted", 0, 0],
    ]);
    expect(files[2].binary).toBe(true);
    expect(files[0].hunks[0].lines).toEqual([
      { kind: "context", old: 1, new: 1, text: "1" },
      { kind: "deleted", old: 2, new: null, text: "2" },
      { kind: "added", old: null, new: 2, text: "два" },
      { kind: "context", old: 3, new: 3, text: "3" },
    ]);
  });

  it("renames keep the old path", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/x.ts b/y.ts", "similarity index 100%", "rename from x.ts", "rename to y.ts"].join("\n"),
    );
    expect(files[0]).toMatchObject({ path: "y.ts", old_path: "x.ts", status: "renamed" });
  });

  it("caps huge files and marks them truncated", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `+l${i}`);
    const files = parseUnifiedDiff(
      ["diff --git a/big b/big", "--- /dev/null", "+++ b/big", "@@ -0,0 +1,5000 @@", ...body].join("\n"),
      { maxLinesPerFile: 100 },
    );
    expect(files[0].additions).toBe(5000);
    expect(files[0].hunks.flatMap((h) => h.lines).length).toBe(100);
    expect(files[0].truncated).toBe(true);
  });
});

describe("taskCodeChanges", () => {
  it("unmerged branch: only what the role changed, not what main did since", () => {
    const result = taskCodeChanges("t1", { repo: live });
    expect(result.state).toBe("branch");
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "gone.txt", "new.txt"]);
    expect(result.totals).toEqual({ files: 3, additions: 2, deletions: 2 });
  });

  it("merged branch: range recorded by the merge queue", () => {
    const before = git("rev-parse", "main");
    git("merge", "-q", "--no-edit", "roles/t1");
    const after = git("rev-parse", "main");
    const result = taskCodeChanges("t1", { repo: live, merged: { before, after } });
    expect(result.state).toBe("merged");
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "gone.txt", "new.txt"]);
  });

  it("рабочая копия роли: незакоммиченные правки и новые файлы тоже в счёте", () => {
    // Роль правила, но не закоммитила (владелец 27.10.2026): ветка без своих
    // коммитов, правки только в рабочей копии.
    const wt = path.join(root, "wt-t2");
    git("worktree", "add", "-q", "-b", "roles/t2", wt, "main");
    fs.writeFileSync(path.join(wt, "a.txt"), fs.readFileSync(path.join(wt, "a.txt"), "utf8") + "ещё\n");
    fs.writeFileSync(path.join(wt, "fresh.txt"), "f1\nf2\n");
    const result = taskCodeChanges("t2", { repo: live, worktree: wt });
    expect(result.state).toBe("branch");
    expect(result.uncommitted).toBe(true);
    expect(result.files.map((f) => [f.path, f.status, f.additions, f.deletions]).sort()).toEqual([
      ["a.txt", "modified", 1, 0],
      ["fresh.txt", "added", 2, 0],
    ]);
    expect(result.totals).toEqual({ files: 2, additions: 3, deletions: 0 });
  });

  it("рабочая копия без правок — как раньше, только коммиты ветки", () => {
    const wt = path.join(root, "wt-t3");
    git("worktree", "add", "-q", "-b", "roles/t3", wt, "main");
    expect(taskCodeChanges("t3", { repo: live, worktree: wt })).toMatchObject({ state: "none", files: [] });
  });

  it("no branch: empty answer, no throw", () => {
    expect(taskCodeChanges("nope", { repo: live })).toMatchObject({ state: "none", files: [] });
  });
});
