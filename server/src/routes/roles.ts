import { applyOverride, revision } from "../lib/roleContextResolver.js";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken, ownerOrApiToken } from "../auth.js";
import {
  ROLE_NAMES,
  allRoles,
  loadRoleRouting,
  roleTitle,
  refreshRoles,
  rolePromptText,
  roleUserId,
  type RoleName,
} from "../roleRouting.js";
import { inProcessToolNames, sweepPendingReviews } from "../runtime/inProcessRun.js";

type ProfileConfig = {
  mcpServers?: {
    taskflow?: {
      env?: Record<string, string>;
    };
  };
};

const ROLE_PROFILES_DIR = path.resolve(
  process.env.TASKFLOW_ROLE_PROFILES_DIR ??
    path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles"),
);

/** Ключ роли: он же часть id учётки role_<ключ> и имя в role-routing.yaml. */
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
const RESERVED_ROLE_KEYS = new Set([
  "owner",
  "agent",
  "viewer",
  "orchestrator",
  "service",
]);

function isRole(value: string): value is RoleName {
  return ROLE_NAMES.includes(value as RoleName);
}

function readRoleTools(role: RoleName): string[] {
  const fileName = path.join(ROLE_PROFILES_DIR, role + ".json");
  // Роль, заведённая с экрана «Команда», профиля Pi не имеет и работает
  // только внутри сервера — её инструменты те, что даёт заход внутри.
  if (!fs.existsSync(fileName)) return inProcessToolNames();
  const config = JSON.parse(fs.readFileSync(fileName, "utf8")) as ProfileConfig;
  const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
  if (!tools) throw new Error(`MCP-профиль роли ${role} не содержит allowlist`);
  return tools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Системный промпт роли: roles.prompt, пустая — файл scripts/role-prompts.
 *  Не колонка users.prompt: она у ролевых учёток пуста, и вторая копия
 *  гарантированно разъехалась бы с первой. */
function readRolePrompt(role: RoleName): string {
  const text = rolePromptText(role);
  if (text === null) throw new Error("нет инструкции роли");
  return text;
}

/** Учётка роли в users — кого диспетчер ставит исполнителем и чьим именем
 *  роль подписана на экране. */
function roleAccount(role: RoleName) {
  return db
    .prepare(
      `SELECT id, name, permissions, status, last_seen_at
         FROM users
        WHERE role_key = ? AND role = 'agent' AND type = 'ai'
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

  const record = allRoles().find((r) => r.key === role);

  return {
    role,
    // Имя из учётки, а не из словаря в коде: владелец переименует роль в
    // одном месте, и экран это подхватит. Учётки role_<ключ> может не быть
    // (Секретарь живёт на u-secretary) — тогда название из таблицы ролей,
    // а не голый ключ: владелец 27.09.2026 видел в исполнителях «secretary».
    title: account?.name ?? roleTitle(role),
    /** «Чем занимается» — строка для Секретаря; правится на экране «Команда». */
    summary: record?.summary ?? "",
    /** Отключённая роль в работу не берётся, но в списке «Команды» видна. */
    enabled: record?.enabled ?? false,
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

  app.get<{ Querystring: { all?: string } }>(
    "/api/roles",
    { preHandler: authPre },
    async (req) => {
      // Здоровье исполнителя спрашивается ОДИН раз на запрос, а не на
      // каждую из восьми ролей: за ответом стоит вызов systemctl.
      const alive = await piAlive();
      // ?all=1 — вместе с отключёнными: экрану «Команда» их надо показать,
      // чтобы было что включить обратно. Без него — только рабочие роли.
      const keys = req.query.all === "1" ? allRoles().map((r) => r.key) : ROLE_NAMES;
      return { roles: keys.map((role) => roleDetails(role, alive)) };
    },
  );

  // Экран «Команда»: роль заводится одним действием — запись в roles и
  // учётка role_<ключ> (ai, без пароля и ключа: агент работает внутри
  // сервера). Модель — существующим PUT /api/runtime/routing/:role;
  // до этого новой роли достаётся модель по умолчанию.
  app.post<{ Body: { key?: unknown; title?: unknown; summary?: unknown; prompt?: unknown } }>(
    "/api/roles",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const body = req.body ?? {};
      const key = typeof body.key === "string" ? body.key.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!ROLE_KEY_RE.test(key)) {
        return reply.code(422).send({
          error: "ключ роли — латиница в нижнем регистре, цифры и _, от 2 до 32 знаков",
        });
      }
      if (RESERVED_ROLE_KEYS.has(key)) {
        return reply.code(422).send({ error: "этот ключ роли зарезервирован системой" });
      }
      if (!title) return reply.code(422).send({ error: "нужно название роли" });
      if (allRoles().some((r) => r.key === key)) {
        return reply.code(409).send({ error: "роль с таким ключом уже есть" });
      }

      const userId = roleUserId(key);
      if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
        return reply.code(409).send({
          error: "учётная запись с каноническим id этой роли уже существует",
        });
      }
      db.transaction(() => {
        const position = (
          db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roles").get() as { p: number }
        ).p;
        db.prepare(
          "INSERT INTO roles (key, title, summary, enabled, position, prompt) VALUES (?, ?, ?, 1, ?, ?)",
        ).run(key, title, summary, position, prompt || null);
        db.prepare(
          `INSERT INTO users
             (id, name, email, password_hash, role, role_key, type, is_system_bot,
              profile, initials, avatar_color)
           VALUES (?, ?, ?, '!no-login', 'agent', ?, 'ai', 1, ?, ?, '#8E8E93')`,
        ).run(
          userId,
          title,
          `${key.replace(/_/g, "-")}@taskflow.local`,
          key,
          key,
          title.slice(0, 1).toUpperCase(),
        );
      })();
      refreshRoles();
      return reply.code(201).send(roleDetails(key, await piAlive()));
    },
  );

  // Правка роли: название, «чем занимается», инструкция, включена, порядок.
  // Роль не удаляется — отключается, чтобы не терялась история её задач.
  app.patch<{
    Params: { role: string };
    Body: { title?: unknown; summary?: unknown; prompt?: unknown; enabled?: unknown; position?: unknown };
  }>(
    "/api/roles/:role",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const key = req.params.role;
      if (!allRoles().some((r) => r.key === key)) {
        return reply.code(404).send({ error: "роль не найдена" });
      }
      const wasEnabled = allRoles().find((r) => r.key === key)?.enabled ?? false;
      const body = req.body ?? {};
      const sets: string[] = [];
      const values: unknown[] = [];
      let title: string | null = null;

      if (body.title !== undefined) {
        if (typeof body.title !== "string" || !body.title.trim()) {
          return reply.code(422).send({ error: "название роли не может быть пустым" });
        }
        title = body.title.trim();
        sets.push("title = ?");
        values.push(title);
      }
      if (body.summary !== undefined) {
        if (typeof body.summary !== "string") {
          return reply.code(422).send({ error: "«чем занимается» — строка" });
        }
        sets.push("summary = ?");
        values.push(body.summary.trim());
      }
      if (body.prompt !== undefined) {
        if (body.prompt !== null && typeof body.prompt !== "string") {
          return reply.code(422).send({ error: "инструкция роли — строка" });
        }
        // Пустая строка или null — вернуться к файлу scripts/role-prompts.
        sets.push("prompt = ?");
        values.push(typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : null);
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return reply.code(422).send({ error: "enabled — true или false" });
        }
        sets.push("enabled = ?");
        values.push(body.enabled ? 1 : 0);
      }
      if (body.position !== undefined) {
        if (typeof body.position !== "number" || !Number.isInteger(body.position)) {
          return reply.code(422).send({ error: "position — целое число" });
        }
        sets.push("position = ?");
        values.push(body.position);
      }
      if (!sets.length) return reply.code(422).send({ error: "нечего менять" });

      db.transaction(() => {
        if (body.prompt !== undefined) {
          applyOverride({scope:"role",roleKey:key,layer:"role.prompt",text:typeof body.prompt === "string" ? body.prompt : "",action:body.prompt ? "set" : "reset",expectedVersion:revision("role",key,"role.prompt"),sourceKind:"db",sourceRef:"roles.prompt",createdBy:(req as any).userId});
        }
        db.prepare(`UPDATE roles SET ${sets.join(", ")} WHERE key = ?`).run(...values, key);
        // Экран и лента подписывают роль именем учётки — держим их вместе.
        if (title !== null) {
          db.prepare("UPDATE users SET name = ? WHERE id = ?").run(title, roleUserId(key));
        }
      })();
      refreshRoles();
      // Включение Критика обратно из выключенного — карточки, сданные на
      // ревью, пока роль молчала, застряли: kickRoleTaskStrict в тот момент
      // вернул терминальный "skipped" (роли не было в ROLE_NAMES), а не
      // "deferred" — job в очереди сам больше не перезапустится. Владелец
      // 30.09.2026: включил — значит пошёл смотреть, а не «жди следующего
      // повода». Тот же принцип и результат, что у sweepStragglers на
      // тумблере «Система» (agent-service.ts).
      if (key === "critic_verifier" && body.enabled === true && !wasEnabled) {
        try {
          await sweepPendingReviews((req as any).userId ?? roleUserId(key));
        } catch (err) {
          req.log.error({ err }, "roles: не удалось разобрать зависшие ревью при включении Критика");
        }
      }
      return roleDetails(key, await piAlive());
    },
  );

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
      const prompt = rolePromptText(req.params.role);
      if (prompt === null) {
        return reply
          .code(404)
          .send({ error: "системный промпт роли ещё не создан" });
      }
      return { role: req.params.role, prompt };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/role",
    { preHandler: authPre },
    async (req, reply) => {
      const user = db
        .prepare("SELECT id, name, role_key, type FROM users WHERE id = ?")
        .get(req.params.id) as
        { id: string; name: string; role_key: string | null; type: string } | undefined;
      if (!user) return reply.code(404).send({ error: "Not found" });
      return {
        agent_id: user.id,
        name: user.name,
        role: user.role_key && isRole(user.role_key) ? user.role_key : null,
        type: user.type,
      };
    },
  );
}
