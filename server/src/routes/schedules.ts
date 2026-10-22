// Ручки рутин (крон-задач): /api/schedules.
//
// Контракт — из заметки «Рутины и расписание TaskFlow», раздел «6. API»:
//   GET    /api/schedules          — список: правило, следующий запуск, последний, статус
//   POST   /api/schedules          — создать рутину
//   PATCH  /api/schedules/:id      — правка, пауза, возобновление
//   DELETE /api/schedules/:id      — удалить
//   POST   /api/schedules/:id/run-now — ручной запуск вне расписания
//   GET    /api/schedules/:id/runs   — история запусков
//
// Авторизация (тот же раздел): создание и правка рутины — владелец;
// запуск по расписанию — служебная учётка планировщика.

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { SCHEDULER_USER_ID } from "../serviceUser.js";
import { logEvent } from "../agentState.js";
import {
  SCHEDULE_RULE_KINDS,
  CRON_RULE_KIND,
  anchorForNow,
  nextRunAfter,
  parseCron,
  parseIntervalMinutes,
  parseMonthDay,
  parseTimeLocal,
  parseWeekday,
  parseWeekdays,
  ruleLabel,
  type ScheduleRuleKind,
} from "../runtime/schedules/rules.js";
import {
  anchorFromCreatedAt,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listRuns,
  listSchedules,
  parsePayload,
  parseUtc,
  ruleOf,
  updateSchedule,
  type ScheduleRow,
} from "../runtime/schedules/store.js";
import { runSchedulesTick } from "../runtime/schedules/tick.js";
import { resolveLabelIds } from "../runtime/schedules/labels.js";
import { routinesEnabled } from "../runtime/schedules/feature.js";

const uid = () => crypto.randomUUID();

function present(row: ScheduleRow) {
  return {
    id: row.id,
    title: row.title,
    task_payload: parsePayload(row),
    rule_kind: row.rule_kind,
    rule_expr: row.rule_expr,
    // Подпись правила по-русски отдаёт сервер (дизайн, п. 2.9): веб и iOS
    // берут одну и ту же строку, подписи не расходятся.
    rule_label: ruleLabel({ kind: row.rule_kind, expr: row.rule_expr }),
    time_local: row.time_local,
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    status: row.status,
    catch_up: row.catch_up === 1,
    overlap_policy: row.overlap_policy,
    current_task_id: row.current_task_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isService(userId: string): boolean {
  return userId === SCHEDULER_USER_ID;
}

export function registerScheduleRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get("/api/schedules", { preHandler: authPre }, async (req: any) => {
    return { schedules: listSchedules().map(present) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const row = getSchedule(req.params.id);
      if (!row) return reply.code(404).send({ error: "Рутина не найдена" });
      return { schedule: present(row), runs: listRuns(row.id) };
    },
  );

  app.get("/api/schedules/preview", { preHandler: authPre }, async (req: any, reply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const kind = String(query.rule_kind ?? "") as ScheduleRuleKind;
    // cron в первой версии не поддерживается (развилка B не решена):
    // отказываем явно, а не молча считаем другой вид расписания.
    if (kind === CRON_RULE_KIND) {
      return reply.code(400).send({
        error: "произвольное расписание по cron в первой версии не поддерживается",
      });
    }
    if (!SCHEDULE_RULE_KINDS.includes(kind)) {
      return reply.code(400).send({
        error: `правило должно быть одним из: ${SCHEDULE_RULE_KINDS.join(", ")}`,
      });
    }
    const timeLocal = String(query.time_local ?? "09:00").trim();
    const time = parseTimeLocal(timeLocal);
    if (!time && kind !== "interval" && kind !== "cron") {
      return reply.code(400).send({ error: "время должно быть в формате ЧЧ:ММ" });
    }
    const timezone = String(query.timezone ?? "Europe/Moscow").trim() || "Europe/Moscow";
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    } catch {
      return reply.code(400).send({ error: `неизвестная зона «${timezone}»` });
    }
    const expr = query.rule_expr == null || query.rule_expr === "" ? null : String(query.rule_expr);
    if (kind === "weekly_days" && !parseWeekdays(expr)) {
      return reply.code(400).send({ error: "дни недели — списком 1..7, где 1=понедельник" });
    }
    if (kind === "weekly" && expr && !parseWeekday(expr)) {
      return reply.code(400).send({ error: "день недели — от 1 (понедельник) до 7 (воскресенье)" });
    }
    if (kind === "monthly" && expr && !parseMonthDay(expr)) {
      return reply.code(400).send({ error: "день месяца — от 1 до 31" });
    }
    if (kind === "interval" && !parseIntervalMinutes(expr)) {
      return reply.code(400).send({ error: "интервал — например 15m или 2h, не меньше 5 минут" });
    }
    if (kind === "cron" && !parseCron(expr)) {
      return reply.code(400).send({ error: "cron — пять полей: минуты часы день месяц день-недели" });
    }
    const next = nextRunAfter(
      {
        kind,
        expr,
        timeLocal: time ? timeLocal : kind === "cron" ? "00:00" : "09:00",
        timezone,
        // Якорь — «сегодня» в зоне рутины: первый показанный запуск и
        // запуск, посчитанный планировщиком по той же формуле, совпадают.
        anchor: anchorForNow(new Date(), timezone),
      },
      new Date(),
    );
    return {
      next_run_at: next ? next.toISOString() : null,
      timezone,
      rule_label: ruleLabel({ kind, expr }),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/schedules/:id/runs",
    { preHandler: authPre },
    async (req: any, reply) => {
      const row = getSchedule(req.params.id);
      if (!row) return reply.code(404).send({ error: "Рутина не найдена" });
      return { runs: listRuns(row.id) };
    },
  );

  app.post("/api/schedules", { preHandler: authPre }, async (req: any, reply) => {
    if (!isOwner(req.userId) && !isService(req.userId)) {
      return reply.code(403).send({ error: "создавать рутины может владелец" });
    }
    // Выключатель рутин: пока механизм выключен, рутины не создаются.
    if (!routinesEnabled()) {
      return reply.code(503).send({ error: "рутины временно выключены" });
    }
    const body = req.body ?? {};
    const title = String(body.title ?? "").trim();
    if (!title) return reply.code(400).send({ error: "название рутины не может быть пустым" });

    const kind = String(body.rule_kind ?? "") as ScheduleRuleKind;
    if (kind === CRON_RULE_KIND) {
      return reply.code(400).send({
        error: "произвольное расписание по cron в первой версии не поддерживается",
      });
    }
    if (!SCHEDULE_RULE_KINDS.includes(kind)) {
      return reply.code(400).send({
        error: `правило должно быть одним из: ${SCHEDULE_RULE_KINDS.join(", ")}`,
      });
    }
    const timeLocal = String(body.time_local ?? "").trim();
    const time = parseTimeLocal(timeLocal);
    if (!time && kind !== "interval" && kind !== "cron") {
      return reply.code(400).send({ error: "время должно быть в формате ЧЧ:ММ" });
    }
    const timezone = String(body.timezone ?? "Europe/Moscow").trim() || "Europe/Moscow";
    try {
      // Зона должна существовать — иначе расчёт запуска молча уедет.
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    } catch {
      return reply.code(400).send({ error: `неизвестная зона «${timezone}»` });
    }
    const ruleExpr = body.rule_expr == null ? null : String(body.rule_expr);
    if (kind === "weekly_days" && !parseWeekdays(ruleExpr)) {
      return reply.code(400).send({ error: "дни недели — списком 1..7, где 1=понедельник" });
    }
    if (kind === "weekly" && ruleExpr && !parseWeekday(ruleExpr)) {
      return reply.code(400).send({ error: "день недели — от 1 (понедельник) до 7 (воскресенье)" });
    }
    if (kind === "monthly" && ruleExpr && !parseMonthDay(ruleExpr)) {
      return reply.code(400).send({ error: "день месяца — от 1 до 31" });
    }
    if (kind === "interval" && !parseIntervalMinutes(ruleExpr)) {
      return reply.code(400).send({ error: "интервал — например 15m или 2h, не меньше 5 минут" });
    }
    if (kind === "cron" && !parseCron(ruleExpr)) {
      return reply.code(400).send({ error: "cron — пять полей: минуты часы день месяц день-недели" });
    }

    const payload = (body.task_payload ?? {}) as Record<string, unknown>;
    if (!payload.title) payload.title = title;
    if (payload.priority != null) {
      const priority = Number(payload.priority);
      if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
        return reply.code(400).send({ error: "priority должен быть от 1 до 4" });
      }
    }
    // Метки в шаблоне задаются именами — проверяем, что такие метки есть:
    // иначе рутина падала бы только в момент запуска, с ошибкой «карточка
    // не создана».
    const labelCheck = resolveLabelIds(
      (payload.labels as string[] | null | undefined) ?? [],
      req.userId,
    );
    if (labelCheck.unknown.length) {
      return reply.code(400).send({
        error: `метка не найдена: ${labelCheck.unknown.join(", ")}`,
      });
    }

    const anchor = anchorForNow(new Date(), timezone);
    const rule = {
      kind,
      expr: ruleExpr,
      timeLocal: time ? timeLocal : kind === "cron" ? "00:00" : "09:00",
      timezone,
      anchor,
    };
    const next = nextRunAfter(rule, new Date());
    const created = createSchedule({
      title,
      taskPayload: payload as never,
      rule,
      nextRunAt: next,
      catchUp: body.catch_up === false ? false : true,
      overlapPolicy: body.overlap_policy === "allow" ? "allow" : "skip",
      createdBy: req.userId,
    });
    return reply.code(201).send({ schedule: present(created) });
  });

  app.patch<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId) && !isService(req.userId)) {
        return reply.code(403).send({ error: "править рутины может владелец" });
      }
      const existing = getSchedule(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Рутина не найдена" });
      // Выключатель рутин: пока механизм выключен, рутины не правятся.
      if (!routinesEnabled()) {
        return reply.code(503).send({ error: "рутины временно выключены" });
      }
      const body = req.body ?? {};

      const kind = body.rule_kind ? (String(body.rule_kind) as ScheduleRuleKind) : existing.rule_kind;
      if (kind === CRON_RULE_KIND) {
        return reply.code(400).send({
          error: "произвольное расписание по cron в первой версии не поддерживается",
        });
      }
      if (!SCHEDULE_RULE_KINDS.includes(kind)) {
        return reply.code(400).send({ error: `неизвестное правило «${kind}»` });
      }
      const timeLocal = body.time_local ? String(body.time_local) : existing.time_local;
      const time = parseTimeLocal(timeLocal);
      if (!time && kind !== "interval" && kind !== "cron") {
        return reply.code(400).send({ error: "время должно быть в формате ЧЧ:ММ" });
      }
      const timezone = body.timezone ? String(body.timezone) : existing.timezone;
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
      } catch {
        return reply.code(400).send({ error: `неизвестная зона «${timezone}»` });
      }
      const ruleExpr = body.rule_expr === undefined ? existing.rule_expr : body.rule_expr == null ? null : String(body.rule_expr);
      if (kind === "weekly_days" && !parseWeekdays(ruleExpr)) {
        return reply.code(400).send({ error: "дни недели — списком 1..7, где 1=понедельник" });
      }
      if (kind === "weekly" && ruleExpr && !parseWeekday(ruleExpr)) {
        return reply.code(400).send({ error: "день недели — от 1 (понедельник) до 7 (воскресенье)" });
      }
      if (kind === "monthly" && ruleExpr && !parseMonthDay(ruleExpr)) {
        return reply.code(400).send({ error: "день месяца — от 1 до 31" });
      }
      if (kind === "interval" && !parseIntervalMinutes(ruleExpr)) {
        return reply.code(400).send({ error: "интервал — например 15m или 2h, не меньше 5 минут" });
      }
      if (kind === "cron" && !parseCron(ruleExpr)) {
        return reply.code(400).send({ error: "cron — пять полей: минуты часы день месяц день-недели" });
      }
      const status = body.status
        ? (String(body.status) as ScheduleRow["status"])
        : existing.status;
      if (!["active", "paused", "finished"].includes(status)) {
        return reply.code(400).send({ error: "status: active | paused | finished" });
      }

      // Метки в шаблоне задаются именами — проверяем, что такие метки есть
      // (иначе запуск упал бы позже, с ошибкой «карточка не создана»).
      const mergedPayload = body.task_payload
        ? ({ ...parsePayload(existing), ...(body.task_payload as object) } as Record<string, unknown>)
        : (parsePayload(existing) as unknown as Record<string, unknown>);
      const labelCheck = resolveLabelIds(
        (mergedPayload.labels as string[] | null | undefined) ?? [],
        existing.created_by,
      );
      if (labelCheck.unknown.length) {
        return reply.code(400).send({
          error: `метка не найдена: ${labelCheck.unknown.join(", ")}`,
        });
      }

      const ruleChanged =
        kind !== existing.rule_kind ||
        ruleExpr !== existing.rule_expr ||
        timeLocal !== existing.time_local ||
        timezone !== existing.timezone;
      const rule = {
        kind,
        expr: ruleExpr,
        timeLocal,
        timezone,
        anchor: anchorFromCreatedAt(existing),
      };
      // Пересчёт следующего запуска: правило изменилось или рутина
      // возобновлена (после паузы следующий запуск надо посчитать заново).
      const recompute =
        ruleChanged || (status === "active" && existing.status !== "active");
      const next = recompute ? nextRunAfter(rule, new Date()) : null;

      const updated = updateSchedule(existing.id, {
        title: body.title ? String(body.title).trim() : undefined,
        taskPayload: body.task_payload
          ? ({ ...parsePayload(existing), ...(body.task_payload as object) } as never)
          : undefined,
        rule,
        nextRunAt: recompute ? next : undefined,
        status,
        catchUp:
          body.catch_up === undefined ? undefined : body.catch_up === false ? false : true,
        overlapPolicy:
          body.overlap_policy === "allow"
            ? "allow"
            : body.overlap_policy === "skip"
              ? "skip"
              : undefined,
      });
      return { schedule: present(updated!) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId) && !isService(req.userId)) {
        return reply.code(403).send({ error: "удалять рутины может владелец" });
      }
      const existing = getSchedule(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Рутина не найдена" });
      // Удаление рутины не трогает уже созданные карточки (инвариант
      // из заметки): чистим только запись рутины.
      deleteSchedule(existing.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run-now",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId) && !isService(req.userId)) {
        return reply.code(403).send({ error: "запускать рутину вручную может владелец" });
      }
      const row = getSchedule(req.params.id);
      if (!row) return reply.code(404).send({ error: "Рутина не найдена" });
      // Пауза останавливает создание карточек (критерий приёмки 12): ручной
      // запуск приостановленной рутины — тоже создание карточки. Отвечаем
      // прямо, а не молча: иначе владелец жмёт «Запустить сейчас» и не
      // понимает, почему ничего не произошло.
      if (row.status !== "active") {
        return reply.code(409).send({
          error: "Рутина на паузе — сначала возобновите её",
        });
      }
      // Ручной запуск вне расписания: слот запуска — «сейчас», поэтому он не
      // совпадает с расписанием и не съедает его.
      const now = new Date();
      const counts = await runSchedulesTick(app, { now, scheduleId: row.id, force: true });
      // Последний запуск — чтобы веб показал ссылку на созданную карточку.
      const run = listRuns(row.id)[0] ?? null;
      return {
        ok: true,
        counts,
        schedule: present(getSchedule(row.id)!),
        run: run
          ? {
              id: run.id,
              run_at: run.run_at,
              task_id: run.task_id,
              status: run.status,
              // Причина пропуска или ошибки — клиенту нужно показать её.
              detail: run.detail ?? null,
            }
          : null,
      };
    },
  );
}

/** Лент-лог создания рутины (для карточки-основания, если она есть). */
export function logScheduleCreated(taskId: string | null, scheduleId: string, actorId: string) {
  if (!taskId) return;
  logEvent({
    taskId,
    actorId,
    kind: "schedule_created",
    field: "schedule",
    toValue: scheduleId,
  });
}

export { uid, db };
