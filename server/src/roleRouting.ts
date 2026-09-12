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

export type ShellRoute = { shell: string; userId: string };

export const SHELL_USER_IDS: Record<string, string> = {
  agent_claude_bot: "u2",
  agent_hermes: "u3",
  agent_orchestrator: "6848a89b-04fe-4015-bb1c-61b03782c378",
  agent_deepseek: "b85212d6-abab-4afb-a4c6-0d379b6537a4",
  agent_antigravity: "5b9d47c1-25c7-4a7c-a276-70e21f7d7816",
  agent_pi: "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2",
};

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

/** Load and validate the shared role-to-shell routing matrix. */
export function loadRoleRouting(fileName = ROLE_ROUTING_FILE): RoleRouting {
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

/** Return the next shell after the executor that hit a provider limit. */
export function nextShellForRole(
  routing: RoleRouting,
  role: string,
  currentExecutorId: string,
): ShellRoute | null {
  if (!ROLE_NAMES.includes(role as RoleName)) return null;
  const typedRole = role as RoleName;
  const shells = [routing.defaults[typedRole], ...routing.fallbacks[typedRole]];
  const currentIndex = shells.findIndex(
    (shell) => SHELL_USER_IDS[shell] === currentExecutorId,
  );
  const firstCandidate = currentIndex >= 0 ? currentIndex + 1 : 1;
  for (const shell of shells.slice(firstCandidate)) {
    const userId = SHELL_USER_IDS[shell];
    if (userId) return { shell, userId };
  }
  return null;
}
