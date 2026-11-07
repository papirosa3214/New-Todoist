// Изменения файлов за ход чата: исходный вид файла запоминается до первой
// правки роли, в конце хода — разница с тем, что стало.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TurnFileTracker } from "../src/lib/turnFileChanges.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-files-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const start = (toolName: string, args: unknown) => ({ type: "tool_execution_start", toolCallId: "c", toolName, args });

describe("TurnFileTracker", () => {
  it("edit, new file and relative path against the role workspace", () => {
    const work = path.join(root, "w1");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "a.txt"), "1\n2\n3\n");
    const tracker = new TurnFileTracker();
    tracker.observe({ type: "taskflow_workspace", cwd: work });
    tracker.observe(start("edit", { path: "a.txt", edits: [{ oldText: "2", newText: "два" }] }));
    fs.writeFileSync(path.join(work, "a.txt"), "1\nдва\n3\n");
    // Повторная правка того же файла не перезаписывает исходник.
    tracker.observe(start("edit", { path: path.join(work, "a.txt") }));
    tracker.observe(start("write", { path: path.join(work, "new.md"), content: "x\n" }));
    fs.writeFileSync(path.join(work, "new.md"), "x\n");
    const result = tracker.result();
    expect(result?.totals).toEqual({ files: 2, additions: 2, deletions: 1 });
    expect(result?.files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["new.md", "added"],
    ]);
    expect(result?.files[0].hunks[0].lines.map((l) => l.kind)).toEqual(["context", "deleted", "added", "context"]);
  });

  it("other tools, unchanged files and no workspace give nothing", () => {
    const work = path.join(root, "w2");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "same.txt"), "s\n");
    const tracker = new TurnFileTracker();
    tracker.observe(start("edit", { path: "lost.txt" })); // ещё нет папки — относительный путь не угадываем
    tracker.observe({ type: "taskflow_workspace", cwd: work });
    tracker.observe(start("read", { path: "same.txt" }));
    tracker.observe(start("edit", { path: "same.txt" })); // правка не удалась — файл тот же
    expect(tracker.result()).toBeNull();
  });

  it("paths outside the workspace are shown with ~ for home", () => {
    const tracker = new TurnFileTracker({ home: root });
    const file = path.join(root, "outside", "b.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tracker.observe({ type: "taskflow_workspace", cwd: path.join(root, "w3") });
    tracker.observe(start("write", { path: file, content: "b\n" }));
    fs.writeFileSync(file, "b\n");
    expect(tracker.result()?.files[0].path).toBe("~/outside/b.txt");
  });
});

it("merges remote captures across edits and distinguishes machines", () => {
  const tracker = new TurnFileTracker();
  const event = (machine: string, before: string | null, after: string | null) => ({
    type: "taskflow_file_changes", machine, files: [{ path: "/repo/a.txt", before, after }],
  });
  tracker.observe(event("macbook", "one\n", "two\n"));
  tracker.observe(event("macbook", "two\n", "three\n"));
  tracker.observe(event("server", null, "new\n"));
  const result = tracker.result();
  expect(result?.totals).toEqual({ files: 2, additions: 2, deletions: 1 });
  expect(result?.files[0].path).toBe("macbook:/repo/a.txt");
  expect(result?.files[0].hunks[0].lines.filter(l => l.kind === "deleted").map(l => l.text)).toEqual(["one"]);
  tracker.observe(event("macbook", "three\n", "one\n"));
  expect(tracker.result()?.totals.files).toBe(1);
});
