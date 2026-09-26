import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

import db from "./db.js";

/**
 * Роли — ДАННЫЕ, а не код (владелец 23.09.2026: «почему всё так зашито,
 * неужели так сложно добавить или удалить агента»). Источник правды —
 * таблица `roles` (миграция 056): ключ, название, «чем занимается» (строка
 * для Секретаря), включена ли, порядок.
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
};

/** Начальный состав — до миграции 056 (свежая база в тестах) и для её посева. */
export const DEFAULT_ROLES: ReadonlyArray<{ key: string; title: string; summary: string }> = [
  { key: "researcher", title: "Исследователь", summary: "узнать, найти, сравнить варианты вне нашего кода и свести найденное в выводы или документ." },
  { key: "analyst", title: "Аналитик", summary: "посчитать цифры, метрики, деньги." },
  { key: "critic_verifier", title: "Критик-проверяющий", summary: "проверить готовую работу и вынести вердикт." },
  { key: "architect", title: "Архитектор", summary: "продумать устройство системы до кода, когда решений несколько." },
  { key: "builder", title: "Разработчик", summary: "пишет и чинит код: сервер, приложение, веб. «Сделать, чтобы работало»." },
  { key: "qa", title: "QA", summary: "прогнать сценарии и найти баги." },
  { key: "designer", title: "Дизайнер", summary: "как выглядит: макет, экран, отступы, цвета. Не пишет серверную логику." }
];

export const ROLE_NAMES: string[] = DEFAULT_ROLES.map((r) => r.key);
let registry: RoleRecord[] = DEFAULT_ROLES.map((r, i) => ({ ...r, enabled: true, position: i }));

/** Перечитать роли из таблицы. Таблицы ещё нет — остаётся начальный состав. */
export function refreshRoles(): void {
  try {
    const rows = db
      .prepare("SELECT key, title, summary, enabled, position FROM roles ORDER BY position, key")
      .all() as Array<{ key: string; title: string; summary: string; enabled: number; position: number }>;
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
  // Секретарь — фиксированная учётка u-secretary (заведена до системы
  // ролей, на неё уже ссылаются chat_messages и iOS-константа
  // ChatBubble.secretaryID); переименовывать в role_secretary — ломать
  // историю сообщений и клиент. Единственное исключение из паттерна.
  if (key === "secretary") return "u-secretary";
  return `role_${key}`;
}

const ROLE_PROMPTS_DIR = path.resolve(
  process.env.TASKFLOW_ROLE_PROMPTS_DIR ??
    path.join(process.cwd(), "scripts", "role-prompts"),
);

/** Инструкция роли: колонка roles.prompt, а пустая — прежний файл
 *  scripts/role-prompts/<ключ>.md. Нет ни того, ни другого — null. */
export function rolePromptText(key: string): string | null {
  try {
    const row = db.prepare("SELECT prompt FROM roles WHERE key = ?").get(key) as
      { prompt: string | null } | undefined;
    if (row?.prompt?.trim()) return row.prompt;
  } catch {
    // колонки ещё нет — до миграции 057
  }
  try {
    return fs.readFileSync(path.join(ROLE_PROMPTS_DIR, `${key}.md`), "utf8");
  } catch {
    return null;
  }
}

/** Раздел «Исполнители» для Секретаря — из таблицы, включённые роли. */
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
  for (const role of ROLE_NAMES) {
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
