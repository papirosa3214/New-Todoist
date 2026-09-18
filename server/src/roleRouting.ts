import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const ROLE_NAMES = [
  "researcher",
  "analyst",
  "synthesizer",
  "critic_verifier",
  "architect",
  "builder",
  "qa",
  "designer",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export type RoleRouting = {
  defaults: Record<RoleName, string>;
  fallbacks: Record<RoleName, string[]>;
  models: Record<RoleName, string>;
};

/** Новый алиас типа. Содержит модель и провайдера, к которому она относится —
 *  используется в новой семантике nextModelForProfile() (см. ниже). Старый
 *  ShellRoute оставлен как deprecated для существующих вызовов. */
export type ModelRoute = { model: string; provider: string };

/** Deprecated с 18.09.2026 (карточка f3108dcc). Новые вызовы должны
 *  использовать ModelRoute. Оставлен для обратной совместимости с
 *  nextShellForRole() ниже (deprecated обёртка). */
export type ShellRoute = { shell: string; userId: string };

/** Канонические имена shell'ов → userId. agent_pi → pi_runtime через
 *  SHELL_AGENT_ALIASES. Старые legacy-shells (claude_bot, hermes и т.д.)
 *  удалены 18.09.2026: Pi — единый runtime, остальные оболочки выведены. */
export const SHELL_AGENT_IDS: Record<string, string> = {
  pi_runtime: "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2",
};

/** Legacy-aliases shell-имён. Карточки до 18.09.2026 содержат "agent_pi",
 *  trigger.py и roleRouting трактуют оба имени одинаково. */
export const SHELL_AGENT_ALIASES: Record<string, string> = {
  agent_pi: "pi_runtime",
};

/** Deprecated с 18.09.2026. Новый код должен использовать SHELL_AGENT_IDS.
 *  Оставлен как алиас для существующих импортов в UI/legacy-коде. */
export const SHELL_USER_IDS = SHELL_AGENT_IDS;

const ROLE_ROUTING_FILE = path.resolve(
  process.env.TASKFLOW_ROLE_ROUTING_FILE ??
    path.join(process.cwd(), "scripts", "role-routing.yaml"),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function roleSection(
  document: Record<string, unknown>,
  name: "defaults" | "fallbacks" | "models",
): Record<RoleName, unknown> {
  const value = document[name];
  if (!isRecord(value)) throw new Error(`role-routing: ${name} должен быть mapping`);
  const expected = new Set<string>(ROLE_NAMES);
  const actual = new Set(Object.keys(value));
  if (actual.size !== expected.size || [...expected].some((role) => !actual.has(role))) {
    throw new Error(`role-routing: ${name} должен содержать все роли`);
  }
  return value as Record<RoleName, unknown>;
}

/** Каноническое имя новой функции. 18.09.2026: маршрутизация переехала
 *  с shell-имён на модели — Pi единственный runtime, и при provider limit
 *  лесенка идёт по моделям, а не по оболочкам. */
export function loadRuntimeConfig(fileName = ROLE_ROUTING_FILE): RoleRouting {
  let document: unknown;
  try {
    document = parse(fs.readFileSync(fileName, "utf8"));
  } catch (error) {
    throw new Error(`role-routing: не удалось прочитать ${fileName}: ${String(error)}`);
  }
  if (!isRecord(document)) {
    throw new Error("role-routing: верхний уровень должен быть mapping");
  }
  const keys = Object.keys(document).sort();
  if (keys.join(",") !== "defaults,fallbacks,models") {
    throw new Error("role-routing: нужны ровно defaults, fallbacks и models");
  }

  const defaults = roleSection(document, "defaults") as Record<RoleName, string>;
  const rawFallbacks = roleSection(document, "fallbacks");
  const models = roleSection(document, "models") as Record<RoleName, string>;
  const fallbacks = {} as Record<RoleName, string[]>;

  for (const role of ROLE_NAMES) {
    if (typeof defaults[role] !== "string" || !defaults[role].trim()) {
      throw new Error(`role-routing: defaults.${role} должен быть непустой строкой`);
    }
    if (typeof models[role] !== "string" || !models[role].trim()) {
      throw new Error(`role-routing: models.${role} должен быть непустой строкой`);
    }
    const chain = rawFallbacks[role];
    if (!Array.isArray(chain) ||
        chain.some((shell) => typeof shell !== "string" || !shell.trim())) {
      throw new Error(`role-routing: fallbacks.${role} должен быть списком строк`);
    }
    if (new Set(chain).size !== chain.length) {
      throw new Error(`role-routing: fallbacks.${role} не должен содержать дубликаты`);
    }
    fallbacks[role] = [...chain];
  }

  return { defaults, fallbacks, models };
}

/** Deprecated алиас для loadRuntimeConfig. Оставлен потому, что
 *  server/scripts/trigger.py, server/test/roles.test.ts и server/src/routes/roles.ts
 *  импортируют loadRoleRouting. Будет удалён, когда переведём их на новое имя. */
export function loadRoleRouting(fileName = ROLE_ROUTING_FILE): RoleRouting {
  return loadRuntimeConfig(fileName);
}

/** Эвристика: какая провайдерская семья соответствует модели. Используется
 *  в nextModelForProfile() для построения ModelRoute. На первом этапе
 *  (Pi = единый runtime, провайдеров минимум три: anthropic/openai/minimax) —
 *  простое сопоставление по префиксу. Расширяется через task 7 (API
 *  /api/runtime/providers). */
export function providerOfModel(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  return "minimax";
}

/** Следующая модель в лесенке для роли после исчерпания текущей.
 *  Семантика «следующая модель», а не «следующий shell» — Pi один,
 *  shell-имён больше нет (см. карточку f3108dcc). */
export function nextModelForProfile(
  config: RoleRouting,
  role: string,
  currentModel: string,
): ModelRoute | null {
  if (!ROLE_NAMES.includes(role as RoleName)) return null;
  const typedRole = role as RoleName;
  const chain = [config.models[typedRole], ...config.fallbacks[typedRole]];
  const idx = chain.indexOf(currentModel);
  for (const candidate of chain.slice(idx + 1)) {
    return { model: candidate, provider: providerOfModel(candidate) };
  }
  return null;
}

/** Deprecated обёртка для nextModelForProfile. Использует старую shell-семантику:
 *  currentExecutorId → shells[i]. Новый код должен использовать nextModelForProfile.
 *  Карточка 16.09.2026, 5f292e87 уже выпила из этого формата, но в
 *  agent-state.ts есть вызовы — перевод на новую семантику в этой же
 *  задаче (см. agent-state.ts изменения). */
export function nextShellForRole(
  routing: RoleRouting,
  role: string,
  currentExecutorId: string,
): ShellRoute | null {
  if (!ROLE_NAMES.includes(role as RoleName)) return null;
  const typedRole = role as RoleName;
  const shells = [routing.defaults[typedRole], ...routing.fallbacks[typedRole]];
  const currentIndex = shells.findIndex(
    (shell) => SHELL_AGENT_IDS[shell] === currentExecutorId
      || (SHELL_AGENT_ALIASES[shell] && SHELL_AGENT_IDS[SHELL_AGENT_ALIASES[shell]] === currentExecutorId),
  );
  const firstCandidate = currentIndex >= 0 ? currentIndex + 1 : 1;
  for (const shell of shells.slice(firstCandidate)) {
    const userId = SHELL_AGENT_IDS[shell]
      ?? SHELL_AGENT_IDS[SHELL_AGENT_ALIASES[shell]];
    if (userId) return { shell, userId };
  }
  return null;
}
