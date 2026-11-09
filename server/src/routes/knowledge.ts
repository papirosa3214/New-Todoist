import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { deleteDocs, noteDocument, rememberUploaded, uploadDocs } from "../lib/knowledgeSync.js";
import { isOwner } from "../access.js";
import {
  createSection,
  datasetRegistryRow,
  datasetRoles,
  deleteSection,
  ensureDatasetRows,
  listSections,
  patchDataset,
  setDatasetRoles,
  updateSection,
} from "../lib/knowledgeRegistry.js";
import {
  docIdFromName,
  frontmatter,
  isConfigured,
  listDatasets,
  ragflow,
  ragflowDataset,
  ragflowToken,
} from "../lib/ragflowClient.js";

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

/**
 * Заметка → в базу знаний сейчас, не дожидаясь суточного прогона (владелец
 * 01.10.2026: кнопка у документа в «Итоге» карточки). Документ собирается
 * тем же кодом, что и суточная выгрузка (lib/knowledgeSync.ts); старая копия
 * под тем же именем удаляется, а залитое запоминается — суточный прогон его
 * повторно не зальёт.
 */
export async function pushNoteToKnowledge(noteId: string): Promise<{ dataset: string; document_id: string | null }> {
  if (!ragflowToken() || !ragflowDataset()) throw new Error("База знаний не настроена");
  const doc = noteDocument(noteId);
  if (!doc) throw new Error("Заметка пустая — в базе знаний от неё толку нет");
  const listed = await ragflow(`/api/v1/datasets/${doc.dataset}/documents?name=${encodeURIComponent(doc.name)}&page=1&page_size=10`);
  const old = ((listed?.data?.docs ?? []) as Array<{ id: string; name: string }>).filter((d) => d.name === doc.name).map((d) => d.id);
  if (old.length) await deleteDocs(doc.dataset, old);
  const [documentId] = await uploadDocs(doc.dataset, [doc]);
  rememberUploaded(doc);
  return { dataset: doc.dataset, document_id: documentId ?? null };
}

export function registerKnowledgeRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Документ → в базу знаний сейчас (кнопка «В базу знаний» в «Итоге»).
  app.post<{ Params: { id: string } }>("/api/notes/:id/knowledge", { preHandler: authPre }, async (req: any, reply) => {
    if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
    try {
      return { ok: true, ...(await pushNoteToKnowledge(req.params.id)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message === "Заметка не найдена" ? 404 : 502).send({ error: message });
    }
  });

  /** Не настроено — честный 503, а не пустой список: пустой список клиент
   *  показал бы как «документов нет», и никто бы не понял, что дело в ключе. */
  function unconfigured(reply: any) {
    return reply.code(503).send({
      error: "База знаний не настроена",
      detail:
        "нужны RAGFLOW_TOKEN и RAGFLOW_TASKFLOW_DATASET в server/.env",
    });
  }

  // Датасеты RAGFlow — витрине нужен выбор при заведении проекта: «складывать
  // в общий или в свой». Владелец 08.09.2026: специфический бизнесовый проект
  // не должен подмешивать документацию туда, где ищут рабочее.
  app.get<{ Querystring: { include_disabled?: string } }>(
    "/api/knowledge/datasets",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ragflowToken()) return unconfigured(reply);
      let list: any[];
      try {
        list = await listDatasets();
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
      // Реестр заводит строки для датасетов, которых он ещё не видел: список
      // живёт в RAGFlow, а решения владельца — здесь.
      ensureDatasetRows(list.map((d) => d.id));
      const sections = new Map(listSections().map((sec) => [sec.id, { id: sec.id, title: sec.title }]));
      const projectDatasets = new Set(
        (
          db
            .prepare(
              "SELECT DISTINCT knowledge_dataset_id AS id FROM projects WHERE knowledge_dataset_id IS NOT NULL AND knowledge_dataset_id <> ''",
            )
            .all() as Array<{ id: string }>
        ).map((r) => r.id),
      );
      const includeDisabled = req.query?.include_disabled === "1";
      return {
        // Датасет по умолчанию: проект без своего выбора едет сюда.
        default_dataset_id: ragflowDataset(),
        datasets: list
          .map((d) => {
            const row = datasetRegistryRow(d.id) as any;
            return {
              id: d.id,
              name: row?.title || d.name,
              ragflow_name: d.name,
              document_count: d.document_count,
              chunk_count: d.chunk_count ?? null,
              is_default: d.id === ragflowDataset(),
              // `owner: taskflow` — только по id: по имени «Память — заметки»
              // и «База знаний — уроки» похожи на наши, но это чужие синки.
              owner: d.id === ragflowDataset() || projectDatasets.has(d.id) ? "taskflow" : "other",
              enabled: row ? row.enabled === 1 : true,
              section: row?.section_id ? sections.get(row.section_id) ?? null : null,
              roles: datasetRoles(d.id),
            };
          })
          .filter((d) => d.enabled || includeDisabled),
      };
    },
  );

  // ── Реестр: разделы-тематики, включение в TaskFlow, доступы ролям ───────
  // Настраивает только владелец. Роли ничего не настраивают — они видят ровно
  // выданное им, иначе чужой датасет засорял бы их поиск.

  app.get("/api/knowledge/sections", { preHandler: authPre }, async (_req, reply) => {
    if (!isConfigured()) return unconfigured(reply);
    return { sections: listSections() };
  });

  app.post<{ Body: { title?: string } }>(
    "/api/knowledge/sections",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "Разделы базы знаний настраивает владелец" });
      }
      try {
        return { section: createSection(String(req.body?.title ?? "")) };
      } catch (e: any) {
        return reply.code(400).send({ error: String(e?.message || e) });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { title?: string; position?: number } }>(
    "/api/knowledge/sections/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "Разделы базы знаний настраивает владелец" });
      }
      try {
        const ok = updateSection(Number(req.params.id), req.body || {});
        if (!ok) return reply.code(404).send({ error: "Раздел не найден" });
        return { ok: true };
      } catch (e: any) {
        return reply.code(400).send({ error: String(e?.message || e) });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/knowledge/sections/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "Разделы базы знаний настраивает владелец" });
      }
      const ok = deleteSection(Number(req.params.id));
      if (!ok) return reply.code(404).send({ error: "Раздел не найден" });
      return { ok: true };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean; section_id?: number | null; title?: string | null };
  }>("/api/knowledge/datasets/:id", { preHandler: authPre }, async (req: any, reply) => {
    if (!isOwner(req.userId)) {
      return reply.code(403).send({ error: "Датасетами базы знаний управляет владелец" });
    }
    try {
      ensureDatasetRows([req.params.id]);
      patchDataset(req.params.id, req.body || {});
      return { ok: true, dataset: { id: req.params.id, ...datasetRegistryRow(req.params.id) } };
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message || e) });
    }
  });

  app.put<{ Params: { id: string }; Body: { role_keys?: string[] } }>(
    "/api/knowledge/datasets/:id/roles",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "Доступ ролям выдаёт владелец" });
      }
      const keys = Array.isArray(req.body?.role_keys) ? req.body.role_keys.map(String) : [];
      ensureDatasetRows([req.params.id]);
      setDatasetRoles(req.params.id, keys);
      return { roles: datasetRoles(req.params.id) };
    },
  );

  // Новый датасет под проект. Настройки — как у соседних датасетов на этой
  // машине (bge-m3 через Ollama, naive-разбиение): другой эмбеддинг означал бы
  // другую модель в памяти и заметно более долгую индексацию на процессоре.
  app.post<{ Body: { name?: string } }>(
    "/api/knowledge/datasets",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken()) return unconfigured(reply);
      const name = (req.body?.name || "").trim();
      if (!name) return reply.code(400).send({ error: "Укажите название датасета" });
      let data: any;
      try {
        data = await ragflow("/api/v1/datasets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            embedding_model: process.env.RAGFLOW_EMBEDDING || "bge-m3-embed@Ollama",
            chunk_method: "naive",
          }),
        });
      } catch (e: any) {
        return reply.code(502).send({ error: "Не удалось создать датасет", detail: String(e?.message || e) });
      }
      // RAGFlow отвечает 200 с code != 0, когда имя занято, — это не наша
      // ошибка сети, а понятный отказ, и клиенту он нужен текстом.
      if (data?.code && data.code !== 0) {
        return reply.code(400).send({ error: data.message || "RAGFlow отказал" });
      }
      return { id: data?.data?.id, name: data?.data?.name };
    },
  );

  // Смысловой поиск по всей документации. Возвращает КУСКИ (так устроен
  // retrieval), у каждого — документ и проект, из которого он взят.
  app.get<{ Querystring: { q?: string; top_k?: string; dataset_id?: string } }>(
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
            dataset_ids: req.query.dataset_id ? [req.query.dataset_id] : allDatasetIds(),
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

      type NamedChunk = { chunk: any; name: string; docId: string | null };
      const named: NamedChunk[] = chunks.map((c: any) => {
        const name = c.document_keyword || byDoc[c.document_id]?.doc_name || "";
        return { chunk: c, name, docId: docIdFromName(name) };
      });

      // Заголовок и проект — из TaskFlow, одним запросом на всю выдачу:
      // в индексе документ зовётся `taskflow-<uuid>.md`, и показывать это имя
      // в результатах поиска бессмысленно.
      const ids = named.map((n: NamedChunk) => n.docId).filter(Boolean) as string[];
      const titles = new Map<string, { title: string; project: string | null }>();
      if (ids.length) {
        const rows = db
          .prepare(
            `SELECT un.id, un.title,
                    (SELECT p.name FROM projects p
                      WHERE p.notes_folder_id = un.folder_id
                      ORDER BY p.created_at LIMIT 1) AS project_name
             FROM user_notes un
             WHERE un.id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as any[];
        for (const r of rows) titles.set(r.id, { title: r.title || "", project: r.project_name || null });
      }

      return {
        query: question,
        results: named.map(({ chunk, name, docId }: NamedChunk) => {
          const known = docId ? titles.get(docId) : undefined;
          return {
            text: chunk.content || chunk.content_with_weight || "",
            score: chunk.similarity ?? chunk.score ?? null,
            document_name: name,
            title: known?.title || "",
            project: known?.project || null,
            // `doc_id` заметки в TaskFlow — по нему открывается оригинал.
            doc_id: docId,
          };
        }),
      };
    },
  );

  // Список документов датасета. Нужен витрине «что вообще есть», в том числе
  // по закрытым проектам: удаление проекта в TaskFlow индекс не трогает,
  // документ остаётся с именем проекта в шапке — это и есть архив.
  app.get<{ Querystring: { page?: string; page_size?: string; dataset_id?: string } }>(
    "/api/knowledge/documents",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(req.query.page_size) || 50, 1), 200);
      let data: any;
      try {
        // RAGFlow перечисляет документы одного датасета за раз; по умолчанию
        // показываем общий, конкретный проектный — по dataset_id.
        const dataset = req.query.dataset_id || ragflowDataset();
        data = await ragflow(
          `/api/v1/datasets/${dataset}/documents?page=${page}&page_size=${pageSize}`,
        );
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
      const docs = data?.data?.docs || [];

      // Имя документа в индексе — `taskflow-<uuid>.md`, человеку показывать
      // нечего. Заголовок и проект берём из самого TaskFlow по doc_id: одним
      // запросом на страницу, без похода за каждым документом.
      const ids = docs.map((d: any) => docIdFromName(d.name)).filter(Boolean) as string[];
      const titles = new Map<string, { title: string; project: string | null }>();
      if (ids.length) {
        const rows = db
          .prepare(
            `SELECT un.id, un.title,
                    (SELECT p.name FROM projects p
                      WHERE p.notes_folder_id = un.folder_id
                      ORDER BY p.created_at LIMIT 1) AS project_name
             FROM user_notes un
             WHERE un.id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as any[];
        for (const r of rows) titles.set(r.id, { title: r.title || "", project: r.project_name || null });
      }

      return {
        total: data?.data?.total ?? docs.length,
        documents: docs.map((d: any) => {
          const docId = docIdFromName(d.name);
          const known = docId ? titles.get(docId) : undefined;
          return {
            name: d.name,
            title: known?.title || "",
            project: known?.project || null,
            doc_id: docId,
            ragflow_id: d.id,
            chunk_count: d.chunk_count,
            size: d.size,
            updated_at: d.update_date,
            // «parsed» — документ уже в поиске; «running» — ещё индексируется.
            indexed: d.run === "DONE",
            // Заметки в TaskFlow уже нет, а в индексе она осталась — это и
            // есть архив закрытого проекта. Открывать её нужно из индекса
            // (`/api/knowledge/documents/:ragflowId`), оригинала больше нет.
            archived: docId != null && !titles.has(docId),
          };
        }),
      };
    },
  );

  // Документ целиком — оригинальный markdown с шапкой, как его залил синк.
  // Клиент может открыть и живую заметку (`/api/notes/:id`); эта ручка нужна
  // для того, чего в TaskFlow уже нет — документов закрытых проектов.
  app.get<{ Params: { ragflowId: string }; Querystring: { dataset_id?: string } }>(
    "/api/knowledge/documents/:ragflowId",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      let text: string;
      try {
        const res = await fetch(
          `${ragflowApi()}/api/v1/datasets/${req.query.dataset_id || ragflowDataset()}/documents/${req.params.ragflowId}`,
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
