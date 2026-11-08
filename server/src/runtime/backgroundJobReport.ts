/**
 * Итог фоновой задачи в переписку (решение владельца 08.11.2026).
 *
 * Зачем не «системное сообщение»: строки с message_type='system' вырезаны из
 * истории модели (chatHistoryModel.modelHistorySql), роль увидела бы текст один
 * раз и без контекста. Поэтому пишем обычное сообщение в нить роли — как это
 * делает deliverDigest для ответа субагента — и будим роль ТОЙ ЖЕ связкой:
 * enqueueMessageDelivery пишет строку очереди, а ход поднимает
 * recoverAgentDelivery по id строки очереди.
 *
 * Если карточка без слота, пробуждение молча не сработает (chats.ts:
 * slotChoiceNotice и return null) — тогда итог остаётся в переписке, а роль
 * увидит его следующим ходом; это видно в журнале сервера.
 */

import crypto from "node:crypto";
import db from "../db.js";
import { roleUserId } from "../roleRouting.js";
import { logServerEvent } from "../lib/serverEvents.js";
import { enqueueMessageDelivery } from "./chatQueue.js";
import { BACKGROUND_STATE_TITLES, type BackgroundJob } from "./backgroundJobs.js";

const TAIL_LIMIT = 4_000;
const COMMAND_LIMIT = 160;

function durationText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} мин ${seconds} с` : `${seconds} с`;
}

function tailText(job: BackgroundJob): string {
  if (!job.tail) return "";
  const tail = job.tail.length > TAIL_LIMIT ? job.tail.slice(-TAIL_LIMIT) : job.tail;
  return "\n```\n" + tail.trimEnd() + "\n```";
}

function reportText(job: BackgroundJob): string {
  const command = job.command.length > COMMAND_LIMIT ? job.command.slice(0, COMMAND_LIMIT) + "…" : job.command;
  const head = `Фон: \`${command}\` — ${BACKGROUND_STATE_TITLES[job.state]}, код ${job.exitCode ?? "—"}, ${durationText(job.durationMs)}.`;
  const truncated = job.truncated ? "\nВывод обрезан по потолку — хвост ниже." : "";
  return head + truncated + tailText(job);
}

export function reportBackgroundJobEnd(job: BackgroundJob): void {
  const actorId = roleUserId(job.role);
  try {
    logServerEvent({
      scope: "system",
      kind: "bg_job_end",
      actorId,
      taskId: job.taskId ?? null,
      subtype: job.state,
      message: `фоновая команда: ${BACKGROUND_STATE_TITLES[job.state]}`,
      durationMs: job.durationMs,
      outcome:
        job.state === "done" ? "ok" : job.state === "stopped" ? "cancelled" : job.state === "timeout" ? "timeout" : "err",
      data: {
        jobId: job.id,
        exitCode: job.exitCode,
        machineId: job.machineId,
        cwd: job.cwd,
        worktreeKey: job.worktreeKey,
        bytes: job.bytes,
        truncated: job.truncated,
      },
    });
  } catch {
    // журнал не должен мешать итогу
  }

  if (!job.chatId) return;
  try {
    const messageId = crypto.randomUUID();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)").run(
      messageId,
      actorId,
      reportText(job),
      job.chatId,
    );
    const queued = enqueueMessageDelivery({
      chatId: job.chatId,
      roleId: actorId,
      deliveryId: `bg:${job.id}`,
      messageId,
      payload: { mode: "work", hop: 0 },
    });
    // queueRowId — id СТРОКИ очереди (queued.id), а не delivery_id: именно по
    // колонке id ищет recoverAgentDelivery (грабли deliverDigest, 27.10.2026).
    void import("../routes/chats.js")
      .then(({ recoverAgentDelivery }) =>
        recoverAgentDelivery({ chatId: job.chatId!, roleId: actorId, queueRowId: queued.id }),
      )
      .catch((error) => console.warn("[bg-job] пробуждение роли отложено:", error instanceof Error ? error.message : error));
  } catch (error) {
    console.warn("[bg-job] итог не доставлен:", error instanceof Error ? error.message : error);
  }
}
