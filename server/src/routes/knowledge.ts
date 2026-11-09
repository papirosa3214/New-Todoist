import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { callUnifiedAi } from "../lib/aiClient.js";
import { deleteDocs, noteDocument, rememberUploaded, uploadDocs } from "../lib/knowledgeSync.js";
import { isOwner } from "../access.js";
import {
  createSection,
  datasetRegistryRow,
  datasetRoles,
  deleteSection,
  enabledDatasetIds,
  ensureDatasetRows,
  listSections,
  patchDataset,
  searchDatasetIds,
  setDatasetRoles,
  updateSection,
} from "../lib/knowledgeRegistry.js";
import {
  deleteDocuments,
  docIdFromName,
  documentStatus,
  frontmatter,
  isConfigured,
  listDatasets,
  listDocuments,
  parseDocuments,
  retrieval,
  ragflow,
  ragflowDataset,
  ragflowToken,
  uploadDocument,
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
      // Область поиска: только включённые в TaskFlow датасеты, а роль — только
      // по выданным ей датасетам (см. searchDatasetIds).
      const caller = db
        .prepare("SELECT type, role, role_key FROM users WHERE id = ?")
        .get(req.userId) as any;
      const requested = String(req.query.dataset_id ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const scope = searchDatasetIds(caller, requested);
      if (!scope.ids.length) {
        return scope.reason === "no-scope"
          ? reply.code(403).send({ error: "Доступ ни к одному датасету базы знаний не выдан" })
          : reply.code(400).send({ error: "Датасет исключён из TaskFlow или не указан" });
      }
      let data: any;
      try {
        data = await ragflow("/api/v1/retrieval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            dataset_ids: scope.ids,
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
  // С 09.11.2026 — делегат к documentsPage: то же самое отдаёт
  // `/api/knowledge/datasets/:id/documents`, и двух правд о документе нет.
  app.get<{ Querystring: { page?: string; page_size?: string; dataset_id?: string } }>(
    "/api/knowledge/documents",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(req.query.page_size) || 50, 1), 200);
      try {
        return await documentsPage(req.query.dataset_id || ragflowDataset(), page, pageSize);
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
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
  // ── Документы датасета: загрузка, ход разбора, удаление, переразбор ──────
  //
  // 09.11.2026. Владелец: «могу сам загружать туда документы для чанкования».
  // Файл приходит СЫРЫМИ БАЙТАМИ, как вложения задач (routes/attachments.ts):
  // имя в `?name=`, тип в Content-Type. Разборщики буфера для этих типов уже
  // зарегистрированы в index.ts, второй раунд упаковки в multipart не нужен.
  const MAX_UPLOAD = 15 * 1024 * 1024;

  /** Право трогать документ: владелец — любой, остальные — только свой залитый.
   *  Документы заметок (`taskflow-<id>.md`) — не «свои» никому, кроме владельца:
   *  их судьба решается сохранением заметки, а не меню в приложении. */
  function canTouchDocument(userId: string, ragflowDocId: string): boolean {
    if (isOwner(userId)) return true;
    const row = db
      .prepare("SELECT uploaded_by FROM knowledge_uploads WHERE ragflow_doc_id = ?")
      .get(ragflowDocId) as { uploaded_by: string | null } | undefined;
    return Boolean(row && row.uploaded_by === userId);
  }

  /** Страница документов датасета — общая для обеих витрин. */
  async function documentsPage(dataset: string, page: number, pageSize: number) {
    const data = await listDocuments(dataset, page, pageSize);
    const docs = data?.docs || [];
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
    const uploads = new Map<string, string>();
    if (docs.length) {
      const rows = db
        .prepare(
          `SELECT ragflow_doc_id, uploaded_by FROM knowledge_uploads
            WHERE ragflow_doc_id IN (${docs.map(() => "?").join(",")})`,
        )
        .all(...docs.map((d: any) => d.id)) as Array<{ ragflow_doc_id: string; uploaded_by: string | null }>;
      for (const r of rows) uploads.set(r.ragflow_doc_id, r.uploaded_by || "");
    }
    return {
      total: data?.total ?? docs.length,
      documents: docs.map((d: any) => {
        const docId = docIdFromName(d.name);
        const known = docId ? titles.get(docId) : undefined;
        const uploadedBy = uploads.get(d.id) ?? "";
        return {
          name: d.name,
          // Заголовок заметки важнее её имени в индексе; у залитых вручную
          // файлов заголовок — это их собственное имя.
          title: known?.title || (uploadedBy !== "" ? d.name : ""),
          project: known?.project || null,
          doc_id: docId,
          ragflow_id: d.id,
          chunk_count: d.chunk_count,
          size: d.size,
          updated_at: d.update_date,
          run: d.run ?? null,
          progress: typeof d.progress === "number" ? d.progress : null,
          indexed: d.run === "DONE",
          archived: docId != null && !titles.has(docId),
          uploaded_by: uploadedBy || null,
        };
      }),
    };
  }

  // Документы конкретного датасета — экран датасета в приложении.
  app.get<{ Params: { id: string }; Querystring: { page?: string; page_size?: string } }>(
    "/api/knowledge/datasets/:id/documents",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(req.query.page_size) || 50, 1), 200);
      try {
        return await documentsPage(req.params.id, page, pageSize);
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
    },
  );

  // Загрузка файла в датасет. Ограничения — те же, что у вложений:
  // 15 МБ и понятный ответ вместо сырой ошибки Fastify.
  app.post<{ Params: { id: string }; Querystring: { name?: string } }>(
    "/api/knowledge/datasets/:id/documents",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const dataset = req.params.id;
      // Исключённый датасет — не «место хранения»: владелец сказал, что в
      // TaskFlow его нет. Загрузка туда противоречила бы его же решению.
      if (!enabledDatasetIds().includes(dataset))
        return reply.code(400).send({ error: "Датасет исключён из TaskFlow" });

      // Имя из query: пользовательское имя может быть каким угодно, поэтому
      // в путь оно не попадает, а слэши и обратные слэши заменяются.
      const name = String(req.query.name ?? "")
        .trim()
        .replace(/[\\/]+/g, "_")
        .slice(0, 200);
      if (!name) return reply.code(400).send({ error: "Не указано имя файла (?name=)" });
      if (!/\.[A-Za-z0-9]{1,8}$/.test(name))
        return reply.code(400).send({ error: "Имя файла без расширения — RAGFlow не поймёт, чем разбирать" });

      const body = req.body;
      const bytes = Buffer.isBuffer(body) ? body : null;
      if (!bytes || bytes.length === 0) return reply.code(400).send({ error: "Пустой файл" });
      if (bytes.length > MAX_UPLOAD) return reply.code(413).send({ error: "Файл больше 15 МБ" });

      try {
        const uploaded = await uploadDocument(
          dataset,
          name,
          new Uint8Array(bytes),
          req.headers["content-type"] || "application/octet-stream",
        );
        if (!uploaded?.id) return reply.code(502).send({ error: "RAGFlow не принял файл" });
        db.prepare(
          `INSERT OR REPLACE INTO knowledge_uploads (ragflow_doc_id, dataset_id, name, uploaded_by)
           VALUES (?, ?, ?, ?)`,
        ).run(uploaded.id, dataset, name, req.userId);
        // Разбор сразу: файл без разбора в поиске не участвует, и человек
        // иначе ждал бы непонятно чего.
        await parseDocuments(dataset, [uploaded.id]);
        return { ok: true, ragflow_id: uploaded.id, name, dataset, status: "parsing" };
      } catch (e: any) {
        return reply.code(502).send({ error: "Загрузка не удалась", detail: String(e?.message || e) });
      }
    },
  );

  // Ход разбора документа: приложение спрашивает, пока не готово.
  app.get<{ Params: { ragflowId: string }; Querystring: { dataset_id?: string } }>(
    "/api/knowledge/documents/:ragflowId/status",
    { preHandler: authPre },
    async (req, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      try {
        const status = await documentStatus(req.query.dataset_id || ragflowDataset(), req.params.ragflowId);
        if (!status) return reply.code(404).send({ error: "Документ не найден" });
        return status;
      } catch (e: any) {
        return reply.code(502).send({ error: "База знаний недоступна", detail: String(e?.message || e) });
      }
    },
  );

  // Удаление документа: владелец — что угодно, остальные — только своё.
  app.delete<{ Params: { ragflowId: string }; Querystring: { dataset_id?: string } }>(
    "/api/knowledge/documents/:ragflowId",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      if (!canTouchDocument(req.userId, req.params.ragflowId))
        return reply.code(403).send({ error: "Это документ не ваш — удалить его нельзя" });
      const dataset = req.query.dataset_id || ragflowDataset();
      try {
        await deleteDocuments(dataset, [req.params.ragflowId]);
        db.prepare("DELETE FROM knowledge_uploads WHERE ragflow_doc_id = ?").run(req.params.ragflowId);
        return { ok: true };
      } catch (e: any) {
        return reply.code(502).send({ error: "Удаление не удалось", detail: String(e?.message || e) });
      }
    },
  );

  // Переразбор: после замены файла или смены модели эмбеддингов.
  app.post<{ Params: { id: string }; Body: { document_ids?: string[] } }>(
    "/api/knowledge/datasets/:id/documents/reparse",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
      const ids = Array.isArray(req.body?.document_ids) ? req.body.document_ids.map(String) : [];
      if (!ids.length) return reply.code(400).send({ error: "Не указаны документы" });
      const foreign = ids.filter((id: string) => !canTouchDocument(req.userId, id));
      if (foreign.length)
        return reply.code(403).send({ error: "Часть документов не ваша", ragflow_ids: foreign });
      try {
        await parseDocuments(req.params.id, ids);
        return { ok: true, documents: ids.length };
      } catch (e: any) {
        return reply.code(502).send({ error: "Переразбор не удался", detail: String(e?.message || e) });
      }
    },
  );
  // ── «Спросить базу»: ответ по найденным кускам ──────────────────────────
  //
  // 09.11.2026. Владелец выбрал «ответ + куски»: модель формулирует ответ,
  // под ним источники, на которые она опиралась. Отвечает МОДЕЛЬ СЕРВЕРА, а
  // не ассистент RAGFlow: ассистентов пришлось бы держать по одному на
  // датасет и у каждого своя правда о промпте и о правах ролей.
  const ASK_MAX_CHUNKS = 8;
  const ASK_MAX_CHARS = 12_000;
  const askModel = () => process.env.KB_ASK_MODEL || "qwen3:8b";

  app.post<{
    Body: { question?: string; dataset_ids?: string[]; document_ids?: string[] };
  }>("/api/knowledge/ask", { preHandler: authPre }, async (req: any, reply) => {
    if (!ragflowToken() || !ragflowDataset()) return unconfigured(reply);
    const question = String(req.body?.question ?? "").trim();
    if (!question) return reply.code(400).send({ error: "Пустой вопрос" });

    // Область — та же, что у поиска: только включённые датасеты, роль — только
    // выданные ей. Даже «спросить» не должно видеть того, чего не видно.
    const caller = db
      .prepare("SELECT type, role, role_key FROM users WHERE id = ?")
      .get(req.userId) as any;
    const requested = Array.isArray(req.body?.dataset_ids) ? req.body.dataset_ids.map(String) : [];
    // Чипсы датасетов обязательны: «ответ по всему сразу» подмешивал бы в
    // ответ чужие тематики — ровно то, на что владелец жаловался в поиске.
    if (!requested.length) return reply.code(400).send({ error: "Выберите датасет" });
    const scope = searchDatasetIds(caller, requested);
    if (!scope.ids.length)
      return scope.reason === "no-scope"
        ? reply.code(403).send({ error: "Доступ ни к одному датасету базы знаний не выдан" })
        : reply.code(400).send({ error: "Выберите датасет — искать по всем сразу не получится" });

    // Внутренняя фильтрация: конкретные документы внутри датасета.
    const documentIds = Array.isArray(req.body?.document_ids)
      ? req.body.document_ids.map(String).filter(Boolean)
      : [];
    let data: any;
    try {
      data = await retrieval({
        question,
        dataset_ids: scope.ids,
        document_ids: documentIds.length ? documentIds : undefined,
        page_size: ASK_MAX_CHUNKS,
        similarity_threshold: 0.15,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: "Поиск недоступен", detail: String(e?.message || e) });
    }

    // Куски — в общий вид и с потолком: модель не должна получить мегабайты
    // (контекст кончится, ответ будет обрезан на середине).
    const raw = (data?.chunks ?? []) as any[];
    const found: Array<{ text: string; score: number | null; document_name: string; doc_id: string | null; title: string }> = [];
    let budget = ASK_MAX_CHARS;
    for (const chunk of raw.slice(0, ASK_MAX_CHUNKS)) {
      const text = String(chunk.content ?? chunk.content_with_weight ?? "").trim();
      if (!text) continue;
      if (text.length > budget) break;
      budget -= text.length;
      const name = String(chunk.document_name ?? chunk.document_keyword ?? "");
      const docId = docIdFromName(name);
      found.push({ text, score: chunk.similarity ?? chunk.score ?? null, document_name: name, doc_id: docId, title: "" });
    }
    // Заголовки заметок — из TaskFlow: в индексе документ зовётся
    // `taskflow-<uuid>.md`, человеку это имя ничего не говорит.
    const ids = found.map((c) => c.doc_id).filter(Boolean) as string[];
    if (ids.length) {
      const rows = db
        .prepare(`SELECT id, title FROM user_notes WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Array<{ id: string; title: string }>;
      const titles = new Map(rows.map((r) => [r.id, r.title || ""]));
      for (const c of found) if (c.doc_id) c.title = titles.get(c.doc_id) ?? "";
    }

    if (!found.length) {
      return {
        question,
        answer: null,
        model: null,
        chunks: [],
        hint: "В выбранных датасетах ничего не нашлось — попробуйте другой вопрос или другие датасеты",
      };
    }

    const context = found
      .map((c, i) => `[${i + 1}] ${c.title || c.document_name}\n${c.text}`)
      .join("\n\n");
    const systemPrompt = [
      "Ты отвечаешь на вопрос по базе знаний TaskFlow.",
      "Отвечай ТОЛЬКО по приведённым кускам. Если в них нет ответа — скажи, что в выбранных датасетах этого не нашлось, и не додумывай.",
      "После утверждения ставь номер куска в квадратных скобках, например [1].",
      "Пиши коротко и по делу, на языке вопроса.",
    ].join("\n");

    let answer: string | null = null;
    const model = askModel();
    try {
      answer = await callUnifiedAi({
        systemPrompt,
        userPrompt: `Вопрос: ${question}\n\nКуски базы знаний:\n${context}`,
        aiModel: model,
        temperature: 0.2,
        predictTokens: 700,
      });
    } catch {
      // Модель упала — куски всё равно полезны: человек прочитает источник сам.
      answer = null;
    }

    return { question, answer, model: answer === null ? null : model, chunks: found };
  });
}
