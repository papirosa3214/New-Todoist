/** A submitted result is input for the next role; acceptance records review. */
export type GateArtifact = { status: string; evidence_json: string; note_id?: string | null };
export function normalizePlanStartCondition(condition: string): string {
  return condition === "accepted" ? "submitted" : condition;
}
export function artifactHasEvidence(artifact: Pick<GateArtifact, "evidence_json" | "note_id">): boolean {
  if (artifact.note_id) return true;
  try { const evidence = JSON.parse(artifact.evidence_json); return Array.isArray(evidence) && evidence.length > 0; }
  catch { return false; }
}
export function artifactGateSatisfied(condition: string, artifact: GateArtifact): boolean {
  const gate = normalizePlanStartCondition(condition);
  if (gate !== "submitted" && gate !== "artifact_ready") return false;
  if (artifact.status !== "submitted" && artifact.status !== "accepted") return false;
  return gate !== "artifact_ready" || artifactHasEvidence(artifact);
}
