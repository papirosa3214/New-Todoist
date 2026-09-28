import crypto from "node:crypto";
import {
  claimNextRoleRunJob,
  completeRoleRunJob,
  deferRoleRunJob,
  failRoleRunJob,
  recoverExpiredRoleRunJobs,
  renewRoleRunJob,
  type RoleRunJob,
} from "./roleRunQueue.js";
import { kickRoleTaskStrict } from "./inProcessRun.js";

export type RoleRunExecutor = (
  job: RoleRunJob,
) => Promise<
  | { outcome: "succeeded" | "skipped" }
  | { outcome: "deferred"; reason: string; delaySeconds: number }
>;

async function defaultExecutor(
  job: RoleRunJob,
): ReturnType<RoleRunExecutor> {
  const result = await kickRoleTaskStrict(
    job.task_id,
    job.reason,
    job.actor_id,
    { durableHandoff: true, chainDepth: job.chain_depth, manualStart: job.manual_start === 1 },
  );
  if (result.outcome === "skipped") return { outcome: "skipped" };
  if (result.outcome === "deferred") return result;
  await result.completion;
  return { outcome: "succeeded" };
}

/**
 * Забрать и полностью обработать один job. Возвращает false, если очередь
 * сейчас пуста. Экспорт нужен и worker loop, и изолированным тестам.
 */
export async function processOneRoleRunJob(input: {
  workerId: string;
  executor?: RoleRunExecutor;
  leaseSeconds?: number;
  heartbeatMs?: number;
}): Promise<boolean> {
  const leaseSeconds = Math.max(2, Math.floor(input.leaseSeconds ?? 120));
  const job = claimNextRoleRunJob({
    workerId: input.workerId,
    leaseSeconds,
  });
  if (!job) return false;

  const heartbeatMs = Math.max(
    250,
    Math.floor(input.heartbeatMs ?? (leaseSeconds * 1000) / 3),
  );
  const heartbeat = setInterval(() => {
    renewRoleRunJob({
      jobId: job.id,
      workerId: input.workerId,
      leaseSeconds,
    });
  }, heartbeatMs);
  heartbeat.unref();

  try {
    const result = await (input.executor ?? defaultExecutor)(job);
    if (result.outcome === "deferred") {
      deferRoleRunJob({
        jobId: job.id,
        workerId: input.workerId,
        reason: result.reason,
        delaySeconds: result.delaySeconds,
      });
    } else {
      completeRoleRunJob({
        jobId: job.id,
        workerId: input.workerId,
        status: result.outcome,
      });
    }
  } catch (error) {
    failRoleRunJob({
      jobId: job.id,
      workerId: input.workerId,
      error,
    });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

let stopCurrentWorker: (() => Promise<void>) | null = null;

/**
 * Запустить один последовательный worker внутри реального server process.
 * buildApp() сам его не запускает: unit tests и app.inject не создают фоновых
 * исполнителей. Main вызывает функцию только после успешного app.listen().
 */
export function startRoleRunWorker(options?: {
  pollMs?: number;
  workerId?: string;
  executor?: RoleRunExecutor;
}): () => Promise<void> {
  if (stopCurrentWorker) return stopCurrentWorker;

  const workerId =
    options?.workerId ??
    `server-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const pollMs = Math.max(100, Math.floor(options?.pollMs ?? 1000));
  let stopping = false;
  let loop: Promise<void> | null = null;

  recoverExpiredRoleRunJobs();

  const tick = (): void => {
    if (stopping || loop) return;
    loop = (async () => {
      // За один tick вычерпываем готовую очередь. Worker последовательный:
      // текущий SQLite/server deployment не должен внезапно умножить LLM runs.
      while (!stopping) {
        const handled = await processOneRoleRunJob({
          workerId,
          executor: options?.executor,
        });
        if (!handled) break;
      }
    })()
      .catch((error) => {
        console.warn("[role-run-worker] tick failed:", error);
      })
      .finally(() => {
        loop = null;
      });
  };

  tick();
  const timer = setInterval(tick, pollMs);
  timer.unref();

  stopCurrentWorker = async () => {
    stopping = true;
    clearInterval(timer);
    if (loop) await loop;
    stopCurrentWorker = null;
  };
  return stopCurrentWorker;
}
