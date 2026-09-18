import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { ROLE_NAMES, loadRoleRouting, type RoleName } from "../roleRouting.js";

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
  const fileName = path.join(ROLE_PROFILES_DIR, role + ".json");
  const config = JSON.parse(fs.readFileSync(fileName, "utf8")) as ProfileConfig;
  const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
  if (!tools) throw new Error(`MCP-профиль роли ${role} не содержит allowlist`);
  return tools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Системный промпт роли. Источник правды — файл, а не колонка users.prompt:
 *  она у ролевых учёток пуста, и заводить вторую копию значит гарантированно
 *  их рассинхронизировать (раздел 5 спецификации: «объединяет одним API, а не
 *  переносит всё в новое параллельное хранилище»). */
function readRolePrompt(role: RoleName): string {
  return fs.readFileSync(path.join(ROLE_PROMPTS_DIR, `${role}.md`), "utf8");
}

/** Учётка роли в users — кого диспетчер ставит исполнителем и чьим именем
 *  роль подписана на экране. */
function roleAccount(role: RoleName) {
  return db
    .prepare(
      `SELECT id, name, permissions, status, last_seen_at
         FROM users
        WHERE role = ?
        ORDER BY created_at
        LIMIT 1`,
    )
    .get(role) as
    | {
        id: string;
        name: string;
        permissions: string | null;
        status: string | null;
        last_seen_at: string | null;
      }
    | undefined;
}

/** Лесенка попыток для модели роли. Политики привязаны не к роли, а к
 *  модели и причине отказа — поэтому берём их по модели из routing. */
function attemptPolicyFor(model: string | undefined) {
  if (!model) return [];
  return db
    .prepare(
      `SELECT reason_code, from_model, to_model, max_attempts, cooldown_seconds
         FROM attempt_policies
        WHERE from_model = ?
        ORDER BY reason_code`,
    )
    .all(model) as Array<{
    reason_code: string;
    from_model: string;
    to_model: string | null;
    max_attempts: number;
    cooldown_seconds: number;
  }>;
}

/** Чем роль занята прямо сейчас: активная карточка, отданная этой роли.
 *  Читается по dispatched_role — той самой колонке, которую заполняет
 *  диспетчер, а не по assignee_id: исполнитель у всех ролей один Pi. */
function currentWorkOf(role: RoleName) {
  return db
    .prepare(
      `SELECT id, title, agent_state, agent_heartbeat_at
         FROM tasks
        WHERE status = 'active' AND dispatched_role = ?
        ORDER BY CASE agent_state
                   WHEN 'in_progress' THEN 0
                   WHEN 'blocked' THEN 1
                   WHEN 'review' THEN 2
                   ELSE 3
                 END,
                 dispatched_at DESC
        LIMIT 1`,
    )
    .get(role) as
    | {
        id: string;
        title: string;
        agent_state: string | null;
        agent_heartbeat_at: string | null;
      }
    | undefined;
}

export type RoleStatus = "ready" | "working" | "blocked" | "unavailable";

/** Человеческие подписи статусов — экран показывает их как есть. */
const STATUS_TITLES_RU: Record<RoleStatus, string> = {
  ready: "Готова",
  working: "Работает",
  blocked: "Заблокирована",
  unavailable: "Недоступна",
};

/**
 * Собранный профиль роли — единый фасад над готовыми источниками
 * (раздел 5 спецификации от 14.09.2026): промпты в scripts/role-prompts,
 * навыки в role_skills, MCP-allowlist в профилях Pi, модель и оболочка в
 * role-routing.yaml, лесенка попыток в attempt_policies, учётка в users.
 *
 * Ничего из этого не копируется в новую таблицу: экран и runtime обязаны
 * читать ОДНИ И ТЕ ЖЕ данные, иначе карточка роли в интерфейсе покажет
 * одно, а Pi запустится с другим — ровно то расхождение, ради которого
 * этот фасад и заводится.
 *
 * Сломанный источник роль не роняет: проблемы собираются в problems, роль
 * становится «Недоступна», а остальные семь продолжают показываться.
 * Раньше отсутствие одного файла профиля обрушивало весь список — экран
 * «Команда» оставался пустым вместо одной проблемной строки.
 */
function roleDetails(role: RoleName, piAlive: boolean) {
  const routing = loadRoleRouting();
  const problems: string[] = [];

  const skills = db
    .prepare(
      `SELECT skill_name, description
         FROM role_skills
        WHERE role = ?
        ORDER BY skill_name`,
    )
    .all(role) as Array<{ skill_name: string; description: string | null }>;

  let tools: string[] = [];
  try {
    tools = readRoleTools(role);
  } catch (err) {
    problems.push(`MCP-профиль не читается: ${(err as Error).message}`);
  }

  let prompt = "";
  try {
    prompt = readRolePrompt(role);
  } catch {
    problems.push("системный промпт роли не найден");
  }

  const account = roleAccount(role);
  if (!account) problems.push("нет учётки роли в системе");

  const model = routing.models[role];
  if (!model) problems.push("в маршрутизации не задана модель");

  const work = currentWorkOf(role);

  // Статус роли (раздел 9). Здоровье Pi в восемь строк НЕ копируется:
  // при живом Pi роль может быть недоступна из-за собственной сломанной
  // конфигурации, и наоборот — исправная конфигурация бесполезна, если
  // исполнять некому.
  // problems — проблемы САМОЙ роли: её промпт, профиль, учётка, модель.
  // Остановленный исполнитель сюда НЕ попадает, хотя роль из-за него тоже
  // недоступна. Причина одна на все восемь, и, размноженная по строкам,
  // она читается как восемь разных поломок — экран показывал бы стену
  // тревоги там, где чинить надо ровно одно и в другом месте.
  let status: RoleStatus;
  if (problems.length) {
    status = "unavailable";
  } else if (!piAlive) {
    status = "unavailable";
  } else if (work?.agent_state === "in_progress") {
    status = "working";
  } else if (work?.agent_state === "blocked") {
    status = "blocked";
  } else {
    status = "ready";
  }

  return {
    role,
    // Имя из учётки, а не из словаря в коде: владелец переименует роль в
    // одном месте, и экран это подхватит.
    title: account?.name ?? role,
    account_id: account?.id ?? null,
    status,
    status_title: STATUS_TITLES_RU[status],
    /** Жив ли исполнитель. Отдельно от problems: это общая причина, а не
     *  свойство роли, и показывать её надо один раз на список. */
    runtime_ready: piAlive,
    problems,
    prompt,
    skills,
    tools,
    permissions: account?.permissions ?? null,
    model,
    default_shell: routing.defaults[role],
    // 18.09.2026 (карточка f3108dcc): добавляем runtime_id — фасадное
    // поле, указывающее на рантайм. Сейчас всегда "runtime:pi". UI
    // продолжает читать default_shell (legacy-alias), новое поле — для
    // новых потребителей (/api/runtime/*).
    runtime_id: "runtime:pi",
    fallbacks: routing.fallbacks[role],
    attempt_policy: attemptPolicyFor(model),
    current_task: work
      ? { id: work.id, title: work.title, state: work.agent_state }
      : null,
    last_activity: work?.agent_heartbeat_at ?? account?.last_seen_at ?? null,
  };
}

/**
 * Жив ли исполнитель, которым роли и работают.
 *
 * Все восемь ролей выполняет один Pi runtime, поднимаемый службой
 * автономки. Служба стоит — исполнять роль некому, какой бы исправной ни
 * была её конфигурация. Отдельного признака у ролей для этого нет и не
 * нужно: он был бы копией того же факта и разъехался бы с ним.
 *
 * Отказ проверки трактуется как «не запущен»: соврать «Готова» и оставить
 * владельца ждать работу, которая не начнётся, хуже, чем показать
 * «Недоступна» лишний раз.
 */
async function piAlive(): Promise<boolean> {
  try {
    const { unitState } = await import("./agent-service.js");
    const state = await unitState();
    return state.active;
  } catch {
    return false;
  }
}

/** Register the role catalog, role prompts, and account-role lookup routes. */
export function registerRoleRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.get("/api/roles", { preHandler: authPre }, async () => {
    // Здоровье исполнителя спрашивается ОДИН раз на запрос, а не на
    // каждую из восьми ролей: за ответом стоит вызов systemctl.
    const alive = await piAlive();
    return { roles: ROLE_NAMES.map((role) => roleDetails(role, alive)) };
  });

  app.get<{ Params: { role: string } }>(
    "/api/roles/:role",
    { preHandler: authPre },
    async (req, reply) => {
      if (!isRole(req.params.role)) {
        return reply.code(404).send({ error: "роль не найдена" });
      }
      return roleDetails(req.params.role, await piAlive());
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
        { id: string; name: string; role: string; type: string } | undefined;
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
