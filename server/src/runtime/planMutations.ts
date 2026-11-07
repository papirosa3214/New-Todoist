import {isRoutineServiceComment} from "../lib/serviceNoise.js";
import { wakeAndDeliver } from "./orchestratorWake.js";
import { normalizePlanStartCondition } from "./planArtifactGate.js";
import { withAssertionInstruction, parseFulfills } from "../lib/missionContract.js";
// Живой план совместной работы (владелец 01.10.2026: «граф живой, может
// достраиваться сам в процессе, а состав я настраиваю хотя бы до старта»;
// предложение — docs/2026-09-30-live-collaboration-plan-spec.md).
//
// План правится операциями — и черновик, и уже утверждённый. Правки идут на
// месте: узлы остаются подзадачами того же плана, прошлое не переписывается.
// Инварианты:
//   • сданный и идущий шаг не меняется и не удаляется; менять, пропускать и
//     удалять можно только неначатый;
//   • входящую связь можно добавить только неначатому шагу, кроме request_help:
//     автор явно приостанавливает себя до результата нового помощника;
//   • граф остаётся ациклическим, до MAX_PLAN_NODES узлов;
//   • каждая применённая правка поднимает plan.version и ложится в журнал
//     task_collaboration_plan_ops.
//
// Кто что может:
//   • владелец/оркестратор — любые операции;
//   • роль — только из своего идущего шага: добавить шаг (add_step) и, для
//     QA/критика, отправить на доработку (rework). В пределах лимита
//     применяется сразу, выше — ложится предложением владельцу.
import crypto from "node:crypto";
import db from "../db.js";
import { technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { logEvent } from "../agentState.js";
import { ROLE_NAMES, roleTitle, roleUserId } from "../roleRouting.js";
import { broadcastToUsers } from "../ws.js";
import { bumpContextVersion } from "./taskContextVersion.js";
import { FINAL_REVIEW_MARKER } from "./planReviewLifecycle.js";

/** Жёсткий потолок узлов (тот же, что у parseGraph). */
export const MAX_PLAN_NODES = 16;
/** До скольких узлов план может дорасти по инициативе ролей. */
export const ROLE_GROWTH_MAX_NODES = 12;
/** Сколько шагов одна роль может добавить сама. */
export const ROLE_ADDED_STEPS_MAX = 3;
/** Сколько кругов «доработка → проверка» идут без владельца. */
export const MAX_REWORK_ROUNDS = 2;

const SLOT_KEY = /^[a-z][a-z0-9_]{1,63}$/;
const CHECKER_ROLES = new Set(["qa", "critic_verifier"]);

export type PlanOp =
  | { op: "request_help"; from_slot: string; role_key: string; expected_result: string; instructions?: string; after?: string[] }
  | { op: "add_step"; slot_key?: string; role_key: string; expected_result: string; instructions?: string; after?: string[]; before?: string[]; fulfills?: string[] }
  | { op: "update_step"; slot_key: string; role_key?: string; expected_result?: string; instructions?: string; after?: string[]; fulfills?: string[] }
  | { op: "remove_step"; slot_key: string }
  | { op: "skip_step"; slot_key: string; reason: string }
  | { op: "rework"; from_slot: string; role_key?: string; defects: string };

export type PlanActor =
  | { kind: "owner"; id: string }
  | { kind: "role"; id: string; roleKey: string; slotKey: string };

export class PlanOpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const PLAN_OP_NAMES = new Set([
  "request_help",
  "add_step",
  "update_step",
  "remove_step",
  "skip_step",
  "rework",
]);

/**
 * Форма операций до применения. Раньше тело запроса приводилось к PlanOp
 * приведением типа (`req.body?.ops as PlanOp[]`), которого во время работы
 * нет вовсе: 22.10.2026 POST …/collaboration-plans/:planId/ops падал 500
 * «op.after is not iterable», потому что клиент прислал after строкой или
 * объектом, а `for (const a of op.after)` ждёт список. После `setErrorHandler`
 * такой сбой стал бы просто непонятной 500-й; здесь он превращается в 400 с
 * указанием, какая операция и какое поле не той формы.
 *
 * Проверяется ТОЛЬКО форма (тип поля), а не смысл: пустой expected_result,
 * неизвестную роль и несуществующий шаг по-прежнему разбирают applyOne и
 * requireRole — их формулировки и коды ответов остаются как были.
 */
export function normalizePlanOps(input: unknown): PlanOp[] {
  if (!Array.isArray(input) || input.length === 0) throw new PlanOpError("нет операций");
  return input.map((raw, index) => {
    const where = `операция №${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PlanOpError(`${where}: ожидается объект`);
    }
    const op = raw as Record<string, unknown>;
    const name = op.op;
    if (typeof name !== "string" || !PLAN_OP_NAMES.has(name)) {
      throw new PlanOpError(
        `${where}: неизвестное действие «${typeof name === "string" ? name : String(name)}»; допустимы: ${[...PLAN_OP_NAMES].join(", ")}`,
      );
    }
    const text = (field: string, required = false): string | undefined => {
      const value = op[field];
      if (value === undefined || value === null) {
        if (required) throw new PlanOpError(`${where}: не хватает поля «${field}»`);
        return undefined;
      }
      if (typeof value !== "string") throw new PlanOpError(`${where}: поле «${field}» должно быть строкой`);
      return value;
    };
    const slots = (field: "after" | "before"): string[] | undefined => {
      const value = op[field];
      if (value === undefined || value === null) return undefined;
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new PlanOpError(`${where}: поле «${field}» должно быть списком ключей шагов`);
      }
      return value as string[];
    };
    // fulfills — список id ассерций контракта, которые закрывает шаг
    // (владелец 01.11.2026). Проверяется при утверждении плана: ровно одна
    // работа на ассерцию.
    const ids = (field: string): string[] | undefined => {
      const value = op[field];
      if (value === undefined || value === null) return undefined;
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
        throw new PlanOpError(`${where}: поле «${field}» должно быть списком id ассерций`);
      }
      return (value as string[]).map((v) => v.trim());
    };
    switch (name) {
      case "request_help":
        return {
          op: name,
          from_slot: text("from_slot", true),
          role_key: text("role_key", true),
          expected_result: text("expected_result", true),
          instructions: text("instructions"),
          after: slots("after"),
        } as PlanOp;
      case "add_step":
        return {
          op: name,
          slot_key: text("slot_key"),
          role_key: text("role_key", true),
          expected_result: text("expected_result", true),
          instructions: text("instructions"),
          after: slots("after"),
          before: slots("before"),
          fulfills: ids("fulfills"),
        } as PlanOp;
      case "update_step":
        return {
          op: name,
          slot_key: text("slot_key", true),
          role_key: text("role_key"),
          expected_result: text("expected_result"),
          instructions: text("instructions"),
          after: slots("after"),
          fulfills: ids("fulfills"),
        } as PlanOp;
      case "remove_step":
        return { op: name, slot_key: text("slot_key", true) } as PlanOp;
      case "skip_step":
        return { op: name, slot_key: text("slot_key", true), reason: text("reason", true) } as PlanOp;
      default:
        return {
          op: name,
          from_slot: text("from_slot", true),
          role_key: text("role_key"),
          defects: text("defects", true),
        } as PlanOp;
    }
  });
}

type NodeRow = {
  slot_key: string;
  role_key: string;
  required: number;
  expected_result: string;
  output_artifact_json: string | null;
  source_subtask_id: string | null;
  instructions: string | null;
  fulfills_json: string | null;
  origin: string;
  added_by: string | null;
  added_reason: string | null;
  iteration: number;
  rework_of_key: string | null;
  skipped_at: string | null;
  skip_reason: string | null;
};
type EdgeRow = { from_slot_key: string; to_slot_key: string; start_condition: string; artifact_key: string | null };
type PlanRow = { id: string; task_id: string; status: string; version: number };
type StepRow = { id: string; plan_node_key: string; done: number; agent_state: string | null };

type Working = {
  nodes: Map<string, NodeRow>;
  edges: EdgeRow[];
  added: Set<string>;
  waiting: Map<string,string>;
  changed: Set<string>;
  removed: Set<string>;
  skipped: Set<string>;
};

export type ApplyResult =
  | { status: "applied"; version: number; opId: string; added: string[] }
  | { status: "proposed"; opId: string; reason: string };

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function loadPlan(planId: string): PlanRow {
  const plan = db.prepare("SELECT id, task_id, status, version FROM task_collaboration_plans WHERE id = ?").get(planId) as PlanRow | undefined;
  if (!plan) throw new PlanOpError("план не найден", 404);
  if (plan.status === "superseded") throw new PlanOpError("это старая версия плана — править можно текущую", 409);
  return plan;
}

/** План сдан целиком и с тех пор не переоткрыт: последнее из двух событий — сдача.
 *  Переоткрытие (владелец 13.10.2026) — новый шаг в уже сданном плане: карточка
 *  возвращается в работу, после шага план сдаётся заново. */
export function planDelivered(taskId: string, planId: string): boolean {
  const last = db.prepare(
    `SELECT kind FROM task_events WHERE task_id = ? AND field = ?
       AND kind IN ('collaboration_plan_completed','collaboration_plan_reopened') ORDER BY rowid DESC LIMIT 1`,
  ).get(taskId, planId) as { kind: string } | undefined;
  return last?.kind === "collaboration_plan_completed";
}

function loadSteps(planId: string): Map<string, StepRow> {
  const rows = db.prepare("SELECT id, plan_node_key, done, agent_state FROM subtasks WHERE collaboration_plan_id = ?").all(planId) as StepRow[];
  return new Map(rows.map((r) => [r.plan_node_key, r]));
}

/** Шаг ещё не начат: у черновика — всегда, у запущенного — нет ни галочки, ни состояния. */
function isPending(plan: PlanRow, steps: Map<string, StepRow>, node: NodeRow): boolean {
  if (node.skipped_at) return false;
  if (plan.status !== "approved") return true;
  const step = steps.get(node.slot_key);
  return !step || (!step.done && !step.agent_state);
}

function artifactKeyOf(node: NodeRow | undefined): string | null {
  if (!node?.output_artifact_json) return null;
  try { return (JSON.parse(node.output_artifact_json) as { key?: string }).key ?? null; } catch { return null; }
}

function edgeFrom(from: NodeRow, to: string): EdgeRow {
  const artifact = artifactKeyOf(from);
  return artifact
    ? { from_slot_key: from.slot_key, to_slot_key: to, start_condition: "artifact_ready", artifact_key: artifact }
    : { from_slot_key: from.slot_key, to_slot_key: to, start_condition: "submitted", artifact_key: null };
}

function freshSlot(nodes: Map<string, NodeRow>, role: string): string {
  const base = role.replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "step";
  for (let i = 2; ; i += 1) {
    const key = `${base}_${i}`;
    if (!nodes.has(key)) return key;
  }
}

function requireRole(role: string | undefined): string {
  const key = String(role ?? "").trim();
  if (!ROLE_NAMES.includes(key)) throw new PlanOpError(`неизвестная роль «${key}»`);
  return key;
}

function newNode(fields: Partial<NodeRow> & { slot_key: string; role_key: string; expected_result: string }): NodeRow {
  return {
    required: 1,
    output_artifact_json: null,
    source_subtask_id: null,
    instructions: null,
    fulfills_json: null,
    origin: "owner",
    added_by: null,
    added_reason: null,
    iteration: 0,
    rework_of_key: null,
    skipped_at: null,
    skip_reason: null,
    ...fields,
  };
}

function applyOne(op: PlanOp, w: Working, plan: PlanRow, steps: Map<string, StepRow>, actor: PlanActor, reason: string | null): void {
  const pending = (slot: string) => {
    const node = w.nodes.get(slot);
    if (!node) throw new PlanOpError(`нет шага «${slot}»`);
    if (!w.added.has(slot) && !isPending(plan, steps, node)) {
      throw new PlanOpError(`шаг «${slot}» уже начат, сдан или пропущен — его не меняют, это история`, 409);
    }
    return node;
  };
  const existing = (slot: string) => {
    const node = w.nodes.get(slot);
    if (!node) throw new PlanOpError(`нет шага «${slot}»`);
    return node;
  };

  switch (op.op) {
    case "request_help": {
      const author=existing(op.from_slot);
      const step=steps.get(op.from_slot);
      if(plan.status!=="approved" || author.skipped_at || !step || step.done || !["in_progress","blocked"].includes(step.agent_state ?? "")) {
        throw new PlanOpError("помощь можно запросить только для незавершённого начатого шага",409);
      }
      const after=op.after ?? w.edges.filter(e=>e.to_slot_key===op.from_slot).map(e=>e.from_slot_key);
      const helper=freshSlot(w.nodes,requireRole(op.role_key));
      applyOne({op:"add_step",slot_key:helper,role_key:op.role_key,expected_result:op.expected_result,instructions:op.instructions,after},w,plan,steps,actor,reason);
      // Автор явно приостанавливает себя: исключение к запрету менять входы начатых шагов.
      w.edges.push({from_slot_key:helper,to_slot_key:op.from_slot,start_condition:"submitted",artifact_key:null});
      w.waiting.set(op.from_slot,reason || op.expected_result);
      return;
    }
    case "add_step": {
      const role = requireRole(op.role_key);
      const expected = clip(String(op.expected_result ?? ""), 1000);
      if (!expected) throw new PlanOpError("expected_result обязателен: что должна сдать роль");
      const slot = op.slot_key ? String(op.slot_key).trim() : freshSlot(w.nodes, role);
      if (!SLOT_KEY.test(slot)) throw new PlanOpError("некорректный slot_key");
      if (w.nodes.has(slot)) throw new PlanOpError(`шаг «${slot}» уже есть`);
      const node = newNode({
        slot_key: slot,
        role_key: role,
        expected_result: expected,
        instructions: withAssertionInstruction(op.instructions ? clip(op.instructions, 4000) : null, op.fulfills ?? []),
        fulfills_json: op.fulfills?.length ? JSON.stringify(op.fulfills) : null,
        origin: actor.kind === "role" ? "role" : "owner",
        added_by: actor.id,
        added_reason: reason,
      });
      const after = op.after ?? (actor.kind === "role" ? [actor.slotKey] : []);
      for (const a of after) w.edges.push(edgeFrom(existing(a), slot));
      for (const b of op.before ?? []) {
        pending(b);
        w.edges.push({ from_slot_key: slot, to_slot_key: b, start_condition: "submitted", artifact_key: null });
      }
      w.nodes.set(slot, node);
      w.added.add(slot);
      return;
    }
    case "update_step": {
      const node = pending(op.slot_key);
      if (op.role_key !== undefined) node.role_key = requireRole(op.role_key);
      if (op.expected_result !== undefined) {
        const expected = clip(String(op.expected_result), 1000);
        if (!expected) throw new PlanOpError("expected_result не может быть пустым");
        node.expected_result = expected;
      }
      if (op.instructions !== undefined) node.instructions = op.instructions ? clip(op.instructions, 4000) : null;
      if (op.fulfills !== undefined) node.fulfills_json = op.fulfills.length ? JSON.stringify(op.fulfills) : null;
      // Инструкция по ассерциям следует за fulfills: контракт изменился —
      // роль должна знать, что именно от неё ждут сейчас (01.11.2026).
      if (op.instructions !== undefined || op.fulfills !== undefined) {
        const effective = op.fulfills ?? parseFulfills(node.fulfills_json);
        const base = op.instructions !== undefined ? node.instructions : node.instructions;
        node.instructions = withAssertionInstruction(base, effective);
      }
      if (op.after !== undefined) {
        w.edges = w.edges.filter((e) => e.to_slot_key !== node.slot_key);
        for (const a of op.after) w.edges.push(edgeFrom(existing(a), node.slot_key));
      }
      w.changed.add(node.slot_key);
      return;
    }
    case "remove_step": {
      const node = pending(op.slot_key);
      const preds = w.edges.filter((e) => e.to_slot_key === node.slot_key).map((e) => e.from_slot_key);
      const succs = w.edges.filter((e) => e.from_slot_key === node.slot_key).map((e) => e.to_slot_key);
      w.edges = w.edges.filter((e) => e.from_slot_key !== node.slot_key && e.to_slot_key !== node.slot_key);
      // Порядок не теряется: предшественники удалённого становятся
      // предшественниками его последователей.
      for (const p of preds) {
        for (const s of succs) {
          if (!w.edges.some((e) => e.from_slot_key === p && e.to_slot_key === s)) w.edges.push(edgeFrom(w.nodes.get(p)!, s));
        }
      }
      w.nodes.delete(node.slot_key);
      w.added.delete(node.slot_key);
      w.removed.add(node.slot_key);
      return;
    }
    case "skip_step": {
      const node = pending(op.slot_key);
      const why = clip(String(op.reason ?? ""), 500);
      if (!why) throw new PlanOpError("пропуск — с причиной: без неё не понять, почему шаг не делали");
      node.skipped_at = new Date().toISOString();
      node.skip_reason = why;
      w.skipped.add(node.slot_key);
      return;
    }
    case "rework": {
      const from = existing(op.from_slot);
      if (!CHECKER_ROLES.has(from.role_key)) throw new PlanOpError("на доработку отправляет проверяющий шаг (QA или критик)");
      if (from.iteration >= MAX_REWORK_ROUNDS) {
        throw new PlanOpError(`круги доработки исчерпаны (${MAX_REWORK_ROUNDS}) — решение за владельцем`, 409);
      }
      const defects = clip(String(op.defects ?? ""), 800);
      if (!defects) throw new PlanOpError("defects обязателен: что именно доработать");
      const target = requireRole(op.role_key ?? "builder");
      const iteration = from.iteration + 1;
      const fix = newNode({
        slot_key: freshSlot(w.nodes, `${target}_fix`),
        role_key: target,
        expected_result: clip(`Доработка по замечаниям (${roleTitle(from.role_key)}): ${defects}`, 1000),
        instructions: defects,
        origin: "rework",
        added_by: actor.id,
        added_reason: reason,
        iteration,
        rework_of_key: from.slot_key,
      });
      w.nodes.set(fix.slot_key, fix);
      w.added.add(fix.slot_key);
      const recheck = newNode({
        slot_key: freshSlot(w.nodes, `${from.role_key}_recheck`),
        role_key: from.role_key,
        expected_result: clip(`Повторная проверка после доработки: ${from.expected_result}`, 1000),
        origin: "rework",
        added_by: actor.id,
        added_reason: reason,
        iteration,
        rework_of_key: from.slot_key,
      });
      w.nodes.set(recheck.slot_key, recheck);
      w.added.add(recheck.slot_key);
      // Те, кто ждал проверку, теперь ждут повторную.
      const waiting = w.edges.filter((e) => e.from_slot_key === from.slot_key).map((e) => e.to_slot_key);
      w.edges = w.edges.filter((e) => e.from_slot_key !== from.slot_key);
      w.edges.push(edgeFrom(from, fix.slot_key));
      w.edges.push(edgeFrom(fix, recheck.slot_key));
      for (const s of waiting) w.edges.push(edgeFrom(recheck, s));
      return;
    }
    default:
      throw new PlanOpError("неизвестная операция");
  }
}

function validate(w: Working): void {
  if (w.nodes.size === 0) throw new PlanOpError("в плане должен остаться хотя бы один шаг");
  if (w.nodes.size > MAX_PLAN_NODES) throw new PlanOpError(`в плане не больше ${MAX_PLAN_NODES} шагов`);
  const seen = new Set<string>();
  for (const e of w.edges) {
    if (!w.nodes.has(e.from_slot_key) || !w.nodes.has(e.to_slot_key) || e.from_slot_key === e.to_slot_key) {
      throw new PlanOpError("связь должна соединять два разных существующих шага");
    }
    const key = `${e.from_slot_key}:${e.to_slot_key}`;
    if (seen.has(key)) throw new PlanOpError("связь между этими шагами уже есть");
    seen.add(key);
  }
  const next = new Map<string, string[]>();
  for (const key of w.nodes.keys()) next.set(key, []);
  for (const e of w.edges) next.get(e.from_slot_key)!.push(e.to_slot_key);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (done.has(key)) return false;
    visiting.add(key);
    if (next.get(key)!.some(cyclic)) return true;
    visiting.delete(key);
    done.add(key);
    return false;
  };
  if ([...w.nodes.keys()].some(cyclic)) throw new PlanOpError("правка замыкает план в цикл — шаг не может ждать сам себя");
}

/** Роль сверх лимита — не отказ, а вопрос владельцу. null — в пределах. */
function overRoleBudget(w: Working, actor: PlanActor): string | null {
  if (actor.kind !== "role") return null;
  if (w.nodes.size > ROLE_GROWTH_MAX_NODES) return `план дорос бы до ${w.nodes.size} шагов (сами роли — до ${ROLE_GROWTH_MAX_NODES})`;
  const mine = [...w.nodes.values()].filter((n) => n.origin === "role" && n.added_by === actor.id).length;
  if (mine > ROLE_ADDED_STEPS_MAX) return `${roleTitle(actor.roleKey)} добавила бы ${mine}-й шаг (сама — до ${ROLE_ADDED_STEPS_MAX})`;
  return null;
}

function roleCheck(ops: PlanOp[], actor: PlanActor): void {
  if (actor.kind !== "role") return;
  for (const op of ops) {
    if (op.op === "add_step" || (op.op === "request_help" && op.from_slot === actor.slotKey)) continue;
    if (op.op === "rework" && op.from_slot === actor.slotKey && CHECKER_ROLES.has(actor.roleKey)) continue;
    throw new PlanOpError(
      op.op === "rework"
        ? "на доработку отправляет только QA или критик — из своего шага"
        : "роль может только добавить шаг или отправить на доработку; остальное меняет владелец",
      403,
    );
  }
}

function persist(plan: PlanRow, w: Working): void {
  db.prepare("DELETE FROM task_collaboration_plan_edges WHERE plan_id = ?").run(plan.id);
  db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(plan.id);
  const insertNode = db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json, source_subtask_id,
        instructions, origin, added_by, added_reason, iteration, rework_of_key, skipped_at, skip_reason, fulfills_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of w.nodes.values()) {
    insertNode.run(
      "tcpn_" + crypto.randomUUID(), plan.id, n.slot_key, n.role_key, n.required, n.expected_result, n.output_artifact_json,
      n.source_subtask_id, n.instructions, n.origin, n.added_by, n.added_reason, n.iteration, n.rework_of_key, n.skipped_at, n.skip_reason,
      n.fulfills_json ?? null,
    );
  }
  const insertEdge = db.prepare(
    "INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition, artifact_key) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const e of w.edges) insertEdge.run("tcpe_" + crypto.randomUUID(), plan.id, e.from_slot_key, e.to_slot_key, normalizePlanStartCondition(e.start_condition), e.artifact_key);

  if (plan.status !== "approved") return;
  // Запущенный план: узлы — подзадачи, правим их вместе с графом.
  const maxPos = (db.prepare("SELECT COALESCE(MAX(position), 0) AS m FROM subtasks WHERE task_id = ?").get(plan.task_id) as { m: number }).m;
  let pos = maxPos;
  const insertStep = db.prepare(
    "INSERT INTO subtasks (id, task_id, title, position, agent_id, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const slot of w.added) {
    const n = w.nodes.get(slot)!;
    insertStep.run(crypto.randomUUID(), plan.task_id, n.expected_result, ++pos, roleUserId(n.role_key), plan.id, slot);
  }
  for (const [slot,reason] of w.waiting) {
    const step=db.prepare("SELECT id,current_attempt_id,agent_id FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key=?")
      .get(plan.id,slot) as {id:string;current_attempt_id:string|null;agent_id:string|null};
    technicalSlotSnapshot(step.id,"blocked",{blocker:reason,attemptId:step.current_attempt_id});
    if(step.current_attempt_id) db.prepare("UPDATE attempts SET ended_at=datetime('now'),outcome='blocked',reason=? WHERE id=? AND ended_at IS NULL").run(reason,step.current_attempt_id);
    db.prepare("UPDATE subtasks SET agent_state='blocked',block_type='dependency',blocked_at=datetime('now'),current_attempt_id=NULL WHERE id=?").run(step.id);
    logEvent({taskId:plan.task_id,actorId:step.agent_id,kind:"plan_help_requested",field:slot,toValue:reason});
  }
  for (const slot of w.changed) {
    const n = w.nodes.get(slot);
    if (!n || w.added.has(slot)) continue;
    db.prepare("UPDATE subtasks SET title = ?, agent_id = ? WHERE collaboration_plan_id = ? AND plan_node_key = ?")
      .run(n.expected_result, roleUserId(n.role_key), plan.id, slot);
  }
  for (const slot of w.skipped) {
    const n = w.nodes.get(slot)!;
    db.prepare("UPDATE subtasks SET done = 1, result = ? WHERE collaboration_plan_id = ? AND plan_node_key = ?")
      .run(`Пропущено: ${n.skip_reason}`, plan.id, slot);
  }
  for (const slot of w.removed) {
    db.prepare("DELETE FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ? AND done = 0 AND agent_state IS NULL")
      .run(plan.id, slot);
  }
}

/** Несданная итоговая проверка сданного плана: новые шаги встают перед ней, она ждёт их. */
function pendingFinalReview(w: Working, steps: Map<string, StepRow>): string | null {
  const review = [...w.nodes.values()].find((n) => !w.added.has(n.slot_key) && !n.skipped_at
    && (n.instructions ?? "").startsWith(FINAL_REVIEW_MARKER) && steps.get(n.slot_key)?.done === 0);
  if (!review) return null;
  for (const slot of w.added) {
    if (!w.edges.some((e) => e.from_slot_key === slot)) w.edges.push({ from_slot_key: slot, to_slot_key: review.slot_key, start_condition: "submitted", artifact_key: null });
  }
  validate(w);
  return review.slot_key;
}

/** Новый шаг в сданном плане: карточка возвращается в работу (и из «на проверке», и из закрытых),
 *  после сдачи шага finishPlanIfComplete сдаёт план заново — с новой версией результата.
 *  Если итоговая проверка ещё не сдана, план остаётся сданным: проверка сама ждёт новый шаг,
 *  а вторая сдача приставила бы второго проверяющего. */
function reopenDeliveredPlan(plan: PlanRow, actor: PlanActor, w: Working, openReview: string | null): void {
  const task = db.prepare("SELECT status, agent_state FROM tasks WHERE id = ?").get(plan.task_id) as { status: string; agent_state: string | null };
  db.prepare("UPDATE tasks SET status = 'active', completed_at = NULL, agent_state = NULL, current_attempt_id = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(plan.task_id);
  if (openReview) {
    // Проверка, ещё не начатая проверяющим, снимается с очереди и откроется снова после нового шага.
    db.prepare("UPDATE subtasks SET agent_state = NULL WHERE collaboration_plan_id = ? AND plan_node_key = ? AND done = 0 AND agent_state = 'todo'")
      .run(plan.id, openReview);
    db.prepare(`UPDATE role_run_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL, finished_at=datetime('now'),
      updated_at=datetime('now'), last_error='план переоткрыт' WHERE task_id = ? AND reason = 'review' AND status IN ('queued','retry_wait')`).run(plan.task_id);
  }
  bumpContextVersion(plan.task_id);
  if (!openReview) logEvent({ taskId: plan.task_id, actorId: actor.id, kind: "collaboration_plan_reopened", field: plan.id, toValue: [...w.added].join(",") });
  if (task.status !== "active") logEvent({ taskId: plan.task_id, actorId: actor.id, kind: "state_changed", field: "status", fromValue: task.status, toValue: "active" });
  if (task.agent_state) logEvent({ taskId: plan.task_id, actorId: actor.id, kind: "state_changed", field: "agent_state", fromValue: task.agent_state, toValue: null });
}

function describe(ops: PlanOp[], w: Working): string {
  return ops
    .map((op) => {
      switch (op.op) {
        case "request_help": return "помощь для "+op.from_slot+": "+roleTitle(op.role_key)+" — "+clip(op.expected_result,120);
        case "add_step": return `+ ${roleTitle(op.role_key)}: ${clip(op.expected_result, 120)}`;
        case "update_step": return `✎ ${op.slot_key}`;
        case "remove_step": return `− ${op.slot_key}`;
        case "skip_step": return `⤼ ${op.slot_key}: ${clip(op.reason, 120)}`;
        case "rework": {
          const fix = [...w.added].map((s) => w.nodes.get(s)!).find((n) => n.origin === "rework" && n.rework_of_key === op.from_slot);
          return `↺ доработка${fix ? ` (${roleTitle(fix.role_key)})` : ""}: ${clip(op.defects, 120)}`;
        }
      }
    })
    .join("; ");
}

function logOp(planId: string, actor: PlanActor, baseVersion: number | null, applied: number | null, ops: PlanOp[], status: "proposed" | "applied", reason: string | null): string {
  const id = "tcpo_" + crypto.randomUUID();
  db.prepare(
    `INSERT INTO task_collaboration_plan_ops (id, plan_id, base_version, applied_version, actor_id, actor_kind, ops_json, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, planId, baseVersion, applied, actor.id, actor.kind, JSON.stringify(ops), status, reason);
  return id;
}

function ownerId(): string | null {
  return (db.prepare("SELECT id FROM users WHERE role = 'owner' AND COALESCE(archived, 0) = 0 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
}

function notifyOwner(taskId: string, actorId: string, text: string): void {
  const owner = ownerId();
  if (!owner) return;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'agent_state', ?, ?, ?)")
    .run(id, owner, taskId, text, actorId);
  broadcastToUsers([owner], { type: "notification:new", notificationId: id, taskId });
}

/**
 * Видимое уведомление владельцу о предложении плана, ждущем решения.
 * Тип plan_approval_request не входит в IN-список триггера
 * notifications_owner_no_activity, поэтому проходит до пользователя
 * (миграции 068/069). Владелец 09.10.2026: видимое, устойчивое, с
 * идентификаторами task/plan/op и явными approve/reject.
 * opId/planId передаются в тексте — отдельных колонок в notifications пока
 * нет, фронт парсит префикс [op:tcpo_… plan:tcp_…] при показе.
 */
function notifyPlanApprovalRequest(taskId: string, planId: string, opId: string, actorId: string, summary: string, reason: string): void {
  const owner = ownerId();
  if (!owner) return;
  const text = `[op:${opId} plan:${planId} task:${taskId}] Роль предлагает изменить план: ${summary}. Причина: ${reason}. Решите: approve/reject в карточке задачи.`;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'plan_approval_request', ?, ?, ?)")
    .run(id, owner, taskId, text, actorId);
  broadcastToUsers([owner], { type: "notification:new", notificationId: id, taskId });
}

function roleNote(taskId: string, roleKey: string, text: string): void {
  if (isRoutineServiceComment({user_id:"role_system", text})) return;
  db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), taskId, roleUserId(roleKey), text);
}

/**
 * Применить операции к плану. baseVersion — версия, которую видел автор
 * правки: не совпала — 409, черновик у клиента не теряется. Роль сверх
 * лимита получает status: "proposed" — правка ждёт владельца.
 * `bypassBudget` — владелец одобрил предложение роли.
 */
export function applyPlanOps(
  planId: string,
  ops: PlanOp[],
  actor: PlanActor,
  opts: { baseVersion?: number | null; reason?: string | null; bypassBudget?: boolean } = {},
): ApplyResult {
  ops = normalizePlanOps(ops);
  if (ops.length > 20) throw new PlanOpError("слишком много операций за раз");
  roleCheck(ops, actor);
  const reason = opts.reason ? clip(opts.reason, 500) : null;

  return db.transaction((): ApplyResult => {
    const plan = loadPlan(planId);
    if (opts.baseVersion != null && opts.baseVersion !== plan.version) {
      throw new PlanOpError(`план уже изменён (версия ${plan.version}, у вас ${opts.baseVersion}) — обновите и повторите`, 409);
    }
    // Сданный план не заперт: новый шаг переоткрывает его (см. reopenDeliveredPlan).
    const delivered = plan.status === "approved" && planDelivered(plan.task_id, plan.id);
    const nodes = db.prepare(
      `SELECT slot_key, role_key, required, expected_result, output_artifact_json, source_subtask_id, instructions, origin,
              added_by, added_reason, iteration, rework_of_key, skipped_at, skip_reason, fulfills_json
         FROM task_collaboration_plan_nodes WHERE plan_id = ?`,
    ).all(plan.id) as NodeRow[];
    const edges = db.prepare("SELECT from_slot_key, to_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ?")
      .all(plan.id) as EdgeRow[];
    const steps = loadSteps(plan.id);
    if (actor.kind === "role") {
      const own = steps.get(actor.slotKey);
      // В сданном плане идущих шагов нет — роль достраивает его из своего сданного шага.
      if (plan.status !== "approved" || !own || (!delivered && (own.done || own.agent_state !== "in_progress"))) {
        throw new PlanOpError("менять план роль может только из своего идущего шага", 403);
      }
    }
    const w: Working = {
      nodes: new Map(nodes.map((n) => [n.slot_key, { ...n }])),
      edges: edges.map((e) => ({ ...e })),
      added: new Set(),
      waiting: new Map(),
      changed: new Set(),
      removed: new Set(),
      skipped: new Set(),
    };
    const normalize=(text:string|null|undefined)=>(text??"").normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase();
    const duplicates:string[]=[];
    for(const op of ops){
      if(op.op==="add_step"){
        const after=[...new Set(op.after??(actor.kind==="role"?[actor.slotKey]:[]))].sort();
        const before=[...new Set(op.before??[])].sort();
        const same=[...w.nodes.values()].find(n=>!n.skipped_at&&!n.rework_of_key&&normalize(n.expected_result)===normalize(op.expected_result)&&normalize(n.instructions)===normalize(op.instructions)&&
          JSON.stringify(w.edges.filter(e=>e.to_slot_key===n.slot_key).map(e=>e.from_slot_key).sort())===JSON.stringify(after)&&
          JSON.stringify(w.edges.filter(e=>e.from_slot_key===n.slot_key).map(e=>e.to_slot_key).sort())===JSON.stringify(before));
        if(same){duplicates.push(same.slot_key);continue;}
      }
      applyOne(op,w,plan,steps,actor,reason);
    }
    if(duplicates.length===ops.length)return {status:"applied",version:plan.version,opId:"existing",added:duplicates};
    validate(w);

    const over = opts.bypassBudget ? null : overRoleBudget(w, actor);
    if (over) {
      const opId = logOp(plan.id, actor, plan.version, null, ops, "proposed", reason);
      logEvent({ taskId: plan.task_id, actorId: actor.id, kind: "collaboration_plan_change_proposed", field: opId, toValue: clip(describe(ops, w), 500) });
      // Режим «Оркестратор»: согласует Оркестратор, а не владелец.
      const orchestrated = (db.prepare("SELECT profile FROM task_collaboration_plans WHERE id = ?").get(plan.id) as { profile: string }).profile === "orchestrated";
      const askerStep = actor.kind === "role" ? steps.get(actor.slotKey) : undefined;
      if (orchestrated && askerStep) {
        const detail = `op_id=${opId}, plan_id=${plan.id}, task_id=${plan.task_id}. Предлагает: ${clip(describe(ops, w), 300)}. Причина: ${over}${reason ? `; ${reason}` : ""}`;
        setImmediate(() => wakeAndDeliver(askerStep.id, actor.id, "approval", detail));
      } else notifyPlanApprovalRequest(plan.task_id, plan.id, opId, actor.id, clip(describe(ops, w), 200), over);
      return { status: "proposed", opId, reason: over };
    }

    const reopen = delivered && w.added.size > 0;
    const openReview = reopen ? pendingFinalReview(w, steps) : null;
    persist(plan, w);
    if (reopen) reopenDeliveredPlan(plan, actor, w, openReview);
    const version = plan.version + 1;
    db.prepare("UPDATE task_collaboration_plans SET version = ? WHERE id = ?").run(version, plan.id);
    const opId = logOp(plan.id, actor, plan.version, version, ops, "applied", reason);
    const summary = describe(ops, w);
    logEvent({ taskId: plan.task_id, actorId: actor.id, kind: "collaboration_plan_changed", field: `version:${version}`, toValue: clip(summary, 500) });
    if (actor.kind === "role") {
      roleNote(plan.task_id, actor.roleKey, `Изменил план совместной работы: ${summary}${reason ? `. Причина: ${reason}` : ""}`);
      notifyOwner(plan.task_id, actor.id, `${roleTitle(actor.roleKey)} изменил план: ${clip(summary, 200)}`);
    }
    // Режим «Оркестратор»: возврат проверяющим будит Оркестратора после
    // коммита — без блока роли могут по кругу сжечь попытки.
    for (const op of ops) if (op.op === "rework") {
      const from = steps.get(op.from_slot);
      if (from) setImmediate(() => wakeAndDeliver(from.id, actor.id, "returned", clip(String(op.defects ?? ""), 600)));
    }
    return { status: "applied", version, opId, added: [...w.added] };
  })();
}

/** Владелец решает по предложению роли: одобрить (применить без лимита) или отклонить. */
export function decidePlanProposal(opId: string, ownerIdValue: string, approve: boolean): ApplyResult | { status: "rejected" } {
  const row = db.prepare("SELECT id, plan_id, actor_id, actor_kind, ops_json, status, reason FROM task_collaboration_plan_ops WHERE id = ?")
    .get(opId) as { id: string; plan_id: string; actor_id: string; actor_kind: string; ops_json: string; status: string; reason: string | null } | undefined;
  if (!row) throw new PlanOpError("предложение не найдено", 404);
  if (row.status !== "proposed") throw new PlanOpError("по этому предложению уже решено", 409);
  const mark = (status: string) =>
    db.prepare("UPDATE task_collaboration_plan_ops SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
      .run(status, ownerIdValue, opId);
  if (!approve) {
    mark("rejected");
    const plan = db.prepare("SELECT task_id FROM task_collaboration_plans WHERE id = ?").get(row.plan_id) as { task_id: string } | undefined;
    if (plan) logEvent({ taskId: plan.task_id, actorId: ownerIdValue, kind: "collaboration_plan_change_rejected", field: opId, toValue: null });
    return { status: "rejected" };
  }
  // Применяем от имени владельца: роль могла уже сдать свой шаг, а решение
  // теперь его. Происхождение шагов остаётся «добавлено ролью».
  const ops = JSON.parse(row.ops_json) as PlanOp[];
  const result = applyPlanOps(row.plan_id, ops, { kind: "owner", id: ownerIdValue }, { reason: row.reason, bypassBudget: true });
  if (result.status === "applied") {
    db.prepare("UPDATE task_collaboration_plan_nodes SET origin = 'role', added_by = ? WHERE plan_id = ? AND slot_key IN (" +
      result.added.map(() => "?").join(",") + ")").run(row.actor_id, row.plan_id, ...result.added);
    mark("applied");
    // Владелец одобрил request_help сверх лимита — apply выше уже перевёл
    // автора в agent_state='blocked' (w.waiting → plan_help_requested),
    // это и есть ожидание помощника. Возобновлять автора здесь НЕЛЬЗЯ:
    // именно блокировка держит шаг до сдачи помощника, а снимает её
    // liftDependencyBlocks, когда предшественник закрыт. Снять блок сразу
    // после одобрения — значит потерять ожидание и пустить автора
    // параллельно с помощником (карточка 38772db1, тест «помощь сверх
    // лимита»).
  }
  return result;
}

/** Предложения ролей, ждущие владельца, — для карточки. */
export function pendingPlanProposals(planId: string) {
  const rows = db.prepare(
    `SELECT o.id, o.actor_id, u.name AS actor_name, u.role_key AS actor_role, o.ops_json, o.reason, o.created_at
       FROM task_collaboration_plan_ops o LEFT JOIN users u ON u.id = o.actor_id
      WHERE o.plan_id = ? AND o.status = 'proposed' ORDER BY o.created_at`,
  ).all(planId) as Array<{ id: string; actor_id: string; actor_name: string | null; actor_role: string | null; ops_json: string; reason: string | null; created_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    actor_id: r.actor_id,
    actor_name: r.actor_role ? roleTitle(r.actor_role) : r.actor_name,
    ops: JSON.parse(r.ops_json) as PlanOp[],
    reason: r.reason,
    created_at: r.created_at,
  }));
}

/** Журнал правок плана — «История плана». */
export function planHistory(planId: string) {
  const rows = db.prepare(
    `SELECT o.id, o.actor_id, o.actor_kind, u.name AS actor_name, u.role_key AS actor_role, o.ops_json, o.status, o.reason,
            o.base_version, o.applied_version, o.created_at
       FROM task_collaboration_plan_ops o LEFT JOIN users u ON u.id = o.actor_id
      WHERE o.plan_id = ? ORDER BY o.created_at DESC, o.rowid DESC LIMIT 100`,
  ).all(planId) as Array<Record<string, unknown> & { ops_json: string; actor_role: string | null; actor_name: string | null }>;
  return rows.map(({ ops_json, actor_role, actor_name, ...r }) => ({
    ...r,
    actor_name: actor_role ? roleTitle(actor_role) : actor_name,
    ops: JSON.parse(ops_json) as PlanOp[],
  }));
}
