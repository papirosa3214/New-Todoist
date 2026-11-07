// Снимки файлов вокруг одной операции роли — для дифа под ответом в чате.
// LOCK-ASSISTANT-TOOL-DIFFS-20261028.
//
// Владелец 28.10.2026: Помощник правит файлы через taskflow_host_edit/write/
// bash и локальный bash, а под ответом пусто — сборщик хода видел только
// локальные edit/write. Здесь вид файла снимается до и после операции там,
// где она идёт (на Маке через хост, на .110 локально), и уходит в сборщик
// событием `taskflow_file_changes`.
//
// edit/write — снимок одного файла по пути из аргументов.
// bash — по git: какие файлы были грязными до команды и стали после, плюс
// файлы новых коммитов, если команда коммитила. Вне git-репозитория правки
// bash не видны — это честный предел, а не ошибка.

export interface FileCapture {
  path: string;
  before: string | null;
  after: string | null;
}

/** Событие для TurnFileTracker. */
export interface FileChangesEvent {
  type: "taskflow_file_changes";
  machine: string;
  files: FileCapture[];
}

/** Как читать файлы и запускать команды на машине, где идёт операция. */
export interface CaptureIO {
  /** Текст файла; null — файла нет, он двоичный или слишком большой. */
  read(absolutePath: string): Promise<string | null>;
  /** Команда в shell; stdout — весь вывод. */
  sh(command: string, cwd: string): Promise<{ ok: boolean; stdout: string }>;
}

const MAX_FILES = 30;
export const MAX_CAPTURE_BYTES = 1_000_000;

export const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/** Текст или null: двоичное и большое в диф не идёт. */
export function asText(buf: Buffer | null): string | null {
  if (!buf || buf.length > MAX_CAPTURE_BYTES || buf.includes(0)) return null;
  return buf.toString("utf8");
}

/** edit/write: файл до и после операции. */
export async function captureFile<T>(io: CaptureIO, file: string, run: () => Promise<T>): Promise<{ result: T; files: FileCapture[] }> {
  const before = await io.read(file).catch(() => null);
  const result = await run();
  const after = await io.read(file).catch(() => null);
  return { result, files: before === after ? [] : [{ path: file, before, after }] };
}

interface GitState {
  top: string;
  head: string | null;
  /** Путь от корня репозитория → текст до команды (только грязные). */
  dirty: Map<string, string | null>;
}

function parseStatus(z: string): string[] {
  const out: string[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    out.push(entry.slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // за переименованием идёт старый путь
  }
  return out;
}

async function gitState(io: CaptureIO, cwd: string): Promise<GitState | null> {
  const top = await io.sh("git rev-parse --show-toplevel", cwd);
  if (!top.ok || !top.stdout.trim()) return null;
  const root = top.stdout.trim();
  const head = await io.sh("git rev-parse HEAD", root);
  const status = await io.sh("git status --porcelain=v1 -z --untracked-files=all", root);
  if (!status.ok) return null;
  const dirty = new Map<string, string | null>();
  for (const rel of parseStatus(status.stdout).slice(0, MAX_FILES)) {
    dirty.set(rel, await io.read(root + "/" + rel).catch(() => null));
  }
  return { top: root, head: head.ok ? head.stdout.trim() || null : null, dirty };
}

async function atCommit(io: CaptureIO, top: string, commit: string | null, rel: string): Promise<string | null> {
  if (!commit) return null;
  const r = await io.sh(`git cat-file -e ${commit}:${q(rel)} && git show ${commit}:${q(rel)}`, top);
  return r.ok ? r.stdout : null;
}

/** bash: что команда поменяла в git-репозитории вокруг cwd. */
export async function captureBash<T>(io: CaptureIO, cwd: string, run: () => Promise<T>): Promise<{ result: T; files: FileCapture[] }> {
  const before = await gitState(io, cwd).catch(() => null);
  const result = await run();
  if (!before) return { result, files: [] };
  const after = await gitState(io, before.top).catch(() => null);
  if (!after) return { result, files: [] };
  const touched = new Set([...before.dirty.keys(), ...after.dirty.keys()]);
  if (before.head && after.head && before.head !== after.head) {
    const committed = await io.sh(`git diff --name-only ${before.head} ${after.head}`, before.top);
    if (committed.ok) for (const rel of committed.stdout.split("\n").filter(Boolean)) touched.add(rel);
  }
  const files: FileCapture[] = [];
  for (const rel of [...touched].slice(0, MAX_FILES)) {
    const was = before.dirty.has(rel) ? before.dirty.get(rel)! : await atCommit(io, before.top, before.head, rel);
    const now = after.dirty.has(rel) ? after.dirty.get(rel)! : await atCommit(io, after.top, after.head, rel);
    if (was !== now) files.push({ path: before.top + "/" + rel, before: was, after: now });
  }
  return { result, files };
}

/** Прицепить снимки к результату инструмента: сборщик достанет их из tool_execution_end. */
export function withFileChanges<T>(result: T, machine: string, files: FileCapture[]): T {
  if (!files.length || !result || typeof result !== "object") return result;
  const r = result as { details?: unknown };
  const details = r.details && typeof r.details === "object" ? r.details as Record<string, unknown> : {};
  const event: FileChangesEvent = { type: "taskflow_file_changes", machine, files };
  return { ...result, details: { ...details, taskflow_file_changes: event } };
}
