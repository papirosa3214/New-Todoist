// ═══════════ Сокращение длинных сообщений агентов ═══════════
//
// Карточка c19c9460 (06.10.2026): жёсткий лимит с отказом уже пробовали —
// сервер отвечал агенту «превысил лимит, перепиши», но ответ уходил в чат
// владельцу, а агент ничего не переписывал. Лимит с отказом не работает.
//
// Правило теперь такое: сообщение АГЕНТА длиннее порога сервер не отклоняет.
// Полный текст ложится документом в папку задачи (тот же путь, что у
// taskflow_doc_write: подпапка задачи создаётся сервером), а в чат уходит
// выжимка — первые 1–2 предложения плюс строка «полный текст: <название>».
// Отправителю в ответе сообщается, что текст сокращён и где лежит полный.
//
// Сообщения владельца сюда не попадают: его текст не сокращается никогда
// (см. routes/chat.ts — вызов делается только для не-владельца).
import crypto from "node:crypto";
import { getSetting } from "./serverSettings.js";
import db from "../db.js";
import { deriveTitleFromMarkdown, markdownToTiptap } from "./markdownToTiptap.js";
import { ensureTaskArtifactFolder } from "./taskArtifactFolder.js";
import { recordTaskDocument } from "./taskOutcome.js";

/**
 * Порог, после которого сообщение агента считается «простынёй». Владелец
 * видит в чате короткую версию, полный текст — документом.
 */
export const CHAT_SHORT_LIMIT = 600;

/** Служебная строка-ссылка на документ с полным текстом. */
export function fullTextReference(title: string): string {
  return `полный текст: ${title}`;
}

export type ShortenedChatMessage = {
  /** Короткая версия, которая ложится в чат и в ответ адресату. */
  text: string;
  shortened: boolean;
  /** Длина исходного текста — чтобы агент видел, что именно урезано. */
  fullLength: number;
  /** Документ с полным текстом (если он создан). */
  document?: { id: string; title: string };
};

/** Обрезает строку по границе слова, чтобы не рвать слово пополам. */
function cutAtWord(s: string, limit: number): string {
  const slice = s.slice(0, limit);
  const cut = slice.lastIndexOf(" ");
  const body = cut > limit * 0.5 ? slice.slice(0, cut) : slice;
  return body.trimEnd() + "…";
}

/**
 * Первые 1–2 предложения, укладывающиеся в порог.
 *
 * Если ни одно целое предложение не влезает — режем первое по границе
 * слова. Пустой результат невозможен: текст уже непустой (проверено выше).
 */
export function summarizeForChat(text: string): string {
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  let out = "";
  for (let i = 0; i < sentences.length && i < 2; i++) {
    const candidate = out ? `${out} ${sentences[i]}` : sentences[i];
    if (candidate.length <= getSetting("chat_short_limit")) {
      out = candidate;
      continue;
    }
    if (!out) out = cutAtWord(sentences[i], getSetting("chat_short_limit"));
    break;
  }
  return out || cutAtWord(text, getSetting("chat_short_limit"));
}

/**
 * Приводит сообщение агента к тому, что уйдёт в чат.
 *
 * Короткое сообщение возвращается как есть. Длинное — сохраняется заметкой
 * (в папке задачи, если задача есть) и заменяется выжимкой со ссылкой.
 * Ничего не теряется: полный текст остаётся документом.
 */
export function shortenChatMessage(opts: {
  text: string;
  taskId: string | null;
  authorId: string;
  authorName: string;
}): ShortenedChatMessage {
  const { text, taskId, authorId } = opts;
  if (text.length <= getSetting("chat_short_limit") || !text.trim()) {
    return { text, shortened: false, fullLength: text.length };
  }

  const title = (
    deriveTitleFromMarkdown(text) || `Сообщение от ${opts.authorName}`
  ).slice(0, 120);
  const id = crypto.randomUUID();
  // Папка задачи — как у taskflow_doc_write. Сообщения без задачи тоже
  // сохраняем (заметка без папки): «ничего не теряется» важнее, чем
  // аккуратность каталога, а терять текст молча нельзя.
  const folderId = taskId ? ensureTaskArtifactFolder(taskId) : null;
  db.prepare(
    `INSERT INTO user_notes (id, title, content, folder_id, updated_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, title, markdownToTiptap(text), folderId, authorId);
  // Заметка карточки попадает в её итог (Documents), как обычный doc_write.
  if (taskId) recordTaskDocument(taskId, id, authorId);

  return {
    text: `${summarizeForChat(text)}\n\n${fullTextReference(title)}`,
    shortened: true,
    fullLength: text.length,
    document: { id, title },
  };
}
