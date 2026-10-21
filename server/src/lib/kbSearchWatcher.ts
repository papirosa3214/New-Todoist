// Сторож поиска по базе знаний (`/api/knowledge/search`, `taskflow_kb_search`).
//
// Зачем (21.10.2026). Роли обязаны сначала искать в базе знаний («гейт
// незнания»). Поиск сломался тихо: у датасета TaskFlow в RAGFlow указатель
// модели эмбеддинга (`tenant_embd_id`) смотрел на старую nomic-embed (768),
// а чанки проиндексированы bge-m3 (1024). RAGFlow отвечал «No chunk found»,
// TaskFlow отдавал пустую выдачу — и роли решали, что знаний нет.
//
// Проба — настоящий запрос retrieval с известным ответом: заметка
// `KB_SEARCH_PROBE_DOC` обязана быть в выдаче на `KB_SEARCH_PROBE_QUERY`.
// Не «RAGFlow отвечает»: при поломке он отвечает, только пусто.
// Сломалось — уведомление в «Состояние системы», не чаще раза в сутки.

import crypto from "node:crypto";

import db from "../db.js";

export const KB_SEARCH_WATCH_TYPE = "kb_search_watch";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 90_000; // эмбеддинг вопроса может ждать холодную Ollama

const probeQuery = () =>
  process.env.KB_SEARCH_PROBE_QUERY ||
  "каналы сообщений для мультиагентских систем";
/** Заметка «Исследование каналов сообщений для мультиагентских систем». */
const probeDoc = () =>
  process.env.KB_SEARCH_PROBE_DOC || "919c1483-adb9-43c7-a077-931a9bebbd50";

export interface KbSearchProbeResult {
  ok: boolean;
  /** Пусто, если поиск не настроен — тогда и тревожить не о чем. */
  reason: string;
  skipped?: boolean;
}

export async function probeKbSearch(
  fetchImpl: typeof fetch = fetch,
): Promise<KbSearchProbeResult> {
  const api = process.env.RAGFLOW_API || "http://127.0.0.1:9380";
  const token = process.env.RAGFLOW_TOKEN || "";
  const dataset = process.env.RAGFLOW_TASKFLOW_DATASET || "";
  if (!token || !dataset) return { ok: true, reason: "", skipped: true };

  let data: any;
  try {
    const res = await fetchImpl(api + "/api/v1/retrieval", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      // Те же параметры, что у /api/knowledge/search.
      body: JSON.stringify({
        question: probeQuery(),
        dataset_ids: [dataset],
        page_size: 8,
        similarity_threshold: 0.15,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `RAGFlow ответил ${res.status}.` };
    data = await res.json();
  } catch (e: any) {
    return {
      ok: false,
      reason: `RAGFlow недоступен: ${String(e?.message || e)}.`,
    };
  }

  if (data?.code !== 0) {
    return {
      ok: false,
      reason:
        `RAGFlow вернул ошибку: ${data?.message || data?.code}. ` +
        "«No chunk found» при живом индексе — сверить tenant_embd_id датасета с моделью, которой он проиндексирован.",
    };
  }
  const chunks: any[] = data?.data?.chunks || [];
  const found = chunks.some((c) =>
    String(c.document_keyword || "").includes(probeDoc()),
  );
  if (found) return { ok: true, reason: "" };
  return {
    ok: false,
    reason: chunks.length
      ? `Известная заметка ${probeDoc().slice(0, 8)} не нашлась на пробный запрос (кусков в выдаче: ${chunks.length}).`
      : "Поиск вернул пустую выдачу на пробный запрос.",
  };
}

/** Уведомление в «Состояние системы» — не чаще одного раза в сутки. */
function alert(reason: string): void {
  const already = db
    .prepare(
      "SELECT 1 FROM notifications WHERE type = ? AND created_at >= datetime('now','-1 day') LIMIT 1",
    )
    .get(KB_SEARCH_WATCH_TYPE);
  if (already) return;
  const owners = db
    .prepare("SELECT id FROM users WHERE role = 'owner'")
    .all() as { id: string }[];
  const text =
    "Поиск по базе знаний не находит известное: роли считают, что знаний нет, и работают на догадках. " +
    reason +
    " Разбор — docs/watchers.md, «Поиск по базе знаний».";
  for (const owner of owners) {
    db.prepare(
      "INSERT INTO notifications (id, user_id, type, text) VALUES (?,?,?,?)",
    ).run(
      crypto.randomUUID(),
      owner.id,
      KB_SEARCH_WATCH_TYPE,
      text.slice(0, 400),
    );
  }
}

export async function checkKbSearch(
  fetchImpl: typeof fetch = fetch,
): Promise<KbSearchProbeResult> {
  const result = await probeKbSearch(fetchImpl);
  if (!result.ok) alert(result.reason);
  return result;
}

export function startKbSearchWatcher(): () => void {
  if (process.env.KB_SEARCH_WATCHER_DISABLED === "1") return () => {};
  const tick = () => void checkKbSearch().catch(() => {});
  // Первая проба — не в момент старта: сервер и Ollama ещё поднимаются.
  const first = setTimeout(tick, 2 * 60 * 1000);
  first.unref();
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
