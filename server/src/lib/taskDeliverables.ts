// Сам документ результата — в итог карточки (владелец 05.11.2026: «там просто
// файл отчёта о том, что он сделал, а сама инструкция — это где?»).
//
// Роль часто сдаёт документ файлом в git-ветку карточки, а в карточку попадает
// только её отчёт о работе. Здесь такие файлы становятся заметками карточки:
// заметку можно открыть из «Итога», а ветка может быть влита и удалена.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { projectRepo, roleBranch } from "../runtime/roleWorkspace.js";
import { markdownToTiptap } from "./markdownToTiptap.js";
import { noteSearchText } from "./noteSearchText.js";
import { ensureTaskArtifactFolder } from "./taskArtifactFolder.js";
import { recordTaskDocument } from "./taskOutcome.js";

const TEXT_DOCUMENT = /\.(md|markdown|txt)$/i;
/** Служебное, а не то, что просил владелец: граф, тесты, инструкции репозитория. */
const NOT_A_RESULT = /(^|\/)(graft|graphify-out|tests?|__tests__|fixtures|node_modules|\.claude|\.github)\/|(^|\/)(CLAUDE|AGENTS|INDEX|README|CHANGELOG)\.md$/i;
const MENTIONED_DOCUMENT = /(?<![\w./-])(docs\/[^\s`'"()<>]+\.(?:md|markdown|txt))/gi;
const MAX_BYTES = 512 * 1024;
const MAX_DOCUMENTS = 20;

function noteIdFor(taskId: string, file: string): string {
  return "deliverable_" + crypto.createHash("sha256").update(`${taskId}:${file}`).digest("hex").slice(0, 32);
}

/** Пути из раздела «Материалы» отчётов: так находятся документы уже влитых веток. */
function mentionedDocuments(taskId: string): string[] {
  const rows = db.prepare(
    `SELECT n.search_text FROM task_events e JOIN user_notes n ON n.id = e.to_value
      WHERE e.task_id = ? AND e.kind = 'role_result_report'`,
  ).all(taskId) as Array<{ search_text: string | null }>;
  const found = new Set<string>();
  for (const { search_text } of rows) {
    const at = search_text?.lastIndexOf("Материалы") ?? -1;
    if (at < 0) continue;
    for (const match of search_text!.slice(at).matchAll(MENTIONED_DOCUMENT)) {
      if (!match[1].split("/").includes("..")) found.add(match[1]);
    }
  }
  return [...found];
}

function titleOf(markdown: string, file: string): string {
  const heading = markdown.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m)?.[1];
  return (heading || file.split("/").pop() || file).slice(0, 200);
}

/**
 * Переносит документы роли в заметки карточки. Повторный вызов ничего не
 * меняет, пока файл тот же; новая версия файла обновляет ту же заметку.
 * Возвращает заметки, созданные или обновлённые этим вызовом.
 */
export function importTaskDeliverables(taskId: string, actorId: string | null, repo: string = projectRepo(taskId)): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_BYTES * 2 }).trim();
  const branch = roleBranch(taskId);
  let ref = "HEAD";
  const files = new Set<string>();
  try {
    git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    ref = `refs/heads/${branch}`;
    // Сверка с main, а не с HEAD: рабочая копия может стоять на любой ветке.
    const base = git("merge-base", "refs/heads/main", ref);
    for (const file of git("-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=A", base, ref).split("\n")) {
      if (file) files.add(file);
    }
  } catch {
    // Ветки нет: уже влита и удалена либо роль в ней не работала.
  }
  for (const file of mentionedDocuments(taskId)) files.add(file);

  const changed: string[] = [];
  const documents = [...files].filter((file) => TEXT_DOCUMENT.test(file) && !NOT_A_RESULT.test(file)).sort().slice(0, MAX_DOCUMENTS);
  for (const file of documents) {
    let blob: string;
    let markdown: string;
    try {
      blob = git("rev-parse", `${ref}:${file}`);
      if (Number(git("cat-file", "-s", blob)) > MAX_BYTES) continue;
      markdown = git("cat-file", "blob", blob);
    } catch {
      continue; // Упомянут, но такого файла нет.
    }
    const noteId = noteIdFor(taskId, file);
    const source = `${file}@${blob}`;
    const seen = db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='task_deliverable' AND field=? AND to_value=? LIMIT 1").get(taskId, noteId, source);
    if (seen) continue;
    const title = titleOf(markdown, file);
    const content = markdownToTiptap(markdown);
    db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM user_notes WHERE id=?").get(noteId);
      if (exists) {
        db.prepare("UPDATE user_notes SET title=?,content=?,search_text=?,updated_by=?,updated_at=datetime('now') WHERE id=?")
          .run(title, content, noteSearchText(content), actorId, noteId);
      } else {
        db.prepare("INSERT INTO user_notes(id,title,content,folder_id,updated_by,search_text) VALUES(?,?,?,?,?,?)")
          .run(noteId, title, content, ensureTaskArtifactFolder(taskId), actorId, noteSearchText(content));
      }
      recordTaskDocument(taskId, noteId, actorId);
      logEvent({ taskId, actorId, kind: "task_deliverable", field: noteId, toValue: source });
    })();
    changed.push(noteId);
  }
  return changed;
}
