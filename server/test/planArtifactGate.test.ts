import { describe, expect, it } from "vitest";
import { artifactGateSatisfied, normalizePlanStartCondition } from "../src/runtime/planArtifactGate.js";

describe("Передача результата между ролями", () => {
  it.each(["submitted", "accepted", "artifact_ready"])("%s пропускает сданный документ без приёмки", gate => {
    expect(artifactGateSatisfied(gate, { status: "submitted", evidence_json: "[]", note_id: "document" })).toBe(true);
  });
  it.each(["rejected", "revision_requested"])("%s не запускает следующую роль", status => {
    for (const gate of ["submitted", "accepted", "artifact_ready"])
      expect(artifactGateSatisfied(gate, { status, evidence_json: '[{"path":"proof"}]' })).toBe(false);
  });
  it("artifact_ready требует документ или доказательство, submitted допускает сдачу без ссылок", () => {
    const artifact = { status: "submitted", evidence_json: "[]" };
    expect(artifactGateSatisfied("artifact_ready", artifact)).toBe(false);
    expect(artifactGateSatisfied("submitted", artifact)).toBe(true);
    expect(artifactGateSatisfied("artifact_ready", { ...artifact, evidence_json: '[{"path":"proof"}]' })).toBe(true);
    expect(artifactGateSatisfied("artifact_ready", { ...artifact, evidence_json: "invalid" })).toBe(false);
  });
  it("неизвестное условие закрыто, старое accepted нормализуется", () => {
    expect(artifactGateSatisfied("typo", { status: "accepted", evidence_json: "[]" })).toBe(false);
    expect(normalizePlanStartCondition("accepted")).toBe("submitted");
  });
});
