import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import {
  ROLE_NAMES,
  loadRoleRouting,
  type RoleName,
} from "../roleRouting.js";

type ProfileConfig = {
  mcpServers?: {
    taskflow?: {
      env?: Record<string, string>;
    };
  };
};

const ROLE_PROMPTS_DIR = path.resolve(
  process.env.TASKFLOW_ROLE_PROMPTS_DIR ??
    path.join(process.cwd(), "scripts", "role-prompts"),
);
const ROLE_PROFILES_DIR = path.resolve(
  process.env.TASKFLOW_ROLE_PROFILES_DIR ??
    path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles"),
);

function isRole(value: string): value is RoleName {
  return ROLE_NAMES.includes(value as RoleName);
}

function readRoleTools(role: RoleName): string[] {
  const fileName = path.join(
    ROLE_PROFILES_DIR,
    role + ".json",
  );
  const config = JSON.parse(fs.readFileSync(fileName, "utf8")) as ProfileConfig;
  const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
  if (!tools) throw new Error(`MCP-профиль роли ${role} не содержит allowlist`);
  return tools.split(",").map((tool) => tool.trim()).filter(Boolean);
}

function roleDetails(role: RoleName) {
  const routing = loadRoleRouting();
  const skills = db
    .prepare(
      `SELECT skill_name, description
         FROM role_skills
        WHERE role = ?
        ORDER BY skill_name`,
    )
    .all(role) as Array<{ skill_name: string; description: string | null }>;
  return {
    role,
    skills,
    tools: readRoleTools(role),
    model: routing.models[role],
    default_shell: routing.defaults[role],
    fallbacks: routing.fallbacks[role],
  };
}

/** Register the role catalog, role prompts, and account-role lookup routes. */
export function registerRoleRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.get("/api/roles", { preHandler: authPre }, async () => ({
    roles: ROLE_NAMES.map((role) => roleDetails(role)),
  }));

  app.get<{ Params: { role: string } }>(
    "/api/roles/:role",
    { preHandler: authPre },
    async (req, reply) => {
      if (!isRole(req.params.role)) {
        return reply.code(404).send({ error: "роль не найдена" });
      }
      return roleDetails(req.params.role);
    },
  );

  app.post<{ Params: { role: string } }>(
    "/api/roles/:role/prompt",
    { preHandler: authPre },
    async (req, reply) => {
      if (!isRole(req.params.role)) {
        return reply.code(404).send({ error: "роль не найдена" });
      }
      const fileName = path.join(ROLE_PROMPTS_DIR, `${req.params.role}.md`);
      try {
        return {
          role: req.params.role,
          prompt: fs.readFileSync(fileName, "utf8"),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply
            .code(404)
            .send({ error: "системный промпт роли ещё не создан" });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/role",
    { preHandler: authPre },
    async (req, reply) => {
      const user = db
        .prepare("SELECT id, name, role, type FROM users WHERE id = ?")
        .get(req.params.id) as
        | { id: string; name: string; role: string; type: string }
        | undefined;
      if (!user) return reply.code(404).send({ error: "Not found" });
      return {
        agent_id: user.id,
        name: user.name,
        role: isRole(user.role) ? user.role : null,
        type: user.type,
      };
    },
  );
}
