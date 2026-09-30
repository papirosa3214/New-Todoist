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
import { LOCAL_EXECUTION_POLICY, INSTRUCTION_DEFAULTS } from "../runtime/instructionDefaults.js";

/** Какие режимы запуска поддерживает compose() — дизайн §3. */
export type RunMode = "work" | "resume" | "reply" | "review" | "subtask" | "chat" | "voice" | "summary";

/** Каталог слоёв (дизайн §5): key, режимы, источник оригинала, read_only. */
export type LayerSpec = {
  key: string;
  title?: string;
  group?: string;
  placeholders?: string[];
  roles?: string[];
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
  title?: string;
  group?: string;
  defaultText?: string;
  roleVersion?: number;
  commandVersion?: number;
  placeholders?: string[];
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
export const LAYER_CATALOG: LayerSpec[] = [
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
    readOnly: true,
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

const BLOCK_META: Record<string, [string, string, RunMode[], string[]]> = {
  "task.start": ["Первый запуск", "Задача", ["work"], ["roleTitle", "taskId", "title", "rules"]],
  "task.resume": ["Продолжение", "Задача", ["resume"], ["taskId"]],
  "task.reply": ["Ответ владельцу", "Задача", ["reply"], ["roleTitle", "taskId", "title"]],
  "task.review": ["Проверка результата", "Ревью", ["review"], ["roleTitle", "taskId", "title"]],
  "task.plan": ["Узел плана", "План", ["subtask"], ["roleTitle", "taskId", "subtaskId", "subtaskTitle", "rules"]],
  "task.documentation": ["Поиск документации", "Задача", ["work", "resume", "subtask"], []],
  "chat.wrapper": ["Чат роли", "Чат", ["chat"], ["roleInstruction", "localPolicy", "roleTitle", "role", "participants", "history", "userText"]],
  "chat.followup": ["Продолжение чата роли", "Чат", ["chat"], ["roleTitle", "role", "history", "userText"]],
  "secretary.chat": ["Чат и быстрые ответы Секретаря", "Чат", ["chat"], ["roleInstruction", "history", "userText"]],
  "secretary.summary": ["Разбор сводки", "Контекст", ["summary"], ["today", "timezone", "periods", "users"]],
  "secretary.voice": ["Голос Секретаря", "Голос", ["voice"], []],
  "secretary.greeting": ["Приветствие", "Голос", ["voice"], []],
};
for (const [key, [title, group, modes, placeholders]] of Object.entries(BLOCK_META)) {
  LAYER_CATALOG.push({key, title, group, modes, placeholders, scope: "command", sourceKind: "code",
    originRef: "server/src/runtime/instructionDefaults.ts:" + key, readOnly: false,
    ...(key.startsWith("secretary.") ? {roles: ["secretary"]} : {})});
}
for (const key of ["owner.task_intake","owner.extract_tasks","ai.subtasks","ai.structure"]) LAYER_CATALOG.push({key,title:({"owner.task_intake":"Постановка задач владельца","owner.extract_tasks":"Извлечение задач","ai.subtasks":"Предложение подзадач","ai.structure":"Разбор надиктовки"} as Record<string,string>)[key],group:"Постановка",scope:key.startsWith("owner.") ? "role" : "command",modes:["voice","chat","work"],sourceKind:"db",originRef:key.startsWith("owner.")?"user_ai_prompts (существующие настройки ИИ)":"ai.ts → instructionDefaults",readOnly:false,roles:["secretary"]});
export function ownerPromptKey(ownerId?:string): string {
 return ownerId ?? (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at,id LIMIT 1").get() as {id:string}|undefined)?.id ?? "";
}
const META: Record<string, [string,string]> = {
 "role.prompt": ["Инструкция роли", "Роль"], rules: ["Правила работы", "Общие"],
 local_policy: ["Среда выполнения", "Общие"], role_skills: ["Навыки роли (метаданные)", "Возможности"],
 mcp_tools: ["Доступные MCP-инструменты", "Возможности"], model_policy: ["Модель и маршрутизация", "Возможности"],
 "plan.role_node": ["Данные узла плана", "Контекст"], "chat.submission": ["История чата", "Контекст"],
 "chat.voice_intake": ["Голосовые данные", "Контекст"], "intake.summary": ["Память и база знаний", "Контекст"],
 "subtask.run_prompt": ["Загрузка внешних инструкций", "Контекст"],
};
for (const spec of LAYER_CATALOG) {
 if (META[spec.key]) [spec.title, spec.group] = META[spec.key];
 spec.placeholders ??= [];
}
export function registerInstructionBlock(spec: LayerSpec, original: string): void {
 if (!getLayerSpec(spec.key)) LAYER_CATALOG.push(spec);
 INSTRUCTION_DEFAULTS[spec.key] = original;
}

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
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='role_context_overrides'").get()) return null;
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
function readOriginal(layer: LayerSpec, role: string, ownerId?: string): string {
  if(layer.key.startsWith("owner.")) {
    const row=db.prepare("SELECT prompt FROM user_ai_prompts WHERE user_id=? AND scope=?").get(ownerPromptKey(ownerId),layer.key.slice(6)) as {prompt:string}|undefined;
    return row?.prompt?.trim() ? row.prompt : (INSTRUCTION_DEFAULTS[layer.key] ?? "");
  }
  if (Object.hasOwn(INSTRUCTION_DEFAULTS, layer.key)) return INSTRUCTION_DEFAULTS[layer.key];
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
    case "plan.role_node": return "Данные выбранной задачи: узел, зависимости и версии артефактов из buildCollaborationPlanContext; добавляются при запуске, не являются постоянной инструкцией.";
    case "chat.submission": return "Последние сообщения chat_messages и сохранённая Pi-сессия. История передаётся как данные; её прежние инструкции могут остаться в разговоре.";
    case "chat.voice_intake": return "Расшифровка и история текущего звонка Gemini Live; голосовые инструменты вызывают общий серверный разбор постановки и сводки.";
    case "intake.summary": return "taskContextBridge → task_context.py: карточка, KB, Mnemosyne, dependency_context и collaboration_context. Факты извлекаются при запуске; ошибки и источники включаются в TaskContext. Это данные, а не редактируемая инструкция.";
    case "subtask.run_prompt": return "Задачи используют явный ResourceLoader: auto AGENTS/skills/extensions не загружаются. Чат использует Pi DefaultResourceLoader и глобальные/локальные AGENTS, skills, extensions, SYSTEM.md и APPEND_SYSTEM.md. Upstream compaction и tool schema меняются через SDK/файлы, не через текст TaskFlow.";
    default:
      // Неизвестный слой — структурная ошибка каталога. Бросаем, иначе
      // пустой слой скрыл бы проблему от UI и от ревью.
      throw new Error(`roleContextResolver: неизвестный слой ${layer.key}`);
  }
}

export function revision(scope: "role" | "command", role: string, layer: string, ownerId?:string): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='role_context_overrides'").get()) return 0;
  return (db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM role_context_overrides WHERE scope=? AND role_key=? AND layer=?").get(scope, scope === "command" ? "*" : layer.startsWith("owner.") ? "owner:"+ownerPromptKey(ownerId) : role, layer) as {v:number}).v;
}
export function composeLayer(role: string, layerKey: string, ownerId?:string): ComposedLayer | null {
 const spec = getLayerSpec(layerKey);
 if (!spec || (spec.roles && !spec.roles.includes(role))) return null;
 const original = readOriginal(spec, role, ownerId);
 const roleRow = readActiveOverride("role", layerKey.startsWith("owner.")?"owner:"+ownerPromptKey(ownerId):role, layerKey);
 const commandRow = spec.scope === "command" ? readActiveOverride("command", "*", layerKey) : null;
 const row = roleRow ?? commandRow;
 return {layer: layerKey, title: spec.title, group: spec.group, defaultText: original,
  effective: (layerKey === "role.prompt" || layerKey.startsWith("owner.")) ? original : (row?.text ?? original),
  source: row ? (roleRow ? "override" : "command_default") : "original",
  origin: {kind: spec.sourceKind, ref: spec.originRef}, version: revision("role", role, layerKey, ownerId),
  roleVersion: revision("role", role, layerKey, ownerId), commandVersion: revision("command", "*", layerKey),
  updatedAt: row?.created_at ?? null, updatedBy: row?.created_by ?? null,
  readOnly: spec.readOnly, modes: spec.modes, placeholders: spec.placeholders ?? []};
}
export function composeTeamText(role:string,layerKey:string,ownerId?:string):string|null {
 const spec=getLayerSpec(layerKey);if(!spec||spec.scope!=="command")return null;
 return readActiveOverride("command","*",layerKey)?.text ?? readOriginal(spec,role,ownerId);
}
export function compose(role: string, mode: RunMode): ComposedLayer[] {
 return listLayerKeysForMode(mode).map(k => composeLayer(role,k)).filter((x): x is ComposedLayer => !!x);
}
export function globalVersionForRole(role: string): number {
 return (db.prepare("SELECT COUNT(*) AS v FROM role_context_overrides WHERE (scope='role' AND role_key=?) OR (scope='command' AND role_key='*')").get(role) as {v:number}).v;
}
export function readOriginalOnly(role: string, layer: string): string | null {
 const spec=getLayerSpec(layer); return spec ? readOriginal(spec,role) : null;
}
export function readHistoryEntry(scope: "role"|"command", roleKey: string, layer: string, version: number) {
 const row = db.prepare("SELECT text, source_kind AS sourceKind, source_ref AS sourceRef, action FROM role_context_overrides_history WHERE scope=? AND role_key=? AND layer=? AND version=? ORDER BY rowid DESC LIMIT 1").get(scope, scope === "command" ? "*" : roleKey,layer,version) as {text:string;sourceKind:string;sourceRef:string;action:string} | undefined;
 return row ?? null;
}
export function listHistory(scope: "role"|"command", roleKey: string, layer: string, limit=50) {
 return db.prepare("SELECT version, action, at, by_user_id AS byUserId, reason, text FROM role_context_overrides_history WHERE scope=? AND role_key=? AND layer=? ORDER BY version DESC LIMIT ?").all(scope, scope === "command" ? "*" : roleKey,layer,limit) as Array<{version:number;action:"set"|"reset"|"restore";at:string;byUserId:string;reason:string|null;text:string}>;
}
export class InstructionConflict extends Error {}
export function validateInstruction(layer: string, text: string): void {
 const spec=getLayerSpec(layer); if (!spec || spec.readOnly) throw new Error("слой только для просмотра или не найден");
 if (Buffer.byteLength(text,"utf8") > 65536) throw new Error("инструкция больше 64 КБ");
 // Only explicit simple placeholders are interpreted; JSON examples are ordinary text.
 const allowed = new Set(spec.placeholders ?? []);
 if (!allowed.size) return;
 for (const m of text.matchAll(/(?<!\{)\{([A-Za-z][A-Za-z0-9_]*)\}(?!\})/g)) {
  if (!allowed.has(m[1])) throw new Error("неизвестный placeholder: " + m[1]);
 }
 for (const name of allowed) {
  if (!text.includes("{"+name+"}")) throw new Error("обязательный placeholder: " + name);
 }
}
export function applyOverride(args: {scope:"role"|"command";roleKey:string;layer:string;text:string;sourceKind:string;sourceRef:string;createdBy:string;action:"set"|"reset"|"restore";reason?:string|null;expectedVersion?:number}): ComposedLayer {
 const spec=getLayerSpec(args.layer);
 if (!spec || spec.readOnly) throw new Error("слой только для просмотра или не найден");
 if (spec.scope === "role" && args.scope !== "role") throw new Error("этот слой можно менять только для роли");
 if (args.action !== "reset") validateInstruction(args.layer,args.text);
 const roleKey=args.scope === "command" ? "*" : args.layer.startsWith("owner.")?"owner:"+args.createdBy:args.roleKey;
 db.transaction(() => {
  const previous=revision(args.scope, args.roleKey,args.layer,args.createdBy);
  if (args.expectedVersion !== undefined && args.expectedVersion !== previous) throw new InstructionConflict("версия не совпала");
  if (!previous) {
   db.prepare("INSERT INTO role_context_overrides_history(id,scope,role_key,layer,version,text,source_kind,source_ref,action,by_user_id) VALUES (?,?,?,?,0,?,?,?,'set',?)").run(crypto.randomUUID(),args.scope,roleKey,args.layer,readOriginal(spec,args.roleKey,args.createdBy),spec.sourceKind,spec.originRef,args.createdBy);
  }
  db.prepare("UPDATE role_context_overrides SET is_active=0 WHERE scope=? AND role_key=? AND layer=?").run(args.scope,roleKey,args.layer);
  if (args.layer === "role.prompt") db.prepare("UPDATE roles SET prompt=? WHERE key=?").run(args.action === "reset" ? null : args.text,args.roleKey);
  if(args.layer.startsWith("owner.")) {
   if(args.action==="reset")db.prepare("DELETE FROM user_ai_prompts WHERE user_id=? AND scope=?").run(args.createdBy,args.layer.slice(6));
   else db.prepare("INSERT INTO user_ai_prompts(user_id,scope,prompt) VALUES (?,?,?) ON CONFLICT(user_id,scope) DO UPDATE SET prompt=excluded.prompt,updated_at=datetime('now')").run(args.createdBy,args.layer.slice(6),args.text);
  }
  const next=previous+1;
  db.prepare("INSERT INTO role_context_overrides(scope,role_key,layer,version,text,source_kind,source_ref,created_by,is_active) VALUES (?,?,?,?,?,?,?,?,?)").run(args.scope,roleKey,args.layer,next,args.text,args.sourceKind,args.sourceRef,args.createdBy,args.action === "reset" ? 0 : 1);
  db.prepare("INSERT INTO role_context_overrides_history(id,scope,role_key,layer,version,prev_version,text,source_kind,source_ref,action,by_user_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(),args.scope,roleKey,args.layer,next,previous,args.text,args.sourceKind,args.sourceRef,args.action,args.createdBy,args.reason ?? null);
 })();
 return composeLayer(args.roleKey,args.layer,args.createdBy)!;
}
export function renderInstruction(role: string, block: string, values: Record<string,string>): string {
 const layer=composeLayer(role,block); if (!layer) throw new Error("нет инструкции: " + block);
 return layer.effective.replace(/(?<!\{)\{([A-Za-z][A-Za-z0-9_]*)\}(?!\})/g, (match,name) => {
  if (!(layer.placeholders ?? []).includes(name)) return match;
  if (!Object.hasOwn(values,name)) throw new Error("нет значения placeholder: " + name);
  return values[name];
 });
}
export function effectiveRules(role: string): string[] {
 return composeLayer(role,"rules")!.effective.split("\n").filter(Boolean).map(x => x.replace(/^- /,""));
}
export function instructionManifest(role: string, mode: RunMode) {
 return compose(role,mode).filter(x => !x.readOnly).map(x => ({blockId:x.layer,scope:x.source,version:x.source === "command_default" ? x.commandVersion : x.version,source:x.origin.ref,sha256:crypto.createHash("sha256").update(x.effective).digest("hex")}));
}
