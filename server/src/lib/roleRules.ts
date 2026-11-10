// Единый реестр правил ролей (server/scripts/role-rules.json, канон с 06.11.2026).
// Читается с кешем по mtime: правка файла подхватывается без рестарта.
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "./serverSettings.js";

export type RuleChannel = "chat" | "card" | "voice";
export type RoleRule = {
  id: string;
  old_id?: string;
  text: string;
  kind: "rule" | "data" | "character" | "compose";
  category: string;
  roles: "all" | string[];
  where?: string;
  channels?: RuleChannel[];
  /** Выключить правило из сборки; по умолчанию включено. */
  enabled?: boolean;
  disabled_reason?: string;
  /** Для category «из кода»: условие применения, место в коде и данные, которые остаются в шаблоне. */
  condition?: string;
  /** kind=compose: порядок строк шаблона этого места кода (id строк, в том числе общих для нескольких шаблонов). */
  ids?: string[];
  site?: string;
  data_part?: string;
  sources?: Array<{ file: string; line: number; section: string }>;
};
export const ALL_CHANNELS: RuleChannel[] = ["chat", "card", "voice"];
/** Категории, которые идут в инструкцию. «Текст из кода*» код подставляет сам — не задваиваем. */
export const INCLUDED_CATEGORIES = ["общий шаблон v2", "общий шаблон", "личные инструкции", "характер", "новое 06.11.2026"];

export function rulesFile(): string {
  const explicit = process.env.TASKFLOW_ROLE_RULES;
  return explicit ? path.resolve(explicit) : path.resolve(process.cwd(), "scripts", "role-rules.json");
}

/** Консервативный вывод каналов из `where`: «везде» — все; явно названный один/два — они; сомнение — все три. */
export function deriveChannels(where: string | undefined): RuleChannel[] {
  const w = (where ?? "").toLowerCase();
  if (/везд|все роли/.test(w)) return [...ALL_CHANNELS];
  const out: RuleChannel[] = [];
  if (/текст|чат/.test(w)) out.push("chat");
  if (/карточ|слот|задач/.test(w)) out.push("card");
  if (/голос/.test(w)) out.push("voice");
  return out.length ? out : [...ALL_CHANNELS];
}

let cache: { file: string; mtimeMs: number; size: number; rules: RoleRule[] } | undefined;
export function loadRoleRules(): RoleRule[] {
  const file = rulesFile();
  const st = fs.statSync(file);
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.rules;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("role-rules.json: ожидался массив правил");
  const norm = (list: string[]) => list.map((c) => (c === "text" ? "chat" : c)) as RuleChannel[];
  const rules = (parsed as RoleRule[]).map((r) => ({ ...r, channels: r.channels?.length ? norm(r.channels) : deriveChannels(r.where) }));
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, rules };
  return rules;
}

const isPlaceholder = (r: RoleRule) => r.kind === "data" && /^\{\{[A-Z]+\}\}$/.test(r.text.trim());
const rank = (r: RoleRule) => Math.max(0, INCLUDED_CATEGORIES.indexOf(r.category.startsWith("данные") ? "общий шаблон" : r.category));

/** Правила роли в канале: только включённые категории; data — лишь строки-плейсхолдеры подстановки. */
export function rulesFor(role: string, channel: RuleChannel): RoleRule[] {
  const picked = loadRoleRules().filter((r) =>
    r.enabled !== false &&
    (INCLUDED_CATEGORIES.includes(r.category) || (isPlaceholder(r))) &&
    (r.kind !== "data" || isPlaceholder(r)) &&
    (r.roles === "all" || r.roles.includes(role)) &&
    (r.channels ?? ALL_CHANNELS).includes(channel));
  // Порядок источников сохраняется; категории идут блоками: шаблон, личные, характер, новое.
  return picked.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** Текст по разделам (sources[0].section), заголовки сохранены: «A > B > C» → #, ##, ###. */
export function renderRules(rules: RoleRule[], subst: Record<string, string> = {}): string {
  const out: string[] = [];
  let stack: string[] = [];
  let prevBullet = false;
  for (const rule of rules) {
    const section = rule.sources?.[0]?.section ?? "";
    const parts = /без раздела/.test(section) ? [] : section.split(" > ").map((s) => s.trim()).filter(Boolean);
    let common = 0;
    while (common < parts.length && common < stack.length && stack[common] === parts[common]) common++;
    if (parts.length && (common < parts.length || !stack.length)) {
      for (let d = common; d < parts.length; d++) out.push("#".repeat(Math.min(d + 1, 6)) + " " + parts[d], "");
      prevBullet = false;
    }
    if (parts.length) stack = parts; else if (!parts.length && stack.length) { stack = []; }
    const text = rule.text.trim();
    const bullet = text.startsWith("- ");
    if (out.length && out[out.length - 1] !== "" && !(bullet && prevBullet)) out.push("");
    out.push(text);
    prevBullet = bullet;
  }
  let result = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  for (const [key, value] of Object.entries(subst)) result = result.split("{{" + key + "}}").join(value);
  return result;
}

// ---- Правила из кода (category «из кода»): выборка по условию вместо литералов в коде ----
export function registryEnabled(): boolean {
  // Явное отключение окружением (процесс/тесты прежнего пути) главнее настройки.
  if (process.env.TASKFLOW_SETTING_ROLE_REGISTRY_ENABLED === "false") return false;
  try { return (getSetting("role_registry_enabled") as boolean) !== false; } catch { return true; }
}
export const CODE_CATEGORY = "из кода";
function codeRows(condition: string, site: string | undefined, role?: string): RoleRule[] {
  const all = loadRoleRules();
  const ok = (r: RoleRule) => r.category === CODE_CATEGORY && r.enabled !== false && (r.roles === "all" || !role || r.roles.includes(role));
  // Место кода со составом (общие блоки в нескольких шаблонах): строки берутся по списку id в порядке шаблона.
  const compose = site === undefined ? undefined : all.find((r) => r.kind === "compose" && r.site === site && r.condition === condition && ok(r));
  if (compose?.ids) {
    const byId = new Map(all.map((r) => [r.id, r]));
    return compose.ids.map((id) => byId.get(id)).filter((r): r is RoleRule => !!r && r.enabled !== false);
  }
  return all.filter((r) => ok(r) && r.kind !== "compose" && r.condition === condition && (site === undefined || r.site === site));
}
/** Текст шаблона по условию: строки правил в порядке файла; данные-подстановки ({history} и т. п.) остаются на месте. */
export function registryText(condition: string, role?: string, site?: string): string {
  return codeRows(condition, site, role)
    .map((r) => [r.text, r.data_part].filter((x) => x && x.length).join("\n"))
    .filter((x) => x.length)
    .join("\n");
}
/** Выборка из реестра. Второй копии в коде нет: пустой результат так и остаётся пустым. */
export function registryTextOr(condition: string, site: string | undefined, _fallback: string, role?: string): string {
  return registryText(condition, role, site);
}
/** Есть ли в реестре строки этого места кода (для привязки при импорте). */
export function hasRegistrySite(site: string): boolean {
  try { return loadRoleRules().some((r) => r.category === CODE_CATEGORY && r.site === site); } catch { return false; }
}
export function registryConditionOf(site: string): string | null {
  try { return loadRoleRules().find((r) => r.category === CODE_CATEGORY && r.site === site)?.condition ?? null; } catch { return null; }
}
