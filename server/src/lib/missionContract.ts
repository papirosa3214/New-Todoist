/**
 * Контракт ассерций миссии (владелец 01.11.2026).
 *
 * «Готово» должно быть определено ДО работы, а не после. Контракт — список
 * проверяемых утверждений: что именно считается выполненным, чем это
 * проверять и какие доказательства обязательны. Работа (узел плана) закрывает
 * ассерцию через поле `fulfills`.
 *
 * Инвариант: каждая ассерция заявлена РОВНО ОДНОЙ работой. Ноль — работа не
 * покрыта, две — непонятно, кто отвечает. Проверка выполняется ДО утверждения
 * плана: дыра в покрытии — отказ approve, а не тихий пропуск.
 *
 * Карточка без контракта — обычная карточка: проверка не выполняется вовсе.
 */
import crypto from "node:crypto";
import db from "../db.js";

export type MissionAssertionStatus = "pending" | "passed" | "failed" | "blocked";

export type MissionAssertion = {
  id: string;
  task_id: string;
  assertion_id: string;
  area: string | null;
  title: string;
  behavior: string;
  tool: string | null;
  evidence_json: string | null;
  status: MissionAssertionStatus;
  claimed_by_slot: string | null;
  created_at: string;
  updated_at: string;
};

export type CoverageViolation = {
  kind: "uncovered" | "duplicate" | "unknown";
  assertion_id?: string;
  slot_key?: string;
  message: string;
};

export type Coverage = { ok: boolean; violations: CoverageViolation[]; total: number };

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Идентификатор ассерции: латиница, цифры, дефис/точка/подчёркивание. */
const ASSERTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

const MAX_ASSERTIONS = 500;

export function parseFulfills(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  } catch {
    return [];
  }
}

/**
 * Разбирает `fulfills` из тела запроса. Строго: молча выкинутое значение
 * превратилось бы в дыру в покрытии, которую никто не увидел бы.
 */
export function parseFulfillsInput(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("fulfills должен быть списком id ассерций");
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !value.trim()) throw new Error("fulfills должен быть списком id ассерций");
    const id = value.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function missionAssertions(taskId: string): MissionAssertion[] {
  return db
    .prepare("SELECT * FROM mission_assertions WHERE task_id = ? ORDER BY assertion_id")
    .all(taskId) as MissionAssertion[];
}

type NormalizedAssertion = {
  assertion_id: string;
  area: string | null;
  title: string;
  behavior: string;
  tool: string | null;
  evidence: unknown;
};

/**
 * Приводит вход контракта к виду, который можно писать в БД. Бросает с
 * понятным сообщением — вызывающий превращает это в 400.
 */
export function normalizeAssertions(input: unknown): NormalizedAssertion[] {
  if (!Array.isArray(input)) throw new Error("assertions должен быть списком");
  if (input.length > MAX_ASSERTIONS) throw new Error(`не больше ${MAX_ASSERTIONS} ассерций в контракте`);
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const assertion_id = String(a.assertion_id ?? "").trim();
    if (!ASSERTION_ID.test(assertion_id)) {
      throw new Error(`ассерция №${index + 1}: некорректный assertion_id «${assertion_id}»`);
    }
    if (seen.has(assertion_id)) {
      throw new Error(`ассерция №${index + 1}: assertion_id «${assertion_id}» повторяется`);
    }
    seen.add(assertion_id);
    const title = String(a.title ?? "").trim();
    const behavior = String(a.behavior ?? "").trim();
    if (!title) throw new Error(`ассерция «${assertion_id}»: пустое название`);
    if (!behavior) throw new Error(`ассерция «${assertion_id}»: пустое поведение`);
    const tool = a.tool == null ? null : String(a.tool).trim() || null;
    return {
      assertion_id,
      area: a.area == null ? null : String(a.area).trim() || null,
      title: clip(title, 300),
      behavior: clip(behavior, 2000),
      tool,
      evidence: a.evidence ?? null,
    };
  });
}

/** Полная замена контракта карточки. Статусы сбросаются в pending. */
export function replaceMissionAssertions(taskId: string, items: unknown): MissionAssertion[] {
  const normalized = normalizeAssertions(items);
  db.transaction(() => {
    db.prepare("DELETE FROM mission_assertions WHERE task_id = ?").run(taskId);
    const insert = db.prepare(
      `INSERT INTO mission_assertions (id, task_id, assertion_id, area, title, behavior, tool, evidence_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const a of normalized) {
      insert.run(
        crypto.randomUUID(),
        taskId,
        a.assertion_id,
        a.area,
        a.title,
        a.behavior,
        a.tool,
        a.evidence == null ? null : JSON.stringify(a.evidence),
      );
    }
  })();
  return missionAssertions(taskId);
}

/** Узлы плана с их `fulfills`. Пропущенные шаги не закрывают ассерции. */
export function planFulfills(planId: string): Array<{ slot_key: string; fulfills: string[] }> {
  const rows = db
    .prepare("SELECT slot_key, fulfills_json FROM task_collaboration_plan_nodes WHERE plan_id = ? AND skipped_at IS NULL")
    .all(planId) as Array<{ slot_key: string; fulfills_json: string | null }>;
  return rows.map((row) => ({ slot_key: row.slot_key, fulfills: parseFulfills(row.fulfills_json) }));
}

/**
 * Покрытие контракта планом. Карточка без контракта → покрытие не проверяется
 * (ok=true, total=0): обычные карточки живут по-старому.
 */
export function assertionCoverage(planId: string): Coverage {
  const violations: CoverageViolation[] = [];
  const plan = db.prepare("SELECT task_id FROM task_collaboration_plans WHERE id = ?").get(planId) as
    | { task_id: string }
    | undefined;
  if (!plan) return { ok: true, violations, total: 0 };

  const assertions = missionAssertions(plan.task_id);
  if (!assertions.length) return { ok: true, violations, total: 0 };

  const known = new Set(assertions.map((a) => a.assertion_id));
  const owners = new Map<string, string[]>();
  for (const node of planFulfills(planId)) {
    for (const id of node.fulfills) {
      if (!known.has(id)) {
        violations.push({
          kind: "unknown",
          assertion_id: id,
          slot_key: node.slot_key,
          message: `шаг «${node.slot_key}» ссылается на ассерцию «${id}», которой нет в контракте`,
        });
        continue;
      }
      const list = owners.get(id) ?? [];
      list.push(node.slot_key);
      owners.set(id, list);
    }
  }

  for (const assertion of assertions) {
    const slots = owners.get(assertion.assertion_id) ?? [];
    if (slots.length === 0) {
      violations.push({
        kind: "uncovered",
        assertion_id: assertion.assertion_id,
        message: `ассерция «${assertion.assertion_id}» не заявлена ни одной работой`,
      });
    } else if (slots.length > 1) {
      violations.push({
        kind: "duplicate",
        assertion_id: assertion.assertion_id,
        message: `ассерция «${assertion.assertion_id}» заявлена в нескольких работах: ${slots.join(", ")}`,
      });
    }
  }

  return { ok: violations.length === 0, violations, total: assertions.length };
}

/** Бросает с перечислением дыр — вызывающий превращает это в отказ approve. */
export function validateAssertionCoverage(planId: string): void {
  const coverage = assertionCoverage(planId);
  if (coverage.ok) return;
  const detail = coverage.violations.map((v) => v.message).join("; ");
  throw new Error(`Контракт ассерций не покрыт планом (${coverage.violations.length}): ${detail}`);
}
