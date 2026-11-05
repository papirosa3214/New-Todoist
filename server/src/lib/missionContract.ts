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

/** Результат проверки одной ассерции — то, что роль кладёт в payload артефакта. */
export type AssertionResult = {
  id: string;
  status: "passed" | "failed" | "blocked";
  evidence?: unknown;
  observed?: unknown;
};

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

const HINT_BEGIN = "<<<MISSION_ASSERTIONS>>>";
const HINT_END = "<<<END_MISSION_ASSERTIONS>>>";

/**
 * Инструкция шагу, который закрывает ассерции. Без неё роль не знает, что
 * от неё ждут: контракт записан, а формат результата — нет.
 *
 * Блок помечен маркерами, чтобы его можно было заменить, а не дописать
 * второй раз: инструкции переживают правку графа.
 */
export function assertionInstruction(fulfills: string[]): string {
  if (!fulfills.length) return "";
  return [
    HINT_BEGIN,
    "Проверка по контракту ассерций. Ты закрываешь ассерции: " + fulfills.join(", ") + ".",
    "В payload артефакта обязательно приложи массив assertions — по каждой ассерции ровно одну запись:",
    '{"id":"<id ассерции>","status":"passed|failed|blocked","evidence":["путь/ссылка на доказательство"],"observed":"что увидел"}',
    "status: passed — поведение подтверждено; failed — не подтверждено (работа идёт на доработку); blocked — проверить вживую нельзя, вопрос владельцу.",
    "Без результата проверки сдача не пройдёт: «готово» без доказательства не засчитывается.",
    HINT_END,
  ].join("\n");
}

/** Ставит (или заменяет) блок инструкции по ассерциям в инструкции шага. */
export function withAssertionInstruction(text: string | null | undefined, fulfills: string[]): string | null {
  const stripped = (text ?? "").replace(new RegExp(`${HINT_BEGIN}[\\s\\S]*?${HINT_END}\\n?`, "g"), "").trimEnd();
  if (!fulfills.length) return stripped || null;
  return (stripped ? stripped + "\n" : "") + assertionInstruction(fulfills);
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

/**
 * Проверка покрытия в момент утверждения плана (02.11.2026).
 *
 * В режиме «Оркестратор» план утверждается СКЕЛЕТОМ: два слота оркестратора,
 * а работы по ролям оркестратор добавляет в план уже после утверждения. Если
 * контракт ассерций написан до утверждения, строгая проверка нашла бы «ассерция
 * не заявлена ни одной работой» на пустом плане и заблокировала бы старт.
 *
 * Поэтому на утверждении проверяем только то, что уже можно проверить:
 * ассерция не заявлена ДВУМЯ работами и работа не ссылается на несуществующую
 * ассерцию. Дыру «не заявлена ни одной работой» ловим там, где декомпозиция
 * закончена — на закрытии слота оркестратора.
 */
export function validateAssertionCoverageForApproval(planId: string): void {
  const coverage = assertionCoverage(planId);
  const blocking = coverage.violations.filter((v) => v.kind !== "uncovered");
  if (!blocking.length) return;
  const detail = blocking.map((v) => v.message).join("; ");
  throw new Error(`Контракт ассерций не согласован с планом (${blocking.length}): ${detail}`);
}

/**
 * Дыры покрытия в момент, когда декомпозиция закончена: каждая ассерция
 * контракта должна быть заявлена ровно одной работой.
 */
export function validateAssertionCoverageComplete(planId: string): void {
  validateAssertionCoverage(planId);
}

/** Бросает с перечислением дыр — вызывающий превращает это в отказ approve. */
export function validateAssertionCoverage(planId: string): void {
  const coverage = assertionCoverage(planId);
  if (coverage.ok) return;
  const detail = coverage.violations.map((v) => v.message).join("; ");
  throw new Error(`Контракт ассерций не покрыт планом (${coverage.violations.length}): ${detail}`);
}

/* ── Результат проверки: что роль сдаёт в payload артефакта ─────────────── */

/**
 * Разбирает результаты проверки из payload артефакта. Строгий: шаг, который
 * заявляет ассерции, обязан приложить результат по каждой — иначе «готово»
 * оказывается голословным (3e27dafe: «секретарь не может выдать виджет»).
 */
export function parseAssertionResults(raw: unknown, expectedIds: string[]): AssertionResult[] {
  if (raw === undefined || raw === null) {
    throw new Error(`шаг закрывает ассерции (${expectedIds.join(", ")}), но в payload нет массива assertions с результатами проверки`);
  }
  if (!Array.isArray(raw)) throw new Error("payload.assertions должен быть списком результатов проверки");
  const known = new Set(expectedIds);
  const seen = new Set<string>();
  const out: AssertionResult[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? "").trim();
    if (!id) throw new Error("payload.assertions: у результата нет id ассерции");
    if (!known.has(id)) throw new Error(`payload.assertions: ассерция «${id}» не заявлена этим шагом`);
    if (seen.has(id)) throw new Error(`payload.assertions: ассерция «${id}» повторяется`);
    seen.add(id);
    const status = String(o.status ?? "").trim();
    if (status !== "passed" && status !== "failed" && status !== "blocked") {
      throw new Error(`payload.assertions: у ассерции «${id}» неверный status «${status}» (passed | failed | blocked)`);
    }
    out.push({ id, status, evidence: o.evidence ?? null, observed: o.observed ?? null });
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length) {
    throw new Error(`payload.assertions: нет результата по ассерциям ${missing.join(", ")} — «готово» без проверки не засчитывается`);
  }
  return out;
}

/** Записывает результаты проверки в контракт и пишет событие в журнал миссии. */
export function recordAssertionResults(
  taskId: string,
  slotKey: string,
  results: AssertionResult[],
  actorId: string | null,
): { failed: string[]; blocked: string[]; passed: string[] } {
  const failed: string[] = [];
  const blocked: string[] = [];
  const passed: string[] = [];
  const update = db.prepare(
    "UPDATE mission_assertions SET status = ?, claimed_by_slot = ?, updated_at = datetime('now') WHERE task_id = ? AND assertion_id = ?",
  );
  for (const r of results) {
    update.run(r.status, slotKey, taskId, r.id);
    if (r.status === "failed") failed.push(r.id);
    else if (r.status === "blocked") blocked.push(r.id);
    else passed.push(r.id);
  }
  appendMissionEvent(taskId, {
    kind: "assertion_results",
    actor_id: actorId,
    slot_key: slotKey,
    payload: { passed, failed, blocked },
  });
  return { failed, blocked, passed };
}

/* ── Журнал миссии ────────────────────────────────────────────────────────── */

export type MissionEventKind =
  | "contract_replaced"
  | "assertion_results"
  | "assertion_failed"
  | "assertion_blocked"
  | "gate_rework"
  | "mission_closed"
  | "mission_skill_registered"
  | "mission_skill_released"
  | "mission_skill_release_failed";

export function appendMissionEvent(
  taskId: string,
  event: { kind: MissionEventKind; actor_id?: string | null; slot_key?: string | null; payload?: unknown },
): void {
  db.prepare(
    "INSERT INTO mission_events (id, task_id, ts, kind, actor_id, slot_key, payload_json) VALUES (?, ?, datetime('now'), ?, ?, ?, ?)",
  ).run(
    crypto.randomUUID(),
    taskId,
    event.kind,
    event.actor_id ?? null,
    event.slot_key ?? null,
    event.payload === undefined ? null : JSON.stringify(event.payload),
  );
}

export function missionEvents(taskId: string, limit = 200): Array<{
  id: string; task_id: string; ts: string; kind: string; actor_id: string | null; slot_key: string | null; payload_json: string | null;
}> {
  return db
    .prepare("SELECT * FROM mission_events WHERE task_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?")
    .all(taskId, Math.min(Math.max(limit, 1), 1000)) as Array<{
    id: string; task_id: string; ts: string; kind: string; actor_id: string | null; slot_key: string | null; payload_json: string | null;
  }>;
}

/**
 * Гейт закрытия миссии: пока в контракте есть ассерция не в `passed`, задача
 * не закрывается. Карточка без контракта живёт по-старому.
 */
export function missionBlocksCompletion(taskId: string): { blocked: boolean; outstanding: string[] } {
  const outcome = missionOutcome(taskId);
  return { blocked: outcome.has_contract && !outcome.closed, outstanding: outcome.outstanding };
}

/**
 * Итог миссии по контракту. Миссия закрыта, когда ВСЕ ассерции `passed`.
 * `blocked` — «не проверяется вживую»: она не запускает доработку, но и не
 * даёт закрыть миссию — вопрос владельцу.
 */
export function missionOutcome(taskId: string): {
  has_contract: boolean;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  pending: number;
  closed: boolean;
  outstanding: string[];
} {
  const assertions = missionAssertions(taskId);
  const counts = { passed: 0, failed: 0, blocked: 0, pending: 0 };
  for (const a of assertions) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const outstanding = assertions.filter((a) => a.status !== "passed").map((a) => a.assertion_id);
  return {
    has_contract: assertions.length > 0,
    total: assertions.length,
    passed: counts.passed,
    failed: counts.failed,
    blocked: counts.blocked,
    pending: counts.pending,
    closed: assertions.length > 0 && outstanding.length === 0,
    outstanding,
  };
}

/**
 * Результат проверки контракта сдаётся только артефактом. Шаг с пунктами контракта без
 * своего описания артефакта получает это: иначе его было нечем сдать (05.11.2026).
 */
export function effectiveArtifactContract(
  outputArtifactJson: string | null | undefined,
  fulfillsJson: string | null | undefined,
): { key: string; type: string; format: "json"; required_fields: string[] } | null {
  if (outputArtifactJson) return JSON.parse(outputArtifactJson);
  if (!parseFulfills(fulfillsJson).length) return null;
  return { key: "assertion_results", type: "result_pack", format: "json", required_fields: ["assertions"] };
}

/**
 * Что не даёт оркестратору сдать шаг разбиения: «готово» определяется до работы,
 * поэтому контракт обязателен (владелец 05.11.2026). null — можно сдавать.
 */
export function orchestrateContractError(taskId: string, planId: string): string | null {
  if (!missionAssertions(taskId).length) {
    return "Сначала запиши контракт: taskflow_mission_contract с пунктами, которые считаются готовым результатом.";
  }
  const critic = db
    .prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id=? AND role_key='critic_verifier' AND fulfills_json IS NOT NULL AND fulfills_json NOT IN ('','[]') LIMIT 1")
    .get(planId) as { slot_key: string } | undefined;
  if (critic) return `Критик сдаёт только вердикт, пункты контракта ему не назначают (шаг ${critic.slot_key}). Перенеси их на шаг qa или исполнителя.`;
  try {
    validateAssertionCoverageComplete(planId);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}
