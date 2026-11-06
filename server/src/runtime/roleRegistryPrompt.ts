// Сборка инструкции роли из реестра правил (server/scripts/role-rules.json).
// Выключатель: настройка role_registry_enabled; false — прежний путь (SYSTEM.md + AGENTS.md + behavior).
import crypto from "node:crypto";
import db from "../db.js";
import { getSetting } from "../lib/serverSettings.js";
import { renderRules, rulesFor, type RuleChannel } from "../lib/roleRules.js";
import { genderInstruction } from "./roleBehavior.js";
import { placeholderValues, roleHome } from "./roleHome.js";

export function registryEnabled(): boolean {
  // Явное отключение окружением (процесс/тесты прежнего пути) главнее настройки.
  if (process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED === "false") return false;
  try { return (getSetting("role_registry_enabled") as boolean) !== false; } catch { return true; }
}

export type RegistryBuild = { text: string; ids: string[]; hash: string };
/** Правила роли без строки о роде; id ушедших правил пишутся в журнал role_rules_log. */
export function buildRegistryRules(role: string, channel: RuleChannel): RegistryBuild {
  const rules = rulesFor(role, channel);
  const text = renderRules(rules, placeholderValues(role, roleHome(role)));
  const ids = rules.map((r) => r.id);
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  logRegistryBuild(role, channel, ids, hash, text.length);
  return { text, ids, hash };
}

/** Правила реестра + строка о грамматическом роде (кодом, как раньше). */
export function registryInstructionText(role: string, channel: RuleChannel): string {
  return [buildRegistryRules(role, channel).text, genderInstruction(role)].join("\n\n");
}

/** Журнал: роль, канал, id правил, хэш, время. Одинаковая сборка не плодит строк — растёт uses. */
function logRegistryBuild(role: string, channel: string, ids: string[], hash: string, length: number): void {
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO role_rules_log(role,channel,hash,ids_json,text_len,first_at,last_at,uses) VALUES(?,?,?,?,?,?,?,1)
      ON CONFLICT(role,channel,hash) DO UPDATE SET last_at=excluded.last_at,uses=uses+1`)
      .run(role, channel, hash, JSON.stringify(ids), length, now, now);
  } catch { /* журнал — наблюдение, а не условие работы */ }
}
