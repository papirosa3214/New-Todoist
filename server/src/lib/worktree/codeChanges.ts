// Изменения кода карточки: что роль поменяла в своей ветке `roles/<taskId>`.
// LOCK-TASK-CODE-CHANGES-20261027.
//
// Владелец 27.10.2026: «точно буду знать, что трогали, что не трогали».
// Только чтение: ничего не сливает и не правит. Разбор diff — здесь, на
// сервере, чтобы приложение только показывало готовые строки.
import { spawnSync } from "node:child_process";
import { gitOrNull, liveRepo, refExists, roleBranch, worktreeExists, worktreePath } from "./paths.js";

export type CodeLineKind = "context" | "added" | "deleted";

export interface CodeLine {
  kind: CodeLineKind;
  /** Номер строки в старой версии; у добавленной — null. */
  old: number | null;
  /** Номер строки в новой версии; у удалённой — null. */
  new: number | null;
  text: string;
}

export interface CodeHunk {
  header: string;
  lines: CodeLine[];
}

export type CodeFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface CodeFile {
  path: string;
  old_path: string | null;
  status: CodeFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Строк больше потолка: показана только часть, счётчики — полные. */
  truncated: boolean;
  hunks: CodeHunk[];
}

export interface CodeChanges {
  task_id: string;
  branch: string;
  /** branch — ветка ещё не влита; merged — влита, диапазон из очереди; none — изменений не найти. */
  state: "branch" | "merged" | "none";
  base: string | null;
  head: string | null;
  /** В счёт вошли незакоммиченные правки рабочей копии роли (27.10.2026). */
  uncommitted?: boolean;
  totals: { files: number; additions: number; deletions: number };
  files: CodeFile[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(raw: string): string {
  return raw.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string, opts: { maxLinesPerFile?: number } = {}): CodeFile[] {
  const cap = opts.maxLinesPerFile ?? 2000;
  const files: CodeFile[] = [];
  let file: CodeFile | null = null;
  let hunk: CodeHunk | null = null;
  let shown = 0;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = {
        path: match?.[2] ?? line.slice(11),
        old_path: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        truncated: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      shown = 0;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.old_path = line.slice(12);
        file.status = "renamed";
      } else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = stripPrefix(line.slice(4));
    }
    const header = HUNK.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    let entry: CodeLine | null = null;
    if (line.startsWith("+")) {
      file.additions += 1;
      entry = { kind: "added", old: null, new: newLine++, text: line.slice(1) };
    } else if (line.startsWith("-")) {
      file.deletions += 1;
      entry = { kind: "deleted", old: oldLine++, new: null, text: line.slice(1) };
    } else if (line.startsWith(" ")) {
      entry = { kind: "context", old: oldLine++, new: newLine++, text: line.slice(1) };
    }
    if (!entry) continue; // «\ No newline at end of file» и пустой хвост
    if (shown < cap) {
      hunk.lines.push(entry);
      shown += 1;
    } else {
      file.truncated = true;
    }
  }
  // Пустые секции после потолка не нужны приложению.
  for (const f of files) f.hunks = f.hunks.filter((h) => h.lines.length > 0);
  return files;
}

function diff(repo: string, base: string, head: string): CodeFile[] {
  const text = gitOrNull(repo, ["diff", "--no-color", "--find-renames", "-U3", base, head], 60_000);
  return text ? parseUnifiedDiff(text) : [];
}

/** Новых файлов в счёт не больше этого: отчёт, а не выгрузка копии. */
const UNTRACKED_MAX = 200;

/** Рабочая копия роли против `base`: закоммиченное и нет, плюс новые файлы. */
function workingDiff(worktree: string, base: string): CodeFile[] {
  const tracked = gitOrNull(worktree, ["diff", "--no-color", "--find-renames", "-U3", base], 60_000);
  const files = tracked ? parseUnifiedDiff(tracked) : [];
  const untracked = (gitOrNull(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
    .split("\0").filter(Boolean).slice(0, UNTRACKED_MAX);
  for (const file of untracked) {
    // --no-index отвечает кодом 1, когда разница есть, — это не ошибка.
    const out = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", "--", "/dev/null", file],
      { cwd: worktree, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (out.stdout) files.push(...parseUnifiedDiff(out.stdout));
  }
  return files;
}

/**
 * Диапазон: невлитая ветка — от точки ответвления до вершины ветки (что
 * сделала роль, без того, что ушло в main после); влитая — `before..after`,
 * записанные очередью слияний.
 */
export function taskCodeChanges(
  taskId: string,
  opts: { repo?: string; merged?: { before: string; after: string } | null; worktree?: string | null } = {},
): CodeChanges {
  const repo = opts.repo ?? liveRepo();
  const branch = roleBranch(taskId);
  const empty: CodeChanges = {
    task_id: taskId,
    branch,
    state: "none",
    base: null,
    head: null,
    totals: { files: 0, additions: 0, deletions: 0 },
    files: [],
  };
  let state: CodeChanges["state"] = "none";
  let base: string | null = null;
  let head: string | null = null;

  if (refExists(repo, `refs/heads/${branch}`) && refExists(repo, "refs/heads/main")) {
    head = gitOrNull(repo, ["rev-parse", `refs/heads/${branch}`]);
    base = head ? gitOrNull(repo, ["merge-base", "refs/heads/main", head]) : null;
    if (head && base && base !== head) state = "branch";
  }
  // Незакоммиченные правки в рабочей копии роли (владелец 27.10.2026):
  // роль могла править и не успеть закоммитить — их тоже видно.
  const worktree = opts.worktree !== undefined ? opts.worktree
    : worktreeExists(taskId) ? worktreePath(taskId) : null;
  let uncommitted = false;
  if (worktree && head && refExists(repo, "refs/heads/main")) {
    const dirty = gitOrNull(worktree, ["status", "--porcelain"]);
    if (dirty && dirty.trim()) {
      base = base ?? gitOrNull(repo, ["merge-base", "refs/heads/main", head]);
      if (base) { uncommitted = true; state = "branch"; }
    }
  }
  if (state === "none" && opts.merged?.before && opts.merged.after) {
    base = opts.merged.before;
    head = opts.merged.after;
    state = "merged";
  }
  if (state === "none" || !base || !head) return empty;

  const files = uncommitted && worktree ? workingDiff(worktree, base) : diff(repo, base, head);
  return {
    task_id: taskId,
    branch,
    state,
    base,
    head,
    ...(uncommitted ? { uncommitted: true } : {}),
    totals: {
      files: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    },
    files,
  };
}
