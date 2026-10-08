// Реестр серверных параметров — шина чтения/записи (MAK-95).
// Контракт: docs/2026-10-08-server-settings-registry.md.
//
// Архитектура:
//   getSetting(key)            — мгновенное чтение из кэша (или дефолт).
//   setSetting(key, value, …)  — запись в БД + обновление кэша +
//                                рассылка события подписчикам.
//   onChange(key, callback)    — реакция на изменение (например, чтобы
//                                пересоздать `setInterval`).
//   resetSetting(key, …)       — удаление строки из БД → возврат к
//                                дефолту; подписчики тоже получают сигнал.
//
// Подписчики получают уведомление и в случае setSetting(), и в случае
// resetSetting() (значение становится дефолтом). Это удобно: код
// «как сменился stall_after_min — перечитать» работает одинаково в обе
// стороны.
//
// Подписки хранятся по ключу в `subscribers: Map<string, Set<fn>>`. Для
// подписки на «что угодно» — ключ `null`; сейчас такой подписки в
// проекте нет, но точка расширения пригодится для логов/UI.
//
// Атомарность записи: write+log+cache в одной транзакции SQLite. Если
// транзакция не дошла до commit (например, БД залочена), кэш НЕ
// обновляется и событие НЕ публикуется — следующий читатель увидит
// прежнее значение. Так владелец не получит «новое значение в карточке,
// но реально ещё старое».
import { EventEmitter } from "node:events";
import db from "../db.js";
import {
  DEFAULTS,
  DEV_OVERRIDES,
  type DefaultsKey,
  type SettingOf,
  getServerSetting,
} from "./serverSettingsRegistry.js";

/** Подписчик конкретного ключа: получает новое (effective) значение
 *  после записи или сброса. Для bool/enum значение уже приведено к
 *  каноническому типу (а не сырая строка из БД). */
export type SettingListener<K extends DefaultsKey = DefaultsKey> = (
  value: SettingOf<K>,
) => void;

/** Общая шина. Использует `node:events.EventEmitter`, чтобы не зависеть
 *  от Fastify/веба и работать в in-memory сценариях и тестах. */
const bus = new EventEmitter();
// Подписчиков обычно 1–3 на ключ; default 10 хватит, расширим при росте.
bus.setMaxListeners(50);

/** Кэш: ключ → текущее effective-значение. Заполняется при первой
 *  загрузке модуля и обновляется на каждом setSetting/resetSetting.
 *  Тип значения — `unknown`, потому что ключи гетерогенные, а при чтении
 *  через `getSetting()` тип всё равно сужается по `key`. */
const cache = new Map<string, unknown>();

/** Карта активных подписок. `null` — wildcard («что угодно»). */
const subscribers = new Map<string | null, Set<(...args: unknown[]) => void>>();

/** Загружает строки из БД в кэш. Вызывается на старте сервера после
 *  миграций и при горячей перезагрузке (для тестов). Отсутствующие
 *  ключи остаются `undefined` → читаются из DEFAULTS/DEV_OVERRIDES.
 *
 *  Особый случай: модуль импортируется из `routes/activity.ts`,
 *  `runtime/stalledStepWatcher.ts`, `runtime/providerProbe.ts`,
 *  `runtime/inProcessRun.ts` — и эти импорты поднимаются до прогона
 *  миграций (buildApp() их уже отработал, но в vitest с `tsx` БД
 *  открывается раньше, чем runMigrations() успевает отработать). На
 *  таком старте таблицы `server_settings` ещё нет — глотаем исключение
 *  и работаем по дефолтам. Следующий reload (после миграций в
 *  buildApp или явный вызов из теста) подхватит таблицу. */
export function loadServerSettingsFromDb(): void {
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = db
      .prepare("SELECT key, value FROM server_settings")
      .all() as Array<{ key: string; value: string }>;
  } catch (error) {
    // Таблицы ещё нет — миграции не отработали. Кэш остаётся пустым,
    // getSetting() вернёт дефолт. Это безопасное состояние для cold start.
    cache.clear();
    return;
  }
  // Сначала очищаем кэш — иначе удалённая через resetSetting строка
  // продолжит отдавать прежнее значение до перезапуска процесса.
  cache.clear();
  for (const { key, value } of rows) {
    const meta = getServerSetting(key);
    if (!meta) {
      // Неизвестный ключ (например, после удаления из реестра) — не
      // загружаем в кэш: getSetting() упадёт на default через код
      // валидации в setSetting(), но безопаснее здесь молча пропустить.
      continue;
    }
    const parsed = deserializeValue(value, meta);
    cache.set(key, parsed);
  }
  // Одноразовая миграция значений из users.task_intake_mode /
  // users.reviewer_first_default, если они там остались после правки
  // SettingsScreen. Делается атомарно и только при пустой registry-строке:
  // если владелец уже успел что-то записать в реестр — users уважаем как
  // «предыдущее значение», но не трогаем (важно для аудита).
  migrateUserDefaultsToRegistry();
}

/** Применяет dev-overrides к кэшу для ключей, которых нет в БД. Это
 *  позволяет менять дефолт через `TASKFLOW_SETTING_X=…` без правки
 *  кода и без записи в БД. */
function applyDevOverrides(): void {
  for (const k of Object.keys(DEV_OVERRIDES) as DefaultsKey[]) {
    if (!cache.has(k)) cache.set(k, DEV_OVERRIDES[k]);
  }
}

/** Инициализация: загрузить из БД и применить overrides. Делается
 *  один раз при импорте модуля. Тесты могут перезапустить через
 *  `reloadServerSettings()`. */
let initialized = false;
export function reloadServerSettings(): void {
  loadServerSettingsFromDb();
  applyDevOverrides();
  initialized = true;
  for (const [key, value] of cache) bus.emit(key, value);
}
reloadServerSettings();

/** Чтение параметра. Если ключ неизвестен реестру — бросаем: это
 *  сигнал опечатки в коде, который дешевле поймать здесь, чем
 *  разбираться в тихом «почему вернулось undefined». */
export function getSetting<K extends DefaultsKey>(key: K): SettingOf<K> {
  if (!initialized) reloadServerSettings();
  if (cache.has(key)) {
    return cache.get(key) as SettingOf<K>;
  }
  const meta = getServerSetting(key);
  if (!meta) {
    throw new Error(`getSetting: неизвестный ключ "${key}"`);
  }
  return DEV_OVERRIDES[key] as SettingOf<K>;
}

/** Подписка на конкретный ключ. Возвращает функцию отписки. */
export function onChange<K extends DefaultsKey>(
  key: K,
  listener: SettingListener<K>,
): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  const wrapped = (v: unknown) => listener(v as SettingOf<K>);
  set.add(wrapped);
  bus.on(key, wrapped);
  return () => {
    bus.off(key, wrapped);
    set!.delete(wrapped);
    if (set!.size === 0) subscribers.delete(key);
  };
}

/** Записать значение в БД и обновить кэш + шину. Валидация —
 *  по метаданным реестра (`min/max/options`). Если значение не прошло —
 *  бросаем, ничего не записывая. */
export function setSetting<K extends DefaultsKey>(
  key: K,
  value: SettingOf<K>,
  actorId: string | null,
  reason?: string,
): void {
  const meta = getServerSetting(key);
  if (!meta) throw new Error(`setSetting: неизвестный ключ "${key}"`);
  const validated = validateValue(key, value);
  if (!validated.ok) {
    throw new Error(`setSetting("${key}"): ${validated.error}`);
  }
  const serialized = JSON.stringify(value);
  const validActor = resolveActor(actorId);
  const txn = db.transaction(() => {
    const prev = db
      .prepare("SELECT value FROM server_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (prev) {
      db.prepare(
        "UPDATE server_settings SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?",
      ).run(serialized, validActor, key);
    } else {
      db.prepare(
        "INSERT INTO server_settings(key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)",
      ).run(key, serialized, validActor);
    }
    db.prepare(
      "INSERT INTO server_settings_log(key, old_value, new_value, reason, actor_id) VALUES (?, ?, ?, ?, ?)",
    ).run(key, prev?.value ?? null, serialized, reason ?? null, validActor);
    syncLegacyOwnerSetting(key, value);
  });
  txn();
  cache.set(key, value);
  bus.emit(key, value);
}

/** Сбросить к дефолту: удалить строку из БД, почистить кэш,
 *  разослать событие с дефолтным значением. Журнал получает запись
 *  «new_value = default» для истории. */
export function resetSetting<K extends DefaultsKey>(
  key: K,
  actorId: string | null,
  reason?: string,
): void {
  const meta = getServerSetting(key);
  if (!meta) throw new Error(`resetSetting: неизвестный ключ "${key}"`);
  const defaultValue = DEV_OVERRIDES[key];
  const serialized = JSON.stringify(defaultValue);
  const validActor = resolveActor(actorId);
  const txn = db.transaction(() => {
    const prev = db
      .prepare("SELECT value FROM server_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    db.prepare("DELETE FROM server_settings WHERE key = ?").run(key);
    db.prepare(
      "INSERT INTO server_settings_log(key, old_value, new_value, reason, actor_id) VALUES (?, ?, ?, ?, ?)",
    ).run(key, prev?.value ?? null, serialized, reason ?? "сброс к дефолту", validActor);
    syncLegacyOwnerSetting(key, defaultValue);
  });
  txn();
  // Если для ключа есть dev-override — он же остаётся; иначе кэш
  // вычищается, и следующий getSetting() вернёт хардкод.
  cache.delete(key);
  bus.emit(key, defaultValue);
}

/** `server_settings_log.actor_id` ссылается на `users.id` через FOREIGN KEY.
 *  Если caller передал строку, которой нет в users (тикер, тест, сервисная
 *  ручка), FK уронит INSERT. Возвращаем либо сам id (если строка есть), либо
 *  null (для неизвестных/тестовых). Это не подмена прав — owner-проверка
 *  делается в роуте, а здесь только защита БД. */
function resolveActor(actorId: string | null): string | null {
  if (!actorId) return null;
  try {
    const row = db.prepare("SELECT 1 AS x FROM users WHERE id = ?").get(actorId) as { x: number } | undefined;
    return row ? actorId : null;
  } catch {
    return null;
  }
}

/** Чтение журнала (для админ-эндпоинта «история изменений»). */
export function getServerSettingsLog(
  limit = 50,
): Array<{
  id: number;
  key: string;
  old_value: string | null;
  new_value: string;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
}> {
  const rows = db
    .prepare(
      "SELECT id, key, old_value, new_value, reason, actor_id, created_at FROM server_settings_log ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as Array<{
    id: number;
    key: string;
    old_value: string | null;
    new_value: string;
    reason: string | null;
    actor_id: string | null;
    created_at: string;
  }>;
  return rows;
}

/** Все текущие effective-значения для UI. */
export function snapshotSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS) as DefaultsKey[]) {
    out[k] = getSetting(k);
  }
  return out;
}

/** Одноразовая миграция: значения режима приёма и рецензента, которые
 *  исторически лежали в `users.task_intake_mode` /
 *  `users.reviewer_first_default`, переезжают в реестр. Делается только
 *  если соответствующего ключа ещё нет в `server_settings` — если
 *  владелец уже успел там что-то записать, считаем registry авторитетным. */
function migrateUserDefaultsToRegistry(): void {
  let owner: { id: string } | undefined;
  let userRow:
    | { task_intake_mode: string | null; reviewer_first_default: number | null }
    | undefined;
  try {
    owner = db
      .prepare(
        "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (!owner) return;
    userRow = db
      .prepare(
        "SELECT task_intake_mode, reviewer_first_default FROM users WHERE id = ?",
      )
      .get(owner.id) as
      | { task_intake_mode: string | null; reviewer_first_default: number | null }
      | undefined;
  } catch (error) {
    // БД ещё не готова (cold start до миграций) — пропускаем миграцию,
    // следующий вызов после миграций подхватит.
    return;
  }
  if (!userRow) return;
  const txn = db.transaction(() => {
    for (const [key, table] of [["linear_sync_enabled", "linear_sync_state"], ["linear_autoimport_enabled", "linear_autoimport_state"]]) {
      if (cache.has(key)) continue;
      const state = db.prepare(`SELECT enabled FROM ${table} WHERE owner_id=?`).get(owner.id) as {enabled:number} | undefined;
      if (state) {
        db.prepare("INSERT OR IGNORE INTO server_settings(key,value,updated_by) VALUES(?,?,?)").run(key,JSON.stringify(state.enabled === 1),owner.id);
        cache.set(key,state.enabled === 1);
      }
    }
    if (!cache.has("task_intake_mode") && userRow.task_intake_mode) {
      db.prepare(
        "INSERT OR IGNORE INTO server_settings(key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)",
      ).run("task_intake_mode", JSON.stringify(userRow.task_intake_mode), owner.id);
      cache.set("task_intake_mode", userRow.task_intake_mode);
    }
    if (!cache.has("reviewer_first_default")) {
      const reviewer = userRow.reviewer_first_default == null
        ? true
        : userRow.reviewer_first_default === 1;
      db.prepare(
        "INSERT OR IGNORE INTO server_settings(key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)",
      ).run("reviewer_first_default", JSON.stringify(reviewer), owner.id);
      cache.set("reviewer_first_default", reviewer);
    }
  });
  txn();
}

// ─────────────────────────── helpers ───────────────────────────

function deserializeValue(
  raw: string,
  meta: { kind: string; default: number | boolean | string },
): unknown {
  // Старое поведение: в БД лежит JSON-строка. Для backward-compatibility
  // принимаем и «голое» число/булеву (если кто-то записал миграцией).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  switch (meta.kind) {
    case "bool":
      return parsed === true || parsed === "true" || parsed === 1 || parsed === "1";
    case "int":
    case "duration_min":
    case "duration_sec":
    case "duration_ms":
    case "interval_ms": {
      const n = typeof parsed === "number" ? parsed : Number(parsed);
      return Number.isFinite(n) ? n : meta.default;
    }
    case "enum":
      return typeof parsed === "string" ? parsed : String(parsed);
    default:
      return parsed;
  }
}

function validateValue(
  key: string,
  value: unknown,
):
  | { ok: true }
  | { ok: false; error: string } {
  const meta = getServerSetting(key);
  if (!meta) return { ok: false, error: "неизвестный ключ" };
  switch (meta.kind) {
    case "bool": {
      if (typeof value !== "boolean") return { ok: false, error: "ожидается boolean" };
      return { ok: true };
    }
    case "int":
    case "duration_min":
    case "duration_sec":
    case "duration_ms":
    case "interval_ms": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: "ожидается число" };
      }
      if (meta.kind === "int" && !Number.isInteger(value)) return { ok: false, error: "ожидается целое число" };
      if (meta.min !== undefined && value < meta.min) {
        return { ok: false, error: `меньше минимума ${meta.min}` };
      }
      if (meta.max !== undefined && value > meta.max) {
        return { ok: false, error: `больше максимума ${meta.max}` };
      }
      return { ok: true };
    }
    case "enum": {
      if (typeof value !== "string") return { ok: false, error: "ожидается строка" };
      if (meta.options && !meta.options.includes(value)) {
        return { ok: false, error: `допустимо: ${meta.options.join(", ")}` };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `неизвестный kind ${meta.kind}` };
  }
}
function syncLegacyOwnerSetting(key: string, value: unknown): void {
  if (key === "linear_sync_enabled") db.prepare("UPDATE linear_sync_state SET enabled=?").run(value ? 1 : 0);
  if (key === "linear_autoimport_enabled") db.prepare("UPDATE linear_autoimport_state SET enabled=?").run(value ? 1 : 0);
  if (key === "task_intake_mode") db.prepare("UPDATE users SET task_intake_mode=? WHERE role='owner'").run(value);
  if (key === "reviewer_first_default") db.prepare("UPDATE users SET reviewer_first_default=? WHERE role='owner'").run(value ? 1 : 0);
}
