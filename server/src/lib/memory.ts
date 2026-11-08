import { randomUUID } from "node:crypto";
import { queryTopics, reindexTopicOf, topicMatches } from "./memoryTopics.js";
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
import { banksFor, forgetIds, recallAcrossBanks, writeRecord } from "./memoryBanks.js";
export { toFtsQuery } from "./ftsQuery.js";
import { startObservation, finishObservation, withObservationContext } from "./contextObservability.js";
import type { ContextItem } from "./contextObservability.js";
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
      purpose: "memory",
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
/** Связать локальную запись с частями, записанными в банк Mnemosyne. */
function linkMnemo(memoryId: string, bank: string, ids: string[]): void {
  if (!ids.length) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO memory_mnemo_ids (memory_id, bank, mnemo_id, chunk_no) VALUES (?, ?, ?, ?)`,
  );
  ids.forEach((mnemoId, i) => stmt.run(memoryId, bank, mnemoId, i));
}

/** Части записи в банке: банк и id (по порядку). */
export function mnemoIdsOf(memoryId: string): { bank: string; ids: string[] } {
  const rows = db
    .prepare(`SELECT bank, mnemo_id FROM memory_mnemo_ids WHERE memory_id = ? ORDER BY chunk_no`)
    .all(memoryId) as Array<{ bank: string; mnemo_id: string }>;
  return { bank: rows[0]?.bank ?? "", ids: rows.map((r) => r.mnemo_id) };
}

/** Записать тело в банк Mnemosyne; при неудаче — понятная ошибка, а не тихий успех. */
async function writeToBank(input: {
  memoryId: string;
  text: string;
  title: string | null;
  scope: "team" | "role" | "project";
  roleKey: string | null;
  projectId: string | null;
  kind: MemoryKind;
  importance?: number;
}): Promise<void> {
  let written;
  try {
    written = await writeRecord({
      text: input.text,
      title: input.title,
      scope: input.scope,
      roleKey: input.roleKey,
      projectId: input.projectId,
      kind: input.kind,
      importance: input.importance,
      memoryId: input.memoryId,
      isUsed: (mnemoId, bank) =>
        Boolean(
          db
            .prepare(`SELECT 1 FROM memory_mnemo_ids WHERE bank = ? AND mnemo_id = ? AND memory_id <> ?`)
            .get(bank, mnemoId, input.memoryId),
        ),
    });
  } catch (err) {
    throw new MemoryError(
      `память Mnemosyne недоступна: запись не сохранена (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  linkMnemo(input.memoryId, written.bank, written.ids);
}

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
  const id = uid();
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
      reindexTopicOf(best.id, title, text);
      const previous = db
        .prepare(`SELECT bank, mnemo_id FROM memory_mnemo_ids WHERE memory_id = ?`)
        .all(best.id) as Array<{ bank: string; mnemo_id: string }>;
      await writeToBank({
        memoryId: best.id,
        text,
        title,
        scope: where.scope,
        roleKey: where.role_key ?? null,
        projectId: where.project_id ?? null,
        kind,
      });
      // Прежнюю редакцию убираем только после удачной записи новой, и только
      // если её не использует другая память.
      queueForget(previous.map((row) => ({ bank: row.bank, mnemoId: row.mnemo_id })));
      await drainForgetQueue();
      return { memory: getMemory(best.id)!, updated: true };
    }
  }

  const localId = id;
  await writeToBank({
    memoryId: localId,
    text,
    title,
    scope: where.scope,
    roleKey: where.role_key ?? null,
    projectId: where.project_id ?? null,
    kind,
    importance: input.pinned === true ? 0.9 : undefined,
  });
  db.prepare(
    `INSERT INTO memories (id, scope, role_key, project_id, kind, title, text, source_kind, source_ref, created_by, updated_by, pinned, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    localId,
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
  reindexTopicOf(localId, title, text);
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
  const fresh = getMemory(id)!;
  if (fresh.kind !== "file") reindexTopicOf(id, fresh.title, fresh.text);
  if (fresh.kind !== "file") {
    // Старые связи снимаем только после того, как новые части записаны:
    // иначе сбой службы оставляет запись без тела и без выдачи.
    const links = mnemoIdsOf(id);
    db.prepare(`DELETE FROM memory_mnemo_ids WHERE memory_id = ?`).run(id);
    await writeToBank({
      memoryId: id,
      text: fresh.text,
      title: fresh.title,
      scope: fresh.scope as "team" | "role" | "project",
      roleKey: fresh.role_key,
      projectId: fresh.project_id,
      kind: fresh.kind,
    });
    queueForget(links.ids.map((mnemoId) => ({ bank: links.bank, mnemoId })));
    await drainForgetQueue();
  }
  return fresh;
}

export function deleteMemory(id: string, author: Author): void {
  const current = getMemory(id);
  if (!current) throw new MemoryError("запись не найдена", 404);
  if (author.kind === "role" && current.created_by !== author.id) {
    throw new MemoryError("роль удаляет только свои записи", 403);
  }
  const links = mnemoIdsOf(id);
  queueForget(links.ids.map((mnemoId) => ({ bank: links.bank, mnemoId })));
  db.prepare(`DELETE FROM memory_mnemo_ids WHERE memory_id = ?`).run(id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  db.prepare("DELETE FROM memory_topics WHERE memory_id = ?").run(id);
  // Мгновенная попытка, а если служба недоступна — очередь доделает позже.
  void drainForgetQueue();
}

/**
 * Забывание в банке через очередь: удаление и правка записи не должны терять
 * тело в Mnemosyne, если служба в этот момент недоступна (перезапуск, таймаут).
 */
function queueForget(items: Array<{ bank: string; mnemoId: string }>): void {
  if (!items.length) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO memory_forget_queue (bank, mnemo_id) VALUES (?, ?)`,
  );
  for (const item of items) stmt.run(item.bank, item.mnemoId);
}

/** Доделать забывание: вызывается после удаления/правки и раз в час сторожем. */
export async function drainForgetQueue(limit = 50): Promise<number> {
  const rows = db
    .prepare(`SELECT id, bank, mnemo_id, attempts FROM memory_forget_queue ORDER BY id LIMIT ?`)
    .all(limit) as Array<{ id: number; bank: string; mnemo_id: string; attempts: number }>;
  if (!rows.length) return 0;
  const shared = db.prepare(
    `SELECT 1 FROM memory_mnemo_ids WHERE bank = ? AND mnemo_id = ? LIMIT 1`,
  );
  const drop = db.prepare(`DELETE FROM memory_forget_queue WHERE id = ?`);
  const bump = db.prepare(`UPDATE memory_forget_queue SET attempts = attempts + 1 WHERE id = ?`);
  let done = 0;
  for (const row of rows) {
    if (shared.get(row.bank, row.mnemo_id)) {
      // Часть ещё нужна другой записи — просто снимаем задание.
      drop.run(row.id);
      continue;
    }
    try {
      await forgetIds(row.bank, [row.mnemo_id]);
      drop.run(row.id);
      done += 1;
    } catch {
      bump.run(row.id);
    }
  }
  return done;
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

  // Поиск — в Mnemosyne (владелец 08.11.2026). Банки держат приватность:
  // команда, своя роль, проект задачи. Локальная таблица хранит только
  // связь с частями записи и признаки (закрепление, кто записал).
  const banks = banksFor({ roleKey: args.roleKey });
  // Пустой запрос не ищет в банке: Mnemosyne вернул бы «свежее», а это не
  // ответ на вопрос роли.
  const found = query.trim() ? await recallAcrossBanks({ banks, query, limit }) : [];
  if (!found.length && !query) {
    finishObservation(memoryObservation, { status: "skipped", reason: "empty" });
    return [];
  }
  const linkOf = db.prepare(`SELECT memory_id FROM memory_mnemo_ids WHERE bank = ? AND mnemo_id = ?`);
  const pinnedRows = db
    .prepare(`SELECT m.id, m.kind, m.scope, m.title, m.text, m.pinned, m.source_kind, u.name AS author_name
                FROM memories m LEFT JOIN users u ON u.id = m.created_by
               WHERE ${vis.sql} AND m.pinned = 1 AND m.kind <> 'file' LIMIT 8`)
    .all(...vis.args) as Array<{
    id: string;
    kind: MemoryKind;
    scope: "team" | "role" | "project";
    title: string | null;
    text: string;
    pinned: number;
    source_kind: "owner" | "role";
    author_name: string | null;
  }>;
  if (!found.length && !pinnedRows.length) {
    finishObservation(memoryObservation, { status: "skipped", reason: "empty" });
    return [];
  }

  // Гейт релевантности: Mnemosyne отдаёт «похожее» даже когда совпадений нет
  // (score — это RRF-позиция, а не близость), поэтому хит без слова вопроса
  // памятью не считается.
  const gateWords = query
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4)
    .slice(0, 8);
  const hitIsRelevant = (content: string): boolean => {
    if (!gateWords.length) return false;
    const body = content.toLowerCase().replace(/ё/g, "е");
    return gateWords.some((word) => body.includes(word));
  };

  const items: RecallItem[] = [];
  const takenLocal = new Set<string>();
  for (const hit of found) {
    if (!hitIsRelevant(String(hit.content ?? ""))) continue;
    const link = linkOf.get(hit.bank, hit.id) as { memory_id: string } | undefined;
    const score = hit.score ?? 0;
    if (link) {
      const [item] = loadRecallItems(vis, [link.memory_id], mode);
      if (item && !takenLocal.has(item.id)) {
        takenLocal.add(item.id);
        item.score = Math.max(score, item.score);
        items.push(item);
      }
      continue;
    }
    // Без локальной строки запись не отдаём: значит локальную запись удалили,
    // а части в банке остались. Такие хвосты чистит уборка, а не пользователь.
  }

  // Файлы памяти живут кусками локально (в банк их не кладём: там предел
  // записи), поэтому ищем их по кускам отдельно.
  // Для кусков файлов берём слова вопроса напрямую: в запросе бывает
  // двоеточие и прочая пунктуация, на которой MATCH отказывается работать.
  const matchText = query
    ? query
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4)
        .slice(0, 6)
        .map((word) => `"${word}"`)
        .join(" OR ") || null
    : null;
  if (matchText) {
    // Имя таблицы, а не псевдоним: FTS5 на `f MATCH ?` отвечает «no such column».
    const fileIds = (() => {
      try {
        const rows = db
          .prepare(
            `SELECT m.id AS id
               FROM memory_chunks_fts
               JOIN memory_chunks c ON c.rowid = memory_chunks_fts.rowid
               JOIN memories m ON m.id = c.memory_id
              WHERE memory_chunks_fts MATCH ? AND ${vis.sql}
              ORDER BY bm25(memory_chunks_fts)
              LIMIT 4`,
          )
          .all(matchText, ...vis.args) as Array<{ id: string }>;
        return rows.map((row) => row.id);
      } catch {
        return [];
      }
    })().filter((id) => !takenLocal.has(id));
    for (const item of loadRecallItems(vis, fileIds, mode)) {
      if (takenLocal.has(item.id)) continue;
      takenLocal.add(item.id);
      items.push(item);
    }
  }
  for (const row of pinnedRows) {
    if (takenLocal.has(row.id)) continue;
    takenLocal.add(row.id);
    items.push({
      id: row.id,
      kind: row.kind,
      scope: row.scope,
      title: row.title,
      text: row.text,
      score: 1,
      pinned: true,
      source: row.source_kind,
      author: row.author_name,
    });
  }

  // Позиция в выдаче Mnemosyne — это RRF (1/(60+rank)), разброс в пределах
  // тысячных, поэтому бонус владельца не прибавляем к score, а держим
  // отдельным ключом сортировки.
  items.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.source === "owner") - Number(a.source === "owner") ||
      b.score - a.score,
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
  if (countUsage && picked.length) bumpUse([...new Set(picked.map((p) => p.id).filter((id) => !id.startsWith("mnemo:")))]);
  finishObservation(memoryObservation,{status:picked.length?"ok":"skipped",reason:picked.length?undefined:"empty",inputCount:items.length,outputCount:picked.length,details:picked.map(p=>p.title??p.id),items:contextItems(picked)});
  return picked;
  } catch(error) {
    finishObservation(memoryObservation,{status:"error",reason:"source_unavailable"});
    throw error;
  }
}

/** Записи для журнала контекста: откуда каждая и сколько весит. */
function contextItems(picked: RecallItem[]): ContextItem[] {
  const scopes = db.prepare("SELECT scope FROM memories WHERE id = ?");
  return picked.map((item) => {
    const text = String((item as { text?: unknown }).text ?? "");
    const scope = (scopes.get(item.id) as { scope?: string } | undefined)?.scope ?? item.scope ?? "team";
    return { title: item.title ?? item.id, source: scope, chars: text.length, excerpt: text.slice(0, 400) };
  });
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

interface HintRow {
  id: string;
  title: string | null;
  text: string;
  scope: string;
  pinned: number;
}

/**
 * Подсказка «эта тема уже записана» (владелец 08.11.2026).
 *
 * Считается детерминированно: темы вопроса сравниваются с темами записей
 * (см. lib/memoryTopics.ts), никакой модели и никакой семантики. Подсказка
 * нарочно короткая — роль должна пойти в память за телом, а не прочитать
 * его в подсказке.
 */
export function memoryTopicHint(args: {
  roleKey: string | null;
  projectId?: string | null;
  query: string;
  chatId?: string | null;
  taskId?: string | null;
}): string {
  const topics = queryTopics(args.query ?? "");
  if (topics.length < 2) return "";
  let matched: Array<{ memory_id: string; score: number; hits?: number; strong?: number }>;
  try {
    matched = topicMatches(topics, 12) as Array<{ memory_id: string; score: number; hits?: number; strong?: number }>;
  } catch {
    return "";
  }
  if (!matched.length) return "";
  // Совпадения по 5-символьным основам дают сотни записей на любой запрос
  // («прове», «правк»), поэтому подсказку получает только запись, где
  // совпало слово из заголовка (strong) либо не меньше трёх тем.
  const strong = matched.filter((row) => (row.strong ?? 0) > 0);
  matched = strong.length ? strong : matched.filter((row) => (row.hits ?? 0) >= 3);
  if (!matched.length) return "";
  const vis = visibleWhere(args.roleKey, args.projectId ?? null);
  const placeholders = matched.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.title AS title, m.text AS text, m.scope AS scope, m.pinned AS pinned
         FROM memories m
        WHERE ${vis.sql} AND m.id IN (${placeholders})`,
    )
    .all(...vis.args, ...matched.map((m) => m.memory_id)) as HintRow[];
  if (!rows.length) return "";
  const order = new Map(matched.map((m, i) => [m.memory_id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const picked = rows.slice(0, 3);
  const names = picked.map((row) => {
    const head = row.title?.trim() || row.text.replace(/\s+/g, " ").trim().slice(0, 60);
    const where = row.scope === "role" ? "твоё" : row.scope === "project" ? "проект" : "общее";
    return `«${head}» (${where}${row.pinned ? ", закреплено" : ""}, id ${row.id})`;
  });
  const matchedTopics = topics.slice(0, 5).join(", ");
  db.prepare(
    `INSERT INTO memory_hint_log (id, role_key, chat_id, task_id, query_text, matched_topics, hit_count, memory_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    args.roleKey,
    args.chatId ?? null,
    args.taskId ?? null,
    (args.query ?? "").slice(0, 500),
    matchedTopics,
    picked.length,
    picked.map((row) => row.id).join(","),
  );
  return [
    `Подсказка по памяти: темы «${matchedTopics}» уже записаны — ${picked.length === 1 ? "запись" : "записи"} ${names.join("; ")}.`,
    "Прежде чем решать заново, посмотри их: taskflow_recall с mode=detail по этим id (или запрос по теме).",
  ].join("\n");
}
