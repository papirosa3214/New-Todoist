// Тик рутин: создание карточки из шаблона и подъём роли.
//
// Вариант B из заметки «Рутины и расписание TaskFlow» (раздел «Этап 1»):
// отдельный модуль server/src/runtime/schedules/, который дёргается из
// общего планировщика (runtime/scheduler.ts) одним тиком.
//
// Поток рутины: в назначенное время из task_payload создаётся НОВАЯ
// карточка (обычный конвейер POST /api/tasks → план → роль → ревью),
// затем поднимается назначенная роль. Запуск по расписанию идёт
// служебной учёткой планировщика (SCHEDULER_USER_ID).

import type { FastifyInstance } from "fastify";
import db from "../../db.js";
import { logEvent } from "../../agentState.js";
import { SCHEDULER_USER_ID } from "../../serviceUser.js";
import { startSingleExecutorPlan } from "../../routes/task-collaboration-plans.js";
import { ROLE_NAMES, roleUserId } from "../../roleRouting.js";
import {
  decideRun,
  nextRunAfter,
  type ScheduleRule,
} from "./rules.js";
import { resolveLabelIds } from "./labels.js";
import { routinesEnabled, routinesTickEnabled } from "./feature.js";
import {
  anchorFromCreatedAt,
  claimRun,
  currentInstanceOpen,
  listSchedules,
  markScheduleRun,
  parsePayload,
  parseUtc,
  ruleOf,
  toUtcIso,
  updateRun,
  type ScheduleRow,
} from "./store.js";

type Api = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => Promise<any>;

/**
 * Внутренний вход с JWT на 5 минут.
 *
 * userId — от чьего имени идёт вызов. Для создания карточки это владелец
 * рутины (created_by): служебная учётка «Система» не имеет права класть
 * задачу в проект владельца (ручка /api/tasks проверяет права по проекту),
 * и карточка рутины с проектом просто не создалась бы. Подъём роли идёт
 * от служебной учётки планировщика — как и требует спека.
 */
function makeApi(app: FastifyInstance, userId: string = SCHEDULER_USER_ID): Api {
  return async (method, url, body) => {
    const token = app.jwt.sign(
      { id: userId, internalService: "scheduler" },
      { expiresIn: "5m" },
    );
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as any } : {}),
    });
    let data: any = {};
    try {
      data = res.body ? JSON.parse(res.body) : {};
    } catch {
      data = { text: res.body };
    }
    return res.statusCode >= 400
      ? { error: data?.error ?? res.body, code: res.statusCode }
      : data;
  };
}

export interface ScheduleTickCounts {
  /** Запусков, где карточка создана. */
  created: number;
  /** Пропусков (не время / просрочено / прошлый экземпляр не закрыт). */
  skipped: number;
  /** Ошибок запуска (карточка создана, роль не поднялась, или создание упало). */
  failed: number;
}

export interface ScheduleTickOptions {
  now?: Date;
  /** Только одна рутина — для тестов и ручного запуска. */
  scheduleId?: string;
  /**
   * Ручной запуск вне расписания: слот запуска — «сейчас», а не
   * next_run_at, поэтому расписание не съедается. Перекрытие и окно
   * догона здесь не действуют: владелец сказал «запусти сейчас».
   */
  force?: boolean;
}

function ruleFor(row: ScheduleRow): ScheduleRule {
  return ruleOf(row, anchorFromCreatedAt(row));
}

/**
 * Один проход по рутинам. Для каждой активной рутины, у которой
 * next_run_at наступил:
 *  - окно догона и правило наложения решают, создаём карточку или нет;
 *  - создание карточки идёт обычной ручкой POST /api/tasks (тот же
 *    конвейер, что у живых задач), затем поднимается роль;
 *  - UNIQUE(schedule_id, run_at) не даёт второму проходу в то же окно
 *    создать вторую карточку.
 */
export async function runSchedulesTick(
  app: FastifyInstance,
  options: ScheduleTickOptions = {},
): Promise<ScheduleTickCounts> {
  const now = options.now ?? new Date();
  const counts: ScheduleTickCounts = { created: 0, skipped: 0, failed: 0 };

  // Выключатели рутин: общий гасит всё (создание, правка, запуск), а
  // выключатель запуска по расписанию оставляет ручной запуск («Запустить
  // сейчас»). Откат делается переменной окружения, без новой выкладки.
  if (!routinesEnabled()) return counts;
  if (!options.force && !routinesTickEnabled()) return counts;

  // Срабатывание по расписанию берёт только активные рутины: пауза
  // останавливает создание карточек (критерий приёмки 12 из спеки).
  const schedules = listSchedules().filter((row) => {
    if (options.scheduleId && row.id !== options.scheduleId) return false;
    return row.status === "active";
  });

  for (const row of schedules) {
    const nextRunAt = parseUtc(row.next_run_at);
    if (!nextRunAt && !options.force) continue;
    const rule = ruleFor(row);
    const overlapOpen =
      row.overlap_policy === "skip" && currentInstanceOpen(row);
    const decision = options.force
      ? { action: "run" as const, runAt: now }
      : decideRun({
          now,
          nextRunAt: nextRunAt!,
          catchUp: row.catch_up === 1,
          overlapOpen,
        });
    if (decision.action === "skip") {
      // «Ещё не время» — это не пропуск: рутина просто ждёт своего часа.
      // В счётчик попадают только реально закрытые слоты (наложение,
      // окно догона) — иначе лампа в «Состоянии системы» горела бы
      // постоянно.
      if (decision.reason !== "ещё не время") counts.skipped += 1;
      // Пропуск из-за догона или наложения — слот всё равно закрываем:
      // иначе рутина застрянет на этом же запуске навсегда.
      if (decision.reason !== "ещё не время") {
        const claimed = claimRun({ scheduleId: row.id, runAt: decision.runAt });
        if (claimed.created) {
          updateRun({
            scheduleId: row.id,
            runAt: decision.runAt,
            status: "skipped",
            detail: decision.reason ?? null,
          });
        }
        // Следующий запуск считаем ОТ ТЕПЕРЬШНЕГО МОМЕНТА: если бы мы
        // считали от старого next_run_at, рутина цепляла бы тот же
        // просроченный слот снова и снова (критерий приёмки 5 из спеки:
        // next_run_at после пересчёта всегда в будущем).
        const next = nextRunAfter(rule, now);
        markScheduleRun(row.id, { nextRunAt: next });
      }
      continue;
    }

    // Идемпотентность: слот (schedule_id, run_at) уже занят — второй проход
    // планировщика в это окно не создаёт ничего нового.
    const claimed = claimRun({ scheduleId: row.id, runAt: decision.runAt });
    if (!claimed.created) {
      counts.skipped += 1;
      continue;
    }

    const payload = parsePayload(row);
    const role = String(payload.assignee_id ?? "").trim();
    if (role && !ROLE_NAMES.includes(role)) {
      updateRun({
        scheduleId: row.id,
        runAt: decision.runAt,
        status: "failed",
        detail: `неизвестная роль «${role}»`,
      });
      counts.failed += 1;
      const next = nextRunAfter(rule, now);
      markScheduleRun(row.id, { nextRunAt: next });
      continue;
    }

    // Метки в шаблоне заданы именами, а ручка создания карточки ждёт
    // идентификаторы: переводим имена в метки владельца рутины. Метку,
    // которую удалили после создания рутины, пропускаем и пишем в историю.
    const labels = resolveLabelIds(payload.labels ?? [], row.created_by);

    const created = await makeApi(app, row.created_by)("POST", "/api/tasks", {
      title: payload.title || row.title,
      description: payload.description ?? undefined,
      project_id: payload.project_id ?? undefined,
      priority: payload.priority ?? undefined,
      duration_min: payload.duration_min ?? undefined,
      label_ids: labels.ids.length ? labels.ids : undefined,
      requires_reviewer_review: payload.requires_reviewer_review ?? undefined,
      needs_research: payload.needs_research ?? undefined,
    });

    const taskId = created?.task?.id ?? created?.id ?? null;
    if (!taskId) {
      updateRun({
        scheduleId: row.id,
        runAt: decision.runAt,
        status: "failed",
        detail: `карточка не создана: ${created?.error ?? "неизвестная причина"}`,
      });
      counts.failed += 1;
      const next = nextRunAfter(rule, now);
      markScheduleRun(row.id, { nextRunAt: next });
      continue;
    }

    // Роль поднимается тем же входом, что и в ветке 4 планировщика:
    // карточка получает узел плана с этой ролью и роль стартует.
    //
    // system:false — запуск рутины это явное поручение владельца («в это
    // время сделай»), а не автоприём: тумблер «Система» на рутины не
    // влияет. Карточка уходит обычному конвейеру — план из одного шага,
    // роль, ревью.
    let roleStarted = false;
    let roleError: string | null = null;
    if (role) {
      const outcome = await startSingleExecutorPlan(taskId, SCHEDULER_USER_ID, {
        roleKey: role,
        expectedResult: payload.title || row.title,
        rationale: `рутина «${row.title}» — запуск по расписанию`,
        system: false,
      });
      if (outcome.ok) {
        roleStarted = true;
      } else {
        roleError = outcome.error;
      }
    }

    if (role && !roleStarted) {
      // Карточка создана, роль не поднялась — это ошибка запуска, а не
      // тихий пропуск: пишем в историю и в ленту карточки.
      updateRun({
        scheduleId: row.id,
        runAt: decision.runAt,
        status: "error",
        detail: roleError,
        taskId,
      });
      counts.failed += 1;
      logEvent({
        taskId,
        actorId: SCHEDULER_USER_ID,
        kind: "schedule_run_failed",
        field: "schedule",
        toValue: roleError ?? "роль не поднялась",
      });
    } else {
      updateRun({
        scheduleId: row.id,
        runAt: decision.runAt,
        status: "created",
        detail: labels.unknown.length
          ? `карточка создана; метки не найдены и пропущены: ${labels.unknown.join(", ")}`
          : "карточка создана",
        taskId,
      });
      counts.created += 1;
    }

    const next = options.force ? null : nextRunAfter(rule, now);
    markScheduleRun(row.id, {
      lastRunAt: decision.runAt,
      nextRunAt: next === null ? undefined : next,
      currentTaskId: taskId,
    });
    // Ручной запуск не двигает расписание (nextRunAt остаётся прежним) —
    // иначе «запустить сейчас» съедал бы будущий слот.
  }

  return counts;
}

/** Статистика рутин для «Состояния системы» (агент-service). */
export function schedulesState(): {
  total: number;
  active: number;
  failed_runs: number;
  next_run_at: string | null;
} {
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM task_schedules").get() as { n: number }
  ).n;
  const active = (
    db
      .prepare("SELECT COUNT(*) AS n FROM task_schedules WHERE status = 'active'")
      .get() as { n: number }
  ).n;
  const failed = (
    db
      .prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE status IN ('failed','error')")
      .get() as { n: number }
  ).n;
  const next = db
    .prepare(
      "SELECT MIN(next_run_at) AS next FROM task_schedules WHERE status = 'active' AND next_run_at IS NOT NULL",
    )
    .get() as { next: string | null };
  return {
    total,
    active,
    failed_runs: failed,
    next_run_at: next?.next ?? null,
  };
}

export { toUtcIso, roleUserId };
