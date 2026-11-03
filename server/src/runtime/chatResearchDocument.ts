// Документ с выводами глубокого исследования (карточка e11eae7a, пункт 3).
//
// Критерий приёмки: «secretary research … сохраняет документ». Инструкции
// режима просят выводы и ссылки, но этого мало: роль может ответить текстом и
// ничего не сохранить. Поэтому сервер проверяет результат хода: если за ход
// роль не записала ни одного документа, сервер сам сохраняет её ответ как
// документ (выводы + ссылки) и прикладывает ссылку в чате. Так «документ с
// выводами» появляется всегда, а не по доброй воле модели.
import crypto from "node:crypto";
import db from "../db.js";
import { deriveTitleFromMarkdown, markdownToTiptap } from "../lib/markdownToTiptap.js";
import { noteSearchText } from "../lib/noteSearchText.js";
import { ensureTaskArtifactFolder } from "../lib/taskArtifactFolder.js";
import { recordTaskDocument } from "../lib/taskOutcome.js";

export type SavedResearchDocument = { id: string; title: string; ref: string };

/**
 * Документ, который роль записала сама после начала хода.
 * Автор — учётка роли, отметка времени — момент старта хода.
 */
export function researchDocumentSince(
  roleUserId: string,
  sinceIso: string,
): SavedResearchDocument | null {
  const row = db
    .prepare(
      `SELECT id, title FROM user_notes
        WHERE updated_by = ?
          AND (datetime(created_at) >= datetime(?) OR datetime(updated_at) >= datetime(?))
        ORDER BY datetime(updated_at) DESC LIMIT 1`,
    )
    .get(roleUserId, sinceIso, sinceIso) as { id: string; title: string } | undefined;
  if (!row) return null;
  return { id: row.id, title: row.title || "Документ", ref: `note://${row.id}` };
}

/**
 * Сохранить ответ исследования как документ (выводы и ссылки целиком).
 * Папка — папка задачи, иначе папка документов проекта, иначе заметка без папки.
 */
export function saveResearchDocument(params: {
  text: string;
  authorId: string;
  taskId?: string | null;
  projectId?: string | null;
  title?: string;
}): SavedResearchDocument | null {
  const text = (params.text ?? "").trim();
  if (!text) return null;
  const title =
    (params.title ?? deriveTitleFromMarkdown(text) ?? "").slice(0, 120) ||
    "Выводы исследования";
  const id = crypto.randomUUID();
  let folderId: number | null = null;
  if (params.taskId) {
    try {
      folderId = ensureTaskArtifactFolder(params.taskId);
    } catch {
      folderId = null;
    }
  }
  if (folderId === null && params.projectId) {
    const project = db
      .prepare("SELECT notes_folder_id FROM projects WHERE id = ?")
      .get(params.projectId) as { notes_folder_id: number | null } | undefined;
    folderId = project?.notes_folder_id ?? null;
  }
  const content = markdownToTiptap(text);
  db.prepare(
    `INSERT INTO user_notes (id, title, content, folder_id, updated_by, search_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, title, content, folderId, params.authorId, noteSearchText(content));
  if (params.taskId) {
    try {
      recordTaskDocument(params.taskId, id, params.authorId);
    } catch {
      // Документ в заметках уже сохранён; итог карточки — вспомогательный.
    }
  }
  return { id, title, ref: `note://${id}` };
}

/**
 * Документ с выводами есть? Нет — сохраняем ответ хода как документ.
 * Возвращает документ (свой или только что сохранённый) и признак,
 * что его сохранил сервер: тогда в чат надо приложить ссылку.
 */
export function ensureResearchDocument(params: {
  roleUserId: string;
  text: string;
  sinceIso: string;
  taskId?: string | null;
  projectId?: string | null;
}): { document: SavedResearchDocument; createdByServer: boolean } | null {
  const own = researchDocumentSince(params.roleUserId, params.sinceIso);
  if (own) return { document: own, createdByServer: false };
  const saved = saveResearchDocument({
    text: params.text,
    authorId: params.roleUserId,
    taskId: params.taskId ?? null,
    projectId: params.projectId ?? null,
  });
  return saved ? { document: saved, createdByServer: true } : null;
}
