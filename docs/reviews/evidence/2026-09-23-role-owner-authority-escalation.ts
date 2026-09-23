import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Reproduces the role-key authority escalation found during the 2026-09-23 audit.
 *
 * Safety properties:
 * - creates an isolated temporary SQLite database;
 * - does not connect to or modify the production database;
 * - removes all temporary files after the run.
 */
async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDir, "../../..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-role-key-audit-"));

  process.env.DB_PATH = path.join(temp, "audit.db");
  process.env.TASKFLOW_RUNS_DIR = path.join(temp, "runs");
  process.env.TASKFLOW_ROLE_PROMPTS_DIR = path.join(temp, "prompts");
  fs.mkdirSync(process.env.TASKFLOW_ROLE_PROMPTS_DIR, { recursive: true });

  const indexUrl = pathToFileURL(path.join(repositoryRoot, "server/src/index.ts")).href;
  const dbUrl = pathToFileURL(path.join(repositoryRoot, "server/src/db.ts")).href;
  const { buildApp } = await import(indexUrl);
  const db = (await import(dbUrl)).default;
  const app = await buildApp();

  try {
    const ownerId = "audit-owner";
    db.prepare(
      "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, 'owner', 'human')",
    ).run(ownerId, "Audit Owner", "role-key-audit@test", "!audit");
    const ownerToken = app.jwt.sign({ id: ownerId });

    const create = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        key: "owner",
        title: "Escalation Probe",
        summary: "audit",
        prompt: "audit",
      },
    });

    const account = db
      .prepare("SELECT id, role, role_key, type FROM users WHERE id = 'role_owner'")
      .get();
    // Подпись JWT с произвольным id не создаёт identity: role_owner в БД
    // отсутствует, поэтому auth обязан отклонить токен.
    const roleJwt = app.jwt.sign({ id: "role_owner" }, { expiresIn: "5m" });
    const privilegedMutation = await app.inject({
      method: "PATCH",
      url: "/api/roles/researcher",
      headers: { authorization: `Bearer ${roleJwt}` },
      payload: { summary: "privileged mutation must be rejected" },
    });

    const result = {
      createStatus: create.statusCode,
      account: account ?? null,
      privilegedMutationStatus: privilegedMutation.statusCode,
      escalationPossible:
        create.statusCode !== 422 || account !== undefined || privilegedMutation.statusCode < 400,
    };
    console.log(JSON.stringify(result));
    if (
      result.createStatus !== 422 ||
      result.account !== null ||
      result.privilegedMutationStatus !== 403 ||
      result.escalationPossible
    ) {
      throw new Error(`P0 regression: ${JSON.stringify(result)}`);
    }
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

void main();
