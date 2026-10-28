// Изменения файлов за один ход роли в чате. LOCK-CHAT-TURN-CODE-CHANGES-20261027.
//
// Владелец 27.10.2026: под ответом роли, рядом с токенами, — что она
// поменяла в файлах, тем же видом, что «Изменения кода» в карточке.
// У хода чата нет своей ветки, поэтому исходный вид файла запоминается
// прямо перед первой правкой (`edit`/`write`), а в конце хода сравнивается
// с тем, что стало.
//
// 28.10.2026 (LOCK-ASSISTANT-TOOL-DIFFS-20261028): правки на других машинах
// и через bash приходят готовыми снимками «до/после» — событием
// `taskflow_file_changes` или в `details` результата инструмента (их снимает
// toolFileCapture.ts там, где идёт операция). Здесь они склеиваются: первый
// «до» и последний «после» по каждому файлу каждой машины.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUnifiedDiff, type CodeFile } from "./worktree/codeChanges.js";
import type { FileChangesEvent } from "./toolFileCapture.js";

const EDIT_TOOLS = new Set(["edit", "write"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 30;
const MAX_LINES_PER_FILE = 1000;

export interface TurnCodeChanges {
  totals: { files: number; additions: number; deletions: number };
  files: CodeFile[];
}

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Unified diff двух текстов через `git diff --no-index` во временной папке. */
function diffTexts(before: string | null, after: string | null, label: string): CodeFile | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-diff-"));
  try {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.writeFileSync(a, before ?? "");
    fs.writeFileSync(b, after ?? "");
    let text = "";
    try {
      execFileSync("git", ["diff", "--no-index", "--no-color", "-U3", a, b], { encoding: "utf8", timeout: 10_000 });
      return null; // код 0 — файлы одинаковые
    } catch (error) {
      text = (error as { stdout?: string }).stdout ?? "";
    }
    const [file] = parseUnifiedDiff(text, { maxLinesPerFile: MAX_LINES_PER_FILE });
    if (!file) return null;
    file.path = label;
    file.old_path = null;
    file.status = before === null ? "added" : after === null ? "deleted" : "modified";
    return file;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class TurnFileTracker {
  private cwd: string | null = null;
  private readonly home: string;
  /** Абсолютный путь → вид файла до первой правки (null — файла не было). */
  private readonly originals = new Map<string, string | null>();
  /** «машина:путь» → первый «до» и последний «после» из готовых снимков. */
  private readonly captured = new Map<string, { before: string | null; after: string | null }>();

  constructor(opts: { home?: string } = {}) {
    this.home = opts.home ?? os.homedir();
  }

  /** Событие рантайма роли; всё, кроме правок файлов, пропускается. */
  observe(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const e = event as { type?: string; cwd?: unknown; toolName?: string; args?: unknown; result?: any };
    if (e.type === "taskflow_file_changes") return this.absorb(event as FileChangesEvent);
    if (e.type === "tool_execution_end") {
      const attached = e.result?.details?.taskflow_file_changes;
      if (attached?.type === "taskflow_file_changes") this.absorb(attached);
      return;
    }
    if (e.type === "taskflow_workspace" && typeof e.cwd === "string") {
      this.cwd = e.cwd;
      return;
    }
    if (e.type !== "tool_execution_start" || !e.toolName || !EDIT_TOOLS.has(e.toolName)) return;
    const raw = (e.args as { path?: unknown } | null)?.path;
    if (typeof raw !== "string" || !raw.trim()) return;
    const resolved = this.resolve(raw.trim());
    if (!resolved || this.originals.has(resolved) || this.originals.size >= MAX_FILES) return;
    this.originals.set(resolved, fs.existsSync(resolved) ? readText(resolved) : null);
  }

  private absorb(event: FileChangesEvent): void {
    if (typeof event.machine !== "string" || !Array.isArray(event.files)) return;
    for (const f of event.files) {
      if (!f || typeof f.path !== "string") continue;
      const key = event.machine + ":" + f.path;
      const prev = this.captured.get(key);
      if (!prev && this.captured.size >= MAX_FILES) continue;
      this.captured.set(key, { before: prev ? prev.before : f.before ?? null, after: f.after ?? null });
    }
  }

  private resolve(raw: string): string | null {
    if (raw.startsWith("~/")) return path.join(this.home, raw.slice(2));
    if (path.isAbsolute(raw)) return path.normalize(raw);
    return this.cwd ? path.resolve(this.cwd, raw) : null;
  }

  /** Как показать путь владельцу: внутри папки роли — относительно неё, иначе от ~. */
  private label(file: string): string {
    if (this.cwd && file.startsWith(this.cwd + path.sep)) return path.relative(this.cwd, file);
    if (file.startsWith(this.home + path.sep)) return "~/" + path.relative(this.home, file);
    return file;
  }

  /** Итог хода; null — ни один файл не изменился. */
  result(): TurnCodeChanges | null {
    const files: CodeFile[] = [];
    for (const [file, before] of this.originals) {
      const after = fs.existsSync(file) ? readText(file) : null;
      if (before === after) continue;
      const changed = diffTexts(before, after, this.label(file));
      if (changed) files.push(changed);
    }
    for (const [key, { before, after }] of this.captured) {
      if (before === after) continue;
      const changed = diffTexts(before, after, key);
      if (changed) files.push(changed);
    }
    if (!files.length) return null;
    return {
      totals: {
        files: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      },
      files,
    };
  }
}
