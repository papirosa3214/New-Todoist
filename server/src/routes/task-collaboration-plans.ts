import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOrchestrator, isOwner } from "../access.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { ROLE_NAMES, roleUserId } from "../roleRouting.js";
import { startSlotRun } from "./task-role-slots.js";

const PROFILES = new Set(["single_executor", "research", "delivery", "full_cycle", "manual", "product_feature"]);
const CONDITIONS = new Set(["submitted", "accepted", "artifact_ready"]);
const SLOT_KEY = /^[a-z][a-z0-9_]{1,63}$/;

type Plan = {
  id: string;
  task_id: string;
  revision: number;
  status: "draft" | "approved" | "superseded";
  profile: string;
  rationale: string;
  context_version: number | null;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
};

type ArtifactContract = { key: string; type: string; format: "json"; required_fields: string[] };
type NodeInput = { slot_key?: unknown; role_key?: unknown; required?: unknown; expected_result?: unknown; output_artifact?: unknown };
type EdgeInput = { from_slot_key?: unknown; to_slot_key?: unknown; start_condition?: unknown; artifact_key?: unknown };
type Node = { slot_key: string; role_key: string; required: boolean; expected_result: string; output_artifact: ArtifactContract | null };
type Edge = { from_slot_key: string; to_slot_key: string; start_condition: string; artifact_key: string | null };

function mayManage(userId: string): boolean {
  return isOwner(userId) || isOrchestrator(userId);
}

function present(plan: Plan) {
  const nodes = db.prepare("SELECT slot_key, role_key, required, expected_result, output_artifact_json FROM task_collaboration_plan_nodes WHERE plan_id = ? ORDER BY slot_key")
    .all(plan.id) as Array<Omit<Node, "required" | "output_artifact"> & { required: number; output_artifact_json: string | null }>;
  const edges = db.prepare("SELECT from_slot_key, to_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ? ORDER BY from_slot_key, to_slot_key")
    .all(plan.id) as Edge[];
  return {
    ...plan,
    nodes: nodes.map((node) => ({
      slot_key: node.slot_key,
      role_key: node.role_key,
      required: node.required === 1,
      expected_result: node.expected_result,
      output_artifact: node.output_artifact_json === null ? null : JSON.parse(node.output_artifact_json) as ArtifactContract,
    })),
    edges,
  };
}

function parseArtifactContract(raw: unknown): ArtifactContract | null {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("output_artifact должен быть объектом");
  const contract = raw as Record<string, unknown>;
  const key = String(contract.key ?? "").trim();
  const type = String(contract.type ?? "").trim();
  const format = String(contract.format ?? "").trim();
  const requiredFields = contract.required_fields;
  if (!SLOT_KEY.test(key)) throw new Error("некорректный output_artifact key");
  if (!SLOT_KEY.test(type)) throw new Error("некорректный output_artifact type");
  if (format !== "json") throw new Error("output_artifact format должен быть json");
  if (!Array.isArray(requiredFields) || requiredFields.length === 0 || requiredFields.length > 32
    || requiredFields.some((field) => typeof field !== "string" || !SLOT_KEY.test(field))) {
    throw new Error("некорректный output_artifact required_fields");
  }
  return { key, type, format: "json", required_fields: requiredFields };
}

function parseGraph(body: { nodes?: unknown; edges?: unknown }) {
  if (!Array.isArray(body.nodes) || body.nodes.length === 0 || body.nodes.length > 16) throw new Error("нужны от 1 до 16 nodes");
  if (body.edges !== undefined && !Array.isArray(body.edges)) throw new Error("edges должен быть массивом");
  if (Array.isArray(body.edges) && body.edges.length > 48) throw new Error("слишком много edges");

  const nodes = (body.nodes as NodeInput[]).map((raw) => ({
    slot_key: String(raw.slot_key ?? "").trim(),
    role_key: String(raw.role_key ?? "").trim(),
    required: raw.required !== false,
    expected_result: String(raw.expected_result ?? "").trim(),
    output_artifact: parseArtifactContract(raw.output_artifact),
  }));
  const keys = new Set<string>();
  const artifactKeys = new Set<string>();
  const sourceArtifacts = new Map<string, ArtifactContract>();
  for (const node of nodes) {
    if (!SLOT_KEY.test(node.slot_key)) throw new Error("некорректный slot_key");
    if (!ROLE_NAMES.includes(node.role_key)) throw new Error("unknown role");
    if (node.expected_result.length > 1000) throw new Error("expected_result длиннее 1000 символов");
    if (keys.has(node.slot_key)) throw new Error("slot_key должен быть уникальным");
    if (node.output_artifact && artifactKeys.has(node.output_artifact.key)) throw new Error("output_artifact key должен быть уникальным");
    keys.add(node.slot_key);
    if (node.output_artifact) {
      artifactKeys.add(node.output_artifact.key);
      sourceArtifacts.set(node.slot_key, node.output_artifact);
    }
  }

  const edgeKeys = new Set<string>();
  const edges = ((body.edges ?? []) as EdgeInput[]).map((raw) => ({
    from_slot_key: String(raw.from_slot_key ?? "").trim(),
    to_slot_key: String(raw.to_slot_key ?? "").trim(),
    start_condition: String(raw.start_condition ?? "accepted").trim(),
    artifact_key: raw.artifact_key === undefined ? null : String(raw.artifact_key).trim(),
  }));
  for (const edge of edges) {
    if (!keys.has(edge.from_slot_key) || !keys.has(edge.to_slot_key) || edge.from_slot_key === edge.to_slot_key) throw new Error("edge должен связывать разные известные slots");
    if (!CONDITIONS.has(edge.start_condition)) throw new Error("unknown start_condition");
    const sourceArtifact = sourceArtifacts.get(edge.from_slot_key);
    if (sourceArtifact && edge.artifact_key !== sourceArtifact.key) throw new Error("edge artifact_key должен совпадать с output_artifact source node");
    if (!sourceArtifact && edge.artifact_key !== null) throw new Error("edge artifact_key требует output_artifact source node");
    const edgeKey = edge.from_slot_key + ":" + edge.to_slot_key;
    if (edgeKeys.has(edgeKey)) throw new Error("edge должен быть уникальным");
    edgeKeys.add(edgeKey);
  }

  const next = new Map<string, string[]>();
  for (const key of keys) next.set(key, []);
  for (const edge of edges) next.get(edge.from_slot_key)!.push(edge.to_slot_key);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    if (next.get(key)!.some(visit)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  if ([...keys].some(visit)) throw new Error("граф collaboration plan содержит цикл");
  return { nodes, edges };
}

function planForTask(taskId: string, planId: string): Plan | undefined {
  return db.prepare("SELECT * FROM task_collaboration_plans WHERE id = ? AND task_id = ?").get(planId, taskId) as Plan | undefined;
}

export function createDraftPlan(taskId: string, createdBy: string, profile: string, rationale: string, contextVersion: number | null, graph: { nodes: Node[]; edges: Edge[] }) {
  const revision = ((db.prepare("SELECT MAX(revision) AS revision FROM task_collaboration_plans WHERE task_id = ?").get(taskId) as { revision: number | null }).revision ?? 0) + 1;
  const id = `tcp_${crypto.randomUUID()}`;
  db.transaction(() => {
    db.prepare(`INSERT INTO task_collaboration_plans (id, task_id, revision, profile, rationale, context_version, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, revision, profile, rationale, contextVersion, createdBy);
    const insertNode = db.prepare("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const node of graph.nodes) insertNode.run("tcpn_" + crypto.randomUUID(), id, node.slot_key, node.role_key, node.required ? 1 : 0, node.expected_result, node.output_artifact === null ? null : JSON.stringify(node.output_artifact));
    const insertEdge = db.prepare("INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition, artifact_key) VALUES (?, ?, ?, ?, ?, ?)");
    for (const edge of graph.edges) insertEdge.run("tcpe_" + crypto.randomUUID(), id, edge.from_slot_key, edge.to_slot_key, edge.start_condition, edge.artifact_key);
  })();
  return { id, revision };
}

/**
 * T03 «Продуктовая фича» (docs/2026-09-29-collaboration-plan-templates,
 * HANDOFF-T03-CONTRACT.md): A1/V1 обязательны всегда, H1/D1/Q1 — только по
 * флагу. При явном `profile: "product_feature"` в `/propose` флаг — прямое
 * решение вызывающего; при `profile: "auto"` флаги считает
 * `autoProductFeatureCandidate()` по тексту задачи. В обоих случаях
 * отключённый узел не оставляет edge на себя.
 */
function productFeatureTemplate(flags: { includeArchitecture: boolean; includeDesign: boolean; includeQa: boolean }): { nodes: Node[]; edges: Edge[]; rationale: string } {
  const artifact = (key: string, type: string, required_fields: string[]): ArtifactContract => ({ key, type, format: "json", required_fields });
  const node = (slot_key: string, role_key: string, expected_result: string, output_artifact: ArtifactContract): Node => ({ slot_key, role_key, required: true, expected_result, output_artifact });
  const edge = (from_slot_key: string, to_slot_key: string, start_condition: string, artifact_key: string): Edge => ({ from_slot_key, to_slot_key, start_condition, artifact_key });

  const nodes: Node[] = [
    node("analysis", "analyst", "feature_spec: scope, out_of_scope, acceptance_criteria, nfr, open_questions", artifact("feature_spec", "specification", ["scope", "out_of_scope", "acceptance_criteria", "nfr", "open_questions"])),
  ];
  const edges: Edge[] = [];
  const included = ["A1"];

  if (flags.includeArchitecture) {
    nodes.push(node("architecture", "architect", "architecture_decision: варианты, решение, последствия, rollout/rollback", artifact("architecture_decision", "decision", ["context", "options", "decision", "consequences", "rollout_rollback"])));
    edges.push(edge("analysis", "architecture", "accepted", "feature_spec"));
    included.push("H1");
  }
  if (flags.includeDesign) {
    nodes.push(node("design", "designer", "feature_ux_spec: экраны, state matrix, доступность, открытые вопросы", artifact("feature_ux_spec", "specification", ["screens", "state_matrix", "accessibility", "open_questions"])));
    edges.push(edge("analysis", "design", "accepted", "feature_spec"));
    included.push("D1");
  }

  nodes.push(node("delivery", "builder", "implementation_pack: изменения, build id, тесты, deployment notes", artifact("implementation_pack", "pack", ["change_refs", "build_id", "test_report", "deployment_notes", "known_limitations"])));
  edges.push(edge("analysis", "delivery", "accepted", "feature_spec"));
  if (flags.includeArchitecture) edges.push(edge("architecture", "delivery", "accepted", "architecture_decision"));
  if (flags.includeDesign) edges.push(edge("design", "delivery", "accepted", "feature_ux_spec"));
  included.push("V1");

  if (flags.includeQa) {
    nodes.push(node("qa", "qa", "feature_test_report: acceptance matrix, evidence, дефекты, рекомендация", artifact("feature_test_report", "report", ["acceptance_matrix", "evidence", "defects", "recommendation"])));
    edges.push(edge("delivery", "qa", "artifact_ready", "implementation_pack"));
    included.push("Q1");
  }

  return { nodes, edges, rationale: `T03 «Продуктовая фича»: ${included.join(" → ")}` };
}

/**
 * T03 в auto-подборе (владелец 29.09.2026: шаблон выбирает диспетчер по
 * правилам, а не владелец вручную именем профиля). Правила — прямо из
 * HANDOFF-T03-CONTRACT.md «Применимость» и «Триггеры условных узлов»:
 * ограниченная фича с проверяемыми AC — да; исследование необходимости
 * функции (T01), подтверждённый баг/регрессия (T05) или внешний
 * API-контракт как главный результат (T04) — нет, даже если совпадают
 * прочие ключевые слова. Детерминированный regex, не embeddings — тот
 * подбор остаётся отдельным будущим шагом (README «Предлагаемая целевая
 * модель»), пока не накопится больше шаблонов, которые есть смысл ранжировать.
 * Возвращает null, если T03 неприменим — тогда решают остальные профили ниже.
 */
function autoProductFeatureCandidate(text: string): { includeArchitecture: boolean; includeDesign: boolean; includeQa: boolean } | null {
  const isBugOrRegression = /\bбаг\b|регресси|дефект|не работает|сломал|ошибк[аи]|падает|краш|почин|исправ/.test(text);
  const isPureResearchQuestion = /нужно ли|стоит ли|имеет ли смысл|целесообразно/.test(text) && !/критери[ийя]? приём|acceptance criteria/.test(text);
  const isApiContractOnly = /(внешн\w* api|api[- ]контракт|спецификация api)/.test(text) && !/(экран|интерфейс|\bui\b|\bux\b)/.test(text);
  if (isBugOrRegression || isPureResearchQuestion || isApiContractOnly) return null;

  const hasFeatureSignal = /\bфич[ауеы]?\b|новая возможность|новый экран|добавить|расшир[ияь]|критери[ийя]? приём|acceptance criteria/.test(text);
  if (!hasFeatureSignal) return null;

  return {
    includeArchitecture: /миграц|интеграц|кросс-сервис|контракт api|\bnfr\b|производительн|масштаб|инфраструктур/.test(text),
    includeDesign: /экран|интерфейс|\bui\b|\bux\b|дизайн|пользовательск\w*\s+(путь|сценари)/.test(text),
    includeQa: true,
  };
}

export function proposalFor(taskId: string, requested: string, productFeatureFlags?: { includeArchitecture: boolean; includeDesign: boolean; includeQa: boolean }) {
  if (requested === "product_feature") {
    return { profile: "product_feature", ...productFeatureTemplate(productFeatureFlags ?? { includeArchitecture: false, includeDesign: false, includeQa: false }) };
  }
  const task = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as { title: string; description: string | null };
  const text = `${task.title}\n${task.description ?? ""}`.toLowerCase();
  if (requested === "auto") {
    const t03 = autoProductFeatureCandidate(text);
    if (t03) return { profile: "product_feature", ...productFeatureTemplate(t03) };
  }
  const profile = requested === "auto"
    ? (/\b(ui|ux|api)\b|дизайн|интерфейс|экран/.test(text) && /исслед|анализ|сравн|вариант/.test(text) ? "full_cycle"
      : /\b(ui|ux|api)\b|сервер|миграц|swift|react|код|интеграц/.test(text) ? "delivery"
      : /исслед|анализ|сравн|вариант|источник/.test(text) ? "research"
      : "single_executor")
    : requested;
  const node = (slot_key: string, role_key: string, expected_result: string): Node => ({ slot_key, role_key, required: true, expected_result, output_artifact: null });
  const edge = (from_slot_key: string, to_slot_key: string): Edge => ({ from_slot_key, to_slot_key, start_condition: "accepted", artifact_key: null });
  const templates: Record<string, { nodes: Node[]; edges: Edge[]; rationale: string }> = {
    single_executor: { nodes: [node("executor", "builder", "Выполненный результат задачи")], edges: [], rationale: "Низкая неопределённость: достаточно основного исполнителя." },
    research: { nodes: [node("research", "researcher", "Факты, источники и ограничения"), node("analysis", "analyst", "Требования, выводы и критерии")], edges: [edge("research", "analysis")], rationale: "Сначала собрать факты, затем превратить их в проверяемые выводы." },
    delivery: { nodes: [node("architecture", "architect", "Техническое решение и риски"), node("executor", "builder", "Реализация"), node("qa", "qa", "Проверенные сценарии и дефекты"), node("critic", "critic_verifier", "Итоговый вердикт")], edges: [edge("architecture", "executor"), edge("executor", "qa"), edge("qa", "critic")], rationale: "Нужны техническое решение, реализация и независимая проверка." },
    full_cycle: { nodes: [node("research", "researcher", "Факты, источники и ограничения"), node("analysis", "analyst", "Требования и критерии"), node("architecture", "architect", "Техническое решение"), node("design", "designer", "Пользовательский сценарий и UX-решение"), node("executor", "builder", "Реализация"), node("qa", "qa", "Проверка сценариев"), node("critic", "critic_verifier", "Итоговый вердикт")], edges: [edge("research", "analysis"), edge("analysis", "architecture"), edge("analysis", "design"), edge("architecture", "executor"), edge("design", "executor"), edge("executor", "qa"), edge("qa", "critic")], rationale: "Высокая неопределённость: исследование, анализ, техническая и UX-ветки, реализация и две проверки." },
  };
  return { profile, ...templates[profile] };
}

/**
 * Владелец 28.09.2026: карточки не получали план сами — `propose` нигде не
 * вызывался автоматически, только вручную через API. Вызывается сразу после
 * создания задачи (routes/tasks.ts). Для одиночного исполнителя план не
 * создаём — не даёт пользы, только шум. Утверждает план по-прежнему
 * ТОЛЬКО владелец (`/collaboration-plans/:planId/approve` — это не трогали).
 *
 * created_by ищем по роли `orchestrator` в БД, а не хардкодим конкретный id:
 * захардкоженный id архивной учётки «Оркестратор Claude» ловил
 * FOREIGN KEY constraint failed на любой базе без этой конкретной строки
 * (тестовая/чистая — поймано тестами task-collaboration-plans.test.ts до
 * выкладки). Fallback на owner — так работает и там, где role=orchestrator
 * вообще не заведён. Найденная учётка используется ТОЛЬКО как значение
 * внешнего ключа для аудита — в чат не заходит, задач не берёт. Это замена
 * внешней агентской координации (закрыта 27.09.2026, CLAUDE.md §5.1/§15)
 * серверным кодом, а не возврат к ней.
 */
function resolveAutoProposalActorId(): string | null {
  const orchestrator = db.prepare("SELECT id FROM users WHERE role = 'orchestrator' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (orchestrator) return orchestrator.id;
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  return owner?.id ?? null;
}

export function autoProposeCollaborationPlanIfNeeded(taskId: string): { profile: string; revision: number } | null {
  const proposal = proposalFor(taskId, "auto");
  if (proposal.profile === "single_executor") return null;
  const actorId = resolveAutoProposalActorId();
  if (!actorId) return null;
  const created = createDraftPlan(taskId, actorId, proposal.profile, proposal.rationale, null, proposal);
  logEvent({ taskId, actorId, kind: "collaboration_plan_proposed", field: `revision:${created.revision}`, toValue: `${proposal.profile}: auto on create` });
  return { profile: proposal.profile, revision: created.revision };
}

export function registerTaskCollaborationPlanRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/tasks/:id/collaboration-plans", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    if (!mayManage(req.userId)) return reply.code(403).send({ error: "collaboration plan доступен владельцу или оркестратору" });
    const plans = db.prepare("SELECT * FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC").all(task.id) as Plan[];
    return { plans: plans.map(present) };
  });

  app.post<{ Params: { id: string }; Body: { profile?: unknown; rationale?: unknown; context_version?: unknown; nodes?: unknown; edges?: unknown } }>("/api/tasks/:id/collaboration-plans", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!mayManage(req.userId)) return reply.code(403).send({ error: "collaboration plan создаёт владелец или оркестратор" });
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const profile = String(req.body?.profile ?? "").trim();
    const rationale = String(req.body?.rationale ?? "").trim();
    const contextVersion = req.body?.context_version === undefined ? null : Number(req.body.context_version);
    if (!PROFILES.has(profile)) return reply.code(422).send({ error: "unknown collaboration profile" });
    if (rationale.length > 2000) return reply.code(400).send({ error: "rationale длиннее 2000 символов" });
    if (contextVersion !== null && (!Number.isInteger(contextVersion) || contextVersion < 1)) return reply.code(400).send({ error: "context_version должен быть положительным целым" });
    let graph: { nodes: Node[]; edges: Edge[] };
    try { graph = parseGraph(req.body ?? {}); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    const created = createDraftPlan(task.id, req.userId, profile, rationale, contextVersion, graph);
    logEvent({ taskId: task.id, actorId: req.userId, kind: "collaboration_plan_proposed", field: `revision:${created.revision}`, toValue: profile });
    return reply.code(201).send({ plan: present(planForTask(task.id, created.id)!) });
  });

  app.post<{ Params: { id: string }; Body: { profile?: unknown; context_version?: unknown; include_architecture?: unknown; include_design?: unknown; include_qa?: unknown } }>("/api/tasks/:id/collaboration-plans/propose", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!mayManage(req.userId)) return reply.code(403).send({ error: "collaboration plan предлагает владелец или оркестратор" });
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const requested = String(req.body?.profile ?? "auto").trim();
    if (requested !== "auto" && !PROFILES.has(requested)) return reply.code(422).send({ error: "unknown collaboration profile" });
    const contextVersion = req.body?.context_version === undefined ? null : Number(req.body.context_version);
    if (contextVersion !== null && (!Number.isInteger(contextVersion) || contextVersion < 1)) return reply.code(400).send({ error: "context_version должен быть положительным целым" });
    // T03: H1/D1/Q1 включаются только явным булевым флагом владельца, а не
    // текстовой эвристикой selector-а — тот же принцип, что и в остальном
    // auto-подборе, но проговорённый Task 4 отдельно для product_feature.
    const productFeatureFlags = requested === "product_feature"
      ? { includeArchitecture: req.body?.include_architecture === true, includeDesign: req.body?.include_design === true, includeQa: req.body?.include_qa === true }
      : undefined;
    const proposal = proposalFor(task.id, requested, productFeatureFlags);
    const created = createDraftPlan(task.id, req.userId, proposal.profile, proposal.rationale, contextVersion, proposal);
    logEvent({ taskId: task.id, actorId: req.userId, kind: "collaboration_plan_proposed", field: `revision:${created.revision}`, toValue: `${proposal.profile}: template` });
    return reply.code(201).send({ plan: present(planForTask(task.id, created.id)!), suggested: true });
  });

  app.post<{ Params: { id: string; planId: string } }>("/api/tasks/:id/collaboration-plans/:planId/approve", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "collaboration plan утверждает владелец" });
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const plan = planForTask(task.id, req.params.planId);
    if (!plan) return reply.code(404).send({ error: "plan not found" });
    if (plan.status !== "draft") return reply.code(409).send({ error: "утвердить можно только draft plan" });
    const nodes = db.prepare("SELECT slot_key, role_key, required FROM task_collaboration_plan_nodes WHERE plan_id = ? ORDER BY slot_key").all(plan.id) as Array<{ slot_key: string; role_key: string; required: number }>;
    const incoming = new Set((db.prepare("SELECT to_slot_key FROM task_collaboration_plan_edges WHERE plan_id = ?").all(plan.id) as Array<{ to_slot_key: string }>).map((edge) => edge.to_slot_key));
    // Корневые (без входящих рёбер) slots собираем отдельно — их нужно не
    // только вставить как ready, но и сразу стартовать, а db.transaction()
    // принимает только синхронный колбэк (better-sqlite3), поэтому реальный
    // async-старт роли идёт после коммита, не внутри него.
    const rootSlots: Array<{ id: string; slotKey: string }> = [];
    try {
      db.transaction(() => {
      const existing = db.prepare("SELECT COUNT(*) AS count FROM task_role_slots WHERE collaboration_plan_id = ?").get(plan.id) as { count: number };
      if (existing.count !== 0) throw new Error("slots этой revision уже materialized");
      const insertSlot = db.prepare(`INSERT INTO task_role_slots (id, task_id, slot_key, role_key, participant_id, state, required, created_by, collaboration_plan_id, plan_node_key)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const node of nodes) {
        const runtimeKey = `p${plan.revision}_${node.slot_key}`;
        const slotId = `trs_${crypto.randomUUID()}`;
        const isRoot = !incoming.has(node.slot_key);
        insertSlot.run(slotId, task.id, runtimeKey, node.role_key, roleUserId(node.role_key), isRoot ? "ready" : "waiting", node.required, req.userId, plan.id, node.slot_key);
        if (isRoot) rootSlots.push({ id: slotId, slotKey: runtimeKey });
      }
      db.prepare("UPDATE task_collaboration_plans SET status = 'superseded' WHERE task_id = ? AND status = 'approved'").run(task.id);
      db.prepare("UPDATE task_collaboration_plans SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(req.userId, plan.id);
      })();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
    logEvent({ taskId: task.id, actorId: req.userId, kind: "collaboration_plan_approved", field: `revision:${plan.revision}`, toValue: plan.profile });
    // Утверждение плана — тот самый момент, когда роль должна сама впрячься
    // в работу, а не ждать ручного POST .../role-slots/:slotId/run. Неудача
    // одного корневого узла не должна ронять утверждение плана целиком или
    // блокировать соседние независимые ветки — try/catch на каждый, тот же
    // fallback, что и в unlockReadySlots: slot остаётся ready, /run работает.
    for (const rootSlot of rootSlots) {
      try {
        const started = await startSlotRun(rootSlot.id, req.userId);
        if (!started.ok) {
          logEvent({ taskId: task.id, actorId: req.userId, kind: "role_slot_autostart_failed", field: rootSlot.slotKey, toValue: started.error });
        }
      } catch (error) {
        logEvent({ taskId: task.id, actorId: req.userId, kind: "role_slot_autostart_failed", field: rootSlot.slotKey, toValue: error instanceof Error ? error.message : String(error) });
      }
    }
    return { plan: present(planForTask(task.id, plan.id)!) };
  });
}
