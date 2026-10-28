// Снимки файлов на этой машине (.110) — для локального bash роли.
// LOCK-ASSISTANT-TOOL-DIFFS-20261028.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { asText, type CaptureIO } from "./toolFileCapture.js";

export function localCaptureIO(): CaptureIO {
  return {
    read: async (file) => {
      try {
        const stat = await fs.stat(file);
        return stat.isFile() ? asText(await fs.readFile(file)) : null;
      } catch {
        return null;
      }
    },
    sh: (command, cwd) => new Promise((resolve) => {
      execFile("/bin/sh", ["-c", command], { cwd, timeout: 15_000, maxBuffer: 4_000_000, encoding: "utf8" },
        (error, stdout) => resolve({ ok: !error, stdout: stdout ?? "" }));
    }),
  };
}
