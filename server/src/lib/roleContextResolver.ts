/**
 * Каталог слоёв контекста запуска ролей и единый resolver
 * (`compose(role, mode)`). Карточка `15c2db1f-521f-4fae-8e47-6ac18458c966`,
 * дизайн — заметка `54ff50a1-37ed-45ac-badd-9cbfab02a5d5` (проект TaskFlow -
 * NewTodoist, 30.09.2026), §5.
 *
 * Назначение: дать один источник правды для всех точек, где собирается
 * prompt модели (inProcessRun, chats, secretaryReply, consultation, и т.д.)
 * и для экрана «Команда», показывающего, что уйдёт в модель.
 *
 * Контракт:
 *   compose(role, mode) → ComposedLayer[]
 *   composeLayer(role, layer) → ComposedLayer | null
 *
 * Приоритет effective-текста:
 *   1. role_context_overrides с is_active=1 (правка владельца, версия монотонная)
 *   2. command_default (`scope='command'`, role_key='*') — общая инструкция
 *   3. original — то, что лежит в исходном файле/БД/коде.
 *
 * Что этот модуль НЕ делает:
 *   • Не правит in-process runtime — это отдельный шаг 4 карточки,
 *     требует отдельного ревью фактического входа модели.
 *   • Не показывает UI — это шаг 5 (iOS) и web-зеркало.
 *   • Не правит существующие чтения `rolePromptText()` /
 *     `AGENT_RULES` / `LOCAL_EXECUTION_POLICY` напрямую — потребители
 *     переключатся на resolver в шаге 4.
 *
 * Версионирование: `version` — монотонный номер активной записи в
 * `role_context_overrides`; для original = 0 (нет правки), для override =
 * `version` этой записи; для command_default = `version` записи в scope='command'.
 *   globalVersion на роль — MAX(version) по (scope='role' и 'command') для этой роли.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import db from "../db.js";
import { rolePromptText } from "../roleRouting.js";
import { loadRoleRouting } from "../roleRouting.js";
import { AGENT_RULES } from "../agentState.js";
// LOCAL_EXECUTION_POLICY живёт в inProcessRun.ts, импорт через прямой
// путь — оба модуля тянутся один раз и циркулярки нет
// (inProcessRun.ts не импортирует roleContextResolver).
// ВАЖНО: при импорте inProcessRun.ts стартует рядом top-level модулей
// (например, defineTool), которые в тестах без живого приложения не нужны.
// Тесты для этого модуля обходят inProcessRun через прямой source-kind
// в обёртке readOriginal — здесь импорт ровно ради константы.
import { LOCAL_EXECUTION_POLICY } from "../runtime/inProcessRun.js";

/** Какие режимы запуска поддерживает compose() — дизайн §3. */
export type RunMode = "work" | "resume" | "reply" | "review" | "subtask" | "chat" | "voice";

/** Каталог слоёв (дизайн §5): key, режимы, источник оригинала, read_only. */
export type LayerSpec = {
  key: string;
  scope: "role" | "command";
  modes: ReadonlyArray<RunMode>;
  sourceKind: "db" | "file" | "code" | "yaml";
  /** Оригинальный путь/идентификатор — для UI «откуда это». */
  originRef: string;
  /** Можно ли править владельцем через /api/runtime/context. */
  readOnly: boolean;
};

/** Что возвращает resolver на каждый слой. */
export type ComposedLayer = {
  layer: string;
  /** Текст, который реально уйдёт в prompt модели в данном режиме. */
  effective: string;
  /** Откуда взяли effective. */
  source: "override" | "command_default" | "original";
  /** Где физически живёт original (даже если effective=command_default). */
  origin: { kind: "db" | "file" | "code" | "yaml"; ref: string };
  /** Монотонная версия (0 для original без правок). */
  version: number;
  /** Когда был последний override (null для original). */
  updatedAt: string | null;
  /** Кто последний правил (null для original). */
  updatedBy: string | null;
  readOnly: boolean;
  /** В каких режимах слой вообще показывается. */
  modes: ReadonlyArray<RunMode>;
};

/** Каталог слоёв по дизайну §5. Не редактируется из REST — это структурный реестр. */
export const LAYER_CATALOG: ReadonlyArray<LayerSpec> = [
  {
    key: "role.prompt",
    scope: "role",
    modes: ["work", "resume", "reply", "review", "subtask", "chat", "voice"],
    sourceKind: "db",
    originRef: "roles.prompt ∨ server/scripts/role-prompts/<role>.md",
    readOnly: false,
  },
  {
    key: "rules",
    scope: "command",
    modes: ["work", "resume", "reply", "review", "subtask", "chat", "voice"],
    sourceKind: "code",
    originRef: "server/src/agentState.ts:AGENT_RULES",
    readOnly: false,
  },
  {
    key: "local_policy",
    scope: "command",
    modes: ["work", "resume", "reply", "review", "subtask", "chat", "voice"],
    sourceKind: "code",
    originRef: "server/src/runtime/inProcessRun.ts:LOCAL_EXECUTION_POLICY",
    readOnly: false,
  },
  {
    key: "role_skills",
    scope: "role",
    modes: ["work", "resume", "reply", "review", "subtask", "chat", "voice"],
    sourceKind: "db",
    originRef: "role_skills",
    readOnly: true,
  },
  {
    key: "mcp_tools",
    scope: "role",
    modes: ["work", "resume", "reply", "review", "subtask", "chat", "voice"],
    sourceKind: "file",
    originRef: "~/.pi/agent/taskflow-profiles/<role>.json",
    readOnly: true,
  },
  {
    key: "model_policy",
    scope: "role",
    modes: ["work", "resume", "reply", "review", "subtask", "chat", "voice"],
    sourceKind: "yaml",
    originRef: "server/scripts/role-routing.yaml",
    readOnly: true,
  },
  {
    key: "plan.role_node",
    scope: "role",
    modes: ["subtask"],
    sourceKind: "db",
    originRef: "task_collaboration_plan_nodes",
    readOnly: true,
  },
  {
    key: "chat.submission",
    scope: "role",
    modes: ["chat"],
    sourceKind: "db",
    originRef: "chat_messages",
    readOnly: true,
  },
  {
    key: "chat.voice_intake",
    scope: "role",
    modes: ["voice"],
    sourceKind: "db",
    originRef: "chat_messages (voice)",
    readOnly: true,
  },
  {
    key: "intake.summary",
    scope: "role",
    modes: ["work"],
    sourceKind: "code",
    originRef: "server/scripts/task_context.py:enrich_*",
    readOnly: false,
  },
  {
    key: "subtask.run_prompt",
    scope: "role",
    modes: ["subtask"],
    sourceKind: "file",
    originRef: "server/skills/<role>/run_prompt.md",
    readOnly: true,
  },
];

const LAYER_KEYS: ReadonlySet<string> = new Set(LAYER_CATALOG.map((l) => l.key));

export function getLayerSpec(layerKey: string): LayerSpec | null {
  return LAYER_CATALOG.find((l) => l.key === layerKey) ?? null;
}

export function listLayerKeysForMode(mode: RunMode): string[] {
  return LAYER_CATALOG.filter((l) => l.modes.includes(mode)).map((l) => l.key);
}

/** Снимок одной строки override из БД — row без мутаций. */
type OverrideRow = {
  scope: "role" | "command";
  role_key: string;
  layer: string;
  version: number;
  text: string;
  source_kind: string;
  source_ref: string;
  created_by: string;
  created_at: string;
};

/** Прочитать активный override для (scope, role_key, layer). */
function readActiveOverride(
  scope: "role" | "command",
  roleKey: string,
  layer: string,
): OverrideRow | null {
  const row = db
    .prepare(
      `SELECT scope, role_key, layer, version, text, source_kind, source_ref, created_by, created_at
         FROM role_context_overrides
        WHERE is_active = 1 AND scope = ? AND role_key = ? AND layer = ?
        LIMIT 1`,
    )
    .get(scope, roleKey, layer) as OverrideRow | undefined;
  return row ?? null;
}

/** Оригинальный текст слоя — то, что лежит в исходном файле/БД/коде,
 *  если НЕТ активного override. Выбрасывает Error при неизвестном layer,
 *  чтобы ошибка в каталоге не прошла как пустой слой. */
function readOriginal(layer: LayerSpec, role: string): string {
  switch (layer.key) {
    case "role.prompt": {
      const text = rolePromptText(role);
      if (text === null) {
        // Роль без промпта — пусть UI увидит «нет текста», а не сломался
        // весь список. effective будет пустой строкой с пометкой original.
        return "";
      }
      return text;
    }
    case "rules": {
      // AGENT_RULES — массив строк; для слоя контекста склеиваем в один
      // текст с буллет-точкой, как это делал сам AGENT_RULES.map раньше
      // (см. inProcessRun.ts:438, 461 в дизайне).
      return AGENT_RULES.map((line) => `- ${line}`).join("\n");
    }
    case "local_policy": {
      // LOCAL_EXECUTION_POLICY — уже склеенный через .join("\n") текст.
      return LOCAL_EXECUTION_POLICY;
    }
    case "role_skills": {
      // Список навыков — read_only, для UI. Текстом: «name: description»
      // по строке на навык.
      const rows = db
        .prepare(
          "SELECT skill_name, description FROM role_skills WHERE role = ? ORDER BY skill_name",
        )
        .all(role) as Array<{ skill_name: string; description: string | null }>;
      if (!rows.length) return "(нет навыков)";
      return rows
        .map((r) => (r.description ? `${r.skill_name}: ${r.description}` : r.skill_name))
        .join("\n");
    }
    case "mcp_tools": {
      // Allowlist из MCP-профиля Pi. Возвращаем как есть — файл читается
      // уже в roles.ts (readRoleTools), мы переоткрываем его тем же путём.
      const profilesDir = process.env.TASKFLOW_ROLE_PROFILES_DIR
        ? path.resolve(process.env.TASKFLOW_ROLE_PROFILES_DIR)
        : path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");
      const file = path.join(profilesDir, `${role}.json`);
      if (!fs.existsSync(file)) return "(профиль не задан)";
      try {
        const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
          mcpServers?: { taskflow?: { env?: { TASKFLOW_MCP_TOOLS?: string } } };
        };
        const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
        return tools ? tools.split(",").map((t) => t.trim()).filter(Boolean).join("\n") : "(allowlist пуст)";
      } catch (err) {
        return `(ошибка чтения профиля: ${(err as Error).message})`;
      }
    }
    case "model_policy": {
      // models/fallbacks из role-routing.yaml. Для UI — компактно.
      const routing = loadRoleRouting();
      const model = routing.models[role] ?? "(не задана)";
      const shell = routing.defaults[role] ?? "(не задана)";
      const fallbacks = (routing.fallbacks[role] ?? []).join(", ") || "(нет)";
      return `model: ${model}\nshell: ${shell}\nfallbacks: ${fallbacks}`;
    }
    case "plan.role_node": {
      // Этот слой — «что генерирует шаблон плана T03/T05 для узла этой
      // роли». Без активной задачи — пусто. Когда активный узел плана
      // есть, дизайн §5 говорит «генерируется шаблоном», сейчас —
      // заглушка: пусть UI увидит «нет активного узла плана». В шаге 4
      // резолвер подключается к активному узлу и берёт ожидаемый текст.
      const row = db
        .prepare(
          `SELECT 1
             FROM task_collaboration_plan_nodes n
             JOIN task_collaboration_plans p ON p.id = n.plan_id
            WHERE p.status = 'approved' AND n.role_key = ?
            LIMIT 1`,
        )
        .get(role);
      return row ? "(есть активный узел плана)" : "(нет активного узла плана)";
    }
    case "chat.submission": {
      // Данные, не настройка. read_only. Для UI — пусть покажет заглушку,
      // фактический снимок диалога берётся из chat_messages, не из этого
      // слоя (см. дизайн §3 «чат с ролью»).
      return "(это данные диалога; смотри в ленте чата)";
    }
    case "chat.voice_intake": {
      return "(это голосовая расшифровка; смотри в заметках голосового моста)";
    }
    case "intake.summary": {
      // В шаге 4 это строка human-summary из task_context.py. Пока —
      // заглушка с явной пометкой «ещё не подключено», чтобы UI
      // показывал слой как существующий, но не врал текстом.
      return "(intake.summary ещё не подключён к resolver — отдельный шаг)";
    }
    case "subtask.run_prompt": {
      const dir = path.join(process.cwd(), "server", "skills", role, "run_prompt.md");
      try {
        return fs.readFileSync(dir, "utf8");
      } catch {
        return "(навык run_prompt не задан)";
      }
    }
    default:
      // Неизвестный слой — структурная ошибка каталога. Бросаем, иначе
      // пустой слой скрыл бы проблему от UI и от ревью.
      throw new Error(`roleContextResolver: неизвестный слой ${layer.key}`);
  }
}

/** Собрать effective-текст одного слоя для роли в режиме. */
export function composeLayer(role: string, layerKey: string): ComposedLayer | null {
  const spec = getLayerSpec(layerKey);
  if (!spec) return null;
  const original = readOriginal(spec, role);
  const origin = { kind: spec.sourceKind, ref: spec.originRef } as const;

  // 1. роль-локальный override
  const roleOverride = readActiveOverride("role", role, layerKey);
  if (roleOverride) {
    return {
      layer: layerKey,
      effective: roleOverride.text,
      source: "override",
      origin,
      version: roleOverride.version,
      updatedAt: roleOverride.created_at,
      updatedBy: roleOverride.created_by,
      readOnly: spec.readOnly,
      modes: spec.modes,
    };
  }

  // 2. общая (scope='command', role_key='*') — для слоёв с scope=command
  //    только она и применяется; для scope=role — fallback, если оригинал
  //    пустой (например, роли без промпта).
  if (spec.scope === "command") {
    const cmdOverride = readActiveOverride("command", "*", layerKey);
    if (cmdOverride) {
      return {
        layer: layerKey,
        effective: cmdOverride.text,
        source: "command_default",
        origin,
        version: cmdOverride.version,
        updatedAt: cmdOverride.created_at,
        updatedBy: cmdOverride.created_by,
        readOnly: spec.readOnly,
        modes: spec.modes,
      };
    }
  }

  // 3. оригинал
  return {
    layer: layerKey,
    effective: original,
    source: "original",
    origin,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    readOnly: spec.readOnly,
    modes: spec.modes,
  };
}

/** Собрать ВСЕ слои, применимые к режиму запуска. */
export function compose(role: string, mode: RunMode): ComposedLayer[] {
  return listLayerKeysForMode(mode)
    .map((key) => composeLayer(role, key))
    .filter((l): l is ComposedLayer => l !== null);
}

/** Глобальная монотонная версия для роли — MAX(version) по её слоям
 *  (включая command_default). Используется в `If-Match` для предотвращения
 *  параллельных правок. Если ни одного override нет — 0. */
export function globalVersionForRole(role: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v
         FROM role_context_overrides
        WHERE is_active = 1
          AND ((scope = 'role' AND role_key = ?)
               OR (scope = 'command' AND role_key = '*'))`,
    )
    .get(role) as { v: number };
  return row.v;
}

/** Прочитать оригинальный текст слоя — МИНУЯ любые активные override.
 *  Используется для reset: «вернуть effective к тому, что лежит в
 *  исходном файле/БД/коде». На неизвестном layer возвращает null,
 *  чтобы вызывающий мог ответить 404. */
export function readOriginalOnly(role: string, layer: string): string | null {
  const spec = getLayerSpec(layer);
  if (!spec) return null;
  return readOriginal(spec, role);
}
export function readHistoryEntry(
  scope: "role" | "command",
  roleKey: string,
  layer: string,
  version: number,
): {
  text: string;
  sourceKind: string;
  sourceRef: string;
} | null {
  // Ищем в обеих таблицах: сначала активные (если версия совпала),
  // потом история. Это нужно, чтобы restore работал и для текущей
  // активной версии (для restore после reset в исходное состояние).
  const active = db
    .prepare(
      `SELECT text, source_kind, source_ref
         FROM role_context_overrides
        WHERE scope = ? AND role_key = ? AND layer = ? AND version = ?
        LIMIT 1`,
    )
    .get(scope, roleKey, layer, version) as
    | { text: string; source_kind: string; source_ref: string }
    | undefined;
  if (active) {
    return { text: active.text, sourceKind: active.source_kind, sourceRef: active.source_ref };
  }
  const hist = db
    .prepare(
      `SELECT text, source_kind, source_ref
         FROM role_context_overrides_history
        WHERE scope = ? AND role_key = ? AND layer = ? AND version = ?
        LIMIT 1`,
    )
    .get(scope, roleKey, layer, version) as
    | { text: string; source_kind: string; source_ref: string }
    | undefined;
  if (!hist) return null;
  return { text: hist.text, sourceKind: hist.source_kind, sourceRef: hist.source_ref };
}

/** Список версий истории слоя — для UI «история». newest first. */
export function listHistory(
  scope: "role" | "command",
  roleKey: string,
  layer: string,
  limit = 50,
): Array<{
  version: number;
  action: "set" | "reset" | "restore";
  at: string;
  byUserId: string;
  reason: string | null;
}> {
  return db
    .prepare(
      `SELECT version, action, at, by_user_id AS byUserId, reason
         FROM role_context_overrides_history
        WHERE scope = ? AND role_key = ? AND layer = ?
        ORDER BY at DESC, version DESC
        LIMIT ?`,
    )
    .all(scope, roleKey, layer, limit) as Array<{
    version: number;
    action: "set" | "reset" | "restore";
    at: string;
    byUserId: string;
    reason: string | null;
  }>;
}

/** Применить новую правку (set/reset/restore) — атомарно.
 *  Возвращает активную запись после применения. Бросает Error на
 *  невалидный layer или несуществующую историю. */
export function applyOverride(args: {
  scope: "role" | "command";
  roleKey: string;
  layer: string;
  text: string;
  sourceKind: string;
  sourceRef: string;
  createdBy: string;
  action: "set" | "reset" | "restore";
  reason?: string | null;
}): ComposedLayer {
  if (!LAYER_KEYS.has(args.layer)) {
    throw new Error(`неизвестный слой: ${args.layer}`);
  }
  const spec = getLayerSpec(args.layer);
  if (!spec) throw new Error(`неизвестный слой: ${args.layer}`);
  if (spec.readOnly && args.action !== "reset") {
    throw new Error(`слой ${args.layer} только для просмотра`);
  }
  const next = db.transaction(() => {
    const currentVersion = db
      .prepare(
        `SELECT version FROM role_context_overrides
          WHERE scope = ? AND role_key = ? AND layer = ? AND is_active = 1
          LIMIT 1`,
      )
      .get(args.scope, args.roleKey, args.layer) as { version: number } | undefined;
    const prevVersion = currentVersion?.version ?? null;
    const version = prevVersion === null ? 1 : prevVersion + 1;

    if (currentVersion) {
      db.prepare(
        `UPDATE role_context_overrides
            SET is_active = 0
          WHERE scope = ? AND role_key = ? AND layer = ? AND version = ?`,
      ).run(args.scope, args.roleKey, args.layer, currentVersion.version);
    }

    db.prepare(
      `INSERT INTO role_context_overrides
         (scope, role_key, layer, version, text, source_kind, source_ref, created_by, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      args.scope,
      args.roleKey,
      args.layer,
      version,
      args.text,
      args.sourceKind,
      args.sourceRef,
      args.createdBy,
    );

    db.prepare(
      `INSERT INTO role_context_overrides_history
         (id, scope, role_key, layer, version, prev_version, text, source_kind, source_ref, action, by_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      args.scope,
      args.roleKey,
      args.layer,
      version,
      prevVersion,
      args.text,
      args.sourceKind,
      args.sourceRef,
      args.action,
      args.createdBy,
      args.reason ?? null,
    );

    return version;
  })();

  // Возвращаем уже посчитанный effective для UI — важно не делать ещё одну
  // транзакцию чтения.
  const origin = { kind: spec.sourceKind, ref: spec.originRef } as const;
  return {
    layer: args.layer,
    effective: args.text,
    source: args.scope === "command" ? "command_default" : "override",
    origin,
    version: next,
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    updatedBy: args.createdBy,
    readOnly: spec.readOnly,
    modes: spec.modes,
  };
}