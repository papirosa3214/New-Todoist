import db from "../db.js";

export type CollaborationArtifactRef = {
  slot_key: string;
  artifact_key: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: unknown[];
};

export type CollaborationPlanContext = {
  status: "ok" | "empty" | "unavailable";
  plan_id: string | null;
  revision: number | null;
  slot_key: string | null;
  predecessor_artifacts: CollaborationArtifactRef[];
};

type SubtaskRow = { id: string; collaboration_plan_id: string | null; plan_node_key: string | null };
type PlanRow = { id: string; revision: number };
type EdgeRow = { from_slot_key: string; start_condition: string; artifact_key: string | null };
type ArtifactRow = { artifact_key: string; summary: string; payload_json: string; evidence_json: string; status: string };

const GATE_STATUSES: Record<string, string[]> = {
  accepted: ["accepted"],
  artifact_ready: ["submitted", "accepted"],
  submitted: ["submitted", "accepted"],
};

function parseObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseArray(text: string): unknown[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * Прямой (не транзитивный) контекст предшественников одного узла плана:
 * только incoming edges с объявленным artifact_key, чей источник сдал
 * артефакт нужного ключа в статусе, достаточном для этого edge gate.
 */
export function buildCollaborationPlanContext(subtaskId: string): CollaborationPlanContext {
  const empty: CollaborationPlanContext = { status: "empty", plan_id: null, revision: null, slot_key: null, predecessor_artifacts: [] };
  try {
    const current = db.prepare("SELECT id, collaboration_plan_id, plan_node_key FROM subtasks WHERE id = ?").get(subtaskId) as SubtaskRow | undefined;
    if (!current) return { ...empty, status: "unavailable" };
    if (!current.collaboration_plan_id || !current.plan_node_key) return empty;
    const plan = db.prepare("SELECT id, revision FROM task_collaboration_plans WHERE id = ?").get(current.collaboration_plan_id) as PlanRow | undefined;
    if (!plan) return { ...empty, status: "unavailable" };

    const edges = db
      .prepare("SELECT from_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ? AND to_slot_key = ? ORDER BY rowid")
      .all(current.collaboration_plan_id, current.plan_node_key) as EdgeRow[];

    const predecessor_artifacts: CollaborationArtifactRef[] = [];
    for (const edge of edges) {
      if (!edge.artifact_key) continue;
      const predecessor = db
        .prepare("SELECT id FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ?")
        .get(current.collaboration_plan_id, edge.from_slot_key) as { id: string } | undefined;
      if (!predecessor) continue;
      const artifact = db
        .prepare("SELECT artifact_key, summary, payload_json, evidence_json, status FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1")
        .get(predecessor.id) as ArtifactRow | undefined;
      if (!artifact || artifact.artifact_key !== edge.artifact_key) continue;
      const allowedStatuses = GATE_STATUSES[edge.start_condition] ?? ["accepted"];
      if (!allowedStatuses.includes(artifact.status)) continue;
      predecessor_artifacts.push({
        slot_key: edge.from_slot_key,
        artifact_key: artifact.artifact_key,
        summary: artifact.summary,
        payload: parseObject(artifact.payload_json),
        evidence: parseArray(artifact.evidence_json),
      });
    }

    return {
      status: predecessor_artifacts.length ? "ok" : "empty",
      plan_id: plan.id,
      revision: plan.revision,
      slot_key: current.plan_node_key,
      predecessor_artifacts,
    };
  } catch {
    return { ...empty, status: "unavailable" };
  }
}
