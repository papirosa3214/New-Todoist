import crypto from "node:crypto";
import db from "../db.js";
import { bumpContextVersion } from "../runtime/taskContextVersion.js";
import { getProjectForFiling } from "../access.js";
import { autoProposeCollaborationPlanIfNeeded } from "../routes/task-collaboration-plans.js";
import { logEvent } from "../agentState.js";
import { LinearSourceError } from "../runtime/linearTransport.js";
import type { LinearIssue, LinearSnapshot } from "./linearSource.js";

type Fields = Record<string, string | number | null>;
const FIELD_NAMES = ["title", "description", "priority", "due_date", "status", "parent_id"];
const uid = () => crypto.randomUUID();
const encode = (value: unknown) => JSON.stringify(value);
const date = (value: string) => new Date(value).toISOString().replace("T", " ").slice(0, 19);
const mappings = (owner: string, workspace: string): any[] => db.prepare("SELECT * FROM linear_import_tasks WHERE owner_id=? AND workspace_id=?").all(owner, workspace);

export function validateLinearSnapshot(snapshot: LinearSnapshot) {
  if (!snapshot.workspace?.id || !snapshot.issues.length || snapshot.issues.length > 500 || encode(snapshot).length > 20 * 1024 * 1024) throw new LinearSourceError("Снимок Linear пуст или слишком большой.", 422);
  const ids = new Set(snapshot.issues.map(i => i.id));
  if (ids.size !== snapshot.issues.length) throw new LinearSourceError("Повторяющиеся задачи Linear.", 422);
  const map = new Map(snapshot.issues.map(i => [i.id, i]));
  for (const issue of snapshot.issues) {
    if (!issue.id || typeof issue.title !== "string" || !issue.title.trim() || issue.title.length > 1000 || (issue.description?.length ?? 0) > 500_000 || !issue.state?.type || !Number.isInteger(issue.priority) || issue.priority < 0 || issue.priority > 4) throw new LinearSourceError("Неполные поля задачи Linear.", 422);
    if (issue.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate) || !Number.isFinite(Date.parse(issue.dueDate)) || new Date(issue.dueDate).toISOString().slice(0,10) !== issue.dueDate)) throw new LinearSourceError("Некорректный срок Linear.", 422);
    if (!Number.isFinite(Date.parse(issue.createdAt)) || !Number.isFinite(Date.parse(issue.updatedAt))) throw new LinearSourceError("Некорректное время Linear.", 422);
    if (!/^https:\/\/linear\.app\//.test(issue.url)) throw new LinearSourceError("Некорректная ссылка задачи Linear.", 422);
    for (const name of ["children", "comments", "history", "labels", "attachments", "documents", "relations", "inverseRelations"]) {
      if (!Array.isArray(issue[name])) throw new LinearSourceError("Структура Linear загружена не полностью.", 422);
    }
    for (const comment of [...issue.comments, ...issue.history, ...issue.documents]) {
      if (!comment.id || !Number.isFinite(Date.parse(comment.createdAt))) throw new LinearSourceError("Некорректная история Linear.", 422);
    }
    const seen = new Set([issue.id]);
    let parent = issue.parent?.id;
    while (parent) {
      if (seen.has(parent)) throw new LinearSourceError("Цикл родительских задач Linear.", 422);
      seen.add(parent);
      const ancestor = map.get(parent);
      if (!ancestor) throw new LinearSourceError("В снимке отсутствует родительская задача.", 422);
      parent = ancestor.parent?.id;
    }
    for (const child of issue.children) {
      if (map.has(child.id) && map.get(child.id)!.parent?.id !== issue.id) throw new LinearSourceError("Связь родителя и дочерней задачи Linear изменилась во время чтения. Повторите загрузку.", 409);
    }
  }
}

function fields(issue: LinearIssue, taskIds: Map<string, string>): Fields {
  return { title: issue.title.trim(), description: issue.description || null, priority: issue.priority || 4,
    due_date: issue.dueDate || null, status: issue.state.type === "completed" ? "completed" : "active",
    parent_id: issue.parent ? taskIds.get(issue.parent.id)! : null };
}

export function mergeLinearFields(current: Fields, previous: Fields, remote: Fields) {
  const applied = { ...previous }, updates: Fields = {}, conflicts: string[] = [];
  for (const key of FIELD_NAMES) {
    if (current[key] === previous[key] || current[key] === remote[key]) { updates[key] = remote[key]; applied[key] = remote[key]; }
    else if (remote[key] !== previous[key]) conflicts.push(key);
  }
  return { applied, updates, conflicts };
}

function object(owner: string, workspace: string, issue: string, kind: string, id: string): any {
  return db.prepare("SELECT * FROM linear_import_objects WHERE owner_id=? AND workspace_id=? AND source_issue_id=? AND kind=? AND source_id=?").get(owner, workspace, issue, kind, id);
}
function saveObject(owner: string, workspace: string, issue: string, kind: string, id: string, local: string | null, text: string | null, snapshot: any) {
  db.prepare(`INSERT INTO linear_import_objects(owner_id,workspace_id,source_issue_id,kind,source_id,local_id,applied_text,snapshot) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,workspace_id,source_issue_id,kind,source_id) DO UPDATE SET local_id=excluded.local_id,applied_text=excluded.applied_text,snapshot=excluded.snapshot`).run(owner, workspace, issue, kind, id, local, text, encode(snapshot));
}
function commentText(kind: string, entry: any) {
  const author = entry.user?.name || entry.externalUser?.name || entry.actor?.name || entry.creator?.name || entry.botActor?.name || "Внешний участник";
  if (kind === "document") return `Linear · документ · ${entry.title} · ${author}\n\n${entry.content || ""}\n\nИсточник: ${entry.url}`;
  if (kind === "comment") return `Linear · ${author} · ${entry.createdAt}\n\n${entry.body}`;
  const changes = Object.fromEntries(Object.entries(entry).filter(([key, value]) => !["id", "createdAt", "updatedAt", "actor", "botActor"].includes(key) && value != null));
  return `Linear · история · ${author} · ${entry.createdAt}\n\n\`\`\`json\n${encode(changes)}\n\`\`\``;
}
function metadataText(issue: LinearIssue) {
  const names = (items: any[]) => items.map(i => i.name).join(", ") || "—";
  const relations = [...new Map([...issue.relations, ...issue.inverseRelations].map((r: any) => [r.id, r])).values()] as any[];
  return `Linear · источник\n\n${issue.identifier}: ${issue.url}\nСтатус Linear: ${issue.state.name}\nИсполнитель Linear: ${issue.assignee?.name || "—"}\nПроект Linear: ${issue.project?.name || "—"}\nКоманда Linear: ${issue.team?.name || "—"}\nМетки Linear: ${names(issue.labels)}\nЦикл Linear: ${issue.cycle?.name || "—"}\nОценка Linear: ${issue.estimate ?? "—"}\n${issue.archivedAt ? "Архивирована в Linear\n" : ""}\nСвязи Linear:\n${relations.map(r => `${r.type}: ${r.issue.identifier} → ${r.relatedIssue.identifier} (${r.relatedIssue.url})`).join("\n") || "—"}\n\nВложения (ссылки на оригиналы):\n${issue.attachments.map((a: any) => `${a.title}: ${a.url}`).join("\n") || "—"}`;
}
function localFingerprint(owner: string, workspace: string) {
  const state = mappings(owner, workspace).map(map => ({ map, task: db.prepare("SELECT title,description,priority,due_date,status,parent_id,agent_state,ready_for_pickup FROM tasks WHERE id=?").get(map.task_id),
    comments: db.prepare("SELECT id,text FROM comments WHERE task_id=? ORDER BY id").all(map.task_id),
    labels: db.prepare("SELECT label_id FROM task_labels WHERE task_id=? ORDER BY label_id").all(map.task_id),
    dependencies: db.prepare("SELECT depends_on_task_id,policy FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id").all(map.task_id) }));
  return crypto.createHash("sha256").update(encode(state)).digest("hex");
}
function taskIdsFor(owner: string, snapshot: LinearSnapshot) {
  const existing = new Map(mappings(owner, snapshot.workspace.id).map(m => [m.source_id, m.task_id]));
  for (const issue of snapshot.issues) if (!existing.has(issue.id)) existing.set(issue.id, uid());
  return existing;
}
function relationsOf(snapshot: LinearSnapshot): any[] {
  return [...new Map(snapshot.issues.flatMap(issue => [...issue.relations, ...issue.inverseRelations]).map((r: any) => [r.id, r])).values()];
}
function ensureAcyclic(edges: Array<[string, string]>) {
  const graph = new Map<string, string[]>();
  for (const [from, to] of edges) { if (from === to) throw new LinearSourceError("Цикл зависимостей.", 422); graph.set(from, [...(graph.get(from) || []), to]); }
  const done = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) { if (visiting.has(id)) throw new LinearSourceError("Импорт создаёт цикл зависимостей. Запись отменена.", 422); if (done.has(id)) return; visiting.add(id); for (const next of graph.get(id) || []) visit(next); visiting.delete(id); done.add(id); }
  for (const id of graph.keys()) visit(id);
}
function validateLocalHierarchy(snapshot: LinearSnapshot, ids: Map<string, string>, owner: string) {
  const pairs = (db.prepare("SELECT id,parent_id FROM tasks WHERE parent_id IS NOT NULL").all() as any[]).map(t => [t.id, t.parent_id] as [string, string]);
  const parent = new Map(pairs);
  for (const issue of snapshot.issues) {
    const mapping: any = db.prepare("SELECT applied_fields FROM linear_import_tasks WHERE owner_id=? AND workspace_id=? AND source_id=?").get(owner, snapshot.workspace.id, issue.id);
    const current: any = db.prepare("SELECT parent_id,agent_state,ready_for_pickup FROM tasks WHERE id=?").get(ids.get(issue.id));
    const remote = issue.parent ? ids.get(issue.parent.id)! : null;
    if (!mapping || (!(current?.agent_state || current?.ready_for_pickup) && (current?.parent_id === JSON.parse(mapping.applied_fields).parent_id || current?.parent_id === remote))) {
      if (remote) parent.set(ids.get(issue.id)!, remote); else parent.delete(ids.get(issue.id)!);
    }
  }
  ensureAcyclic([...parent.entries()]);
}

export function createLinearPreview(owner: string, snapshot: LinearSnapshot, projectId: string | null) {
  validateLinearSnapshot(snapshot);
  const ids = taskIdsFor(owner, snapshot), existing = new Map(mappings(owner, snapshot.workspace.id).map(m => [m.source_id, m]));
  validateLocalHierarchy(snapshot, ids, owner);
  const items = snapshot.issues.map(issue => {
    const mapping = existing.get(issue.id), current: any = mapping ? db.prepare("SELECT * FROM tasks WHERE id=?").get(mapping.task_id) : undefined;
    const merge = current ? mergeLinearFields(current, JSON.parse(mapping.applied_fields), fields(issue, ids)) : null;
    const conflicts = merge?.conflicts ?? [];
    for (const [kind, entries] of [["comment", issue.comments], ["history", issue.history], ["document", issue.documents]] as const) {
      for (const entry of entries) {
        const old = object(owner, snapshot.workspace.id, issue.id, kind, entry.id);
        const local: any = old?.local_id ? db.prepare("SELECT text FROM comments WHERE id=?").get(old.local_id) : undefined;
        if (local && local.text !== old.applied_text && commentText(kind, entry) !== old.applied_text && local.text !== commentText(kind, entry)) conflicts.push(`${kind}:${entry.id}`);
      }
    }
    if (current?.agent_state || current?.ready_for_pickup) conflicts.push("Внутренняя работа: статус и родитель сохраняются");
    return { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url, parent_id: issue.parent?.id ?? null,
      task_id: mapping?.task_id ?? null, action: mapping ? "update" : "create", reason: snapshot.selected_ids.includes(issue.id) ? "selected" : "hierarchy",
      comments: issue.comments.length, history: issue.history.length, labels: issue.labels.length, attachments: issue.attachments.length, documents: issue.documents.length, conflicts,
      source_state: issue.state.name, source_assignee: issue.assignee?.name ?? null };
  });
  const warnings: string[] = ["Для активных карточек без существующего плана будет создан редактируемый черновик командной работы. Роли запускаются только после утверждения."];
  if (snapshot.issues.some(i => i.state.type === "canceled")) warnings.push("Отменённые задачи остаются активными внутренними карточками; исходный статус сохраняется отдельно.");
  if (snapshot.issues.some(i => i.attachments.length)) warnings.push("Вложения сохраняются ссылками на оригиналы. Файлы не скачиваются.");
  if (relationsOf(snapshot).some(r => !ids.has(r.issue.id) || !ids.has(r.relatedIssue.id))) warnings.push("Связи с неперенесёнными задачами сохраняются как внешние ссылки.");
  const previewId = uid(), expires = Date.now() + 15 * 60_000;
  const stored = { source: snapshot, project_id: projectId, fingerprint: localFingerprint(owner, snapshot.workspace.id) };
  db.prepare("DELETE FROM linear_import_previews WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO linear_import_previews(id,owner_id,snapshot,expires_at) VALUES(?,?,?,?)").run(previewId, owner, encode(stored), expires);
  return { preview_id: previewId, workspace: snapshot.workspace, fetched_at: snapshot.fetched_at, expires_at: new Date(expires).toISOString(), project_id: projectId,
    items, warnings, create_count: items.filter(i => i.action === "create").length, update_count: items.filter(i => i.action === "update").length };
}

function importComment(owner: string, workspace: string, issue: LinearIssue, task: string, kind: string, entry: any, text: string) {
  const old = object(owner, workspace, issue.id, kind, entry.id);
  const current: any = old?.local_id ? db.prepare("SELECT text,task_id FROM comments WHERE id=?").get(old.local_id) : null;
  if (current?.task_id === task) {
    let applied = old.applied_text;
    if (current.text === old.applied_text || current.text === text) { db.prepare("UPDATE comments SET text=? WHERE id=?").run(text, old.local_id); applied = text; }
    saveObject(owner, workspace, issue.id, kind, entry.id, old.local_id, applied, entry);
  } else if (old && !current && kind !== "metadata") {
    // A locally deleted source comment remains deleted; keep its source snapshot.
    saveObject(owner, workspace, issue.id, kind, entry.id, old.local_id, old.applied_text, entry);
  } else {
    const id = uid(); db.prepare("INSERT INTO comments(id,task_id,user_id,text,created_at) VALUES(?,?,?,?,?)").run(id, task, owner, text, date(entry.createdAt));
    saveObject(owner, workspace, issue.id, kind, entry.id, id, text, entry);
  }
}
function importLabels(owner: string, workspace: string, issue: LinearIssue, task: string) {
  const incoming = new Set(issue.labels.map((l: any) => l.id));
  const previous = db.prepare("SELECT * FROM linear_import_objects WHERE owner_id=? AND workspace_id=? AND source_issue_id=? AND kind='label'").all(owner, workspace, issue.id) as any[];
  for (const old of previous) if (!incoming.has(old.source_id)) {
    if (JSON.parse(old.snapshot).managed) db.prepare("DELETE FROM task_labels WHERE task_id=? AND label_id=?").run(task, old.local_id);
    db.prepare("DELETE FROM linear_import_objects WHERE owner_id=? AND workspace_id=? AND source_issue_id=? AND kind='label' AND source_id=?").run(owner, workspace, issue.id, old.source_id);
  }
  for (const label of issue.labels) {
    const old = object(owner, workspace, issue.id, "label", label.id);
    let local: any = old?.local_id ? db.prepare("SELECT * FROM labels WHERE id=?").get(old.local_id) : undefined;
    if (!local) {
      const shared: any = db.prepare("SELECT local_id FROM linear_import_objects WHERE owner_id=? AND workspace_id=? AND kind='label' AND source_id=? LIMIT 1").get(owner, workspace, label.id);
      if (shared) local = db.prepare("SELECT * FROM labels WHERE id=?").get(shared.local_id);
      local ??= db.prepare("SELECT * FROM labels WHERE owner_id=? AND name=?").get(owner, label.name);
      if (!local) { local = { id: uid() }; db.prepare("INSERT INTO labels(id,name,color,owner_id) VALUES(?,?,?,?)").run(local.id, label.name, /^#[a-f0-9]{6}$/i.test(label.color) ? label.color : "#A6A6A6", owner); }
    }
    const present = !!db.prepare("SELECT 1 FROM task_labels WHERE task_id=? AND label_id=?").get(task, local.id);
    if (!old) db.prepare("INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES(?,?)").run(task, local.id);
    saveObject(owner, workspace, issue.id, "label", label.id, local.id, null, { ...label, managed: old ? JSON.parse(old.snapshot).managed : !present });
  }
}
function importRelations(owner: string, snapshot: LinearSnapshot, ids: Map<string, string>) {
  const incoming = relationsOf(snapshot), seen = new Set(incoming.map(r => r.id)), selected = new Set(snapshot.issues.map(i => i.id));
  const old = db.prepare("SELECT * FROM linear_import_relations WHERE owner_id=? AND workspace_id=? AND active=1").all(owner, snapshot.workspace.id) as any[];
  for (const relation of old) if ((selected.has(relation.source_issue_id) || selected.has(relation.target_issue_id)) && !seen.has(relation.source_id)) {
    const dependent = ids.get(relation.target_issue_id), blocker = ids.get(relation.source_issue_id);
    if (relation.managed_edge && dependent && blocker) db.prepare("DELETE FROM task_dependencies WHERE task_id=? AND depends_on_task_id=? AND policy='completed'").run(dependent, blocker);
    db.prepare("UPDATE linear_import_relations SET active=0 WHERE owner_id=? AND workspace_id=? AND source_id=?").run(owner, snapshot.workspace.id, relation.source_id);
  }
  for (const relation of incoming) {
    const from = ids.get(relation.issue.id), to = ids.get(relation.relatedIssue.id);
    const previous: any = db.prepare("SELECT * FROM linear_import_relations WHERE owner_id=? AND workspace_id=? AND source_id=?").get(owner, snapshot.workspace.id, relation.id);
    let managed = previous?.managed_edge ?? 0;
    if (relation.type === "blocks" && from && to && (!previous || !previous.active)) {
      const present = db.prepare("SELECT 1 FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?").get(to, from);
      if (!present) { db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id,policy) VALUES(?,?,'completed')").run(to, from); managed = 1; }
    }
    db.prepare(`INSERT INTO linear_import_relations(owner_id,workspace_id,source_id,source_issue_id,target_issue_id,relation_type,managed_edge,snapshot) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,workspace_id,source_id) DO UPDATE SET active=1,snapshot=excluded.snapshot,managed_edge=excluded.managed_edge`).run(owner, snapshot.workspace.id, relation.id, relation.issue.id, relation.relatedIssue.id, relation.type, managed, encode(relation));
  }
  const edges = db.prepare("SELECT task_id,depends_on_task_id FROM task_dependencies").all() as any[];
  ensureAcyclic(edges.map(e => [e.task_id, e.depends_on_task_id]));
}

export function commitLinearPreview(owner: string, previewId: string) {
  return db.transaction(() => {
    const preview: any = db.prepare("SELECT * FROM linear_import_previews WHERE id=? AND owner_id=?").get(previewId, owner);
    if (!preview || preview.expires_at < Date.now()) throw new LinearSourceError("Предварительный просмотр устарел. Загрузите его заново.", 409);
    if (preview.result) return JSON.parse(preview.result);
    const stored = JSON.parse(preview.snapshot), snapshot: LinearSnapshot = stored.source;
    if (localFingerprint(owner, snapshot.workspace.id) !== stored.fingerprint) throw new LinearSourceError("Карточки TaskFlow изменились после просмотра. Обновите предварительный просмотр.", 409);
    validateLinearSnapshot(snapshot);
    if (stored.project_id && !getProjectForFiling(stored.project_id, owner, null)) throw new LinearSourceError("Проект назначения изменился. Обновите просмотр.", 409);
    const ids = taskIdsFor(owner, snapshot), existing = new Map(mappings(owner, snapshot.workspace.id).map(m => [m.source_id, m]));
    validateLocalHierarchy(snapshot, ids, owner);
    const result: any = { created: 0, updated: 0, conflicts: [], task_ids: [] };
    // Insert every card before setting hierarchy; no model, proposal, or dispatch.
    for (const issue of snapshot.issues) if (!existing.has(issue.id)) {
      // A deleted local card can be re-imported explicitly with its full source history.
      db.prepare("DELETE FROM linear_import_objects WHERE owner_id=? AND workspace_id=? AND source_issue_id=?").run(owner, snapshot.workspace.id, issue.id);
      db.prepare("UPDATE linear_import_relations SET active=0,managed_edge=0 WHERE owner_id=? AND workspace_id=? AND (source_issue_id=? OR target_issue_id=?)").run(owner, snapshot.workspace.id, issue.id, issue.id);
      const remote = fields(issue, ids);
      db.prepare("INSERT INTO tasks(id,title,description,priority,due_date,status,creator_id,project_id,ready_for_pickup,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").run(ids.get(issue.id), remote.title, remote.description, remote.priority, remote.due_date, remote.status, owner, stored.project_id, date(issue.createdAt));
    }
    for (const issue of snapshot.issues) {
      const task = ids.get(issue.id)!, mapping = existing.get(issue.id), current: any = db.prepare("SELECT * FROM tasks WHERE id=?").get(task), remote = fields(issue, ids);
      const merged = mapping ? mergeLinearFields(current, JSON.parse(mapping.applied_fields), remote) : { applied: remote, updates: remote, conflicts: [] as string[] };
      if (mapping && (current.agent_state || current.ready_for_pickup)) {
        for (const key of ["status", "parent_id"]) { delete merged.updates[key]; merged.applied[key] = JSON.parse(mapping.applied_fields)[key]; }
      }
      const columns = Object.keys(merged.updates);
      if (columns.length) db.prepare(`UPDATE tasks SET ${columns.map(c => `${c}=?`).join(",")},updated_at=datetime('now') WHERE id=?`).run(...columns.map(c => merged.updates[c]), task);
      if (mapping && columns.some(key => current[key] !== merged.updates[key])) bumpContextVersion(task);
      db.prepare(`INSERT INTO linear_import_tasks(owner_id,workspace_id,source_id,task_id,source_url,snapshot,applied_fields) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,workspace_id,source_id) DO UPDATE SET snapshot=excluded.snapshot,source_url=excluded.source_url,applied_fields=excluded.applied_fields,imported_at=datetime('now')`).run(owner, snapshot.workspace.id, issue.id, task, issue.url, encode(issue), encode(merged.applied));
      for (const entry of issue.comments) importComment(owner, snapshot.workspace.id, issue, task, "comment", entry, commentText("comment", entry));
      for (const entry of issue.history) importComment(owner, snapshot.workspace.id, issue, task, "history", entry, commentText("history", entry));
      for (const entry of issue.documents) importComment(owner, snapshot.workspace.id, issue, task, "document", entry, commentText("document", entry));
      importComment(owner, snapshot.workspace.id, issue, task, "metadata", { id: "source", createdAt: issue.createdAt }, metadataText(issue));
      importLabels(owner, snapshot.workspace.id, issue, task);
      for (const attachment of issue.attachments) saveObject(owner, snapshot.workspace.id, issue.id, "attachment", attachment.id, null, null, attachment);
      if (!mapping || mapping.snapshot !== encode(issue)) logEvent({ taskId: task, actorId: owner, kind: mapping ? "linear_import_updated" : "linear_imported", toValue: issue.url });
      result[mapping ? "updated" : "created"]++;
      if (merged.conflicts.length) result.conflicts.push({ source_id: issue.id, fields: merged.conflicts });
      result.task_ids.push({ source_id: issue.id, task_id: task, title: issue.title });
    }
    importRelations(owner, snapshot, ids);
    // All cards/parents/dependencies exist before proposing work. This is the
    // shared draft mechanism, not intake that re-creates source decomposition.
    for (const item of result.task_ids) {
      const draft = autoProposeCollaborationPlanIfNeeded(item.task_id, { actorId: owner, imported: true });
      const visible = draft ?? db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='draft' ORDER BY revision DESC LIMIT 1").get(item.task_id) as {id:string}|undefined;
      if (visible) item.draft_plan_id = visible.id;
    }
    db.prepare("UPDATE linear_import_previews SET result=?,snapshot='{}' WHERE id=?").run(encode(result), previewId);
    return result;
  })();
}
