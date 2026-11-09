// Клиент RAGFlow (09.11.2026). Вынесен из `routes/knowledge.ts`, потому что
// ручек стало много: витрина датасетов, документы, загрузка, разбор, вопрос к
// базе, поиск для ролей. Им нужен один и тот же набор вызовов, а дублировать
// авторизацию и разбор ошибок в каждом месте — верный способ разойтись.
//
// ⚠️ Читать `process.env` на уровне модуля здесь НЕЛЬЗЯ: `loadEnvFile()`
// (env.ts) вызывается из `main()`, то есть ПОЗЖЕ выполнения импортов, и
// константы успели бы застыть пустыми — ручки отвечали бы «не настроено» при
// полностью заполненном `.env` (проверено 08.09.2026).

export const ragflowApi = () => process.env.RAGFLOW_API || "http://127.0.0.1:9380";
export const ragflowDataset = () => process.env.RAGFLOW_TASKFLOW_DATASET || "";
export const ragflowToken = () => process.env.RAGFLOW_TOKEN || "";

/** Настроена ли связь с RAGFlow: без ключа ходить туда бессмысленно. */
export const isConfigured = () => Boolean(ragflowToken() && ragflowDataset());

/** Поля YAML-шапки, которую кладёт синк: проект, заголовок, doc_id заметки. */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/.exec(text || "");
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
  }
  return out;
}

/** Имя документа в датасете — `taskflow-<note_id>.md` (см. PREFIX в синке). */
export function docIdFromName(name: string): string | null {
  const m = /^taskflow-(.+)\.md$/.exec(name || "");
  return m ? m[1] : null;
}

/** Общий вызов: JSON на входе-выходе, не-200 — исключение с кодом в тексте. */
export async function ragflow(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(ragflowApi() + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + ragflowToken(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`RAGFlow ответил ${res.status}`);
  return res.json();
}

export interface RagflowDataset {
  id: string;
  name: string;
  document_count?: number;
  chunk_count?: number;
  update_date?: string;
  [key: string]: unknown;
}

/** Все датасеты аккаунта. Больше сотни на этой машине не будет. */
export async function listDatasets(): Promise<RagflowDataset[]> {
  const data = await ragflow("/api/v1/datasets?page=1&page_size=100");
  return ((data?.data ?? []) as RagflowDataset[]).slice();
}

export async function listDocuments(
  datasetId: string,
  page = 1,
  pageSize = 50,
): Promise<{ docs: any[]; total: number }> {
  const data = await ragflow(
    `/api/v1/datasets/${datasetId}/documents?page=${page}&page_size=${pageSize}`,
  );
  return { docs: data?.data?.docs ?? [], total: data?.data?.total ?? 0 };
}

/**
 * Загрузка файла. RAGFlow ждёт multipart с полем `file`; содержимое приходит
 * из приложения сырыми байтами, поэтому имя передаём отдельно.
 */
export async function uploadDocument(
  datasetId: string,
  name: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<{ id: string | null; name: string }> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), name);
  const res = await fetch(`${ragflowApi()}/api/v1/datasets/${datasetId}/documents`, {
    method: "POST",
    headers: { Authorization: "Bearer " + ragflowToken() },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data?.code && data.code !== 0)) {
    throw new Error(data?.message || `RAGFlow ответил ${res.status}`);
  }
  const docs = data?.data ?? [];
  const first = Array.isArray(docs) ? docs[0] : docs;
  return { id: first?.id ?? null, name: first?.name ?? name };
}

/** Удаление документов датасета пачкой (RAGFlow принимает до 100 id). */
export async function deleteDocuments(datasetId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ragflow(`/api/v1/datasets/${datasetId}/documents`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

/** Разбор загруженного документа — без него кусков не будет и поиск его не увидит. */
export async function parseDocuments(datasetId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ragflow(`/api/v1/datasets/${datasetId}/documents/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: ids }),
  });
}

export interface DocumentStatus {
  id: string;
  name: string;
  /** `UNSTART` / `RUNNING` / `DONE` / `FAIL` — как их называет RAGFlow. */
  run: string;
  progress: number;
  message: string;
  chunk_count: number;
}

export async function documentStatus(
  datasetId: string,
  documentId: string,
): Promise<DocumentStatus> {
  const data = await ragflow(`/api/v1/datasets/${datasetId}/documents/${documentId}`);
  const doc = data?.data ?? {};
  return {
    id: doc.id ?? documentId,
    name: doc.name ?? "",
    run: doc.run ?? "UNSTART",
    progress: Number(doc.progress ?? 0),
    message: doc.progress_msg ?? "",
    chunk_count: Number(doc.chunk_count ?? 0),
  };
}

/** Документ целиком — оригинальный markdown с шапкой, как его залил синк. */
export async function documentText(datasetId: string, documentId: string): Promise<string | null> {
  const res = await fetch(`${ragflowApi()}/api/v1/datasets/${datasetId}/documents/${documentId}`, {
    headers: { Authorization: "Bearer " + ragflowToken() },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`RAGFlow ответил ${res.status}`);
  return res.text();
}

export async function retrieval(body: Record<string, unknown>): Promise<{
  chunks: any[];
  docAggs: any[];
}> {
  const data = await ragflow("/api/v1/retrieval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { chunks: data?.data?.chunks ?? [], docAggs: data?.data?.doc_aggs ?? [] };
}
