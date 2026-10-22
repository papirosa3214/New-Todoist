// Метки в шаблоне рутины: имена → идентификаторы.
//
// Контракт рутин (заметка «Рутины и расписание TaskFlow», раздел «Модель
// данных»): в шаблоне задачи метки задаются ИМЕНАМИ («Отчёт», «Срочно»),
// а ручка POST /api/tasks принимает только идентификаторы меток. Без
// перевода рутина падала с ошибкой «карточка не создана».
//
// Перевод делается один раз — при создании рутины (чтобы несуществующая
// метка была видна сразу, а не в момент запуска) и повторно на тике (метку
// могли удалить между созданием рутины и запуском).

import db from "../../db.js";

export interface LabelResolution {
  /** Идентификаторы меток для POST /api/tasks. */
  ids: string[];
  /** Что не нашлось: метку удалили или опечатка в имени. */
  unknown: string[];
}

interface LabelRow {
  id: string;
  name: string;
  owner_id: string | null;
}

function findById(id: string): LabelRow | undefined {
  return db.prepare("SELECT id, name, owner_id FROM labels WHERE id = ?").get(id) as
    | LabelRow
    | undefined;
}

/**
 * Метки по имени среди меток владельца рутины и меток владельца трекера.
 * Имя сравнивается без учёта регистра — «отчёт» и «Отчёт» это одна метка.
 */
function findByName(name: string, ownerId: string): LabelRow | undefined {
  const own = db
    .prepare(
      "SELECT id, name, owner_id FROM labels WHERE owner_id = ? AND lower(name) = lower(?) ORDER BY name LIMIT 1",
    )
    .get(ownerId, name) as LabelRow | undefined;
  if (own) return own;
  return db
    .prepare(
      `SELECT l.id, l.name, l.owner_id FROM labels l
         JOIN users u ON u.id = l.owner_id
        WHERE u.role = 'owner' AND lower(l.name) = lower(?)
        ORDER BY l.name LIMIT 1`,
    )
    .get(name) as LabelRow | undefined;
}

/**
 * Перевести список меток (имена или идентификаторы) в идентификаторы.
 *
 * Значение, которое уже похоже на идентификатор метки, берём как есть;
 * остальное ищем по имени. Что не нашлось — возвращаем отдельно, чтобы
 * вызывающий код мог сказать об этом честно.
 */
export function resolveLabelIds(
  labels: string[] | null | undefined,
  ownerId: string,
): LabelResolution {
  const ids: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels ?? []) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const byId = findById(value);
    const row = byId ?? findByName(value, ownerId);
    if (!row) {
      if (!unknown.includes(value)) unknown.push(value);
      continue;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    ids.push(row.id);
  }
  return { ids, unknown };
}
