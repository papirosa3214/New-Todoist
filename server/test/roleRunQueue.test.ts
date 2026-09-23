import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  claimNextRoleRunJob,
  completeRoleRunJob,
  enqueueRoleRunJob,
  failRoleRunJob,
  getRoleRunJob,
  recoverExpiredRoleRunJobs,
} from "../src/runtime/roleRunQueue.js";
import { processOneRoleRunJob } from "../src/runtime/roleRunWorker.js";

const ownerId = `queue-owner-${crypto.randomUUID()}`;
const createdTasks: string[] = [];

function makeTask(label: string): string {
  const id = `queue-${label}-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tasks (id, title, creator_id, status)
     VALUES (?, ?, ?, 'active')`,
  ).run(id, `Queue ${label}`, ownerId);
  createdTasks.push(id);
  return id;
}

function dedupe(taskId: string, suffix: string): string {
  return `test:${taskId}:${suffix}`;
}

describe("durable role-run queue", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Queue Owner', ?, '!', 'owner', 'human')`,
    ).run(ownerId, `${ownerId}@test`);
    ownerToken = app.jwt.sign({ id: ownerId });
  });

  afterAll(async () => {
    for (const taskId of createdTasks) {
      db.prepare("DELETE FROM role_run_jobs WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    await app.close();
  });

  it("enqueue коммитится вместе с породившей транзакцией и дедуплицируется", () => {
    const taskId = makeTask("atomic");
    const key = dedupe(taskId, "assigned");

    const first = enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      actorId: ownerId,
      dedupeKey: key,
    });
    const second = enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      actorId: ownerId,
      dedupeKey: key,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });

    const rolledBackKey = dedupe(taskId, "rolled-back");
    expect(() =>
      db.transaction(() => {
        enqueueRoleRunJob({
          taskId,
          reason: "commented",
          actorId: ownerId,
          dedupeKey: rolledBackKey,
        });
        throw new Error("rollback probe");
      })(),
    ).toThrow("rollback probe");
    expect(
      db.prepare("SELECT 1 FROM role_run_jobs WHERE dedupe_key = ?").get(rolledBackKey),
    ).toBeUndefined();

    const claimed = claimNextRoleRunJob({ workerId: "atomic-worker" });
    expect(claimed?.id).toBe(first.id);
    completeRoleRunJob({
      jobId: first.id,
      workerId: "atomic-worker",
      status: "succeeded",
    });
  });

  it("claim атомарен и не запускает два job одной задачи одновременно", () => {
    const firstTask = makeTask("serial-a");
    const secondTask = makeTask("serial-b");
    enqueueRoleRunJob({
      taskId: firstTask,
      reason: "assigned",
      dedupeKey: dedupe(firstTask, "1"),
    });
    enqueueRoleRunJob({
      taskId: firstTask,
      reason: "commented",
      dedupeKey: dedupe(firstTask, "2"),
    });
    enqueueRoleRunJob({
      taskId: secondTask,
      reason: "assigned",
      dedupeKey: dedupe(secondTask, "1"),
    });

    const first = claimNextRoleRunJob({ workerId: "worker-a" });
    const parallel = claimNextRoleRunJob({ workerId: "worker-b" });
    expect(first).not.toBeNull();
    expect(parallel).not.toBeNull();
    expect(parallel?.task_id).not.toBe(first?.task_id);

    expect(
      completeRoleRunJob({
        jobId: first!.id,
        workerId: "wrong-worker",
        status: "succeeded",
      }),
    ).toBe(false);
    expect(
      completeRoleRunJob({
        jobId: first!.id,
        workerId: "worker-a",
        status: "succeeded",
      }),
    ).toBe(true);
    expect(
      completeRoleRunJob({
        jobId: parallel!.id,
        workerId: "worker-b",
        status: "succeeded",
      }),
    ).toBe(true);

    const next = claimNextRoleRunJob({ workerId: "worker-c" });
    expect(next?.task_id).toBe(firstTask);
    completeRoleRunJob({
      jobId: next!.id,
      workerId: "worker-c",
      status: "succeeded",
    });
  });

  it("просроченный lease восстанавливается и сохраняет число попыток", () => {
    const taskId = makeTask("recovery");
    const job = enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      dedupeKey: dedupe(taskId, "lease"),
    });
    const claimed = claimNextRoleRunJob({
      workerId: "crashed-worker",
      leaseSeconds: 0,
    });
    expect(claimed?.id).toBe(job.id);
    expect(recoverExpiredRoleRunJobs()).toBeGreaterThanOrEqual(1);
    expect(getRoleRunJob(job.id)?.status).toBe("queued");

    const recovered = claimNextRoleRunJob({ workerId: "replacement-worker" });
    expect(recovered).toMatchObject({ id: job.id, attempts: 2, status: "running" });
    completeRoleRunJob({
      jobId: job.id,
      workerId: "replacement-worker",
      status: "succeeded",
    });
  });

  it("ошибка проходит retry_wait и после лимита становится dead", () => {
    const taskId = makeTask("retry");
    const job = enqueueRoleRunJob({
      taskId,
      reason: "review",
      dedupeKey: dedupe(taskId, "retry"),
      maxAttempts: 2,
    });

    const first = claimNextRoleRunJob({ workerId: "retry-worker" });
    expect(first?.id).toBe(job.id);
    expect(
      failRoleRunJob({
        jobId: job.id,
        workerId: "retry-worker",
        error: new Error("temporary provider failure"),
        retryDelaySeconds: 0,
      }),
    ).toBe("retry_wait");

    const second = claimNextRoleRunJob({ workerId: "retry-worker" });
    expect(second).toMatchObject({ id: job.id, attempts: 2 });
    expect(
      failRoleRunJob({
        jobId: job.id,
        workerId: "retry-worker",
        error: new Error("permanent provider failure"),
      }),
    ).toBe("dead");
    expect(getRoleRunJob(job.id)).toMatchObject({
      status: "dead",
      attempts: 2,
      last_error: "permanent provider failure",
    });
  });

  it("worker ждёт executor и только затем завершает job", async () => {
    const taskId = makeTask("worker-success");
    const job = enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      dedupeKey: dedupe(taskId, "worker"),
    });
    const seen: string[] = [];

    expect(
      await processOneRoleRunJob({
        workerId: "worker-success",
        executor: async (claimed) => {
          expect(getRoleRunJob(claimed.id)?.status).toBe("running");
          seen.push(claimed.id);
          return { outcome: "succeeded" };
        },
      }),
    ).toBe(true);
    expect(seen).toEqual([job.id]);
    expect(getRoleRunJob(job.id)?.status).toBe("succeeded");
  });

  it("worker записывает terminal failure как dead", async () => {
    const taskId = makeTask("worker-dead");
    const job = enqueueRoleRunJob({
      taskId,
      reason: "review",
      dedupeKey: dedupe(taskId, "worker-dead"),
      maxAttempts: 1,
    });

    await processOneRoleRunJob({
      workerId: "worker-dead",
      executor: async () => {
        throw new Error("executor crashed");
      },
    });
    expect(getRoleRunJob(job.id)).toMatchObject({
      status: "dead",
      last_error: "executor crashed",
    });
  });

  it("временная недоступность откладывает job без расходования попытки", async () => {
    const taskId = makeTask("worker-deferred");
    const job = enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      dedupeKey: dedupe(taskId, "worker-deferred"),
    });

    await processOneRoleRunJob({
      workerId: "worker-deferred",
      executor: async () => ({
        outcome: "deferred",
        reason: "autonomous system is disabled",
        delaySeconds: 60,
      }),
    });
    expect(getRoleRunJob(job.id)).toMatchObject({
      status: "retry_wait",
      attempts: 0,
      last_error: "autonomous system is disabled",
    });
  });

  it("владелец видит очередь, отменяет pending и повторяет terminal job", async () => {
    const taskId = makeTask("owner-api");
    const queued = enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      dedupeKey: dedupe(taskId, "owner-api"),
    });
    const auth = { authorization: `Bearer ${ownerToken}` };

    const listed = await app.inject({
      method: "GET",
      url: `/api/role-run-jobs?task_id=${taskId}`,
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().jobs).toEqual([
      expect.objectContaining({ id: queued.id, status: "queued" }),
    ]);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/role-run-jobs/${queued.id}/cancel`,
      headers: auth,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().job.status).toBe("cancelled");

    const retried = await app.inject({
      method: "POST",
      url: `/api/role-run-jobs/${queued.id}/retry`,
      headers: auth,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().job.status).toBe("queued");

    const running = claimNextRoleRunJob({ workerId: "owner-api-worker" });
    expect(running?.id).toBe(queued.id);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/role-run-jobs/${queued.id}/cancel`,
      headers: auth,
    });
    expect(conflict.statusCode).toBe(409);
    completeRoleRunJob({
      jobId: queued.id,
      workerId: "owner-api-worker",
      status: "succeeded",
    });
  });
});
