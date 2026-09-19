import crypto from "crypto";
import db from "./db.js";
import { isReviewer } from "./access.js";

export type EvidenceItem = Record<string, unknown> | string;

export type ResultVersion = {
  id: string;
  task_id: string;
  version_no: number;
  task_revision: number;
  result: string;
  evidence: EvidenceItem[];
  artifact_hash: string;
  created_by: string;
  created_at: string;
};

type VersionRow = Omit<ResultVersion, "evidence"> & { evidence_json: string };

function hydrate(row: VersionRow | undefined): ResultVersion | undefined {
  if (!row) return undefined;
  let evidence: EvidenceItem[] = [];
  try {
    const parsed = JSON.parse(row.evidence_json || "[]");
    if (Array.isArray(parsed)) evidence = parsed as EvidenceItem[];
  } catch {
    evidence = [];
  }
  return { ...row, evidence };
}

function currentRevision(taskId: string): number {
  const task = db
    .prepare("SELECT current_revision FROM tasks WHERE id = ?")
    .get(taskId) as { current_revision?: number } | undefined;
  if (!task) throw new Error("task not found");
  return Number.isInteger(task.current_revision) ? Number(task.current_revision) : 1;
}

function hashResult(
  taskId: string,
  revision: number,
  result: string,
  evidence: EvidenceItem[],
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ taskId, revision, result, evidence }))
    .digest("hex");
}

export function getResultVersion(id: string): ResultVersion | undefined {
  return hydrate(
    db.prepare("SELECT * FROM artifact_versions WHERE id = ?").get(id) as
      | VersionRow
      | undefined,
  );
}

export function listResultVersions(taskId: string): ResultVersion[] {
  return (
    db
      .prepare(
        "SELECT * FROM artifact_versions WHERE task_id = ? ORDER BY version_no ASC",
      )
      .all(taskId) as VersionRow[]
  )
    .map(hydrate)
    .filter((row): row is ResultVersion => Boolean(row));
}

export function latestResultVersion(taskId: string): ResultVersion | undefined {
  return hydrate(
    db
      .prepare(
        "SELECT * FROM artifact_versions WHERE task_id = ? ORDER BY version_no DESC LIMIT 1",
      )
      .get(taskId) as VersionRow | undefined,
  );
}

export function currentResultVersion(taskId: string): ResultVersion | undefined {
  const revision = currentRevision(taskId);
  return hydrate(
    db
      .prepare(
        `SELECT * FROM artifact_versions
          WHERE task_id = ? AND task_revision = ?
          ORDER BY version_no DESC LIMIT 1`,
      )
      .get(taskId, revision) as VersionRow | undefined,
  );
}

export function createResultVersion(params: {
  taskId: string;
  createdBy: string;
  result: string;
  evidence?: EvidenceItem[];
  artifactHash?: string | null;
}): ResultVersion {
  const result = params.result.trim();
  if (!result) throw new Error("result обязателен");
  const evidence = params.evidence ?? [];
  const revision = currentRevision(params.taskId);
  const next =
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(version_no), 0) AS n FROM artifact_versions WHERE task_id = ?",
        )
        .get(params.taskId) as { n: number }
    ).n + 1;
  const artifactHash =
    params.artifactHash?.trim() ||
    hashResult(params.taskId, revision, result, evidence);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO artifact_versions
       (id, task_id, version_no, task_revision, result, evidence_json,
        artifact_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    params.taskId,
    next,
    revision,
    result,
    JSON.stringify(evidence),
    artifactHash,
    params.createdBy,
  );
  return getResultVersion(id)!;
}

/** Create the version for a review round exactly once. */
export function ensureResultVersionForReview(
  taskId: string,
  createdBy: string,
  result: string,
): ResultVersion {
  return currentResultVersion(taskId) ??
    createResultVersion({ taskId, createdBy, result });
}

export function resultFromSubtasks(taskId: string): string {
  const rows = db
    .prepare(
      `SELECT title, result FROM subtasks
        WHERE task_id = ? AND done = 1 ORDER BY position, id`,
    )
    .all(taskId) as Array<{ title: string; result: string | null }>;
  const lines = rows
    .filter((row) => row.result?.trim())
    .map((row) => `${row.title}: ${row.result!.trim()}`);
  return lines.length
    ? lines.join("\n")
    : "Все подзадачи закрыты; результат зафиксирован в карточке.";
}

export function hasApprovedCurrentVersion(taskId: string): boolean {
  const version = currentResultVersion(taskId);
  if (!version) return false;
  const latest = db
    .prepare(
      `SELECT verdict FROM reviews
        WHERE version_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(version.id) as { verdict?: string } | undefined;
  return latest?.verdict === "approved";
}

/**
 * Есть ли одобрение Reviewer для АКТУАЛЬНОЙ версии результата.
 *
 * Сигнал для UI и маршрута, что карточку посмотрел ревьюер. НЕ гейт для
 * владельца: владелец закрывает и без него (AGENT-PROTOCOL.md, «Владелец
 * вне процесса»).
 */
export function hasReviewerApprovedCurrentVersion(taskId: string): boolean {
  const version = currentResultVersion(taskId);
  if (!version) return false;
  const rows = db
    .prepare(
      `SELECT reviewer_id FROM reviews
        WHERE version_id = ? AND verdict = 'approved'`,
    )
    .all(version.id) as { reviewer_id: string }[];
  return rows.some((row) => isReviewer(row.reviewer_id));
}

export function hasAnyResultVersion(taskId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM artifact_versions WHERE task_id = ? LIMIT 1")
      .get(taskId),
  );
}
