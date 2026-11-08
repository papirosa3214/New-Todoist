/**
 * Живой реестр фоновых задач: реестр + шлюз хоста + итог в переписку.
 *
 * Здесь только проводка. Вся логика состояний — в backgroundJobs.ts (его
 * проверяют тесты без базы), текст итога — в backgroundJobReport.ts.
 *
 * Две тонкости, за которые этот файл и существует:
 *  - сигнал хода НЕ передаём: у задачи свой AbortController, отмена хода ролью
 *    не должна убивать сборку;
 *  - шлюзу даём времени больше, чем хосту, чтобы первым отказывал хост (у него
 *    есть код выхода), а не транспорт.
 */

import { runOperation } from "../host/gateway.js";
import { createBackgroundJobs, type BackgroundJob } from "./backgroundJobs.js";
import { reportBackgroundJobEnd } from "./backgroundJobReport.js";

const GATEWAY_SLACK_MS = 60_000;
const FINAL_STATES = ["done", "failed", "timeout", "stopped", "lost"];

let activityModule: Promise<{ touchTaskActivity: (taskId: string) => void }> | null = null;

/**
 * Пока задача идёт, ход не считается молчащим (сторож тишины в inProcessRun).
 * Динамический импорт обязателен: inProcessRun тянет каталог ролей, а каталог —
 * этот модуль; статический импорт замкнул бы цикл на загрузке.
 */
function markActivity(job: BackgroundJob): void {
  const taskId = job.taskId;
  if (!taskId) return; // у чатового хода сторожа тишины нет
  activityModule ??= import("./inProcessRun.js");
  void activityModule.then((module) => module.touchTaskActivity(taskId)).catch(() => {});
}

const jobs = createBackgroundJobs({
  run: (input) =>
    runOperation(
      input.machineId,
      "bash",
      { command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs },
      { signal: input.signal, onChunk: input.onChunk, timeoutMs: input.timeoutMs + GATEWAY_SLACK_MS },
    ).then((result) => ({
      ok: result.ok,
      exitCode: result.ok ? (result.exitCode ?? 0) : null,
      error: result.ok ? undefined : result.error,
    })),
  onActivity: markActivity,
  onStateChange: (job) => {
    if (FINAL_STATES.includes(job.state)) reportBackgroundJobEnd(job);
  },
});

// Уборка завершённых задач: раз в десять минут, таймер процесс не держит.
const sweeper = setInterval(() => jobs.sweep(), 10 * 60_000);
sweeper.unref?.();

export function backgroundJobs() {
  return jobs;
}
