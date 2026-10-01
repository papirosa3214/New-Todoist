import { linearQuery, LinearSourceError } from "../runtime/linearTransport.js";
export type LinearIssue = {
  id: string; identifier: string; title: string; description: string | null; url: string;
  priority: number; dueDate: string | null; createdAt: string; updatedAt: string; archivedAt: string | null;
  parent: { id: string } | null; state: { id: string; name: string; type: string };
  [key: string]: any;
};
export type LinearSnapshot = { workspace: { id: string; name: string }; selected_ids: string[]; issues: LinearIssue[]; fetched_at: string };
export type LinearRead = (owner: string, query: string, variables?: Record<string, unknown>) => Promise<any>;
const PAGE = "pageInfo { hasNextPage endCursor }";
const CORE = `id identifier title description url priority dueDate createdAt updatedAt archivedAt
 parent { id } state { id name type } team { id name key } project { id name }
 assignee { id name } creator { id name } cycle { id name } estimate sortOrder subIssueSortOrder
 projectMilestone { id name } descriptionState`;
const CONNECTIONS: Record<string, string> = {
  children: "id",
  labels: "id name color",
  comments: "id body createdAt updatedAt url user { id name } parent { id } externalUser { id name } botActor { id name }",
  attachments: "id title subtitle url createdAt updatedAt metadata sourceType",
  documents: "id title content url createdAt updatedAt creator { id name }",
  relations: "id type issue { id identifier title url } relatedIssue { id identifier title url }",
  inverseRelations: "id type issue { id identifier title url } relatedIssue { id identifier title url }",
  history: `actorId addedLabelIds addedToReleaseIds archived archivedAt attachmentId autoArchived autoClosed changes createdAt customerNeedId fromAssigneeId fromCycleId fromDueDate fromEstimate fromParentId fromPriority fromProjectId fromSlaBreached fromSlaBreachesAt fromSlaStartedAt fromSlaType fromStateId fromTeamId fromTitle id removedFromReleaseIds removedLabelIds toAssigneeId toConvertedProjectId toCycleId toDueDate toEstimate toParentId toPriority toProjectId toSlaBreached toSlaBreachesAt toSlaStartedAt toSlaType toStateId toTeamId toTitle trashed triageResponsibilityAutoAssigned updatedAt updatedDescription actor { id name } botActor { id name } fromState { id name type } toState { id name type }`,
};

function connection(value: any) {
  if (!value || !Array.isArray(value.nodes) || typeof value.pageInfo?.hasNextPage !== "boolean") throw new LinearSourceError("Linear вернул неполную коллекцию. Импорт остановлен.");
  if (value.pageInfo.hasNextPage && (typeof value.pageInfo.endCursor !== "string" || !value.pageInfo.endCursor)) throw new LinearSourceError("Linear не вернул курсор следующей страницы.");
  return value;
}

export async function listLinearIssues(owner: string, after: string | null = null, read: LinearRead = linearQuery) {
  const data = await read(owner, `query TaskFlowLinearList($after: String) {
    organization { id name }
    issues(first: 50, after: $after, includeArchived: true, orderBy: createdAt) { nodes { ${CORE} } ${PAGE} }
  }`, { after });
  const items = connection(data.issues);
  if (!data.organization?.id) throw new LinearSourceError("Linear не вернул рабочее пространство.");
  return { workspace: data.organization, issues: items.nodes, cursor: items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null };
}

export async function fetchLinearSnapshot(owner: string, selected: string[], read: LinearRead = linearQuery): Promise<LinearSnapshot> {
  const started = Date.now();
  const withinDeadline = () => { if (Date.now() - started > 10 * 60_000) throw new LinearSourceError("Подготовка Linear заняла слишком долго. Выберите меньшую группу задач.", 422); };
  const issues = new Map<string, LinearIssue>();
  const expanded = new Set<string>();
  const queue = selected.map(id => ({ id, descend: true }));
  let workspace: any;
  while (queue.length) {
    withinDeadline();
    const item = queue.shift()!;
    let issue = issues.get(item.id);
    if (!issue) {
      if (issues.size >= 500) throw new LinearSourceError("Структура содержит более 500 карточек. Выберите меньшую группу.", 422);
      const data = await read(owner, `query TaskFlowLinearIssue($id: String!) {
        organization { id name }
        issue(id: $id) { ${CORE} ${Object.entries(CONNECTIONS).map(([name, fields]) => `${name}(first: 50, includeArchived: true) { nodes { ${fields} } ${PAGE} }`).join("\n")} }
      }`, { id: item.id });
      if (!data.organization?.id || (workspace && workspace.id !== data.organization.id)) throw new LinearSourceError("Рабочее пространство Linear изменилось во время загрузки. Повторите preview.", 409);
      workspace = data.organization;
      if (!data.issue || data.issue.id !== item.id) throw new LinearSourceError("Одна из задач структуры недоступна. Импорт остановлен.", 422);
      issue = data.issue;
      for (const [name, fields] of Object.entries(CONNECTIONS)) {
        let page = connection(issue![name]);
        const nodes = [...page.nodes], cursors = new Set<string>();
        while (page.pageInfo.hasNextPage) {
          withinDeadline();
          const cursor = page.pageInfo.endCursor;
          if (cursors.has(cursor) || cursors.size >= 100 || nodes.length >= 5000) throw new LinearSourceError("Коллекция Linear слишком большая или её пагинация зациклена. Импорт остановлен.", 422);
          cursors.add(cursor);
          const next = await read(owner, `query TaskFlowLinearCollection($id: String!, $after: String!) {
            issue(id: $id) { ${name}(first: 50, after: $after, includeArchived: true) { nodes { ${fields} } ${PAGE} } }
          }`, { id: item.id, after: cursor });
          page = connection(next.issue?.[name]); nodes.push(...page.nodes);
        }
        if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new LinearSourceError("Linear вернул дубли элементов между страницами. Повторите загрузку.", 409);
        issue![name] = nodes;
      }
      issues.set(item.id, issue!);
      if (issue!.parent?.id) queue.push({ id: issue!.parent.id, descend: false });
    }
    if (item.descend && !expanded.has(item.id)) {
      expanded.add(item.id);
      for (const child of issue!.children) queue.push({ id: child.id, descend: true });
    }
  }
  withinDeadline();
  return { workspace, selected_ids: [...new Set(selected)], issues: [...issues.values()], fetched_at: new Date().toISOString() };
}
