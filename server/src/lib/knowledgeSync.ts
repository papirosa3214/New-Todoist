// Документация проектов → база знаний (RAGFlow) — внутри сервера (владелец
// 01.10.2026). Раньше это делал внешний ~/kb/taskflow_docs_ragflow_sync.py:
// он читал заметки через API ключом TASKFLOW_AGENT_TOKEN, ключ сняли 27.09,
// и выгрузка молча падала 401 — в infra-panel её не было, никто не заметил.
// Здесь та же логика без ключей: заметки берутся прямо из базы.
//
// Совместимость со старым скриптом — нарочно полная: то же имя документа
// (`taskflow-<id>.md`), та же YAML-шапка, тот же «хэш смысла»
// (~/kb/kb_content_hash.py: служебные поля шапки в хэш не входят), тот же
// файл состояния по формату. При первом запуске состояние перенимается из
// ~/kb/taskflow-docs-ragflow-sync.json — неизменившиеся заметки не
// перезаливаются.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../db.js";
import { tiptapToMarkdown } from "./tiptapToMarkdown.js";

export const KB_ALGO = "content-v1";
const PREFIX = "taskflow-";
const UPLOAD_BATCH = 10;
const PARSE_BATCH = 20;
/** Суточный прогон — не раньше этого часа по местному времени. */
const DAILY_AT = { hour: 6, minute: 20 };

const ragflowApi = () => process.env.RAGFLOW_API || "http://127.0.0.1:9380";
const ragflowToken = () => process.env.RAGFLOW_TOKEN || "";
export const defaultDataset = () => process.env.RAGFLOW_TASKFLOW_DATASET || "";

export async function ragflow(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(ragflowApi() + pathname, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(120_000),
    headers: {
      Authorization: "Bearer " + ragflowToken(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`RAGFlow ответил ${res.status}`);
  return res.json();
}

// ── Хэш смысла (порт ~/kb/kb_content_hash.py, ALGO content-v1) ──────────

const BOOKKEEPING_KEYS = new Set([
  "created", "created_at", "updated", "updated_at", "modified", "modified_at",
  "synced", "synced_at", "last_synced", "indexed", "indexed_at",
  "id", "uuid", "hash", "checksum", "mtime", "revision", "version",
  "verified", "verified_at", "checked", "checked_at",
]);

function splitFrontmatter(text: string): [string[], string] {
  if (!text.startsWith("---")) return [[], text];
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return [[], text];
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") return [lines.slice(1, i), lines.slice(i + 1).join("\n")];
  }
  return [[], text];
}

function stripBookkeeping(lines: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const stripped = line.replace(/^\s+/, "");
    const indented = line.length !== stripped.length;
    if (indented || !stripped) {
      if (!skipping) out.push(line);
      continue;
    }
    skipping = false;
    if (stripped.includes(":")) {
      const key = stripped.split(":", 1)[0].trim().replace(/^["']+|["']+$/g, "").toLowerCase();
      if (BOOKKEEPING_KEYS.has(key)) {
        skipping = true;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/** sha1 значимого содержания: шапка без служебных ключей + тело. */
export function contentSha(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const [fm, body] = splitFrontmatter(normalized);
  const significant = stripBookkeeping(fm).join("\n").trim();
  const cleanBody = body.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();
  const payload = significant ? `${significant}\n\n${cleanBody}` : cleanBody;
  return crypto.createHash("sha1").update(payload, "utf8").digest("hex");
}

// ── Документ из заметки ─────────────────────────────────────────────────

function yamlScalar(value: string | null | undefined): string {
  const s = (value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').split(/\s+/).filter(Boolean).join(" ");
  return `"${s}"`;
}

type NoteRow = {
  id: string; title: string | null; content: string; created_at: string; updated_at: string;
  folder_name: string | null; project_name: string | null; dataset_id: string | null;
};

const NOTE_SQL = `
  SELECT un.id, un.title, un.content, un.created_at, un.updated_at, jf.name AS folder_name,
         (SELECT p.name FROM projects p WHERE p.notes_folder_id = un.folder_id ORDER BY p.created_at LIMIT 1) AS project_name,
         (SELECT p.knowledge_dataset_id FROM projects p WHERE p.notes_folder_id = un.folder_id ORDER BY p.created_at LIMIT 1) AS dataset_id
    FROM user_notes un LEFT JOIN journal_folders jf ON jf.id = un.folder_id`;

export type KnowledgeDocument = { name: string; dataset: string; text: string };

/** Документ индекса из строки заметки; пустая заметка — null (индексу бесполезна). */
function documentOf(row: NoteRow): KnowledgeDocument | null {
  const body = tiptapToMarkdown(row.content).trim();
  if (!body) return null;
  const title = (row.title ?? "").trim() || "без названия";
  let text = [
    "---",
    "source: taskflow",
    `doc_id: ${yamlScalar(row.id)}`,
    `title: ${yamlScalar(title)}`,
    `project: ${yamlScalar(row.project_name || "(вне проекта)")}`,
    `folder: ${yamlScalar(row.folder_name || "(без папки)")}`,
    `created_at: ${yamlScalar(row.created_at)}`,
    `updated_at: ${yamlScalar(row.updated_at)}`,
    "---",
    "",
  ].join("\n");
  if (!body.startsWith("# ")) text += `# ${title}\n\n`;
  text += body + "\n";
  return { name: `${PREFIX}${row.id}.md`, dataset: (row.dataset_id ?? "").trim() || defaultDataset(), text };
}

export function noteDocument(noteId: string): KnowledgeDocument | null {
  const row = db.prepare(`${NOTE_SQL} WHERE un.id = ?`).get(noteId) as NoteRow | undefined;
  if (!row) throw new Error("Заметка не найдена");
  return documentOf(row);
}

function allDocuments(): Map<string, KnowledgeDocument> {
  const out = new Map<string, KnowledgeDocument>();
  for (const row of db.prepare(NOTE_SQL).all() as NoteRow[]) {
    const doc = documentOf(row);
    if (doc) out.set(doc.name, doc);
  }
  return out;
}

// ── Состояние ────────────────────────────────────────────────────────────

function stateDir(): string {
  return process.env.TASKFLOW_KB_SYNC_DIR || path.join(os.homedir(), ".local", "state", "taskflow-docs-sync");
}
const statePath = () => path.join(stateDir(), "state.json");
const heartbeatPath = () => path.join(stateDir(), "last-run.json");
const legacyStatePath = () => process.env.TASKFLOW_KB_SYNC_LEGACY_STATE || path.join(os.homedir(), "kb", "taskflow-docs-ragflow-sync.json");

type SyncState = Record<string, string>;

function loadState(): SyncState {
  for (const file of [statePath(), legacyStatePath()]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
    } catch {
      // нет файла — пробуем следующий
    }
  }
  return {};
}

function saveState(state: SyncState): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = statePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 0));
  fs.renameSync(tmp, statePath());
}

const markOf = (doc: KnowledgeDocument) => `${contentSha(doc.text)}@${doc.dataset}`;

/** Кнопка «В базу знаний» залила документ сама — синк не должен заливать его повторно. */
export function rememberUploaded(doc: KnowledgeDocument): void {
  const state = loadState();
  state[doc.name] = markOf(doc);
  state.__algo = KB_ALGO;
  saveState(state);
}

// ── RAGFlow ──────────────────────────────────────────────────────────────

async function existingDocs(dataset: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; ; page++) {
    const d = await ragflow(`/api/v1/datasets/${dataset}/documents?page=${page}&page_size=200`);
    const docs = ((d?.data?.docs ?? []) as Array<{ id: string; name: string }>);
    for (const x of docs) if (x.name?.startsWith(PREFIX)) out.set(x.name, x.id);
    if (docs.length < 200) break;
  }
  return out;
}

export async function deleteDocs(dataset: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    await ragflow(`/api/v1/datasets/${dataset}/documents`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + 100) }),
    });
  }
}

export async function uploadDocs(dataset: string, docs: KnowledgeDocument[]): Promise<string[]> {
  const form = new FormData();
  for (const doc of docs) form.append("file", new Blob([doc.text], { type: "text/markdown" }), doc.name);
  const uploaded = await ragflow(`/api/v1/datasets/${dataset}/documents`, { method: "POST", body: form });
  const ids = ((uploaded?.data ?? []) as Array<{ id: string }>).map((d) => d.id);
  for (let i = 0; i < ids.length; i += PARSE_BATCH) {
    await ragflow(`/api/v1/datasets/${dataset}/chunks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: ids.slice(i, i + PARSE_BATCH) }),
    });
  }
  return ids;
}

// ── Прогон ───────────────────────────────────────────────────────────────

export type SyncReport = { documents: number; uploaded: number; deleted: number };

/** Тот же план, что у старого скрипта: залить новое/изменившееся/переехавшее,
 *  удалить своё, чего в TaskFlow больше нет, и копии в прежнем датасете. */
export async function runKnowledgeSync(opts: { full?: boolean } = {}): Promise<SyncReport> {
  if (!ragflowToken() || !defaultDataset()) throw new Error("База знаний не настроена (RAGFLOW_TOKEN / RAGFLOW_TASKFLOW_DATASET)");
  const desired = allDocuments();
  const prev = loadState();
  const state: SyncState = opts.full ? {} : { ...prev };
  const cur = new Map([...desired].map(([name, doc]) => [name, markOf(doc)]));

  const datasets = new Set<string>([...desired.values()].map((d) => d.dataset));
  for (const value of Object.values(prev)) if (value.includes("@")) datasets.add(value.slice(value.lastIndexOf("@") + 1));
  datasets.add(defaultDataset());
  const existing = new Map<string, Map<string, string>>();
  for (const ds of [...datasets].sort()) existing.set(ds, await existingDocs(ds));
  const owned = new Set(Object.keys(prev).filter((n) => n !== "__algo"));

  const plannedUpload: KnowledgeDocument[] = [];
  for (const name of [...desired.keys()].sort()) {
    const doc = desired.get(name)!;
    const already = existing.get(doc.dataset)?.has(name) ?? false;
    if (opts.full || !already || state[name] !== cur.get(name)) plannedUpload.push(doc);
  }
  const plannedDelete: Array<{ dataset: string; name: string; id: string }> = [];
  for (const [dataset, docs] of existing) {
    for (const [name, id] of docs) {
      if (!owned.has(name)) continue; // не наше — не трогаем
      const want = desired.get(name);
      if (!want || want.dataset !== dataset) plannedDelete.push({ dataset, name, id });
    }
  }

  let deleted = 0;
  for (const dataset of new Set(plannedDelete.map((d) => d.dataset))) {
    const ids = plannedDelete.filter((d) => d.dataset === dataset).map((d) => d.id);
    await deleteDocs(dataset, ids);
    deleted += ids.length;
  }
  for (const d of plannedDelete) if (!desired.has(d.name)) delete state[d.name];

  let uploaded = 0;
  for (const dataset of new Set(plannedUpload.map((d) => d.dataset))) {
    const items = plannedUpload.filter((d) => d.dataset === dataset);
    for (let i = 0; i < items.length; i += UPLOAD_BATCH) {
      const batch = items.slice(i, i + UPLOAD_BATCH);
      // Заново залитый документ заменяет прежнюю копию — иначе поиск двоит.
      const dup = batch.map((d) => existing.get(dataset)?.get(d.name)).filter((x): x is string => Boolean(x));
      if (dup.length) await deleteDocs(dataset, dup);
      uploaded += (await uploadDocs(dataset, batch)).length;
      for (const d of batch) state[d.name] = cur.get(d.name)!;
      state.__algo = KB_ALGO;
      saveState(state); // после каждого батча: обрыв не заставит лить всё заново
    }
  }
  state.__algo = KB_ALGO;
  saveState(state);
  return { documents: desired.size, uploaded, deleted };
}

// ── Раз в сутки + отметка живости + сигнал о сбое ───────────────────────

type Heartbeat = { at: string; at_epoch: number; ok: boolean; error?: string } & Partial<SyncReport>;

function readHeartbeat(): Heartbeat | null {
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath(), "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

function writeHeartbeat(hb: Heartbeat): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(heartbeatPath(), JSON.stringify(hb));
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Пора ли суточный прогон: после 06:20 и сегодня ещё не было удачного. */
export function isSyncDue(now: Date, last: Heartbeat | null): boolean {
  const after = now.getHours() > DAILY_AT.hour || (now.getHours() === DAILY_AT.hour && now.getMinutes() >= DAILY_AT.minute);
  if (!after) return false;
  if (!last?.ok) return !last || now.getTime() - last.at_epoch >= 60 * 60 * 1000; // сбой — повтор через час
  return localDay(new Date(last.at_epoch)) !== localDay(now);
}

function notifyOwner(text: string): void {
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' AND COALESCE(archived, 0) = 0 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (!owner) return;
  db.prepare("INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'kb_sync', NULL, ?, NULL)")
    .run(crypto.randomUUID(), owner.id, text);
}

let running = false;

/** Один прогон с отметкой живости; о НОВОМ сбое — уведомление владельцу. */
export async function runKnowledgeSyncWithHeartbeat(): Promise<Heartbeat> {
  if (running) return readHeartbeat() ?? { at: new Date().toISOString(), at_epoch: Date.now(), ok: false, error: "уже идёт" };
  running = true;
  const previous = readHeartbeat();
  try {
    const report = await runKnowledgeSync();
    const hb: Heartbeat = { at: new Date().toISOString(), at_epoch: Date.now(), ok: true, ...report };
    writeHeartbeat(hb);
    return hb;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hb: Heartbeat = { at: new Date().toISOString(), at_epoch: Date.now(), ok: false, error: message };
    writeHeartbeat(hb);
    if (previous?.ok !== false) {
      try {
        notifyOwner(`Выгрузка документации в базу знаний не удалась: ${message}`);
      } catch (err) {
        console.warn("[kb-sync] уведомление не записано:", err);
      }
    }
    return hb;
  } finally {
    running = false;
  }
}

/** Проверка каждые 10 минут; сам прогон — раз в сутки после 06:20. */
export function startKnowledgeSyncSchedule(): () => void {
  const tick = () => {
    if (!isSyncDue(new Date(), readHeartbeat())) return;
    void runKnowledgeSyncWithHeartbeat().then((hb) =>
      console.log(hb.ok ? `[kb-sync] залито ${hb.uploaded}, удалено ${hb.deleted} из ${hb.documents}` : `[kb-sync] сбой: ${hb.error}`),
    );
  };
  const timer = setInterval(tick, 10 * 60 * 1000);
  setTimeout(tick, 60 * 1000);
  return () => clearInterval(timer);
}
