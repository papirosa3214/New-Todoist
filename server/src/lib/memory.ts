import { getSetting } from "./serverSettings.js";
// Память ролей внутри приложения (владелец 02.10.2026): «с чистого листа;
// пусть сами пишут, а я вижу и редактирую; и чтобы файлы можно было
// закидывать».
//
// Три области видимости:
//   • team    — общая: ваши предпочтения, правила, факты об инфраструктуре;
//   • role    — память одной роли: её уроки и приёмы;
//   • project — договорённости по проекту, видны ролям в этом проекте.
// Запись — короткий факт / урок / предпочтение или файл (текст файла режется
// на куски, каждый ищется отдельно).
//
// Вспоминание — смысловым поиском по эмбеддингам (тот же Ollama-клиент, что у
// подбора ролей). Нет эмбеддингов (Ollama недоступен) — поиск по словам:
// память не должна пропадать из-за соседнего сервиса.
//
// Роль получает память сама, без запроса: перед ходом сервер подмешивает в
// задание закреплённые записи и самые близкие к теме (memoryBlock).
import crypto from "node:crypto";
import db from "../db.js";
import { toFtsQuery } from "./ftsQuery.js";
export { toFtsQuery } from "./ftsQuery.js";
import { startObservation, finishObservation, withObservationContext } from "./contextObservability.js";
import {
  filterMemoryByJev,
  reviewMemoryWriteByJev,
  MemoryWriteRejected,
} from "./memorySkillsJev.js";

export type MemoryScope = "team" | "role" | "project";
export type MemoryKind = "fact" | "lesson" | "preference" | "file";

export interface MemoryRow {
  id: string;
  scope: MemoryScope;
  role_key: string | null;
  project_id: string | null;
  kind: MemoryKind;
  title: string | null;
  text: string;
  source_kind: "owner" | "role";
  source_ref: string | null;
  created_by: string | null;
  updated_by: string | null;
  pinned: number;
  attachment_id: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const MEMORY_TEXT_MAX = 2_000;
const CHUNK_TARGET = 1_200;
/** Похожая запись в той же области — обновляем её, а не плодим дубль. */
function duplicateSimilarity(): number {
  const pct = Number(getSetting("memory_duplicate_similarity") ?? 92);
  if (!Number.isFinite(pct)) return 0.92;
  return Math.min(0.99, Math.max(0.5, pct / 100));
}
/** Ниже этой близости запись в задание не попадает. */
const RECALL_MIN_SIMILARITY = 0.35;

const SCOPES: MemoryScope[] = ["team", "role", "project"];
const KINDS: MemoryKind[] = ["fact", "lesson", "preference", "file"];

const uid = () => crypto.randomUUID();

// ── Эмбеддинги ─────────────────────────────────────────────────────────

async function embed(text: string): Promise<Float32Array | null> {
  try {
    const { getEmbeddings } = await import("./embeddingClient.js");
    const result = await getEmbeddings(text.slice(0, 4_000), {
      timeoutMs: 8_000,
    });
    const vec = result.embeddings as number[];
    return Array.isArray(vec) && vec.length ? new Float32Array(vec) : null;
  } catch {
    return null;
  }
}

function toBlob(vec: Float32Array | null): Buffer | null {
  return vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null;
}

function fromBlob(blob: Buffer | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

/** Запасной поиск без эмбеддингов: доля слов запроса, найденных в тексте. */
function wordScore(query: string, text: string): number {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hay = text.toLowerCase();
  const hits = words.filter((w) =>
    hay.includes(w.slice(0, Math.max(4, w.length - 2))),
  ).length;
  return hits / words.length;
}

let ftsKnown: boolean | null = null;
function ftsReady(): boolean {
  if (ftsKnown != null) return ftsKnown;
  try {
    ftsKnown = Boolean(
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memories_fts'").get(),
    );
  } catch {
    ftsKnown = false;
  }
  return ftsKnown;
}

function ftsRankedIds(
  table: "memories_fts" | "memory_chunks_fts",
  joinSql: string,
  vis: { sql: string; args: unknown[] },
  match: string,
  limit: number,
): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT m.id FROM ${table} f
           ${joinSql}
          WHERE f MATCH ? AND ${vis.sql}
          ORDER BY bm25(f)
          LIMIT ${limit}`,
      )
      .all(match, ...vis.args) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

// ── Проверка полей ─────────────────────────────────────────────────────

function clean(text: unknown, max: number): string {
  const t = String(text ?? "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** Роли часто передают в project_id id задачи — подскажем, какой проект верный. */
function projectHint(p: string): string {
  const base = p
    ? `нет проекта с project_id «${p}».`
    : "для памяти проекта нужен project_id.";
  const task = p
    ? (db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(p) as
        { project_id: string | null } | undefined)
    : undefined;
  if (task?.project_id)
    return `${base} Это id задачи, а не проекта: её проект — project_id «${task.project_id}». Повтори с ним.`;
  if (task)
    return `${base} Это id задачи без проекта — запиши в scope role (своё) или team (общее) без project_id.`;
  return `${base} Список проектов и их id — taskflow_projects. Если знание не про конкретный проект — scope role или team без project_id.`;
}

function checkScope(
  scope: unknown,
  roleKey: unknown,
  projectId: unknown,
): { scope: MemoryScope; role_key: string | null; project_id: string | null } {
  const s = String(scope ?? "team") as MemoryScope;
  if (!SCOPES.includes(s))
    throw new MemoryError("scope: team | role | project");
  if (s === "role") {
    const r = clean(roleKey, 64);
    if (!r) throw new MemoryError("для памяти роли нужен role_key — роль определяется по учётке; если её нет, пиши scope=team");
    return { scope: s, role_key: r, project_id: null };
  }
  if (s === "project") {
    let p = clean(projectId, 64);
    // Роли чаще всего передают id своей задачи: проект берём из неё, а не
    // отказываем с подсказкой (23 отказа за 16–19.10.2026).
    if (p && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(p)) {
      const task = db
        .prepare("SELECT project_id FROM tasks WHERE id = ?")
        .get(p) as { project_id: string | null } | undefined;
      if (task?.project_id) p = task.project_id;
    }
    if (!p || !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(p))
      throw new MemoryError(projectHint(p));
    return { scope: s, role_key: null, project_id: p };
  }
  return { scope: "team", role_key: null, project_id: null };
}

// ── Чтение ─────────────────────────────────────────────────────────────

const COLUMNS = `id, scope, role_key, project_id, kind, title, text, source_kind, source_ref, created_by, updated_by,
  pinned, attachment_id, use_count, last_used_at, created_at, updated_at`;

export function getMemory(id: string): (MemoryRow & { chunks: number }) | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`)
    .get(id) as MemoryRow | undefined;
  if (!row) return null;
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE memory_id = ?")
    .get(id) as { n: number };
  return { ...row, chunks: n };
}

/** Список для экрана «Память»: фильтр по области/роли/проекту и словам. */
export function listMemories(filter: {
  scope?: string;
  role_key?: string;
  project_id?: string;
  q?: string;
  limit?: number;
}): MemoryRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.scope) {
    where.push("scope = ?");
    args.push(filter.scope);
  }
  if (filter.role_key) {
    where.push("role_key = ?");
    args.push(filter.role_key);
  }
  if (filter.project_id) {
    where.push("project_id = ?");
    args.push(filter.project_id);
  }
  if (filter.q) {
    const match = toFtsQuery(filter.q);
    if (match && ftsReady()) {
      where.push("rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
      args.push(match);
    } else {
      where.push("(text LIKE ? OR title LIKE ?)");
      args.push(`%${filter.q}%`, `%${filter.q}%`);
    }
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY pinned DESC, updated_at DESC LIMIT ${limit}`,
    )
    .all(...args) as MemoryRow[];
}

// ── Запись ─────────────────────────────────────────────────────────────

export interface WriteInput {
  scope?: unknown;
  role_key?: unknown;
  project_id?: unknown;
  kind?: unknown;
  title?: unknown;
  text?: unknown;
  pinned?: unknown;
  source_ref?: unknown;
}

export interface Author {
  id: string;
  kind: "owner" | "role";
}

/**
 * Записать факт/урок/предпочтение. Похожая запись в той же области уже
 * есть — она обновляется (возвращается с updated: true), дубль не плодится.
 */
export async function remember(
  input: WriteInput,
  author: Author,
  opts?: { onDuplicate?: "update" | "skip"; skipWriteReview?: boolean },
): Promise<{ memory: MemoryRow; updated: boolean; skipped?: boolean }> {
  const text = clean(input.text, MEMORY_TEXT_MAX);
  if (!text) throw new MemoryError("пустая запись: что запомнить?");
  const kind = String(input.kind ?? "fact") as MemoryKind;
  if (!KINDS.includes(kind) || kind === "file")
    throw new MemoryError("kind: fact | lesson | preference");
  const where = checkScope(input.scope, input.role_key, input.project_id);
  const title = clean(input.title, 200) || null;
  // Галочка «Проверка записи в память» (раздел JEV): только записи ролей,
  // владелец пишет что хочет. JEV уверен, что это разовая деталь, — отказ
  // с объяснением; не ответил или сомневается — запись идёт как обычно.
  if (author.kind === "role" && !opts?.skipWriteReview) {
    try {
      await reviewMemoryWriteByJev({ kind, title, text });
    } catch (err) {
      if (err instanceof MemoryWriteRejected)
        throw new MemoryError(err.message);
      throw err;
    }
  }
  const vec = await embed(title ? `${title}\n${text}` : text);

  if (vec) {
    const near = db
      .prepare(
        `SELECT id, embedding, source_kind FROM memories
          WHERE scope = ? AND COALESCE(role_key,'') = ? AND COALESCE(project_id,'') = ? AND kind <> 'file' AND embedding IS NOT NULL`,
      )
      .all(where.scope, where.role_key ?? "", where.project_id ?? "") as Array<{
      id: string;
      embedding: Buffer;
      source_kind: string;
    }>;
    let best: { id: string; score: number; source_kind: string } | null = null;
    for (const row of near) {
      const other = fromBlob(row.embedding);
      const score = other ? cosine(vec, other) : 0;
      if (score >= duplicateSimilarity() && (!best || score > best.score))
        best = { id: row.id, score, source_kind: row.source_kind };
    }
    // Запись владельца роль не перетирает — рядом ляжет своя.
    if (best && !(best.source_kind === "owner" && author.kind === "role")) {
      if (opts?.onDuplicate === "skip")
        return { memory: getMemory(best.id)!, updated: false, skipped: true };
      db.prepare(
        `UPDATE memories SET text = ?, title = COALESCE(?, title), kind = ?, embedding = ?, updated_by = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(text, title, kind, toBlob(vec), author.id, best.id);
      return { memory: getMemory(best.id)!, updated: true };
    }
  }

  const id = uid();
  db.prepare(
    `INSERT INTO memories (id, scope, role_key, project_id, kind, title, text, source_kind, source_ref, created_by, updated_by, pinned, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    where.scope,
    where.role_key,
    where.project_id,
    kind,
    title,
    text,
    author.kind,
    clean(input.source_ref, 100) || null,
    author.id,
    author.id,
    input.pinned === true ? 1 : 0,
    toBlob(vec),
  );
  return { memory: getMemory(id)!, updated: false };
}

/** Правка записи (владельцем или ролью-автором). */
export async function updateMemory(
  id: string,
  input: WriteInput,
  author: Author,
): Promise<MemoryRow> {
  const current = getMemory(id);
  if (!current) throw new MemoryError("запись не найдена", 404);
  if (author.kind === "role" && current.created_by !== author.id) {
    throw new MemoryError(
      "роль правит только свои записи; чужие — владелец",
      403,
    );
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  let reembed = false;
  if (input.text !== undefined) {
    const text = clean(
      input.text,
      current.kind === "file" ? 24_000 : MEMORY_TEXT_MAX,
    );
    if (!text)
      throw new MemoryError("пустая запись — удалите её, а не стирайте текст");
    sets.push("text = ?");
    args.push(text);
    reembed = true;
  }
  if (input.title !== undefined) {
    sets.push("title = ?");
    args.push(clean(input.title, 200) || null);
    reembed = true;
  }
  if (input.kind !== undefined) {
    const kind = String(input.kind) as MemoryKind;
    if (
      !KINDS.includes(kind) ||
      (kind === "file") !== (current.kind === "file")
    )
      throw new MemoryError("kind: fact | lesson | preference");
    sets.push("kind = ?");
    args.push(kind);
  }
  if (input.pinned !== undefined) {
    if (author.kind !== "owner")
      throw new MemoryError("закрепляет владелец", 403);
    sets.push("pinned = ?");
    args.push(input.pinned === true ? 1 : 0);
  }
  if (
    input.scope !== undefined ||
    input.role_key !== undefined ||
    input.project_id !== undefined
  ) {
    if (author.kind !== "owner")
      throw new MemoryError("область памяти меняет владелец", 403);
    const where = checkScope(
      input.scope ?? current.scope,
      input.role_key ?? current.role_key,
      input.project_id ?? current.project_id,
    );
    sets.push("scope = ?", "role_key = ?", "project_id = ?");
    args.push(where.scope, where.role_key, where.project_id);
  }
  if (!sets.length) throw new MemoryError("нечего менять");
  if (reembed && current.kind !== "file") {
    const text =
      input.text !== undefined
        ? clean(input.text, MEMORY_TEXT_MAX)
        : current.text;
    const title =
      input.title !== undefined
        ? clean(input.title, 200)
        : (current.title ?? "");
    sets.push("embedding = ?");
    args.push(toBlob(await embed(title ? `${title}\n${text}` : text)));
  }
  sets.push("updated_by = ?", "updated_at = datetime('now')");
  args.push(author.id);
  db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(
    ...args,
    id,
  );
  return getMemory(id)!;
}

export function deleteMemory(id: string, author: Author): void {
  const current = getMemory(id);
  if (!current) throw new MemoryError("запись не найдена", 404);
  if (author.kind === "role" && current.created_by !== author.id) {
    throw new MemoryError("роль удаляет только свои записи", 403);
  }
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/** Нарезать текст файла на куски по абзацам, около CHUNK_TARGET символов. */
export function chunkText(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (p.length > CHUNK_TARGET * 1.5) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < p.length; i += CHUNK_TARGET)
        chunks.push(p.slice(i, i + CHUNK_TARGET));
      continue;
    }
    if (current && current.length + p.length + 2 > CHUNK_TARGET) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Файл в память: текст уже извлечён, режем на куски и считаем эмбеддинги. */
export async function rememberFile(
  input: {
    scope?: unknown;
    role_key?: unknown;
    project_id?: unknown;
    title: string;
    text: string;
    attachment_id: string;
  },
  author: Author,
): Promise<MemoryRow> {
  const where = checkScope(input.scope, input.role_key, input.project_id);
  const text = input.text.trim();
  if (!text) throw new MemoryError("в файле не нашлось текста");
  const id = uid();
  const chunks = chunkText(text);
  const vectors: Array<Float32Array | null> = [];
  for (const chunk of chunks) vectors.push(await embed(chunk));
  db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, scope, role_key, project_id, kind, title, text, source_kind, created_by, updated_by, attachment_id)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      where.scope,
      where.role_key,
      where.project_id,
      clean(input.title, 200),
      text,
      author.kind,
      author.id,
      author.id,
      input.attachment_id,
    );
    const insert = db.prepare(
      "INSERT INTO memory_chunks (id, memory_id, idx, text, embedding) VALUES (?, ?, ?, ?, ?)",
    );
    chunks.forEach((chunk, i) =>
      insert.run(uid(), id, i, chunk, toBlob(vectors[i])),
    );
  })();
  return getMemory(id)!;
}

// ── Вспоминание ────────────────────────────────────────────────────────

export interface RecallItem {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string | null;
  text: string;
  score: number;
  pinned: boolean;
  source: "owner" | "role";
  /**
   * Кто именно записал — имя учётки (владелец, Оркестратор, «Разработчик»).
   * Владелец 01.11.2026: «каждый сам должен писать от своего имени» — раньше
   * вывод показывал «записал владелец» у всех, потому что подпись строилась
   * только по source_kind, а Оркестратор и Помощник пишут с правами владельца.
   */
  author: string | null;
}

function visibleWhere(
  roleKey: string | null,
  projectId: string | null,
): { sql: string; args: unknown[] } {
  const parts = ["m.scope = 'team'"];
  const args: unknown[] = [];
  if (roleKey) {
    parts.push("(m.scope = 'role' AND m.role_key = ?)");
    args.push(roleKey);
  }
  if (projectId) {
    parts.push("(m.scope = 'project' AND m.project_id = ?)");
    args.push(projectId);
  }
  return { sql: `(${parts.join(" OR ")})`, args };
}

/**
 * Что роль помнит по теме: записи и куски файлов, видимые ей, по близости к
 * запросу. Закреплённые владельцем — всегда, первыми.
 */
export type RecallMode = "full" | "index" | "detail";

export async function recall(args: {
  roleKey: string | null;
  projectId?: string | null;
  query: string;
  limit?: number;
  mode?: RecallMode;
  ids?: string[];
  countUsage?: boolean;
}): Promise<RecallItem[]> {
  const memoryObservation=startObservation("enricher","teamMemory",{role:args.roleKey??undefined});
  try {
  const limit = Math.min(Math.max(args.limit ?? 6, 1), 20);
  const vis = visibleWhere(args.roleKey, args.projectId ?? null);
  const query = args.query.trim();
  const mode: RecallMode = args.mode ?? "full";
  const countUsage = args.countUsage ?? mode !== "index";

  if (mode === "detail") {
    const ids = (args.ids ?? []).filter(Boolean).slice(0, 20);
    if (!ids.length) {
      finishObservation(memoryObservation,{status:"skipped",reason:"empty"});
      return [];
    }
    const items = loadRecallItems(vis, ids, mode);
    if (countUsage && items.length) bumpUse(items.map((i) => i.id));
    finishObservation(memoryObservation,{status:items.length?"ok":"skipped",reason:items.length?undefined:"empty",inputCount:ids.length,outputCount:items.length,details:items.map(p=>p.title??p.id)});
    return items;
  }

  const anyRow = db.prepare(`SELECT 1 AS ok FROM memories m WHERE ${vis.sql} LIMIT 1`).get(...vis.args);
  if (!anyRow) {
    finishObservation(memoryObservation,{status:"skipped",reason:"empty"});
    return [];
  }

  const ranked = new Map<string, number>();
  const addRank = (id: string, rank: number, weight = 1) => {
    ranked.set(id, (ranked.get(id) ?? 0) + weight / (60 + rank));
  };
  const match = query ? toFtsQuery(query) : null;
  if (match && ftsReady()) {
    ftsRankedIds(
      "memories_fts",
      "JOIN memories m ON m.rowid = f.rowid",
      vis,
      match,
      40,
    ).forEach((id, i) => addRank(id, i + 1));
    ftsRankedIds(
      "memory_chunks_fts",
      "JOIN memory_chunks c ON c.rowid = f.rowid JOIN memories m ON m.id = c.memory_id",
      vis,
      match,
      20,
    ).forEach((id, i) => addRank(id, i + 1, 0.8));
  }

  const vecNotes = db
    .prepare(
      `SELECT m.id, m.title, m.embedding FROM memories m WHERE ${vis.sql} AND m.kind <> 'file' AND m.embedding IS NOT NULL`,
    )
    .all(...vis.args) as Array<{ id: string; title: string | null; embedding: Buffer | null }>;
  const vecChunks = db
    .prepare(
      `SELECT m.id, c.embedding FROM memory_chunks c JOIN memories m ON m.id = c.memory_id WHERE ${vis.sql} AND c.embedding IS NOT NULL`,
    )
    .all(...vis.args) as Array<{ id: string; embedding: Buffer | null }>;
  const hasVectors = vecNotes.some((n) => n.embedding) || vecChunks.some((c) => c.embedding);
  const qvec = query && hasVectors ? await embed(query) : null;
  const vecHits: Array<{ id: string; score: number; title?: string | null }> = [];
  const vecScore = (blob: Buffer | null, text = ""): number => {
    const vec = fromBlob(blob);
    if (qvec && vec) return cosine(qvec, vec);
    return query ? wordScore(query, text) * 0.6 : 0;
  };
  for (const n of vecNotes) {
    const s = vecScore(n.embedding, n.title ?? "");
    if (s >= RECALL_MIN_SIMILARITY) vecHits.push({ id: n.id, score: s, title: n.title });
  }
  for (const c of vecChunks) {
    const s = vecScore(c.embedding);
    if (s >= RECALL_MIN_SIMILARITY) vecHits.push({ id: c.id, score: s });
  }
  vecHits
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .forEach((h, i) => addRank(h.id, i + 1));

  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter((t) => t.length > 1);
  for (const n of vecNotes) {
    const title = (n.title ?? "").toLowerCase();
    if (tokens.some((t) => title.includes(t))) addRank(n.id, 1, 8);
  }

  const pinned = db
    .prepare(`SELECT m.id FROM memories m WHERE ${vis.sql} AND m.pinned = 1`)
    .all(...vis.args) as Array<{ id: string }>;
  for (const p of pinned) addRank(p.id, 1, 20);

  const candidateIds = [...ranked.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 40);
  if (!candidateIds.length && !match) {
    // Нет FTS-хитов и векторов — запасной обход по словам только по title/text без эмбеддингов.
    const fallback = db
      .prepare(`SELECT m.id, m.title, m.text FROM memories m WHERE ${vis.sql} AND m.kind <> 'file' LIMIT 80`)
      .all(...vis.args) as Array<{ id: string; title: string | null; text: string }>;
    for (const row of fallback) {
      const s = wordScore(query, `${row.title ?? ""} ${row.text}`);
      if (s > 0) ranked.set(row.id, s);
    }
  }
  const ids = [...new Set([...pinned.map((p) => p.id), ...candidateIds, ...[...ranked.keys()]])].slice(0, 40);
  let items = loadRecallItems(vis, ids, mode);
  for (const item of items) {
    item.score = ranked.get(item.id) ?? item.score;
    if (tokens.some((t) => (item.title ?? "").toLowerCase().includes(t))) item.score += 0.15;
  }
  items = items.filter((i) => i.pinned || (ranked.has(i.id) && (ranked.get(i.id) ?? 0) > 0) || i.score >= RECALL_MIN_SIMILARITY);

  items.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.score +
        (b.source === "owner" ? 0.05 : 0) -
        (a.score + (a.source === "owner" ? 0.05 : 0)),
  );
  const ordered = (await withObservationContext({role:args.roleKey??undefined},()=>filterMemoryByJev(query, items))) ?? items;
  const picked: RecallItem[] = [];
  const seenFiles = new Map<string, number>();
  for (const item of ordered) {
    if (item.kind === "file") {
      const n = seenFiles.get(item.id) ?? 0;
      if (n >= 2) continue;
      seenFiles.set(item.id, n + 1);
    }
    picked.push(item);
    if (picked.length >= limit) break;
  }
  if (countUsage && picked.length) bumpUse([...new Set(picked.map((p) => p.id))]);
  finishObservation(memoryObservation,{status:picked.length?"ok":"skipped",reason:picked.length?undefined:"empty",inputCount:items.length,outputCount:picked.length,details:picked.map(p=>p.title??p.id)});
  return picked;
  } catch(error) {
    finishObservation(memoryObservation,{status:"error",reason:"source_unavailable"});
    throw error;
  }
}

function bumpUse(ids: string[]): void {
  if (!ids.length) return;
  db.prepare(
    `UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).run(...ids);
}

function loadRecallItems(
  vis: { sql: string; args: unknown[] },
  ids: string[],
  mode: RecallMode,
): RecallItem[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const notes = db
    .prepare(
      `SELECT m.id, m.kind, m.scope, m.title, m.text, m.pinned, m.source_kind, u.name AS author_name
         FROM memories m LEFT JOIN users u ON u.id = m.created_by
        WHERE ${vis.sql} AND m.kind <> 'file' AND m.id IN (${placeholders})`,
    )
    .all(...vis.args, ...ids) as Array<{
    id: string;
    kind: MemoryKind;
    scope: MemoryScope;
    title: string | null;
    text: string;
    pinned: number;
    source_kind: "owner" | "role";
    author_name: string | null;
  }>;
  const chunks = db
    .prepare(
      `SELECT m.id, m.scope, m.title, m.pinned, m.source_kind, u.name AS author_name, c.text
         FROM memory_chunks c
         JOIN memories m ON m.id = c.memory_id
         LEFT JOIN users u ON u.id = m.created_by
        WHERE ${vis.sql} AND m.id IN (${placeholders})`,
    )
    .all(...vis.args, ...ids) as Array<{
    id: string;
    scope: MemoryScope;
    title: string | null;
    pinned: number;
    source_kind: "owner" | "role";
    author_name: string | null;
    text: string;
  }>;
  const hideBody = (pinned: boolean, source: "owner" | "role") =>
    mode === "index" && !(pinned && source === "owner");
  const items: RecallItem[] = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    scope: n.scope,
    title: n.title,
    text: hideBody(Boolean(n.pinned), n.source_kind) ? "" : n.text,
    score: 0,
    pinned: Boolean(n.pinned),
    source: n.source_kind,
    author: n.author_name,
  }));
  for (const c of chunks) {
    items.push({
      id: c.id,
      kind: "file",
      scope: c.scope,
      title: c.title,
      text: hideBody(Boolean(c.pinned), c.source_kind) ? "" : c.text,
      score: 0,
      pinned: false,
      source: c.source_kind,
      author: c.author_name,
    });
  }
  return items;
}

/** Блок «что ты помнишь» для задания роли. Пусто — пустая строка. */
export async function memoryBlock(args: {
  roleKey: string | null;
  projectId?: string | null;
  query: string;
}): Promise<string> {
  let items: RecallItem[];
  try {
    items = await recall({ ...args, limit: 8, mode: "index", countUsage: false });
  } catch {
    return "";
  }
  if (!items.length) return "";
  const lines = items.map((m) => {
    const where =
      m.scope === "team" ? "общее" : m.scope === "role" ? "твоё" : "проект";
    const head =
      m.kind === "file"
        ? `файл «${m.title ?? "без названия"}»`
        : m.title
          ? `«${m.title}»`
          : "запись";
    const body = m.text.replace(/\s+/g, " ").trim();
    const clipped = body.length > 600 ? `${body.slice(0, 599)}…` : body;
    const extra = clipped ? `: ${clipped}` : "";
    return `- [${where}${m.pinned ? ", закреплено" : ""}] ${head} (${m.kind}, id ${m.id})${extra}`;
  });
  return [
    "Память команды (то, что уже известно; записи владельца важнее твоих). Тела — по запросу: taskflow_recall mode=detail и ids.",
    ...lines,
    "Устарело или неверно — поправь своей записью (taskflow_remember); новое устойчивое знание — запомни.",
  ].join("\n");
}
