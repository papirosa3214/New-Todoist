// Умные напоминания о просроченных задачах (карточка 615095f4-…). Роуты
// для экрана «Настройки уведомлений» и для журнала «что уже прилетало».
//
// Контракт и обоснование — `docs/escalation-architecture.md` §2, §5, §6.
// GET /api/escalation/rules лениво создаёт дефолтную запись на владельца,
// чтобы фронт всегда получал согласованную форму без отдельного «создай,
// если нет» шага. PUT принимает и steps_json (как хранится в БД), и
// развёрнутый steps (как удобнее UI) — оба варианта валидны, приоритет у
// steps_json, если присланы оба.

import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import {
  defaultSteps,
  parseSteps,
  previewNotifications,
  validateRuleInput,
  type EscalationChannel,
  type EscalationRule,
  type EscalationStep,
  type EscalationTask,
} from "../lib/escalationEvaluator.js";

const uid = () => crypto.randomUUID();

const DEFAULT_WEEKDAYS = "1,2,3,4,5,6,7";

function ownerIdFromAuth(req: any): string | null {
  // `authOrApiToken` кладёт id пользователя в req.userId; у владельца
  // он же совпадает с id записи в users, чьё правило мы читаем/пишем.
  const id = req.userId;
  if (typeof id !== "string" || !id) return null;
  if (!isOwner(id)) return null;
  return id;
}

function getOrCreateRule(ownerId: string): EscalationRule {
  const row = db
    .prepare(
      "SELECT enabled, quiet_from, quiet_to, weekdays, steps_json FROM escalation_rules WHERE user_id = ?",
    )
    .get(ownerId) as
    | {
        enabled: number;
        quiet_from: string;
        quiet_to: string;
        weekdays: string;
        steps_json: string;
      }
    | undefined;
  if (row) {
    return {
      enabled: row.enabled === 1,
      quiet_from: row.quiet_from,
      quiet_to: row.quiet_to,
      weekdays: row.weekdays
        .split(",")
        .map((s) => Number(s))
        .filter((n) => n >= 1 && n <= 7),
      steps: parseSteps(row.steps_json),
    };
  }
  // Ленивая вставка дефолта: один раз на владельца, идемпотентно. Шаги
  // сохраняем канонической JSON-строкой — при следующем чтении parseSteps
  // распарсит их обратно в массив.
  const steps = defaultSteps();
  const stepsJson = JSON.stringify(steps);
  db.prepare(
    `INSERT INTO escalation_rules (user_id, enabled, quiet_from, quiet_to, weekdays, steps_json)
     VALUES (?, 1, '22:00', '08:00', ?, ?)`,
  ).run(ownerId, DEFAULT_WEEKDAYS, stepsJson);
  return {
    enabled: true,
    quiet_from: "22:00",
    quiet_to: "08:00",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    steps,
  };
}

function listOwnerTasks(ownerId: string): EscalationTask[] {
  return db
    .prepare(
      `SELECT id, title, priority, due_date, status
         FROM tasks
        WHERE creator_id = ?
          AND status = 'active'
          AND due_date IS NOT NULL
          AND trim(due_date) != ''`,
    )
    .all(ownerId) as EscalationTask[];
}

export function registerEscalationRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.get("/api/escalation/rules", { preHandler: authPre }, async (req: any, reply) => {
    const ownerId = ownerIdFromAuth(req);
    if (!ownerId) return reply.code(403).send({ error: "только владелец" });
    const rule = getOrCreateRule(ownerId);
    return { ...rule, steps_json: JSON.stringify(rule.steps) };
  });

  app.put("/api/escalation/rules", { preHandler: authPre }, async (req: any, reply) => {
    const ownerId = ownerIdFromAuth(req);
    if (!ownerId) return reply.code(403).send({ error: "только владелец" });
    const errors = validateRuleInput(req.body);
    if (errors.length > 0) {
      return reply.code(400).send({ error: "неверные параметры", details: errors });
    }
    const body = req.body as {
      enabled: boolean;
      quiet_from: string;
      quiet_to: string;
      weekdays: number[];
      steps_json?: string;
      steps?: EscalationStep[];
    };
    // steps_json — канонический путь (БД так и хранит). steps — удобный
    // для UI: сериализуем, прогоняем через parseSteps, чтобы отсеять мусор.
    let stepsJson: string;
    if (typeof body.steps_json === "string" && body.steps_json.trim()) {
      // Сначала убеждаемся, что JSON читается. parseSteps умеет глотать
      // мусор, поэтому без этой проверки битая строка молча превратилась
      // бы в дефолт — и владелец потерял бы свои настройки.
      try {
        JSON.parse(body.steps_json);
      } catch {
        return reply.code(400).send({ error: "steps_json не парсится" });
      }
      // Нормализуем через parseSteps (отбрасывает битые элементы), но
      // сохраняем уже канонический JSON, а не исходную строку — иначе в
      // БД осядет то, что в SELECT потом не пройдёт фильтр.
      const normalized = parseSteps(body.steps_json);
      if (normalized.length === 0) {
        return reply.code(400).send({ error: "ни один шаг не прошёл валидацию" });
      }
      stepsJson = JSON.stringify(normalized);
    } else if (Array.isArray(body.steps)) {
      const normalized = parseSteps(body.steps);
      if (normalized.length === 0) {
        return reply.code(400).send({ error: "ни один шаг не прошёл валидацию" });
      }
      stepsJson = JSON.stringify(normalized);
    } else {
      return reply.code(400).send({ error: "steps_json или steps — обязательно" });
    }
    // Спека §5: защита от факапа — без шага с priority_max=1 у владельца
    // самые срочные никогда не триггернутся. Мягкое правило: ругаемся, но
    // сохраняем (владелец лучше знает свои правила) — и в UI подсветим.
    const steps = parseSteps(stepsJson);
    const hasUrgent = steps.some((s) => s.priority_max === 1 && s.after_hours >= 1);
    const weekdaysCsv = body.weekdays.join(",");
    db.prepare(
      `INSERT INTO escalation_rules (user_id, enabled, quiet_from, quiet_to, weekdays, steps_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = excluded.enabled,
         quiet_from = excluded.quiet_from,
         quiet_to = excluded.quiet_to,
         weekdays = excluded.weekdays,
         steps_json = excluded.steps_json,
         updated_at = excluded.updated_at`,
    ).run(
      ownerId,
      body.enabled ? 1 : 0,
      body.quiet_from,
      body.quiet_to,
      weekdaysCsv,
      stepsJson,
    );
    return { ok: true, warning: hasUrgent ? null : "ни один шаг не покрывает priority=1, самые срочные не триггернутся" };
  });

  app.get("/api/escalation/preview", { preHandler: authPre }, async (req: any, reply) => {
    const ownerId = ownerIdFromAuth(req);
    if (!ownerId) return reply.code(403).send({ error: "только владелец" });
    const daysRaw = Number((req.query as Record<string, unknown> | undefined)?.days ?? 7);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 30 ? Math.floor(daysRaw) : 7;
    const rule = getOrCreateRule(ownerId);
    const tasks = listOwnerTasks(ownerId);
    const items = previewNotifications(rule, tasks, days);
    return { days, count: items.length, items };
  });

  app.get("/api/escalation/recent", { preHandler: authPre }, async (req: any, reply) => {
    const ownerId = ownerIdFromAuth(req);
    if (!ownerId) return reply.code(403).send({ error: "только владелец" });
    const daysRaw = Number((req.query as Record<string, unknown> | undefined)?.days ?? 7);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 30 ? Math.floor(daysRaw) : 7;
    const rows = db
      .prepare(
        `SELECT e.id, e.task_id, e.step_key, e.sent_at, e.notification_id,
                t.title AS task_title, t.priority AS task_priority, t.due_date AS task_due_date
           FROM escalation_events e
           LEFT JOIN tasks t ON t.id = e.task_id
          WHERE e.user_id = ?
            AND date(e.sent_at) >= date('now', ?)
          ORDER BY e.sent_at DESC
          LIMIT 200`,
      )
      .all(ownerId, `-${days} days`) as Array<{
      id: string;
      task_id: string;
      step_key: string;
      sent_at: string;
      notification_id: string | null;
      task_title: string | null;
      task_priority: number | null;
      task_due_date: string | null;
    }>;
    return {
      days,
      count: rows.length,
      events: rows.map((r) => ({
        id: r.id,
        task_id: r.task_id,
        step_key: r.step_key,
        sent_at: r.sent_at,
        notification_id: r.notification_id,
        task_title: r.task_title,
        task_priority: r.task_priority,
        task_due_date: r.task_due_date,
      })),
    };
  });
}

/** Каналы для конкретного сработавшего шага на конкретной задаче.
 *  stepKey имеет вид `p<приоритет_задачи>_h<after_hours>` — это метка
 *  события, а не шага. Здесь мы ищем шаг по `after_hours` (priority_max
 *  в ключ не входит) и возвращаем каналы этого шага. */
export function channelsForStep(rule: EscalationRule, stepKey: string): EscalationChannel[] {
  const m = /^p[1-4]_h(\d+)$/.exec(stepKey);
  if (!m) return ["inapp"];
  const after = Number(m[1]);
  const step = rule.steps.find((s) => s.after_hours === after);
  return step ? [...step.channels] : ["inapp"];
}
