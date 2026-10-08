import crypto from "node:crypto";
import { getSetting } from "../lib/serverSettings.js";
import {
  claimNextRoleRunJob,
  completeRoleRunJob,
  deferRoleRunJob,
  failRoleRunJob,
  recoverExpiredRoleRunJobs,
  renewRoleRunJob,
  type RoleRunJob,
} from "./roleRunQueue.js";
import { kickRoleTaskStrict, sweepStaleInProcessRuns } from "./inProcessRun.js";

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
  // Владелец 05.10.2026: до трёх запусков одновременно (было строго по одному —
  // проверки стояли в очереди за длинными задачами). Каждая «полоса» берёт
  // задание через claimNextRoleRunJob — он атомарен и не даёт одной задаче
  // два параллельных запуска. Число полос — ROLE_RUN_CONCURRENCY.
  const lanes = 8;
  const loops: Array<Promise<void> | null> = Array.from({ length: lanes }, () => null);

  recoverExpiredRoleRunJobs();

  // Тишина в in-process запусках (владелец 05.10.2026, п.9 части II
  // taskflow-flow.md). pollMs по умолчанию 1 сек, так что при каждом тике
  // пробегаемся по активным запускам; полная стоимость — пара SQL-запросов.
  const staleSweep = async (): Promise<void> => {
    if (stopping) return;
    try {
      const aborted = await sweepStaleInProcessRuns();
      if (aborted.length > 0) {
        console.warn(`[role-run-worker] прервал ${aborted.length} зависших заходов по тишине`);
      }
    } catch (error) {
      console.warn("[role-run-worker] sweepStaleInProcessRuns упал:", error);
    }
  };

  const tick = (): void => {
    if (stopping) return;
    void staleSweep();
    for (let lane = 0; lane < getSetting("role_run_concurrency"); lane++) {
      if (loops[lane]) continue;
      loops[lane] = (async () => {
        while (!stopping && lane < getSetting("role_run_concurrency")) {
          const handled = await processOneRoleRunJob({
            workerId: lanes > 1 ? `${workerId}-${lane}` : workerId,
            executor: options?.executor,
          });
          if (!handled) break;
        }
      })()
        .catch((error) => {
          console.warn("[role-run-worker] tick failed:", error);
        })
        .finally(() => {
          loops[lane] = null;
        });
    }
  };

  tick();
  const timer = setInterval(tick, pollMs);
  timer.unref();

  stopCurrentWorker = async () => {
    stopping = true;
    clearInterval(timer);
    await Promise.all(loops.filter(Boolean));
    stopCurrentWorker = null;
  };
  return stopCurrentWorker;
}
