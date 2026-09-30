// «Система» — единый переключатель серверной автоматики, без запуска старого trigger.
import type { FastifyInstance } from "fastify";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { authOrApiToken } from "../auth.js";
import db from "../db.js";
import { isOwner, isOrchestrator } from "../access.js";

const run = promisify(execFile);

// Единое сохранённое разрешение на автоматическую работу сервера.
// automatic = «Система» включена, manual = только явные запуски владельца.
// Старый systemd-trigger не запускаем и не используем как gate ролей.
export async function unitState(): Promise<{
  active: boolean; enabled: boolean; last_alive_at: string | null;
  next_scan_at: string | null; scan_interval_sec: number;
}> {
  const owner = db.prepare("SELECT task_intake_mode FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as {task_intake_mode?: string} | undefined;
  const on = owner?.task_intake_mode === "automatic";
  return { active: on, enabled: on, last_alive_at: null, next_scan_at: null, scan_interval_sec: 0 };
}

const SCHEDULER_HEARTBEAT = join(
  homedir(),
  ".local/state/taskflow-scheduler/last-run.json",
);

/** Состояние планировщика (taskflow-scheduler.timer) — отдельная лампа:
 *  воркер живёт независимо от будильника и делает расписание и повторы. */
async function schedulerState(): Promise<{
  active: boolean;
  last_run_at: string | null;
  handled: Record<string, unknown>;
}> {
  // С 01.10.2026 планировщик живёт внутри сервера (runtime/scheduler.ts),
  // systemd-таймера у него нет: живой — если отметка обхода свежая (обход
  // раз в 5 минут, 15 минут — три пропуска подряд).
  let active = false;
  let lastRunAt: string | null = null;
  let handled: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULER_HEARTBEAT, "utf8"));
    lastRunAt =
      typeof parsed?.at_epoch === "number"
        ? new Date(parsed.at_epoch).toISOString()
        : null;
    active = typeof parsed?.at_epoch === "number" && Date.now() - parsed.at_epoch < 15 * 60 * 1000;
    handled = parsed ?? {};
  } catch {
    lastRunAt = null;
  }
  return { active, last_run_at: lastRunAt, handled };
}

/** Отложенные карточки: созданы, пока «Система» была выключена, и с тех
 *  пор ни разу не пытались взлететь (без исполнителя, флаг не поднят,
 *  не контейнер — у контейнеров работу делают дети). Включение «Системы»
 *  подбирает им роль и раздаёт тем же путём, что и новой карточке —
 *  владелец 30.09.2026: тумблер должен быть разрешением на будущее И
 *  прошлое разом, а не окном, которое нужно поймать точно в момент
 *  создания карточки («мало ли что случилось... никто не стартанет уже»).
 */
async function sweepStragglers(actorId: string): Promise<void> {
  const { applyIntakeToNewTask } = await import("./dispatch.js");
  const stragglers = db
    .prepare(
      `SELECT id FROM tasks
        WHERE status = 'active'
          AND assignee_id IS NULL
          AND ready_for_pickup = 0
          AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id)
        ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string }>;
  for (const row of stragglers) {
    await applyIntakeToNewTask(row.id, actorId);
  }
}

export function registerAgentServiceRoutes(app: FastifyInstance) {
  app.get(
    "/api/agent-service",
    { preHandler: authOrApiToken },
    async () => ({ ...(await unitState()), scheduler: await schedulerState() }),
  );

  // Завершённые повторяющиеся карточки, по которым ещё не создано
  // следующее вхождение — их добирает планировщик («одна за раз»).
  app.get(
    "/api/scheduler/recurring",
    { preHandler: authOrApiToken },
    async () =>
      db
        .prepare(
          `SELECT id, title, description, due_date, start_time, project_id,
                  assignee_id, run_repeat, repeat_until
             FROM tasks
            WHERE status = 'completed'
              AND run_repeat IS NOT NULL AND run_repeat != 'none'
              AND COALESCE(recurrence_spawned, 0) = 0`,
        )
        .all(),
  );

  // Отложенные технические повторы. attempt_retries.scheduled_at пишется
  // в /api/tasks/:id/stop (reason_code='technical_failure'), но раньше его
  // никто не читал — повтор не поднимался. Планировщик забирает назревшие
  // повторы ЗДЕСЬ, атомарно и с отметкой fired_at, и по каждому поднимает
  // заход (scripts/scheduler.py, ветка 6). Отметка делает выборку
  // идемпотентной: следующий обход доски тот же повтор уже не отдаст.
  app.post(
    "/api/scheduler/deferred-retries/claim",
    { preHandler: authOrApiToken },
    async () => {
      const claim = db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT r.id AS retry_id, r.attempt_id, r.reason_code,
                    r.retry_no, r.scheduled_at, t.id AS task_id
               FROM attempt_retries r
               JOIN attempts a ON a.id = r.attempt_id
               JOIN tasks t ON t.id = a.task_id
              WHERE r.fired_at IS NULL
                AND r.scheduled_at <= datetime('now')
                AND a.ended_at IS NULL
                AND t.current_attempt_id = a.id
                AND t.status = 'active'
                AND t.agent_state = 'in_progress'
              ORDER BY r.scheduled_at ASC`,
          )
          .all() as Array<{
          retry_id: string;
          attempt_id: string;
          reason_code: string;
          retry_no: number;
          scheduled_at: string;
          task_id: string;
        }>;
        const mark = db.prepare(
          "UPDATE attempt_retries SET fired_at = datetime('now') " +
            "WHERE id = ? AND fired_at IS NULL",
        );
        return rows.filter((row) => mark.run(row.retry_id).changes > 0);
      });
      return { retries: claim() };
    },
  );

  app.post<{ Body: { on?: boolean } }>(
    "/api/agent-service",
    // Шаг 5 ТЗ docs/taskflow-direct-dispatch-mvp.md: владелец может
    // включать/выключать службу. Агентский API-token не должен иметь такой
    // ручки.
    //
    // Расширение 11.09.2026 (карточка b6b57092, согласовано с владельцем):
    // тумблер автономки также доступен учётке с role='orchestrator' — это
    // узкая строка матрицы прав, а не пересмотр решения 08.09.2026 об
    // оркестраторе (закрытие/возврат задачи остаются только за владельцем).
    // Сторож по-прежнему не имеет права — учётки типа 'ai' сюда не пройдут
    // уже на authOrApiToken (там стоит проверка на DELETE для всех ИИ, а
    // /api/agent-service — не DELETE, но agent-токен всё равно отбивается
    // дальше isOwner/isOrchestrator).
    //
    // authOrApiToken на успехе возвращает undefined и ставит userId в req
    // (см. auth.ts:172-201). reply.sent=true означает «уже ответили 401» —
    // дальше идти некуда. Иначе — берём userId из req и проверяем
    // isOwner() / isOrchestrator() из access.ts.
    {
      preHandler: async (req: any, reply) => {
        await authOrApiToken(req, reply);
        if (reply.sent) return;
        const userId = (req as any).userId;
        if (!userId || (!isOwner(userId) && !isOrchestrator(userId))) {
          return reply.code(403).send({ error: "owner_or_orchestrator_only" });
        }
      },
    },
    async (req: any, reply) => {
      if (typeof req.body?.on !== "boolean") {
        return reply.code(400).send({ error: "Ожидается поле on: true|false" });
      }

      const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as {id:string} | undefined;
      if (!owner) return reply.code(404).send({ error: "владелец не найден" });
      const wasOn = (await unitState()).active;
      db.prepare("UPDATE users SET task_intake_mode=? WHERE id=?").run(req.body.on ? "automatic" : "manual", owner.id);

      // Только на переходе выкл→вкл: подбор роли зовёт модель, гонять его
      // на каждый повторный POST с on:true было бы лишней нагрузкой и
      // риском переписать то, что уже раздано. Ждём здесь же (не фоном):
      // если процесс упадёт посреди фонового разбора, зависшие карточки
      // так и останутся зависшими без повторной попытки — а тумблер в
      // приложении и так уже показывает "isTogglingService" на время
      // запроса, лишняя секунда-другая на разбор очереди не заметна.
      if (req.body.on && !wasOn) {
        const actorId = (req as any).userId ?? owner.id;
        try {
          await sweepStragglers(actorId);
        } catch (err) {
          app.log.error({ err }, "agent-service: не удалось разобрать отложенные карточки при включении «Системы»");
        }
      }

      return { ok: true, ...(await unitState()) };
    },
  );
}
