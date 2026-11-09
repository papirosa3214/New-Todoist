// Поиск по базе знаний для ролей (09.11.2026). Роль видит только датасеты,
// которые ей выдали в приложении, и только включённые: исключённый датасет не
// существует для TaskFlow ни для кого. Вынесено из инструмента
// `taskflow_rag_search` отдельной функцией — роль-пользователя в тестах не
// создать (триггеры users_role_key_update_guard), а поведение проверить надо.
import { isConfigured, retrieval } from "./ragflowClient.js";
import { roleDatasetIds } from "./knowledgeRegistry.js";

export const MAX_RAG_CHUNKS = 20;

export type RagChunk = {
  текст: string;
  оценка: number | null;
  название: string;
  датасет: string;
  документ: string | null;
};

export async function ragSearchForRole(
  roleKey: string,
  query: string,
  topK?: number,
): Promise<{ запрос: string; куски: RagChunk[]; подсказка?: string }> {
  const question = String(query ?? "").trim();
  if (!question) return { запрос: "", куски: [], подсказка: "пустой запрос" };

  const datasetIds = roleDatasetIds(String(roleKey ?? ""));
  if (!datasetIds.length) {
    // Молчаливая пустая выдача выглядела бы как «в базе ничего нет» — роль
    // должна сказать человеку, что доступ не выдан.
    return {
      запрос: question,
      куски: [],
      подсказка: "доступ ни к одному датасету базы знаний не выдан — попросите владельца выдать доступ",
    };
  }
  if (!isConfigured()) {
    return { запрос: question, куски: [], подсказка: "база знаний не настроена на сервере" };
  }

  const pageSize = Math.min(Math.max(Number(topK) || 5, 1), MAX_RAG_CHUNKS);
  const data = await retrieval({
    question,
    dataset_ids: datasetIds,
    page_size: pageSize,
    similarity_threshold: 0.2,
  });

  const chunks = (data?.chunks ?? []) as any[];
  return {
    запрос: question,
    куски: chunks.map((c) => ({
      текст: String(c.content ?? c.content_with_weight ?? "").trim(),
      оценка: c.similarity ?? c.score ?? null,
      название: String(c.document_name ?? c.document_keyword ?? ""),
      // Датасет — по имени, если RAGFlow его отдал: роль должна понимать, из
      // какой тематики пришёл кусок.
      датасет: String(c.dataset_name ?? c.dataset_id ?? ""),
      документ: c.document_id ? String(c.document_id) : null,
    })),
  };
}
