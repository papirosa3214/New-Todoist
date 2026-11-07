// Дедупликация манифестов инструкций.
//
// КАК БЫЛО (24.10.2026, аудит): каждый ход роли писал в task_events
// событие instruction_snapshot, в котором лежал ПОЛНЫЙ манифест собранных
// инструкций (список блоков с sha256 каждого). Средний размер — 18 КБ,
// максимум 28 КБ. За месяц набежало 2 831 событие на 48 МБ — при том, что
// уникальных манифестов среди них всего 530: один и тот же набор блоков
// повторялся снова и снова.
//
// ЧТО НЕЛЬЗЯ: просто обрезать манифест. Тогда теряется главное свойство
// снимка — по нему видно, какая ВЕРСИЯ правил ушла в модель. Аудит
// «почему роль сделала то-то» без этого невозможен.
//
// ЧТО ДЕЛАЕМ: манифест кладём в отдельную таблицу один раз на уникальное
// содержимое (content-addressed, по sha256), а в событии оставляем ссылку
// плюс те два поля, которые реально читает выдача (mode, resumed).
// Событие сжимается с 18 КБ до ~120 байт, аудит сохранён полностью:
// манифест восстанавливается по ссылке.
//
// Ссылка в to_value лежит рядом с mode/resumed, поэтому потребитель
// briefInstructionSnapshot (routes/tasks.ts) продолжает работать без
// изменений: он читает только mode и resumed.
import crypto from "node:crypto";
import db from "../db.js";

/**
 * Кладёт манифест в справочник и возвращает ссылку на него.
 *
 * Один и тот же манифест (тот же набор блоков и версий) возвращает одну и
 * ту же ссылку — поэтому повторные ходы не плодят копии.
 */
export function storeInstructionManifest(manifest: unknown): string {
  const json = JSON.stringify(manifest);
  const sha = crypto.createHash("sha256").update(json).digest("hex");
  db.prepare(
    `INSERT INTO instruction_manifests (sha256, manifest, created_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(sha256) DO NOTHING`,
  ).run(sha, json);
  return sha;
}

/** Манифест по ссылке. null — если ссылка неизвестна (или её нет). */
export function loadInstructionManifest(sha: string | null | undefined): unknown {
  if (!sha) return null;
  const row = db
    .prepare("SELECT manifest FROM instruction_manifests WHERE sha256 = ?")
    .get(sha) as { manifest: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.manifest);
  } catch {
    return null;
  }
}

/**
 * Собирает значение события instruction_snapshot.
 *
 * В to_value кладём {mode, resumed, manifest_sha256}. Ключ manifest_sha256
 * (а не manifest) — чтобы форма события не изменился для потребителей,
 * которые уже разбирают to_value как JSON.
 */
export function instructionSnapshotValue(params: {
  mode: string;
  resumed: boolean;
  manifest: unknown;
}): string {
  const sha = storeInstructionManifest(params.manifest);
  return JSON.stringify({
    mode: params.mode,
    resumed: params.resumed,
    manifest_sha256: sha,
  });
}
