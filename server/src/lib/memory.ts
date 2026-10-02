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
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const MEMORY_TEXT_MAX = 2_000;
const CHUNK_TARGET = 1_200;
/** Похожая запись в той же области — обновляем её, а не плодим дубль. */
const DUPLICATE_SIMILARITY = 0.92;
/** Ниже этой близости запись в задание не попадает. */
const RECALL_MIN_SIMILARITY = 0.35;

const SCOPES: MemoryScope[] = ["team", "role", "project"];
const KINDS: MemoryKind[] = ["fact", "lesson", "preference", "file"];

const uid = () => crypto.randomUUID();

// ── Эмбеддинги ─────────────────────────────────────────────────────────

async function embed(text: string): Promise<Float32Array | null> {
  try {
    const { getEmbeddings } = await import("./embeddingClient.js");
    const result = await getEmbeddings(text.slice(0, 4_000), { timeoutMs: 8_000 });
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
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hay = text.toLowerCase();
  const hits = words.filter((w) => hay.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
  return hits / words.length;
}

// ── Проверка полей ─────────────────────────────────────────────────────

function clean(text: unknown, max: number): string {
  const t = String(text ?? "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function checkScope(scope: unknown, roleKey: unknown, projectId: unknown): { scope: MemoryScope; role_key: string | null; project_id: string | null } {
  const s = String(scope ?? "team") as MemoryScope;
  if (!SCOPES.includes(s)) throw new MemoryError("scope: team | role | project");
  if (s === "role") {
    const r = clean(roleKey, 64);
    if (!r) throw new MemoryError("для памяти роли нужен role_key");
    return { scope: s, role_key: r, project_id: null };
  }
  if (s === "project") {
    const p = clean(projectId, 64);
    if (!p || !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(p)) throw new MemoryError("нет такого проекта");
    return { scope: s, role_key: null, project_id: p };
  }
  return { scope: "team", role_key: null, project_id: null };
}

// ── Чтение ─────────────────────────────────────────────────────────────

const COLUMNS = `id, scope, role_key, project_id, kind, title, text, source_kind, source_ref, created_by, updated_by,
  pinned, attachment_id, use_count, last_used_at, created_at, updated_at`;

export function getMemory(id: string): (MemoryRow & { chunks: number }) | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
  if (!row) return null;
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE memory_id = ?").get(id) as { n: number };
  return { ...row, chunks: n };
}

/** Список для экрана «Память»: фильтр по области/роли/проекту и словам. */
export function listMemories(filter: { scope?: string; role_key?: string; project_id?: string; q?: string; limit?: number }): MemoryRow[] {
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
    where.push("(text LIKE ? OR title LIKE ?)");
    args.push(`%${filter.q}%`, `%${filter.q}%`);
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
export async function remember(input: WriteInput, author: Author): Promise<{ memory: MemoryRow; updated: boolean }> {
  const text = clean(input.text, MEMORY_TEXT_MAX);
  if (!text) throw new MemoryError("пустая запись: что запомнить?");
  const kind = String(input.kind ?? "fact") as MemoryKind;
  if (!KINDS.includes(kind) || kind === "file") throw new MemoryError("kind: fact | lesson | preference");
  const where = checkScope(input.scope, input.role_key, input.project_id);
  const title = clean(input.title, 200) || null;
  const vec = await embed(title ? `${title}\n${text}` : text);

  if (vec) {
    const near = db
      .prepare(
        `SELECT id, embedding, source_kind FROM memories
          WHERE scope = ? AND COALESCE(role_key,'') = ? AND COALESCE(project_id,'') = ? AND kind <> 'file' AND embedding IS NOT NULL`,
      )
      .all(where.scope, where.role_key ?? "", where.project_id ?? "") as Array<{ id: string; embedding: Buffer; source_kind: string }>;
    let best: { id: string; score: number; source_kind: string } | null = null;
    for (const row of near) {
      const other = fromBlob(row.embedding);
      const score = other ? cosine(vec, other) : 0;
      if (score >= DUPLICATE_SIMILARITY && (!best || score > best.score)) best = { id: row.id, score, source_kind: row.source_kind };
    }
    // Запись владельца роль не перетирает — рядом ляжет своя.
    if (best && !(best.source_kind === "owner" && author.kind === "role")) {
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
    id, where.scope, where.role_key, where.project_id, kind, title, text, author.kind,
    clean(input.source_ref, 100) || null, author.id, author.id, input.pinned === true ? 1 : 0, toBlob(vec),
  );
  return { memory: getMemory(id)!, updated: false };
}

/** Правка записи (владельцем или ролью-автором). */
export async function updateMemory(id: string, input: WriteInput, author: Author): Promise<MemoryRow> {
  const current = getMemory(id);
  if (!current) throw new MemoryError("запись не найдена", 404);
  if (author.kind === "role" && current.created_by !== author.id) {
    throw new MemoryError("роль правит только свои записи; чужие — владелец", 403);
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  let reembed = false;
  if (input.text !== undefined) {
    const text = clean(input.text, current.kind === "file" ? 24_000 : MEMORY_TEXT_MAX);
    if (!text) throw new MemoryError("пустая запись — удалите её, а не стирайте текст");
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
    if (!KINDS.includes(kind) || (kind === "file") !== (current.kind === "file")) throw new MemoryError("kind: fact | lesson | preference");
    sets.push("kind = ?");
    args.push(kind);
  }
  if (input.pinned !== undefined) {
    if (author.kind !== "owner") throw new MemoryError("закрепляет владелец", 403);
    sets.push("pinned = ?");
    args.push(input.pinned === true ? 1 : 0);
  }
  if (input.scope !== undefined || input.role_key !== undefined || input.project_id !== undefined) {
    if (author.kind !== "owner") throw new MemoryError("область памяти меняет владелец", 403);
    const where = checkScope(input.scope ?? current.scope, input.role_key ?? current.role_key, input.project_id ?? current.project_id);
    sets.push("scope = ?", "role_key = ?", "project_id = ?");
    args.push(where.scope, where.role_key, where.project_id);
  }
  if (!sets.length) throw new MemoryError("нечего менять");
  if (reembed && current.kind !== "file") {
    const text = input.text !== undefined ? clean(input.text, MEMORY_TEXT_MAX) : current.text;
    const title = input.title !== undefined ? clean(input.title, 200) : current.title ?? "";
    sets.push("embedding = ?");
    args.push(toBlob(await embed(title ? `${title}\n${text}` : text)));
  }
  sets.push("updated_by = ?", "updated_at = datetime('now')");
  args.push(author.id);
  db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
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
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (p.length > CHUNK_TARGET * 1.5) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < p.length; i += CHUNK_TARGET) chunks.push(p.slice(i, i + CHUNK_TARGET));
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
  input: { scope?: unknown; role_key?: unknown; project_id?: unknown; title: string; text: string; attachment_id: string },
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
    ).run(id, where.scope, where.role_key, where.project_id, clean(input.title, 200), text, author.kind, author.id, author.id, input.attachment_id);
    const insert = db.prepare("INSERT INTO memory_chunks (id, memory_id, idx, text, embedding) VALUES (?, ?, ?, ?, ?)");
    chunks.forEach((chunk, i) => insert.run(uid(), id, i, chunk, toBlob(vectors[i])));
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
}

function visibleWhere(roleKey: string | null, projectId: string | null): { sql: string; args: unknown[] } {
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
export async function recall(args: { roleKey: string | null; projectId?: string | null; query: string; limit?: number }): Promise<RecallItem[]> {
  const limit = Math.min(Math.max(args.limit ?? 6, 1), 20);
  const vis = visibleWhere(args.roleKey, args.projectId ?? null);
  const query = args.query.trim();

  const notes = db
    .prepare(`SELECT m.id, m.kind, m.scope, m.title, m.text, m.pinned, m.source_kind, m.embedding FROM memories m WHERE ${vis.sql} AND m.kind <> 'file'`)
    .all(...vis.args) as Array<{ id: string; kind: MemoryKind; scope: MemoryScope; title: string | null; text: string; pinned: number; source_kind: "owner" | "role"; embedding: Buffer | null }>;
  const chunks = db
    .prepare(
      `SELECT m.id, m.scope, m.title, m.pinned, m.source_kind, c.text, c.embedding FROM memory_chunks c
         JOIN memories m ON m.id = c.memory_id WHERE ${vis.sql}`,
    )
    .all(...vis.args) as Array<{ id: string; scope: MemoryScope; title: string | null; pinned: number; source_kind: "owner" | "role"; text: string; embedding: Buffer | null }>;

  // Помнить нечего — и к модели эмбеддингов не ходим (каждый ход роли).
  if (!notes.length && !chunks.length) return [];
  const hasVectors = notes.some((n) => n.embedding) || chunks.some((c) => c.embedding);
  const qvec = query && hasVectors ? await embed(query) : null;

  const score = (text: string, blob: Buffer | null): number => {
    const vec = fromBlob(blob);
    if (qvec && vec) return cosine(qvec, vec);
    return query ? wordScore(query, text) * 0.6 : 0;
  };

  const items: RecallItem[] = [];
  for (const n of notes) {
    const s = score(`${n.title ?? ""} ${n.text}`, n.embedding);
    if (n.pinned || s >= RECALL_MIN_SIMILARITY) {
      items.push({ id: n.id, kind: n.kind, scope: n.scope, title: n.title, text: n.text, score: s, pinned: Boolean(n.pinned), source: n.source_kind });
    }
  }
  for (const c of chunks) {
    const s = score(c.text, c.embedding);
    if (s >= RECALL_MIN_SIMILARITY) {
      items.push({ id: c.id, kind: "file", scope: c.scope, title: c.title, text: c.text, score: s, pinned: false, source: c.source_kind });
    }
  }
  // Владелец весомее роли; закреплённое — вперёд.
  items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.score + (b.source === "owner" ? 0.05 : 0)) - (a.score + (a.source === "owner" ? 0.05 : 0)));
  const picked: RecallItem[] = [];
  const seenFiles = new Map<string, number>();
  for (const item of items) {
    // Из одного файла — не больше двух кусков, иначе он забьёт всё.
    if (item.kind === "file") {
      const n = seenFiles.get(item.id) ?? 0;
      if (n >= 2) continue;
      seenFiles.set(item.id, n + 1);
    }
    picked.push(item);
    if (picked.length >= limit) break;
  }
  const used = [...new Set(picked.map((p) => p.id))];
  if (used.length) {
    db.prepare(
      `UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id IN (${used.map(() => "?").join(",")})`,
    ).run(...used);
  }
  return picked;
}

/** Блок «что ты помнишь» для задания роли. Пусто — пустая строка. */
export async function memoryBlock(args: { roleKey: string | null; projectId?: string | null; query: string }): Promise<string> {
  let items: RecallItem[];
  try {
    items = await recall({ ...args, limit: 8 });
  } catch {
    return "";
  }
  if (!items.length) return "";
  const lines = items.map((m) => {
    const where = m.scope === "team" ? "общее" : m.scope === "role" ? "твоё" : "проект";
    const head = m.kind === "file" ? `файл «${m.title ?? "без названия"}»` : m.title ? `«${m.title}»` : "";
    const text = m.text.replace(/\s+/g, " ").trim();
    const clipped = text.length > 600 ? `${text.slice(0, 599)}…` : text;
    return `- [${where}${m.pinned ? ", закреплено" : ""}] ${head}${head ? ": " : ""}${clipped}`;
  });
  return [
    "Память команды (то, что уже известно; записи владельца важнее твоих):",
    ...lines,
    "Устарело или неверно — поправь своей записью (taskflow_remember); новое устойчивое знание — запомни.",
  ].join("\n");
}
