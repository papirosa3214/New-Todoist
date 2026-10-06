// Исходящий вебхук для оркестратора (владелец 06.10.2026): сервер сам будит
// оркестратора, а не ждёт, пока тот опросит сторожем.
//
// Устройство без постоянных секретов:
//   • приёмник оркестратора (`scripts/orchestrator/tf_hook_wait.py`) при запуске
//     поднимает HTTP на 127.0.0.1, пишет в реестр-файл адрес и случайный токен
//     (права 0600) и ждёт первых событий; получив, печатает их и завершается;
//   • сервер на КАЖДОЕ важное событие кладёт строку в `orchestrator_events`,
//     а раз в 2 секунды смотрит реестр-файл: есть приёмник — шлёт пачкой
//     POST с токеном; нет — события ждут (не дольше часа), ничего не теряется.
// Включать нечего: нет приёмника — нет отправки.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../db.js";

/** События, ради которых оркестратора стоит будить. */
export const WATCHED_KINDS = new Set([
  "step_outcome",          // любое завершение запуска шага (MAK-96)
  "review_recorded",       // вердикт Критика
  "branch_card_accepted",  // карточка ветки принята и закрыта
  "test_budget_blocked",   // роль упёрлась в лимит полных прогонов
  "subtask_blocked",       // шаг заблокирован ролью
  "plan_subtask_stalled_blocked",
  "model_failover",        // смена модели из-за лимита
]);

export const REGISTRY_FILE =
  process.env.TASKFLOW_ORCHESTRATOR_HOOK_FILE ||
  path.join(os.homedir(), ".local", "state", "taskflow", "orchestrator-hook.json");

const TICK_MS = 2000;
const MAX_AGE_MIN = 60;      // события старше часа не доставляем (их уже разбирали руками)
const BATCH = 50;
const LOG_THROTTLE_MS = 60_000;

/** Положить событие в очередь доставки. Никогда не бросает: побочный эффект. */
export function queueOrchestratorEvent(e: {
  taskId: string;
  kind: string;
  field?: string | null;
  toValue?: string | null;
}): void {
  try {
    if (!WATCHED_KINDS.has(e.kind)) return;
    db.prepare(
      "INSERT INTO orchestrator_events(kind, task_id, field, detail) VALUES (?, ?, ?, ?)",
    ).run(e.kind, e.taskId, e.field ?? null, (e.toValue ?? "").slice(0, 400));
  } catch {
    /* очередь — побочная: событие остаётся в task_events */
  }
}

type Registry = { url: string; token: string };

function readRegistry(): Registry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    if (typeof raw?.url === "string" && typeof raw?.token === "string") {
      // Приёмник убит без уборки: файл остался, процесса нет — считаем, что приёмника нет.
      if (typeof raw.pid === "number") {
        try { process.kill(raw.pid, 0); } catch { return null; }
      }
      return raw;
    }
  } catch {
    /* нет файла — нет приёмника */
  }
  return null;
}

type Row = { id: number; kind: string; task_id: string; field: string | null; detail: string | null; created_at: string; title: string | null };

/** Один проход доставки; вынесен отдельно, чтобы тестировать без таймера. */
export async function deliverOrchestratorEvents(
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; skipped?: "no_receiver" | "failed" | "empty" }> {
  db.prepare(
    `UPDATE orchestrator_events SET delivered_at = datetime('now'), expired = 1
     WHERE delivered_at IS NULL AND created_at < datetime('now', ?)`,
  ).run(`-${MAX_AGE_MIN} minutes`);
  const reg = readRegistry();
  if (!reg) return { sent: 0, skipped: "no_receiver" };
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.task_id, e.field, e.detail, e.created_at, t.title
         FROM orchestrator_events e LEFT JOIN tasks t ON t.id = e.task_id
        WHERE e.delivered_at IS NULL ORDER BY e.id LIMIT ?`,
    )
    .all(BATCH) as Row[];
  if (!rows.length) return { sent: 0, skipped: "empty" };
  try {
    const res = await fetchImpl(reg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({
        events: rows.map(r => ({
          id: r.id, at: r.created_at, kind: r.kind, task_id: r.task_id,
          task_title: r.title, field: r.field, detail: r.detail,
        })),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { sent: 0, skipped: "failed" };
  } catch {
    return { sent: 0, skipped: "failed" };
  }
  const mark = db.prepare("UPDATE orchestrator_events SET delivered_at = datetime('now') WHERE id = ?");
  db.transaction(() => rows.forEach(r => mark.run(r.id)))();
  return { sent: rows.length };
}

/** Запуск фонового цикла доставки; возвращает остановщик. */
export function startOrchestratorWebhook(): () => void {
  let lastLog = 0;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await deliverOrchestratorEvents();
      if (r.skipped === "failed" && Date.now() - lastLog > LOG_THROTTLE_MS) {
        lastLog = Date.now();
        console.warn("orchestrator-webhook: приёмник в реестре есть, но не отвечает; события ждут");
      }
    } catch (error) {
      if (Date.now() - lastLog > LOG_THROTTLE_MS) {
        lastLog = Date.now();
        console.warn("orchestrator-webhook:", error);
      }
    } finally {
      busy = false;
    }
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
