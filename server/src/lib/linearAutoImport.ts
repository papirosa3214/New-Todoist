// Фоновая служба автоимпорта из Linear (карточка cc7caa43…).
//
// Владелец 06.10.2026: «завести задачу в Linear, и она автоматом к нам
// прилетела». Ручной импорт (routes/linear.ts → lib/linearImport.ts) уже
// умеет всё, чего не хватает: снимок, трёхсторонний merge, соответствия
// source_id → task_id, связи, метки, история. Служба надстраивается над ним
// и не повторяет его логику:
//
//   1. раз в 5 минут читает проекты Linear с меткой «Сейчас» (project label,
//      не issue label — проверено живьём 06.10.2026: label id df8d337a…);
//   2. проект Linear → родительская карточка (исполнитель — Оркестратор
//      Claude), задача → дочерняя карточка; иерархия берётся из Linear
//      (родитель/подзадача), корневые задачи проекта цепляются к карточке
//      проекта;
//   3. находит новые и изменённые задачи (по updatedAt исходного снимка),
//      применяет импорт без подтверждения владельца и БЕЗ черновиков планов:
//      приём работы остаётся в режиме владельца (`proposePlans:false`);
//   4. идемпотентность — таблица соответствий linear_import_tasks: повторный
//      проход не создаёт дублей;
//   5. отменённые и архивные задачи не импортируются;
//   6. никакой записи в Linear — транспорт только читающий (linearTransport);
//   7. контроль тихого отказа: состояние службы (последний успешный проход,
//      ошибка, счётчики) и уведомление владельцу, если успешного прохода не
//      было больше 30 минут;
//   8. выключатель владельца — по умолчанию включён.
//
// Цикл встроен в процесс сервера (как scheduler.ts и inboxTriageWatcher):
// никаких внешних таймеров и HTTP-ключей.

import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { LinearSourceError } from "../runtime/linearTransport.js";
import {
  fetchLinearSnapshot,
  findLinearProjectsByLabel,
  listLinearProjectIssues,
  type LinearSnapshot,
} from "./linearSource.js";
import { commitLinearPreview, createLinearPreview } from "./linearImport.js";

/** Метка проекта Linear, по которой служба отбирает работу. */
export const LINEAR_NOW_LABEL = "Сейчас";
/** Период прохода. */
export const LINEAR_AUTOIMPORT_INTERVAL_MS = 5 * 60 * 1000;
/** Тишина дольше этого — владельцу уведомление. */
export const LINEAR_AUTOIMPORT_STALE_MS = 30 * 60 * 1000;
/** Не повторять одно и то же уведомление чаще раза в час. */
const NOTIFY_REPEAT_MS = 60 * 60 * 1000;
/** Первый проход — не сразу после старта, чтобы сервер встал. */
const FIRST_PASS_DELAY_MS = 45 * 1000;

export type LinearAutoImportState = {
  owner_id: string;
  enabled: number;
  started_at: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  notified_at: string | null;
  created_total: number;
  updated_total: number;
};

export type LinearAutoImportResult = {
  owner_id: string;
  skipped?: "disabled";
  projects: number;
  created: number;
  updated: number;
  conflicts: Array<{ source_id: string; fields: string[] }>;
  errors: string[];
};

const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function ownerRow(ownerId?: string): { id: string } | undefined {
  return ownerId
    ? (db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId) as { id: string } | undefined)
    : (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined);
}

/** Строка состояния; создаётся лениво, включённой по умолчанию. */
export function linearAutoImportState(ownerId: string): LinearAutoImportState {
  db.prepare("INSERT OR IGNORE INTO linear_autoimport_state(owner_id) VALUES(?)").run(ownerId);
  return db.prepare("SELECT * FROM linear_autoimport_state WHERE owner_id = ?").get(ownerId) as LinearAutoImportState;
}

export function isLinearAutoImportEnabled(ownerId: string): boolean {
  return linearAutoImportState(ownerId).enabled === 1;
}

export function setLinearAutoImportEnabled(ownerId: string, enabled: boolean): LinearAutoImportState {
  linearAutoImportState(ownerId);
  db.prepare("UPDATE linear_autoimport_state SET enabled = ? WHERE owner_id = ?").run(enabled ? 1 : 0, ownerId);
  return linearAutoImportState(ownerId);
}

function orchestratorId(): string | null {
  return (db.prepare("SELECT id FROM users WHERE role = 'orchestrator' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
}

/** Родительская карточка проекта Linear: создаётся один раз, переименование подхватывает. */
function ensureProjectCard(ownerId: string, workspaceId: string, project: { id: string; name: string; url: string }): string {
  const existing = db.prepare("SELECT * FROM linear_autoimport_projects WHERE owner_id=? AND workspace_id=? AND project_id=?").get(ownerId, workspaceId, project.id) as
    | { task_id: string; snapshot: string }
    | undefined;
  if (existing) {
    const stored = JSON.parse(existing.snapshot) as { name: string };
    if (stored.name !== project.name) {
      db.prepare("UPDATE tasks SET title=?, updated_at=datetime('now') WHERE id=?").run(project.name, existing.task_id);
      db.prepare("UPDATE linear_autoimport_projects SET snapshot=? WHERE owner_id=? AND workspace_id=? AND project_id=?").run(JSON.stringify({ name: project.name, url: project.url }), ownerId, workspaceId, project.id);
    }
    return existing.task_id;
  }
  const id = crypto.randomUUID();
  const assignee = orchestratorId();
  const description = [
    `Linear · проект`,
    ``,
    `Источник: ${project.url}`,
    ``,
    `Родительская карточка собирает дочерние задачи проекта. Сама не исполняется;`,
    `приём работы идёт в режиме владельца.`,
  ].join("\n");
  db.prepare(
    "INSERT INTO tasks(id,title,description,priority,status,creator_id,project_id,assignee_id,ready_for_pickup,created_at) VALUES(?,?,?,?, 'active',?,NULL,?,0,datetime('now'))",
  ).run(id, project.name, description, 4, ownerId, assignee);
  db.prepare("INSERT INTO linear_autoimport_projects(owner_id,workspace_id,project_id,task_id,snapshot) VALUES(?,?,?,?,?)").run(
    ownerId, workspaceId, project.id, id, JSON.stringify({ name: project.name, url: project.url }),
  );
  logEvent({ taskId: id, actorId: ownerId, kind: "linear_project_imported", toValue: project.url });
  return id;
}

/** id источников, которых нет в соответствиях или чей updatedAt разошёлся. */
function changedIssueIds(ownerId: string, workspaceId: string, issues: Array<{ id: string; updatedAt: string; state: { type: string }; archivedAt: string | null }>): string[] {
  const stored = new Map(
    (db.prepare("SELECT source_id, snapshot FROM linear_import_tasks WHERE owner_id=? AND workspace_id=?").all(ownerId, workspaceId) as Array<{ source_id: string; snapshot: string }>)
      .map(r => [r.source_id, r.snapshot]),
  );
  const changed: string[] = [];
  for (const issue of issues) {
    // Отменённые и архивные не импортируются и не обновляются.
    if (issue.state.type === "canceled" || issue.archivedAt) continue;
    const snapshot = stored.get(issue.id);
    if (!snapshot) {
      // Заводится только задача в работе (владелец 07.10.2026): выполненные,
      // запланированные и лежащие в бэклоге новыми карточками не становятся.
      if (issue.state.type === "started") changed.push(issue.id);
      continue;
    }
    let previous: { updatedAt?: string } = {};
    try { previous = JSON.parse(snapshot); } catch { /* повреждённый снимок — считаем изменённым */ }
    if (previous.updatedAt !== issue.updatedAt) changed.push(issue.id);
  }
  return changed;
}

/**
 * Один проход службы. Не бросает наружу: любая ошибка остаётся в состоянии
 * и не роняет сервер. Возвращает счётчики для тестов и ручного прогона.
 */
export async function runLinearAutoImportPass(ownerId?: string, options: { projectIds?: string[] } = {}): Promise<LinearAutoImportResult> {
  const owner = ownerRow(ownerId);
  if (!owner) throw new LinearSourceError("Владелец не найден.", 404);
  const state = linearAutoImportState(owner.id);
  if (state.enabled !== 1) return { owner_id: owner.id, skipped: "disabled", projects: 0, created: 0, updated: 0, conflicts: [], errors: [] };

  db.prepare("UPDATE linear_autoimport_state SET last_attempt_at=? WHERE owner_id=?").run(nowIso(), owner.id);
  const result: LinearAutoImportResult = { owner_id: owner.id, projects: 0, created: 0, updated: 0, conflicts: [], errors: [] };
  try {
    const { workspace, projects } = await findLinearProjectsByLabel(owner.id, LINEAR_NOW_LABEL);
    for (const project of projects) {
      if (options.projectIds && !options.projectIds.includes(project.id)) continue;
      result.projects += 1;
      try {
        await importProject(owner.id, workspace.id, project, result);
      } catch (error) {
        // Один сломанный проект не мешает остальным; причину называем.
        result.errors.push(`${project.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (result.errors.length) {
      const message = result.errors.join(" | ").slice(0, 2000);
      db.prepare("UPDATE linear_autoimport_state SET last_error=?, last_error_at=? WHERE owner_id=?").run(message, nowIso(), owner.id);
    } else {
      db.prepare("UPDATE linear_autoimport_state SET last_success_at=?, last_error=NULL, created_total=created_total+?, updated_total=updated_total+? WHERE owner_id=?")
        .run(nowIso(), result.created, result.updated, owner.id);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE linear_autoimport_state SET last_error=?, last_error_at=? WHERE owner_id=?").run(message.slice(0, 2000), nowIso(), owner.id);
    result.errors.push(message);
    return result;
  }
}

async function importProject(ownerId: string, workspaceId: string, project: { id: string; name: string; url: string }, result: LinearAutoImportResult): Promise<void> {
  const projectTaskId = ensureProjectCard(ownerId, workspaceId, project);
  const issues = await listLinearProjectIssues(ownerId, project.id);
  const changed = changedIssueIds(ownerId, workspaceId, issues);
  if (!changed.length) return;

  const snapshot: LinearSnapshot = await fetchLinearSnapshot(ownerId, changed);
  // Снимок мог притащить предков из других проектов — их тоже импортируем,
  // иначе дочерняя карточка повиснет без родителя.
  const preview = createLinearPreview(ownerId, snapshot, null);
  const committed = commitLinearPreview(ownerId, preview.preview_id, { proposePlans: false });

  // Корневые задачи проекта цепляются к карточке проекта. Ищем корни по
  // исходной иерархии Linear (parent === null).
  const rootIds = new Set(snapshot.issues.filter(i => !i.parent?.id).map(i => i.id));
  for (const item of committed.task_ids as Array<{ source_id: string; task_id: string }>) {
    if (rootIds.has(item.source_id)) {
      const current = db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(item.task_id) as { parent_id: string | null } | undefined;
      if (current && current.parent_id !== projectTaskId) db.prepare("UPDATE tasks SET parent_id=?, updated_at=datetime('now') WHERE id=?").run(projectTaskId, item.task_id);
    }
  }
  result.created += committed.created;
  result.updated += committed.updated;
  for (const conflict of committed.conflicts ?? []) result.conflicts.push(conflict);
}

/** Уведомление владельцу, если служба давно не завершала проход успешно. */
export function notifyLinearAutoImportStale(ownerId?: string, now = Date.now()): boolean {
  const owner = ownerRow(ownerId);
  if (!owner) return false;
  const state = linearAutoImportState(owner.id);
  if (state.enabled !== 1) return false;
  // Если успешного прохода ещё не было, отсчёт тишины идёт от запуска службы,
  // а не от нуля: иначе владелец получил бы уведомление при первом же сбое.
  const reference = state.last_success_at ?? state.started_at;
  const referenceAt = reference ? Date.parse(reference.replace(" ", "T") + "Z") : null;
  const stale = referenceAt === null || now - referenceAt > LINEAR_AUTOIMPORT_STALE_MS;
  if (!stale) return false;
  const notified = state.notified_at ? Date.parse(state.notified_at.replace(" ", "T") + "Z") : null;
  if (notified !== null && now - notified < NOTIFY_REPEAT_MS) return false;
  const text = [
    "⚠️ Автоимпорт Linear не завершал успешный проход больше 30 минут.",
    state.last_success_at ? `Последний успех: ${state.last_success_at}.` : "Успешного прохода ещё не было.",
    state.last_error ? `Последняя ошибка: ${state.last_error}` : "Задач в проектах с меткой «Сейчас» не нашлось или проход не дошёл.",
    "Проверьте подключение Linear в Composio и настройку автоимпорта.",
  ].join("\n");
  db.prepare("INSERT INTO notifications(id,user_id,type,task_id,text,actor_id) VALUES(?,?,?,NULL,?,NULL)").run(
    crypto.randomUUID(), owner.id, "linear_autoimport_stale", text,
  );
  db.prepare("UPDATE linear_autoimport_state SET notified_at=? WHERE owner_id=?").run(nowIso(), owner.id);
  return true;
}

/** Раз в 5 минут; первый проход — через 45 секунд после старта. */
export function startLinearAutoImport(): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runLinearAutoImportPass();
      if (result.created || result.updated || result.errors.length) {
        console.log(`[linear-autoimport] проектов ${result.projects}, создано ${result.created}, обновлено ${result.updated}${result.errors.length ? `, ошибок ${result.errors.length}` : ""}`);
      }
      notifyLinearAutoImportStale();
    } catch (error) {
      console.warn("[linear-autoimport] проход не удался:", error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_PASS_DELAY_MS);
  const timer = setInterval(() => void tick(), LINEAR_AUTOIMPORT_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
