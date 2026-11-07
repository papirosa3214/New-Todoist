// Серверная логика версионированных правил (Этап B карточки 51763de5-…).
//
// Правила переезжают из свободных чат-сообщений и `AGENTS.md` в БД: новая
// таблица `agent_rules_manifests` хранит конкретную версию правила, а
// `rule_acknowledgements` — факт подтверждения её ролью в рамках сессии.
// Этот модуль — единственная точка записи; маршруты и инструмент роли
// ходят через него, чтобы идемпотентность publish по `(rule_id, version)`
// и supersede старой `active` версии держались в одном месте.
//
// Контракт `taskflow_rule_publish` и `taskflow_rule_acknowledge` описан в
// спецификации `45d948af-…` (Аналитик) и решении `4ec246d6-…` (Архитектор):
//   • publish — UPSERT по `(rule_id, version)`, старая `active` →
//     `superseded`, запись в `chat_messages` (kind='rule'), событие
//     `task_events kind='rule_superseded'`. Идемпотентен по паре.
//   • acknowledge — UPSERT по `(role, rule_id, version)`, запись в
//     `chat_messages` (kind='rule', rule_ref=...) при первом подтверждении
//     (повтор тот же `acknowledged_at` без дубля строки). Отвергает
//     `superseded` версии 409-ой, как и просила спека.
//
// Идемпотентность «acknowledged» в чате держим отдельной переменной
// `acknowledgedIdempotencyKey` в chat_messages.quick_replies (JSON) только
// когда в этом возникнет нужда; пока хватает уникального ключа в таблице
// `rule_acknowledgements`.
import crypto from "node:crypto";
import db from "../db.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { isOwner, isOrchestrator } from "../access.js";

export class RuleValidationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, statusCode = 400) {
    super(code);
    this.name = "RuleValidationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Маска из спеки: латиница, нижний регистр, точки/подчёркивания/дефисы;
// длина 3..64, первый символ — буква. Разрешены и 'builder', и
// 'a.b.c.d', и 'agent_foo-bar'.
const RULE_ID_RE = /^[a-z][a-z0-9_.-]{2,63}$/;

const CONTENT_MAX_BYTES = 64 * 1024;
const ROLE_SCOPE_MAX = 64;

function uid(): string {
  return crypto.randomUUID();
}

export function isRuleId(value: unknown): value is string {
  return typeof value === "string" && RULE_ID_RE.test(value);
}

/** Бросает RuleValidationError при невалидных аргументах. */
export function validatePublishArgs(args: {
  ruleId: unknown;
  version: unknown;
  content: unknown;
  roleScope: unknown;
}): { ruleId: string; version: number; content: string; roleScope: string } {
  if (!isRuleId(args.ruleId)) {
    throw new RuleValidationError("invalid_rule_id");
  }
  const version = Number(args.version);
  if (!Number.isInteger(version) || version < 1 || version > 9999) {
    throw new RuleValidationError("invalid_version");
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) {
    throw new RuleValidationError("empty_content");
  }
  if (Buffer.byteLength(content, "utf8") > CONTENT_MAX_BYTES) {
    throw new RuleValidationError("content_too_large");
  }
  const roleScope = normalizeRoleScope(args.roleScope);
  return { ruleId: args.ruleId, version, content, roleScope };
}

function normalizeRoleScope(value: unknown): string {
  if (value == null) return "*";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "*";
    if (trimmed === "*") return "*";
    // Строка с запятыми — тоже допустимая форма (из тестов и из
    // storeRoleScope, сериализованного через .join(",")). Разбираем
    // список ключей и валидируем каждый.
    const parts = trimmed.split(",").map((x) => x.trim()).filter(Boolean);
    return normalizeRoleScope(parts);
  }
  if (!Array.isArray(value)) {
    throw new RuleValidationError("role_scope_must_be_array_or_wildcard");
  }
  if (value.length === 0 || value.length > ROLE_SCOPE_MAX) {
    throw new RuleValidationError("role_scope_size");
  }
  const known = new Set(ROLE_NAMES);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new RuleValidationError("role_scope_must_be_strings");
    const key = raw.trim();
    if (!key) continue;
    if (!known.has(key)) {
      // Неизвестные ключи отвергаем явно: владелец мог ошибиться в
      // написании, и молчаливая фильтрация скроет это от него и от
      // последующего подтверждения «не той» ролью.
      throw new RuleValidationError("unknown_role_in_scope");
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length ? out.join(",") : "*";
}

export function roleScopeIncludes(roleScope: string, role: string): boolean {
  if (roleScope === "*") return true;
  return roleScope.split(",").includes(role);
}

export function roleScopeRoles(roleScope: string): string[] {
  return roleScope === "*" ? [...ROLE_NAMES] : roleScope.split(",");
}

/** Право на publish: владелец трекера или оркестратор. */
export function canPublish(userId: string): boolean {
  if (!userId) return false;
  if (isOwner(userId) || isOrchestrator(userId)) return true;
  return false;
}

type PublishExisting = {
  status: string;
  published_at: string;
  content_markdown: string;
  role_scope: string;
};

/**
 * Публикация новой версии правила. Идемпотентен по `(ruleId, version)`:
 * повтор с теми же аргументами возвращает `{ok:true, existed:true}` без
 * побочных эффектов (вторая попытка ничего не пишет в манифест/чат/журнал).
 */
export function publishRule(args: {
  ruleId: string;
  version: number;
  content: string;
  roleScope: string | string[] | null;
  publishedBy: string;
}): { ok: true; existed: boolean; ref: string; chatMessageId: string | null } {
  // Нормализуем roleScope здесь тоже, чтобы любой прямой вызов из тестов
  // и будущих скриптов получал ту же валидацию, что и HTTP-роут.
  const validated = validatePublishArgs({
    ruleId: args.ruleId,
    version: args.version,
    content: args.content,
    roleScope: args.roleScope as unknown,
  });
  const { ruleId, version, content, roleScope, publishedBy } = { ...validated, publishedBy: args.publishedBy };
  const ref = `${ruleId}@v${version}`;

  const existing = db
    .prepare(
      `SELECT status, published_at, content_markdown, role_scope
         FROM agent_rules_manifests WHERE rule_id = ? AND version = ?`,
    )
    .get(ruleId, version) as PublishExisting | undefined;

  if (existing) {
    // Повтор того же объявления — ничего не пишем ни в манифест, ни в чат.
    // Сравниваем по факту: content_markdown и role_scope совпадают с
    // прошлой записью; иначе владелец мог ошибиться версией, и лучше
    // попросить его поднять version, чем тайно править манифест.
    const sameContent = existing.content_markdown === content;
    const sameScope = existing.role_scope === roleScope;
    if (sameContent && sameScope) {
      return { ok: true, existed: true, ref, chatMessageId: null };
    }
    throw new RuleValidationError("rule_version_exists_with_different_payload");
  }

  // На свежей publish: перевести прежнюю active-версию в superseded.
  // Возьмём максимальную существующую версию по rule_id, чтобы не
  // пропустить случай, когда владелец пропустил нумерацию.
  let supersededPrev: number | null = null;
  const txn = db.transaction(() => {
    const currentActive = db
      .prepare(
        `SELECT version FROM agent_rules_manifests
          WHERE rule_id = ? AND status = 'active'
          ORDER BY version DESC LIMIT 1`,
      )
      .get(ruleId) as { version: number } | undefined;

    if (currentActive && currentActive.version !== version) {
      db.prepare(
        `UPDATE agent_rules_manifests
            SET status = 'superseded', superseded_by = ?
          WHERE rule_id = ? AND version = ? AND status = 'active'`,
      ).run(ref, ruleId, currentActive.version);
      supersededPrev = currentActive.version;
    }

    db.prepare(
      `INSERT INTO agent_rules_manifests
         (rule_id, version, content_markdown, published_by, status, role_scope)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(ruleId, version, content, publishedBy, roleScope);
  });
  txn();

  // Запись в чат и task_events — снаружи транзакции манифеста, чтобы
  // внешние эффекты (broadcast, лог) шли уже после фиксации данных. В
  // чат id отправителя проставляется через publishedBy: владелец трекера,
  // оркестратор или (в тестах) специально заведённая учётка.
  const chatId = insertRuleChat({
    fromUserId: publishedBy,
    text: `🔔 Правило ${ref} опубликовано\n\n${previewOf(content)}`,
    ruleRef: ref,
    toUserId: null, // широковещательно — адресаты идут через slot_topic_inbox
    taskId: null,
  });

  if (supersededPrev !== null) {
    db.prepare(
      `INSERT INTO task_events
         (id, task_id, actor_id, kind, field, from_value, to_value)
       VALUES (?, NULL, ?, 'rule_superseded', ?, ?, ?)`,
    ).run(
      uid(),
      publishedBy,
      ruleId,
      `${ruleId}@v${supersededPrev}`,
      ref,
    );
    // Дополнительный системный пузырь в чате: подсказка подтвердить новую
    // версию тем, кто уже подтверждал предыдущую. Без этого адресаты
    // узнают о замене только через snapshot на старте следующего шага.
    const ackNote = `⏫ Правило ${ruleId}@v${supersededPrev} заменило v${version}. Требуется подтвердить v${version}.`;
    insertRuleChat({
      fromUserId: publishedBy,
      text: ackNote,
      ruleRef: ref,
      toUserId: null,
      taskId: null,
    });
  }

  return { ok: true, existed: false, ref, chatMessageId: chatId };
}

/**
 * Подтверждение роли в конкретной версии правила. Идемпотентен по тройке
 * `(role, ruleId, version)`: повтор возвращает тот же `acknowledged_at`
 * без новой строки `rule_acknowledged`. На superseded-версии — 409, чтобы
 // подтверждение устаревшего правила не прошло как ОК.
 */
export function acknowledgeRule(args: {
  ruleId: string;
  version: number;
  role: string;
  sessionId: string | null;
  actorUserId: string;
}): { ok: true; acknowledgedAt: string; ref: string; chatMessageId: string | null } | {
  ok: false;
  error: "rule_version_superseded";
  currentVersion: number;
} {
  const { ruleId, version, role, sessionId, actorUserId } = args;
  const ref = `${ruleId}@v${version}`;

  const manifest = db
    .prepare(
      `SELECT status, content_markdown, role_scope
         FROM agent_rules_manifests WHERE rule_id = ? AND version = ?`,
    )
    .get(ruleId, version) as
    | { status: string; content_markdown: string; role_scope: string }
    | undefined;
  if (!manifest) {
    throw new RuleValidationError("rule_version_not_found", 404);
  }

  if (manifest.status !== "active") {
    const current = db
      .prepare(
        `SELECT version FROM agent_rules_manifests
          WHERE rule_id = ? AND status = 'active' LIMIT 1`,
      )
      .get(ruleId) as { version: number } | undefined;
    return {
      ok: false,
      error: "rule_version_superseded",
      currentVersion: current?.version ?? version,
    };
  }

  // Проверка role_scope: подтверждение имеет смысл только если правило
  // адресовано этой роли (или широковещательно). Это закрывает попытку
  // агента подтвердить чужое корпоративное правило.
  if (!roleScopeIncludes(manifest.role_scope, role)) {
    throw new RuleValidationError("rule_not_addressed_to_role", 403);
  }

  const existing = db
    .prepare(
      `SELECT acknowledged_at FROM rule_acknowledgements
        WHERE role = ? AND rule_id = ? AND version = ?`,
    )
    .get(role, ruleId, version) as { acknowledged_at: string } | undefined;
  if (existing) {
    return { ok: true, acknowledgedAt: existing.acknowledged_at, ref, chatMessageId: null };
  }

  let ackAt = "";
  let chatId: string | null = null;
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO rule_acknowledgements (role, rule_id, version, session_id)
       VALUES (?, ?, ?, ?)`,
    ).run(role, ruleId, version, sessionId);
    ackAt =
      (
        db
          .prepare(
            "SELECT acknowledged_at FROM rule_acknowledgements WHERE role = ? AND rule_id = ? AND version = ?",
          )
          .get(role, ruleId, version) as { acknowledged_at: string }
      ).acknowledged_at;
  });
  txn();

  chatId = insertRuleChat({
    fromUserId: actorUserId,
    text: `✅ ${roleLabel(role)} подтвердил ${ref}`,
    ruleRef: ref,
    toUserId: null,
    taskId: null,
  });

  return { ok: true, acknowledgedAt: ackAt, ref, chatMessageId: chatId };
}

/**
 * Снимок неподтверждённых активных правил для конкретной роли. Используется
 * блоком `rules.pending_acknowledgement` инструкции при старте шага.
 */
export function pendingRulesForRole(role: string): Array<{
  ruleId: string;
  version: number;
  preview: string;
  ref: string;
}> {
  if (!role) return [];
  // Подставляем роль в JSON-массив (INSTR работает не во всех SQLite,
  // а LIKE через запятую достаточно для размера до десятков ролей).
  const rows = db
    .prepare(
      `SELECT rule_id, version, content_markdown, role_scope
         FROM agent_rules_manifests
        WHERE status = 'active'`,
    )
    .all() as Array<{
    rule_id: string;
    version: number;
    content_markdown: string;
    role_scope: string;
  }>;
  const filtered = rows.filter((r) => roleScopeIncludes(r.role_scope, role));
  if (!filtered.length) return [];

  // Один SELECT с NOT EXISTS — дешевле, чем N+1, и индекс покрывает
  // фильтр по status. Соединение с подтверждениями по (role, rule_id,
  // version) тоже идёт по PRIMARY KEY.
  const placeholders = filtered.map(() => "?").join(",");
  const ackSet = db
    .prepare(
      `SELECT rule_id, version FROM rule_acknowledgements
        WHERE role = ? AND (rule_id, version) IN (${filtered
        .map(() => "(?, ?)").join(",")})`,
    )
    .all(
      role,
      ...filtered.flatMap((r) => [r.rule_id, r.version]),
    ) as Array<{ rule_id: string; version: number }>;
  const acked = new Set(ackSet.map((a) => `${a.rule_id}@v${a.version}`));

  return filtered
    .filter((r) => !acked.has(`${r.rule_id}@v${r.version}`))
    .map((r) => ({
      ruleId: r.rule_id,
      version: r.version,
      preview: previewOf(r.content_markdown),
      ref: `${r.rule_id}@v${r.version}`,
    }))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

export function rulesForOwner(): Array<{
  ruleId: string;
  version: number;
  status: string;
  publishedAt: string;
  publishedBy: string;
  roleScope: string;
}> {
  const rows = db
    .prepare(
      `SELECT rule_id, version, status, published_at, published_by, role_scope
         FROM agent_rules_manifests ORDER BY rule_id, version DESC`,
    )
    .all() as Array<{
    rule_id: string;
    version: number;
    status: string;
    published_at: string;
    published_by: string;
    role_scope: string;
  }>;
  return rows.map((r) => ({
    ruleId: r.rule_id,
    version: r.version,
    status: r.status,
    publishedAt: r.published_at,
    publishedBy: r.published_by,
    roleScope: r.role_scope,
  }));
}

function insertRuleChat(args: {
  fromUserId: string;
  text: string;
  ruleRef: string;
  toUserId: string | null;
  taskId: string | null;
}): string {
  const id = uid();
  db.prepare(
    `INSERT INTO chat_messages
       (id, from_user_id, to_user_id, task_id, kind, text, channel, rule_ref)
     VALUES (?, ?, ?, ?, 'rule', ?, 'agents', ?)`,
  ).run(id, args.fromUserId, args.toUserId, args.taskId, args.text, args.ruleRef);
  return id;
}

/** Краткое превью: первая строка или первые 120 символов — для показа агенту в блоке `pending_acknowledgement`. */
function previewOf(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + "…";
}

function roleLabel(role: string): string {
  if (role === "owner") return "Владелец";
  if (role === "orchestrator") return "Оркестратор";
  if (role === "qa") return "QA";
  if (role === "critic") return "Критик";
  return role;
}
