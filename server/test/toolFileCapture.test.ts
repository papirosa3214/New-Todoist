import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureBash, captureFile, withFileChanges, type CaptureIO } from "../src/lib/toolFileCapture.js";
import { localCaptureIO } from "../src/lib/localCaptureIO.js";
import { TurnFileTracker } from "../src/lib/turnFileChanges.js";

const io: CaptureIO = localCaptureIO();

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "dirty.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "dirty.txt"), "base\nlocal\n");
  return fs.realpathSync(dir);
}

describe("toolFileCapture", () => {
  it("edit/write: file before and after", async () => {
    const dir = repo(); const file = path.join(dir, "a.txt");
    const { files } = await captureFile(io, file, async () => fs.writeFileSync(file, "two\n"));
    expect(files).toEqual([{ path: file, before: "one\n", after: "two\n" }]);
    const none = await captureFile(io, file, async () => {});
    expect(none.files).toEqual([]);
  });

  it("bash: edits, new files and commits inside the repo", async () => {
    const dir = repo();
    const { result, files } = await captureBash(io, dir, async () => {
      execSync("printf \"x\\n\" > new.txt && printf \"three\\n\" > a.txt && git -c user.name=t -c user.email=t@t commit -qam c && printf \"base\\nlocal\\nmore\\n\" > dirty.txt", { cwd: dir });
      return 7;
    });
    expect(result).toBe(7);
    const byName = Object.fromEntries(files.map(f => [path.basename(f.path), f]));
    expect(byName["a.txt"]).toMatchObject({ before: "one\n", after: "three\n" });
    expect(byName["new.txt"]).toMatchObject({ before: null, after: "x\n" });
    expect(byName["dirty.txt"]).toMatchObject({ before: "base\nlocal\n", after: "base\nlocal\nmore\n" });
    expect(files).toHaveLength(3);
  });

  it("bash outside git sees nothing and still returns the result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    const { result, files } = await captureBash(io, dir, async () => { fs.writeFileSync(path.join(dir, "f"), "x"); return "ok"; });
    expect(result).toBe("ok");
    expect(files).toEqual([]);
  });

  it("captures travel in tool result details to the turn tracker", async () => {
    const tracker = new TurnFileTracker();
    const result = withFileChanges({ content: [], details: { exitCode: 0 } }, "MacBook", [{ path: "/w/a.txt", before: "one\n", after: "two\n" }]);
    expect((result as any).details.exitCode).toBe(0);
    tracker.observe({ type: "tool_execution_end", toolCallId: "1", toolName: "taskflow_host_bash", result });
    const changes = tracker.result();
    expect(changes?.totals).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(changes?.files[0].path).toBe("MacBook:/w/a.txt");
    expect(withFileChanges({ content: [] }, "MacBook", [])).toEqual({ content: [] });
  });
});
