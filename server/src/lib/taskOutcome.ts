// Итог карточки (владелец 01.10.2026): что решили и что сдали — одним
// местом. Раньше это лежало в шести углах: результат шага, лента,
// документация проекта, вердикт проверяющего (в приложении не виден вовсе),
// ветка с кодом, отчёты. Итог собирает их и сам ложится заметкой в папку
// документации проекта карточки — «как все документы сейчас туда сливаются».
import { ownerBlocks, type ChatBlock } from "./chatBlocks.js";
import { humanStepResult } from "./stepResults.js";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleTitle } from "../roleRouting.js";
import { liveServerRepo, roleBranch } from "../runtime/roleWorkspace.js";
import { ensureTaskArtifactFolder } from "./taskArtifactFolder.js";
import { markdownToTiptap } from "./markdownToTiptap.js";
import { noteSearchText } from "./noteSearchText.js";

export type TaskOutcome = {
  verdict: { verdict: string; findings: string; reviewer_id: string; created_at: string; findings_blocks?: ChatBlock[] | null } | null;
  /** human_title / human_result — то же, что сдала роль, человеческим языком для владельца (lib/stepResults.ts). */
  nodes: Array<{ slot_key: string | null; role: string | null; title: string; result: string | null; done: boolean; human_title: string | null; human_result: string | null; display_result_blocks?: ChatBlock[] | null }>;
  /** kind: result — сам документ результата, outcome — сводка «Итог: …», report — отчёт роли о проделанной работе. */
  documents: Array<{ id: string; title: string; updated_at: string | null; is_outcome: boolean; kind: "result" | "outcome" | "report" }>;
  branch: { name: string; commit: string; subject: string; ahead: number } | null;
};

/** Документ, записанный по карточке (ролью через doc_write или итог). */
export function recordTaskDocument(taskId: string, noteId: string, actorId: string | null, kind: "doc_written" | "outcome_note" = "doc_written"): void {
  // Итог (outcome_note) живёт в папке документации проекта — там, куда
  // положил его `writeOutcomeNote`. Перенос в artifact folder нужен
  // обычным рабочим документам (`doc_written`), чтобы они лежали рядом
  // с артефактами задачи; итог — единственная заметка карточки на
  // верхнем уровне, и в тесте «итог в папке проекта» ожидается именно
  // он.
  if (kind !== "outcome_note") {
    const folderId = ensureTaskArtifactFolder(taskId);
    db.prepare("UPDATE user_notes SET folder_id=? WHERE id=?").run(folderId, noteId);
  }
  const seen = db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND kind = ? AND field = ? LIMIT 1").get(taskId, kind, noteId);
  if (!seen) logEvent({ taskId, actorId, kind, field: noteId });
}

function outcomeNoteId(taskId: string): string | null {
  const row = db.prepare(
    `SELECT e.field FROM task_events e JOIN user_notes n ON n.id = e.field
      WHERE e.task_id = ? AND e.kind = 'outcome_note' ORDER BY e.created_at DESC LIMIT 1`,
  ).get(taskId) as { field: string } | undefined;
  return row?.field ?? null;
}

function taskDocuments(taskId: string): TaskOutcome["documents"] {
  const outcome = outcomeNoteId(taskId);
  const rows = db.prepare(
    `SELECT DISTINCT n.id, n.title, n.updated_at,
            EXISTS(SELECT 1 FROM task_events r WHERE r.task_id = e.task_id AND r.kind = 'role_result_report' AND r.to_value = n.id) AS is_report
       FROM task_events e
       JOIN user_notes n ON n.id = e.field
      WHERE e.task_id = ? AND e.kind IN ('doc_written', 'outcome_note')
      ORDER BY n.updated_at DESC`,
  ).all(taskId) as Array<{ id: string; title: string; updated_at: string | null; is_report: number }>;
  const rank = { result: 0, outcome: 1, report: 2 } as const;
  // Первым идёт то, что просил владелец; отчёты о работе — после него.
  return rows
    .map(({ is_report, ...r }) => {
      const kind: keyof typeof rank = r.id === outcome ? "outcome" : is_report ? "report" : "result";
      return { ...r, is_outcome: r.id === outcome, kind };
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Ветка с кодом карточки (runtime/roleWorkspace.ts), если роли там коммитили. */
function taskBranch(taskId: string, repo: string = liveServerRepo()): TaskOutcome["branch"] {
  const name = roleBranch(taskId);
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
    const ahead = Number(git("rev-list", "--count", `HEAD..${name}`)) || 0;
    if (ahead === 0) return null;
    const [commit, subject] = git("log", "-1", "--format=%h%x09%s", name).split("\t");
    return { name, commit, subject: subject ?? "", ahead };
  } catch {
    return null;
  }
}

export function buildTaskOutcome(taskId: string): TaskOutcome {
  const verdict = db.prepare(
    "SELECT verdict, findings, reviewer_id, created_at FROM reviews WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(taskId) as TaskOutcome["verdict"] | undefined;
  const plan = db.prepare(
    "SELECT id FROM task_collaboration_plans WHERE task_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1",
  ).get(taskId) as { id: string } | undefined;
  const nodeRows = plan
    ? db.prepare(
        `SELECT s.id AS subtask_id, s.plan_node_key AS slot_key, n.role_key AS role, s.title, s.result, s.done
           FROM subtasks s LEFT JOIN task_collaboration_plan_nodes n
             ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
          WHERE s.collaboration_plan_id = ? ORDER BY s.position`,
      ).all(plan.id)
    : db.prepare(
        `SELECT NULL AS slot_key, NULL AS role, title, result, done FROM subtasks
          WHERE task_id = ? AND COALESCE(result, '') <> '' ORDER BY position`,
      ).all(taskId);
  const nodes = (nodeRows as Array<{ subtask_id?: string; slot_key: string | null; role: string | null; title: string; result: string | null; done: number }>)
    .map(({ subtask_id, ...n }) => {
      const human = subtask_id ? humanStepResult(subtask_id) : null;
      const humanResult = human?.body || null;
      // Что показать владельцу — пересказ, без него исходный текст; готовыми блоками.
      return { ...n, done: Boolean(n.done), human_title: human?.title ?? null, human_result: humanResult,
        display_result_blocks: ownerBlocks(humanResult?.trim() ? humanResult : n.result) };
    });
  return { verdict: verdict ? { ...verdict, findings_blocks: ownerBlocks(verdict.findings) } : null, nodes, documents: taskDocuments(taskId), branch: taskBranch(taskId) };
}

const VERDICT_RU: Record<string, string> = {
  approved: "принято",
  changes_requested: "вернуть на доработку",
  blocked: "остановить",
};

export function outcomeMarkdown(title: string, outcome: TaskOutcome): string {
  const lines = [`# Итог: ${title}`, ""];
  if (outcome.verdict) {
    lines.push(`## Вердикт проверяющего — ${VERDICT_RU[outcome.verdict.verdict] ?? outcome.verdict.verdict}`, "");
    if (outcome.verdict.findings.trim()) lines.push(outcome.verdict.findings.trim(), "");
  }
  if (outcome.nodes.length) {
    lines.push("## Что сдала каждая роль", "");
    for (const n of outcome.nodes) {
      const who = n.role ? `${roleTitle(n.role)} — ` : "";
      lines.push(`- **${who}${n.title}**${n.result ? `: ${n.result.replace(/\s+/g, " ").trim()}` : ""}`);
    }
    lines.push("");
  }
  for (const [heading, kind] of [["Документы результата", "result"], ["Отчёты о проделанной работе", "report"]] as const) {
    const docs = outcome.documents.filter((d) => d.kind === kind);
    if (!docs.length) continue;
    lines.push(`## ${heading}`, "");
    for (const d of docs) lines.push(`- ${d.title}`);
    lines.push("");
  }
  if (outcome.branch) {
    lines.push("## Код", "", `Ветка \`${outcome.branch.name}\`: ${outcome.branch.ahead} коммит(а), последний \`${outcome.branch.commit}\` — ${outcome.branch.subject}`, "");
  }
  return lines.join("\n").trim() + "\n";
}

/**
 * Итог — заметкой в папку документации проекта карточки. Одна заметка на
 * карточку: новый вердикт её переписывает. У карточки без проекта или у
 * проекта без папки документации писать некуда — null.
 */
export function writeOutcomeNote(taskId: string, authorId: string): string | null {
  const task = db.prepare(
    `SELECT t.title, p.notes_folder_id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
  ).get(taskId) as { title: string; notes_folder_id: number | null } | undefined;
  if (!task || task.notes_folder_id === null || task.notes_folder_id === undefined) return null;
  const markdown = outcomeMarkdown(task.title, buildTaskOutcome(taskId));
  const content = markdownToTiptap(markdown);
  const title = `Итог: ${task.title}`.slice(0, 200);
  const existing = outcomeNoteId(taskId);
  const searchText = noteSearchText(content);
  if (existing) {
    db.prepare("UPDATE user_notes SET title = ?, content = ?, search_text = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, content, searchText, authorId, existing);
    return existing;
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO user_notes (id, title, content, folder_id, updated_by, search_text) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, title, content, task.notes_folder_id, authorId, searchText);
  recordTaskDocument(taskId, id, authorId, "outcome_note");
  return id;
}
