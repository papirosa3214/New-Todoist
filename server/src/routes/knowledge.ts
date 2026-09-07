import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";

// База знаний — тонкий прокси к RAGFlow (:9380 на .110), где лежит датасет
// «TaskFlow — документация». Документы туда синкает
// `~/kb/taskflow_docs_ragflow_sync.py` из `user_notes`, markdown'ом с
// YAML-шапкой (project/folder/doc_id/updated_at).
//
// Зачем прокси, а не запрос из клиента напрямую: ключ RAGFlow должен остаться
// на сервере. В телефоне ему делать нечего — приложение показывает витрину и
// ходит сюда с обычным токеном TaskFlow, как во все остальные ручки.
//
// Источник правды — сам TaskFlow (`user_notes`): RAGFlow здесь поисковый
// индекс, его можно снести и залить заново. Поэтому в ответах рядом с куском
// текста всегда едет `doc_id` — по нему клиент открывает НАСТОЯЩУЮ заметку
// (`/api/notes/:id`), а не копию из индекса.
// ⚠️ Читать `process.env` на уровне модуля здесь НЕЛЬЗЯ: `loadEnvFile()`
// (env.ts) вызывается из `main()`, то есть ПОЗЖЕ, чем выполняются импорты, и
// константы модуля успели бы застыть пустыми — ручка отвечала бы «не
// настроено» при полностью заполненном `.env` (проверено 08.09.2026).
const ragflowApi = () => process.env.RAGFLOW_API || "http://127.0.0.1:9380";
const ragflowDataset = () => process.env.RAGFLOW_TASKFLOW_DATASET || "";
const ragflowToken = () => process.env.RAGFLOW_TOKEN || "";

/** Поля YAML-шапки, которую кладёт синк. Нужны, чтобы вернуть клиенту проект
 *  и заголовок, не ходя лишний раз в базу. */
function frontmatter(text: string): Record<string, string> {
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
function docIdFromName(name: string): string | null {
  const m = /^taskflow-(.+)\.md$/.exec(name || "");
  return m ? m[1] : null;
}

async function ragflow(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(ragflowApi() + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + ragflowToken(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    throw new Error(`RAGFlow ответил ${res.status}`);
  }
  return res.json();
}

export function registerKnowledgeRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  /** Не настроено — честный 503, а не пустой список: пустой список клиент
   *  показал бы как «документов нет», и никто бы не понял, что дело в ключе. */
  function unconfigured(reply: any) {
    return reply.code(503).send({
      error: "База знаний не настроена",
      detail:
        "нужны RAGFLOW_TOKEN и RAGFLOW_TASKFLOW_DATASET в server/.env",
    });
  }

  // Смысловой поиск по всей документации. Возвращает КУСКИ (так устроен
  // retrieval), у каждого — документ и проект, из которого он взят.
  app.get<{ Querystring: { q?: string; top_k?: string; project?: string } }>(
    "/api/knowledge/search",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const question = (req.query.q || "").trim();
      if (!question) return reply.code(400).send({ error: "Пустой запрос" });

      // 30 — потолок: выше RAGFlow на CPU отвечает заметно дольше, а витрине
      // столько и не нужно.
      const topK = Math.min(Math.max(Number(req.query.top_k) || 8, 1), 30);
      let data: any;
      try {
        data = await ragflow("/api/v1/retrieval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            dataset_ids: [ragflowDataset()],
            page_size: topK,
            similarity_threshold: 0.15,
          }),
        });
      } catch (e: any) {
        return reply.code(502).send({ error: "Поиск недоступен", detail: String(e?.message || e) });
      }

      const chunks = data?.data?.chunks || [];
      const byDoc: Record<string, any> = {};
      for (const d of data?.data?.doc_aggs || []) byDoc[d.doc_id] = d;

      return {
        query: question,
        results: chunks.map((c: any) => ({
          text: c.content || c.content_with_weight || "",
          score: c.similarity ?? c.score ?? null,
          document_name: c.document_keyword || byDoc[c.document_id]?.doc_name || "",
          // `doc_id` заметки в TaskFlow — по нему открывается оригинал.
          doc_id: docIdFromName(c.document_keyword || byDoc[c.document_id]?.doc_name || ""),
        })),
      };
    },
  );

  // Список документов датасета. Нужен витрине «что вообще есть», в том числе
  // по закрытым проектам: удаление проекта в TaskFlow индекс не трогает,
  // документ остаётся с именем проекта в шапке — это и есть архив.
  app.get<{ Querystring: { page?: string; page_size?: string } }>(
    "/api/knowledge/documents",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(req.query.page_size) || 50, 1), 200);
      let data: any;
      try {
        data = await ragflow(
          `/api/v1/datasets/${ragflowDataset()}/documents?page=${page}&page_size=${pageSize}`,
        );
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
      const docs = data?.data?.docs || [];
      return {
        total: data?.data?.total ?? docs.length,
        documents: docs.map((d: any) => ({
          name: d.name,
          doc_id: docIdFromName(d.name),
          ragflow_id: d.id,
          chunk_count: d.chunk_count,
          size: d.size,
          updated_at: d.update_date,
          // «parsed» — документ уже в поиске; «running» — ещё индексируется.
          indexed: d.run === "DONE",
        })),
      };
    },
  );

  // Документ целиком — оригинальный markdown с шапкой, как его залил синк.
  // Клиент может открыть и живую заметку (`/api/notes/:id`); эта ручка нужна
  // для того, чего в TaskFlow уже нет — документов закрытых проектов.
  app.get<{ Params: { ragflowId: string } }>(
    "/api/knowledge/documents/:ragflowId",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      let text: string;
      try {
        const res = await fetch(
          `${ragflowApi()}/api/v1/datasets/${ragflowDataset()}/documents/${req.params.ragflowId}`,
          { headers: { Authorization: "Bearer " + ragflowToken() } },
        );
        if (!res.ok) return reply.code(res.status === 404 ? 404 : 502).send({ error: "Документ не отдан" });
        text = await res.text();
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
      const meta = frontmatter(text);
      // Тело без шапки: шапка — служебная, показывать её в приложении незачем.
      const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
      return {
        title: meta.title || "",
        project: meta.project || "",
        folder: meta.folder || "",
        doc_id: meta.doc_id || null,
        updated_at: meta.updated_at || null,
        markdown: body,
      };
    },
  );
}
