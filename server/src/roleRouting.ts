import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

import db from "./db.js";
import { roleInstructionText } from "./runtime/roleHome.js";

/**
 * Роли — ДАННЫЕ, а не код (владелец 23.09.2026: «почему всё так зашито,
 * неужели так сложно добавить или удалить агента»). Источник правды —
 * таблица `roles` (миграция 056): ключ, название, «чем занимается» (строка
 * для Помощника владельца), включена ли, порядок.
 *
 * `ROLE_NAMES` — ЖИВОЙ список включённых ролей: тот же массив, который
 * `refreshRoles()` переписывает на месте, поэтому все старые проверки
 * `ROLE_NAMES.includes(x)` работают без правок. Учётка роли — `role_<ключ>`.
 */
export type RoleName = string;

export type RoleRecord = {
  key: string;
  title: string;
  summary: string;
  enabled: boolean;
  position: number;
  /** Чем исполняется участник: pi — внутренняя роль, claude-code — внешний агент со своим окружением. */
  runtime?: string;
};

/** Начальный состав — до миграции 056 (свежая база в тестах) и для её посева. */
export const DEFAULT_ROLES: ReadonlyArray<{ key: string; title: string; summary: string }> = [
  { key: "researcher", title: "Исследователь", summary: "узнать, найти, сравнить варианты вне нашего кода и свести найденное в выводы или документ." },
  { key: "analyst", title: "Аналитик", summary: "посчитать цифры, метрики, деньги." },
  { key: "critic_verifier", title: "Критик-проверяющий", summary: "проверить готовую работу и вынести вердикт." },
  { key: "architect", title: "Архитектор", summary: "продумать устройство системы до кода, когда решений несколько." },
  { key: "builder", title: "Разработчик", summary: "пишет и чинит код: сервер, приложение, веб. «Сделать, чтобы работало»." },
  { key: "qa", title: "Лайф-тестировщик", summary: "пройти сценарии в живом приложении и найти баги." },
  { key: "designer", title: "Дизайнер", summary: "как выглядит: макет, экран, отступы, цвета. Не пишет серверную логику." }
];

export const ROLE_NAMES: string[] = DEFAULT_ROLES.map((r) => r.key);
let registry: RoleRecord[] = DEFAULT_ROLES.map((r, i) => ({ ...r, enabled: true, position: i }));

function rolesHaveRuntime(): boolean {
  return (db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>).some((c) => c.name === "runtime");
}

/** Внешний агент (не Pi): его рантайм, иначе null. */
export function externalRuntime(key: string): string | null {
  const runtime = registry.find((r) => r.key === key)?.runtime;
  return runtime && runtime !== "pi" ? runtime : null;
}

/** Перечитать роли из таблицы. Таблицы ещё нет — остаётся начальный состав. */
export function refreshRoles(): void {
  try {
    const rows = db
      .prepare(`SELECT key, title, summary, enabled, position, ${rolesHaveRuntime() ? "runtime" : "'pi' AS runtime"} FROM roles ORDER BY position, key`)
      .all() as Array<{ key: string; title: string; summary: string; enabled: number; position: number; runtime: string }>;
    registry = rows.map((r) => ({ ...r, enabled: r.enabled === 1 }));
    ROLE_NAMES.splice(0, ROLE_NAMES.length, ...registry.filter((r) => r.enabled).map((r) => r.key));
  } catch {
    // таблицы roles ещё нет — до миграции 056
  }
}

/** Все роли, включая отключённые (для экрана «Команда»). */
export function allRoles(): RoleRecord[] {
  return registry.map((r) => ({ ...r }));
}

export function roleTitle(key: string): string {
  return registry.find((r) => r.key === key)?.title ?? key;
}

export function roleUserId(key: string): string {
  // Помощник владельца — фиксированная учётка u-secretary (заведена до системы
  // ролей, на неё уже ссылаются chat_messages и iOS-константа
  // ChatBubble.secretaryID); переименовывать в role_secretary — ломать
  // историю сообщений и клиент. Единственное исключение из паттерна.
  if (key === "secretary") return "u-secretary";
  return `role_${key}`;
}

/** Инструкция роли — общий шаблон + AGENTS.md роли (runtime/roleHome.ts).
 *  Ключ не годится для папки роли — null. */
export function rolePromptText(key: string): string | null {
  try {
    return roleInstructionText(key) || null;
  } catch {
    return null;
  }
}

/** Раздел «Исполнители» для Помощника владельца — из таблицы, включённые роли. */
export function rolesPromptBlock(): string {
  return registry
    .filter((r) => r.enabled)
    .map((r) => `- ${r.key} — ${r.summary}`)
    .join("\n");
}

refreshRoles();

export type RoleRouting = {
  defaults: Record<RoleName, string>;
  fallbacks: Record<RoleName, string[]>;
  models: Record<RoleName, string>;
};

/** Новый алиас типа. Содержит модель и провайдера, к которому она относится —
 *  используется в новой семантике nextModelForProfile() (см. ниже). */
export type ModelRoute = { model: string; provider: string };

/** 18.09.2026 (карточка be9cf712, фаза 2): ShellRoute удалён вместе с
 *  nextShellForRole. Семантика «следующая оболочка» больше не применима. */

/** С 06.10.2026 (MAK-72) shell-учётки удалены: Pi — единственный runtime,
 *  а прежние «оболочки» (личности старой схемы) были
 *  остатками снятой схемы и указывали на архивные/удалённые учётки. */

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
  // С 23.09.2026 состав ролей задаёт таблица roles, а не этот файл: новой
  // роли в файле может ещё не быть — ниже ей подставляются значения по
  // умолчанию; лишние ключи (отключённые роли) не мешают.
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

  // Модель по умолчанию для роли, которой ещё нет в файле, — самая частая
  // среди уже настроенных; поменять её можно на экране моделей.
  const counts = new Map<string, number>();
  for (const m of Object.values(models)) {
    if (typeof m === "string" && m.trim()) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const defaultModel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "MiniMax-M3";
  // Все роли из файла плюс ROLE_NAMES (БД): code_orchestrator может быть в
  // role-routing.yaml до того, как роль заведена в БД (миграция 056), и
  // при чтении конфига её fallbacks всё равно должны быть видны; обратное
  // тоже верно — 'writer' в БД, но не в yaml, должен получить fallbacks=[]
  // (как раньше при обходе только по ROLE_NAMES).
  const fileRoles = new Set<string>([
    ...Object.keys(defaults),
    ...Object.keys(rawFallbacks),
    ...Object.keys(models),
    ...ROLE_NAMES,
  ]);
  for (const role of fileRoles) {
    if (defaults[role] === undefined) defaults[role] = "pi_runtime";
    if (models[role] === undefined) models[role] = defaultModel;
    if (rawFallbacks[role] === undefined) rawFallbacks[role] = [];
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
 *  server/test/roles.test.ts и server/src/routes/roles.ts импортируют
 *  loadRoleRouting. Будет удалён, когда переведём их на новое имя. */
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

/** Записать RoleRouting обратно в YAML-файл. Атомарно: tmp + rename +
 *  lock-файл, как в PiRuntimeAdapter.writeAuthFile(). Шапка-комментарий
 *  из исходного файла теряется (yaml.stringify их не сохраняет) — это
 *  deviation от спека §G («без потери шапки-комментария»), но без
 *  зависимости от ruamel.yaml и без сложного round-trip через CST. При
 *  дальнейшем переезде routing в БД вопрос снимается. */
export function writeRuntimeConfig(
  config: RoleRouting,
  fileName = ROLE_ROUTING_FILE,
): void {
  const yamlText =
    "# Role routing для TaskFlow. Сгенерировано автоматически Pi\n" +
    "# runtime (карточка be9cf712, фаза 2). При правке руками — не\n" +
    "# забывайте порядок: defaults, fallbacks, models.\n" +
    stringify(config, { lineWidth: 0 });
  const lockPath = `${fileName}.lock`;
  const tmpPath = `${fileName}.tmp.${process.pid}.${Date.now()}`;

  for (let i = 0; i < 50; i++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(tmpPath, yamlText, { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmpPath, fileName);
        return;
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Кто-то уже держит lock — синхронный retry.
        const start = Date.now();
        while (Date.now() - start < 100) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`routing lock timeout: ${lockPath}`);
}

/** Следующая модель в лесенке для роли после исчерпания текущей.
 *  Семантика «следующая модель», а не «следующий shell» — Pi один,
 *  shell-имён больше нет (см. карточку f3108dcc). */
export function nextModelForProfile(
  config: RoleRouting,
  role: string,
  currentModel: string,
): ModelRoute | null {
  if (!ROLE_NAMES.includes(role)) return null;
  const typedRole = role;
  const chain = [config.models[typedRole], ...config.fallbacks[typedRole]];
  const idx = chain.indexOf(currentModel);
  for (const candidate of chain.slice(idx + 1)) {
    return { model: candidate, provider: providerOfModel(candidate) };
  }
  return null;
}

/** 18.09.2026 (карточка be9cf712, фаза 2): nextShellForRole удалён.
 *  Семантика «следующая оболочка» больше не применима — Pi единственный
 *  runtime. Используйте nextModelForProfile() для fallback по моделям
 *  внутри одной роли. Если код ссылается на nextShellForRole — это
 *  ошибка миграции, надо править. */
