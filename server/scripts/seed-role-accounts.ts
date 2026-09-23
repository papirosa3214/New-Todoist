/**
 * Create the eight role accounts from vault-injected tokens.
 *
 * The script is intentionally one-shot and idempotent: tokens arrive only
 * through TASKFLOW_AGENT_TOKEN_<ROLE>, their SHA-256 fingerprints are stored
 * in users.api_token when supplied, and the plaintext values never enter the database or
 * output. Re-running it refreshes the fingerprints for the supplied vault
 * values without creating duplicate accounts.
 *
 * Example:
 *   TASKFLOW_AGENT_TOKEN_RESEARCHER=... \
 *   ... \
 *   npx tsx scripts/seed-role-accounts.ts
 */
import crypto from "crypto";
import db, { hashApiToken } from "../src/db.js";

const owner = db
  .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1")
  .get() as { id?: string } | undefined;
if (!owner?.id) {
  throw new Error("Не найден владелец для created_by");
}

const roles = [
  {
    role: "researcher",
    name: "Исследователь",
    email: "researcher@taskflow.local",
    initials: "R",
    color: "#4A9FD8",
    skills: [
      ["research", "Поиск и сбор фактов"],
      ["sources", "Проверка и фиксация источников"],
    ],
  },
  {
    role: "analyst",
    name: "Аналитик",
    email: "analyst@taskflow.local",
    initials: "A",
    color: "#35B8A3",
    skills: [
      ["analysis", "Анализ данных и разбор проблемы"],
      ["reasoning", "Проверяемое логическое рассуждение"],
    ],
  },
  {
    role: "critic_verifier",
    name: "Критик-проверяющий",
    email: "critic-verifier@taskflow.local",
    initials: "CV",
    color: "#FF7A8A",
    skills: [
      ["review", "Поиск ошибок и несоответствий"],
      ["verification", "Проверка результата и доказательств"],
    ],
  },
  {
    role: "architect",
    name: "Архитектор",
    email: "architect@taskflow.local",
    initials: "AR",
    color: "#FF9A14",
    skills: [
      ["architecture", "Проектирование систем и решений"],
      ["design", "Выбор структуры и технических границ"],
    ],
  },
  {
    role: "builder",
    name: "Разработчик",
    email: "builder@taskflow.local",
    initials: "B",
    color: "#8E8E93",
    skills: [
      ["implementation", "Реализация изменений в коде"],
      ["sql", "Изменение схемы и запросов базы данных"],
    ],
  },
  {
    role: "qa",
    name: "QA",
    email: "qa@taskflow.local",
    initials: "Q",
    color: "#E44332",
    skills: [
      ["testing", "Проверка поведения и регрессий"],
      ["validation", "Валидация требований и приёмочных условий"],
    ],
  },
  {
    role: "designer",
    name: "Дизайнер интерфейсов",
    email: "designer@taskflow.local",
    initials: "D",
    color: "#F06A4F",
    skills: [
      ["web_design", "Проектирование веб-интерфейсов и дизайн-системы"],
      ["mobile_design", "Проектирование мобильных экранов и взаимодействий"],
      ["accessibility", "Доступность, адаптивность и проверка состояний"],
    ],
  },
] as const;

const missing = roles
  .filter(({ role }) => role !== "designer")
  .map(({ role }) => "TASKFLOW_AGENT_TOKEN_" + role.toUpperCase())
  .filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error("Не заданы токены ролей: " + missing.join(", "));
}

const unusablePassword = () => "!" + crypto.randomBytes(24).toString("hex");
const upsertUser = db.prepare(
  "INSERT INTO users " +
    "(id, name, email, password_hash, role, role_key, type, avatar_color, initials, " +
    "status, api_token, is_system_bot, created_by) " +
    "VALUES (?, ?, ?, ?, 'agent', ?, 'ai', ?, ?, 'offline', ?, 1, ?) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "name = excluded.name, role = 'agent', role_key = excluded.role_key, type = 'ai', " +
    "avatar_color = excluded.avatar_color, initials = excluded.initials, " +
    "api_token = excluded.api_token, is_system_bot = 1, " +
    "created_by = excluded.created_by " +
    "WHERE users.type = 'ai' AND users.is_system_bot = 1",
);
const upsertSkill = db.prepare(
  "INSERT INTO role_skills (role, skill_name, description) VALUES (?, ?, ?) " +
    "ON CONFLICT(role, skill_name) DO UPDATE SET " +
    "description = excluded.description",
);

const seed = db.transaction(() => {
  for (const spec of roles) {
    const token = process.env[
      "TASKFLOW_AGENT_TOKEN_" + spec.role.toUpperCase()
    ];
    upsertUser.run(
      "role_" + spec.role,
      spec.name,
      spec.email,
      unusablePassword(),
      spec.role,
      spec.color,
      spec.initials,
      token ? hashApiToken(token) : null,
      owner.id,
    );
    for (const [skill, description] of spec.skills) {
      upsertSkill.run(spec.role, skill, description);
    }
  }
});

seed();
console.log("Создано/обновлено учёток ролей: " + roles.length);
