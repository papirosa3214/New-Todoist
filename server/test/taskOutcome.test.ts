// Итог карточки (владелец 01.10.2026): вердикт, что сдали роли, документы;
// итог — заметкой в папку проекта; документ — в базу знаний по кнопке.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "test-run", completion: Promise.resolve() }) };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { ensureResultVersionForReview } from "../src/resultVersions.js";
import { buildTaskOutcome, recordTaskDocument, writeOutcomeNote } from "../src/lib/taskOutcome.js";
import { pushNoteToKnowledge } from "../src/routes/knowledge.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("итог карточки", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let taskId: string;
  let folderId: number;
  let docId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Outcome owner", email: `outcome-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };

    const project = await app.inject({ method: "POST", url: "/api/projects", headers: ownerAuth, payload: { name: `Проект итога ${Date.now()}`, with_docs: true } });
    const projectId = project.json().id as string;
    folderId = project.json().notes_folder_id as number;
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth, payload: { title: "Фабрика T05", project_id: projectId } });
    taskId = task.json().task.id;
    const plan = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: ownerAuth,
      payload: { profile: "manual", rationale: "тест", nodes: [{ slot_key: "analysis", role_key: "analyst", required: true, expected_result: "Требования и критерии" }], edges: [] },
    });
    const planId = (plan.json().id ?? plan.json().plan?.id) as string;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: ownerAuth });
    db.prepare("UPDATE subtasks SET done = 1, agent_state = NULL, result = 'Согласован DAG T05' WHERE collaboration_plan_id = ?").run(planId);
    const doc = await app.inject({ method: "POST", url: "/api/notes", headers: ownerAuth, payload: { markdown: "# DAG T05\n\nконтракт", folder_id: folderId } });
    docId = doc.json().id;
    recordTaskDocument(taskId, docId, roleUserId("analyst"));
  });

  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function verdict(value: "approved" | "changes_requested", findings: string) {
    const version = ensureResultVersionForReview(taskId, roleUserId("analyst"), "сдано");
    db.prepare(
      `INSERT INTO reviews (id, task_id, version_id, task_revision, reviewer_id, artifact_hash, criteria_version, verdict, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, datetime('now', ?))`,
    ).run(crypto.randomUUID(), taskId, version.id, version.task_revision, roleUserId("critic_verifier"), version.artifact_hash, value, findings, value === "approved" ? "+1 second" : "+0 seconds");
  }

  it("итог собирает вердикт, что сдала роль, и документы карточки", () => {
    verdict("changes_requested", "поправить опечатку");
    const outcome = buildTaskOutcome(taskId);
    expect(outcome.verdict?.verdict).toBe("changes_requested");
    expect(outcome.nodes).toEqual([expect.objectContaining({ role: "analyst", title: "Требования и критерии", result: "Согласован DAG T05", done: true })]);
    expect(outcome.documents.map((d) => d.id)).toEqual([docId]);
  });

  it("итог — заметкой в папку проекта; новый вердикт переписывает ту же заметку", () => {
    const first = writeOutcomeNote(taskId, roleUserId("critic_verifier"))!;
    const note = db.prepare("SELECT title, folder_id FROM user_notes WHERE id = ?").get(first) as { title: string; folder_id: number };
    expect(note).toEqual({ title: "Итог: Фабрика T05", folder_id: folderId });
    verdict("approved", "всё подтверждено тестами");
    expect(writeOutcomeNote(taskId, roleUserId("critic_verifier"))).toBe(first);
    const content = (db.prepare("SELECT content FROM user_notes WHERE id = ?").get(first) as { content: string }).content;
    expect(content).toContain("всё подтверждено тестами");
    expect(content).toContain("Согласован DAG T05");
    const docs = buildTaskOutcome(taskId).documents;
    expect(docs.find((d) => d.id === first)?.is_outcome).toBe(true);
    expect(docs).toHaveLength(2);
  });

  it("GET /api/tasks/:id/outcome", async () => {
    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/outcome`, headers: ownerAuth });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict.verdict).toBe("approved");
  });

  it("в базу знаний: старая копия удаляется, новая с шапкой и именем как у синка", async () => {
    vi.stubEnv("RAGFLOW_TOKEN", "t");
    vi.stubEnv("RAGFLOW_TASKFLOW_DATASET", "ds-default");
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url.includes("/documents?name=")) return new Response(JSON.stringify({ data: { docs: [{ id: "old", name: `taskflow-${docId}.md` }] } }));
      if (init?.method === "POST" && url.endsWith("/documents")) return new Response(JSON.stringify({ data: [{ id: "new-doc" }] }));
      return new Response(JSON.stringify({ code: 0 }));
    }));
    expect(await pushNoteToKnowledge(docId)).toEqual({ dataset: "ds-default", document_id: "new-doc" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "POST", "POST"]);
    expect(String(calls[1].body)).toContain('"old"');
    const file = (calls[2].body as FormData).get("file") as File;
    expect(file.name).toBe(`taskflow-${docId}.md`);
    const text = await file.text();
    expect(text).toContain(`doc_id: "${docId}"`);
    expect(text).toContain("source: taskflow");
    expect(calls[3].url).toContain("/chunks");
  });
});
