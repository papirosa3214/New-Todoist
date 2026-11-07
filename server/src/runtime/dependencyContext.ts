import db from "../db.js";
import { contextVersionOf } from "./taskContextVersion.js";

const MAX_DEPENDENCIES = 12;
const MAX_RESULT_CHARS = 700;
const MAX_ROOT_NOTES = 3;
const MAX_NOTE_CHARS = 360;

export type DependencyContext = {
  status: "ok" | "empty" | "unavailable";
  version: number;
  root: { task_id: string; title: string; goal: string; recent_comments: string[] } | null;
  dependencies: Array<{ task_id: string; title: string; status: string; agent_state: string | null; result: string | null; artifact_refs: string[] }>;
  open_questions: string[];
};

type TaskRow = { id: string; title: string; description: string | null; parent_id: string | null; status: string; agent_state: string | null };

const clip = (value: unknown, limit: number): string => {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

function taskRow(taskId: string): TaskRow | undefined {
  return db.prepare("SELECT id, title, description, parent_id, status, agent_state FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
}

function rootFor(task: TaskRow): TaskRow {
  const seen = new Set<string>();
  let current = task;
  while (current.parent_id) {
    if (seen.has(current.id)) throw new Error("цикл в parent_id");
    seen.add(current.id);
    const parent = taskRow(current.parent_id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function recentRootComments(taskId: string): string[] {
  return (db.prepare("SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(taskId, MAX_ROOT_NOTES) as Array<{ text: string }>)
    .map((row) => clip(row.text, MAX_NOTE_CHARS)).filter(Boolean);
}

function artifactFor(taskId: string): { result: string | null; artifact_refs: string[] } {
  const row = db.prepare("SELECT result, evidence_json FROM artifact_versions WHERE task_id = ? ORDER BY version_no DESC LIMIT 1").get(taskId) as { result: string; evidence_json: string } | undefined;
  if (!row) return { result: null, artifact_refs: [] };
  let evidence: unknown[] = [];
  try { const parsed = JSON.parse(row.evidence_json || "[]"); evidence = Array.isArray(parsed) ? parsed : []; } catch { evidence = []; }
  const artifact_refs = evidence.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const value = item as Record<string, unknown>;
    return String(value.path ?? value.url ?? value.file ?? value.reference ?? "");
  }).map((value) => clip(value, 240)).filter(Boolean).slice(0, 4);
  return { result: clip(row.result, MAX_RESULT_CHARS) || null, artifact_refs };
}

/** Корень карточки и только транзитивные предшественники из dependency graph. */
export function buildDependencyContext(taskId: string): DependencyContext {
  const empty: DependencyContext = { status: "empty", version: 1, root: null, dependencies: [], open_questions: [] };
  try {
    const task = taskRow(taskId);
    if (!task) return { ...empty, status: "unavailable", open_questions: ["карточка не найдена"] };
    const root = rootFor(task);
    const version = contextVersionOf(task.id);
    const dependencies: DependencyContext["dependencies"] = [];
    const seen = new Set<string>([taskId]);
    const queue = (db.prepare("SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id").all(taskId) as Array<{ id: string }>).map((row) => row.id);
    for (let index = 0; index < queue.length && dependencies.length < MAX_DEPENDENCIES; index += 1) {
      const dependencyId = queue[index];
      if (seen.has(dependencyId)) continue;
      seen.add(dependencyId);
      const dependency = taskRow(dependencyId);
      if (!dependency) continue;
      const artifact = artifactFor(dependency.id);
      dependencies.push({ task_id: dependency.id, title: dependency.title, status: dependency.status, agent_state: dependency.agent_state, result: artifact.result, artifact_refs: artifact.artifact_refs });
      const predecessors = db.prepare("SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY created_at, depends_on_task_id").all(dependency.id) as Array<{ id: string }>;
      queue.push(...predecessors.map((row) => row.id));
    }
    return {
      ...empty,
      version,
      status: dependencies.length || root.id !== task.id ? "ok" : "empty",
      root: { task_id: root.id, title: root.title, goal: clip(root.description || root.title, MAX_RESULT_CHARS), recent_comments: recentRootComments(root.id) },
      dependencies,
    };
  } catch (error) {
    return { ...empty, status: "unavailable", open_questions: [clip(error instanceof Error ? error.message : error, 180)] };
  }
}
