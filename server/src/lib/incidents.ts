// Единая точка «поломка → уведомление → карточка починки».
//
// Решение Максима 12.10.2026: поломка — это уведомление в разделе
// «Обзор → Уведомления», а не задача в проекте. Проекта «Серверные
// уведомления» больше нет. Карточка на починку остаётся как механизм для
// роли-исполнителя, но служебная: `tasks.service_hidden = 1`, в списках
// задач, «Входящих» и поиске её нет, попасть в неё можно только по ссылке из
// уведомления. Раздаёт её тот же диспетчер, что и диагностику из файлового
// ящика (`diagnosticDispatch.ts`).
//
// Одна поломка — одна карточка: пока карточка с тем же `incident_key`
// открыта, повторное срабатывание сторожа ничего не создаёт. Раньше сторожа
// помнили «уже поднимал» только в памяти процесса и после каждого
// перезапуска сервера заводили дубль (8 одинаковых карточек про wake-канал
// за 10–11.10.2026).

import * as crypto from "node:crypto";

import db from "../db.js";
import { logEvent } from "../agentState.js";

export const INCIDENT_NOTIFICATION_TYPE = "incident";

export interface IncidentInput {
  /** Постоянный ключ поломки: один на причину, не на срабатывание. */
  key: string;
  title: string;
  description: string;
  priority?: number;
  ownerId?: string;
}

export interface IncidentResult {
  taskId: string;
  /** false — такая поломка уже открыта, новой карточки и уведомления нет. */
  created: boolean;
}

function ownerId(explicit?: string): string | null {
  if (explicit) return explicit;
  const row = db
    .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/** id открытой карточки починки по ключу поломки, если такая есть. */
export function openIncidentTaskId(key: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM tasks
        WHERE incident_key = ? AND status = 'active' AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`,
    )
    .get(key) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Когда по этому ключу последний раз заводилась карточка починки?
 *
 * Зачем (24.10.2026, аудит надёжности): правило владельца — «не больше одной
 * тревоги в сутки на сторожа». Сторожа держали это ограничение переменной
 * в ПАМЯТИ процесса (`let lastRaisedAt`), а она обнуляется при рестарте —
 * то есть после каждого перезапуска ограничение переставало действовать,
 * и защита от лавины оказывалась «внутри одного запуска».
 *
 * Здесь источник правды — карточка инцидента в БД: она переживает рестарт.
 * Проверяется ПОСЛЕДНЯЯ карточка по ключу, даже если её уже закрыли:
 * поломка, случившаяся повторно сразу после починки, не должна снова
 * заваливать «Состояние системы» — ровно то, чего требует правило.
 *
 * @param key ключ поломки (тот же, что у raiseIncident)
 * @param windowMs окно, по умолчанию сутки
 * @returns true — тревога этого ключа уже была в окне
 */
export function incidentRaisedRecently(key: string, windowMs = 24 * 60 * 60 * 1000): boolean {
  const hours = Math.max(1, Math.round(windowMs / (60 * 60 * 1000)));
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM tasks
        WHERE incident_key = ?
          AND created_at >= datetime('now', ?)
        LIMIT 1`,
    )
    .get(key, `-${hours} hours`);
  return Boolean(row);
}

export function raiseIncident(input: IncidentInput): IncidentResult | null {
  const existing = openIncidentTaskId(input.key);
  if (existing) return { taskId: existing, created: false };

  const owner = ownerId(input.ownerId);
  if (!owner) return null;

  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
         id, title, description, priority, creator_id, status, agent_state,
         project_id, service_hidden, incident_key
       ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, 1, ?)`,
    ).run(id, input.title, input.description, input.priority ?? 2, owner, input.key);
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(crypto.randomUUID(), owner, INCIDENT_NOTIFICATION_TYPE, id, input.title.slice(0, 200));
  })();

  // Вставка идёт мимо API, поэтому перечитываем сами: немая потеря карточки
  // уже случалась (11.10.2026, см. inboxTriageWatcher).
  if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id)) {
    console.error(`[incident] карточка не появилась после INSERT (key=${input.key})`);
    return null;
  }

  try {
    logEvent({ taskId: id, actorId: owner, kind: "task_created", field: "task", toValue: input.title });
  } catch {
    // лента — по возможности
  }
  return { taskId: id, created: true };
}
