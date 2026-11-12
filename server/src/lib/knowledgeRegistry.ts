// Реестр датасетов базы знаний (09.11.2026, «сшить RAGFlow с TaskFlow»).
//
// RAGFlow — источник правды о том, какие датасеты существуют и сколько в них
// документов. Здесь лежит только то, чего в RAGFlow нет и быть не может:
// включён ли датасет в TaskFlow, в каком он разделе-тематике, как он назван в
// приложении и каким ролям выдан доступ. Без реестра поиск звал бы все
// датасеты сразу, и роли засоряли бы выдачу чужими темами, о которых их никто
// не спрашивал.
import db from "../db.js";

/**
 * Датасет памяти агентов — его наполняет синк Mnemosyne, а не TaskFlow.
 * В базе знаний приложения он лишний, поэтому заведён выключенным.
 */
export const MEMORY_DATASET_ID = "aad90ec0901f11f1be69a9ef96f0a9d6";

export interface RegistryRow {
  dataset_id: string;
  enabled: 0 | 1;
  section_id: number | null;
  title: string | null;
}

export interface SectionRow {
  id: number;
  title: string;
  position: number;
}

export interface SectionWithCount extends SectionRow {
  dataset_count: number;
}

/**
 * Заводит строки для датасетов, которые появились в RAGFlow после прошлого
 * чтения. Существующие строки не трогаются: включённость и раздел — решение
 * владельца, а не вывод из чужого списка.
 */
export function ensureDatasetRows(ids: string[]): void {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO knowledge_datasets (dataset_id, enabled) VALUES (?, ?)",
  );
  const txn = db.transaction((list: string[]) => {
    for (const id of list) {
      if (!id) continue;
      ins.run(id, id === MEMORY_DATASET_ID ? 0 : 1);
    }
  });
  txn(ids);
}

export function datasetRegistryRow(datasetId: string): RegistryRow | undefined {
  return db
    .prepare(
      "SELECT dataset_id, enabled, section_id, title FROM knowledge_datasets WHERE dataset_id = ?",
    )
    .get(datasetId) as RegistryRow | undefined;
}

/** Включённые датасеты — то, что видно в приложении и участвует в поиске. */
export function enabledDatasetIds(): string[] {
  return (
    db
      .prepare("SELECT dataset_id FROM knowledge_datasets WHERE enabled = 1 ORDER BY dataset_id")
      .all() as Array<{ dataset_id: string }>
  ).map((r) => r.dataset_id);
}

export function listSections(): SectionWithCount[] {
  return db
    .prepare(
      `SELECT s.id, s.title, s.position,
              (SELECT COUNT(*) FROM knowledge_datasets d
                WHERE d.section_id = s.id AND d.enabled = 1) AS dataset_count
         FROM knowledge_dataset_sections s
        ORDER BY s.position, s.id`,
    )
    .all() as SectionWithCount[];
}

export function createSection(title: string): SectionRow {
  const name = title.trim();
  if (!name) throw new Error("Раздел без названия");
  const next = (
    db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM knowledge_dataset_sections")
      .get() as { p: number }
  ).p;
  const info = db
    .prepare("INSERT INTO knowledge_dataset_sections (title, position) VALUES (?, ?)")
    .run(name, next);
  return { id: Number(info.lastInsertRowid), title: name, position: next };
}

/** Переименование и перестановка. Пустой патч — не ошибка, ничего не меняется. */
export function updateSection(
  id: number,
  patch: { title?: string; position?: number },
): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.title === "string") {
    const name = patch.title.trim();
    if (!name) throw new Error("Раздел без названия");
    sets.push("title = ?");
    args.push(name);
  }
  if (typeof patch.position === "number") {
    sets.push("position = ?");
    args.push(Math.trunc(patch.position));
  }
  if (typeof patch.position === "number") {
    // Перестановка — не голое число в строку: иначе два раздела поделят одну
    // позицию и порядок начнёт зависеть от id. Двигаем список целиком.
    const txn = db.transaction((sectionId: number, index: number) => {
      if (typeof patch.title === "string") {
        db.prepare("UPDATE knowledge_dataset_sections SET title = ? WHERE id = ?").run(
          patch.title.trim(),
          sectionId,
        );
      }
      const order = (
        db
          .prepare("SELECT id FROM knowledge_dataset_sections ORDER BY position, id")
          .all() as Array<{ id: number }>
      ).map((r) => r.id);
      const rest = order.filter((x) => x !== sectionId);
      if (!order.includes(sectionId)) return false;
      rest.splice(Math.max(0, Math.min(index, rest.length)), 0, sectionId);
      const upd = db.prepare("UPDATE knowledge_dataset_sections SET position = ? WHERE id = ?");
      rest.forEach((sid, i) => upd.run(i, sid));
      return true;
    });
    return txn(id, Math.trunc(patch.position));
  }
  if (!sets.length) return Boolean(db.prepare("SELECT 1 FROM knowledge_dataset_sections WHERE id = ?").get(id));
  args.push(id);
  return db
    .prepare(`UPDATE knowledge_dataset_sections SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args).changes > 0;
}

/**
 * Раздел удаляется, датасеты остаются — просто без раздела. Удалять вместе с
 * разделом сами датасеты было бы удалением чужих данных: в RAGFlow они живут
 * своей жизнью.
 */
export function deleteSection(id: number): boolean {
  const txn = db.transaction((sectionId: number) => {
    db.prepare("UPDATE knowledge_datasets SET section_id = NULL WHERE section_id = ?").run(sectionId);
    return db.prepare("DELETE FROM knowledge_dataset_sections WHERE id = ?").run(sectionId).changes > 0;
  });
  return txn(id);
}

export function patchDataset(
  datasetId: string,
  patch: { enabled?: boolean; section_id?: number | null; title?: string | null },
): void {
  const row = datasetRegistryRow(datasetId);
  if (!row) throw new Error(`Датасет ${datasetId} не в реестре`);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.enabled === "boolean") {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  if (patch.section_id !== undefined) {
    if (patch.section_id !== null) {
      const exists = db
        .prepare("SELECT 1 FROM knowledge_dataset_sections WHERE id = ?")
        .get(patch.section_id);
      if (!exists) throw new Error(`Раздел ${patch.section_id} не найден`);
    }
    sets.push("section_id = ?");
    args.push(patch.section_id);
  }
  if (patch.title !== undefined) {
    const name = patch.title === null ? null : patch.title.trim() || null;
    sets.push("title = ?");
    args.push(name);
  }
  if (!sets.length) return;
  args.push(datasetId);
  db.prepare(`UPDATE knowledge_datasets SET ${sets.join(", ")} WHERE dataset_id = ?`).run(...args);
}

/** Доступ ролям заменяется целым набором: разделять «добавить» и «убрать» незачем. */
export function setDatasetRoles(datasetId: string, roleKeys: string[]): void {
  const known = new Set(
    (db.prepare("SELECT key FROM roles").all() as Array<{ key: string }>).map((r) => r.key),
  );
  const keys = [...new Set(roleKeys.map((k) => k.trim()).filter((k) => known.has(k)))];
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM knowledge_dataset_roles WHERE dataset_id = ?").run(datasetId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO knowledge_dataset_roles (dataset_id, role_key) VALUES (?, ?)",
    );
    for (const key of keys) ins.run(datasetId, key);
  });
  txn();
}

export function datasetRoles(datasetId: string): Array<{ key: string; title: string }> {
  return db
    .prepare(
      `SELECT r.key, r.title
         FROM knowledge_dataset_roles g
         JOIN roles r ON r.key = g.role_key
        WHERE g.dataset_id = ?
        ORDER BY r.position, r.key`,
    )
    .all(datasetId) as Array<{ key: string; title: string }>;
}

/** Что роли разрешено искать: выданное ей И включённое в TaskFlow. */
export function roleDatasetIds(roleKey: string): string[] {
  if (!roleKey) return [];
  return (
    db
      .prepare(
        `SELECT g.dataset_id
           FROM knowledge_dataset_roles g
           JOIN knowledge_datasets d ON d.dataset_id = g.dataset_id
          WHERE g.role_key = ? AND d.enabled = 1
          ORDER BY g.dataset_id`,
      )
      .all(roleKey) as Array<{ dataset_id: string }>
  ).map((r) => r.dataset_id);
}

export type SearchCaller = {
  type?: string | null;
  role?: string | null;
  role_key?: string | null;
};

/**
 * Область поиска (09.11.2026): по каким датасетам вызывающему можно искать.
 *
 * Правила владельца: исключённый датасет не ищется никому, даже по прямому
 * указанию в запросе; роль ищет только по выданным ей. Пустой список — это
 * не «искать везде», а отказ: иначе роль без доступов подмешивала бы в ответ
 * весь индекс TaskFlow.
 */
export function searchDatasetIds(
  caller: SearchCaller | undefined,
  requested: string[] = [],
): { ids: string[]; reason: "no-scope" | "unavailable" | null } {
  const enabled = new Set(enabledDatasetIds());
  const roleKey =
    caller?.type === "ai" && caller.role !== "owner" && caller.role_key && caller.role_key !== "secretary"
      ? caller.role_key
      : null;
  const allowed = roleKey ? new Set(roleDatasetIds(roleKey)) : enabled;
  const scoped = (id: string) => allowed.has(id) && enabled.has(id);
  const ids = requested.length ? requested.filter(scoped) : [...allowed].filter(scoped);
  if (ids.length) return { ids, reason: null };
  // Роли не хватило прав; владельцу просто нечего искать — разные ответы
  // нужны и клиенту: «нет доступов» и «датасет исключён» это разные беды.
  return { ids: [], reason: roleKey ? "no-scope" : "unavailable" };
}
