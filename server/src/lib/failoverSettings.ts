// Общие переключатели автопереключения моделей (владелец 07.10.2026). Не заданы — оба включены,
// то есть поведение прежнее. Хранятся в runtime_settings (миграция 116).
import db from "../db.js";

export type FailoverSettings = { autoSwitch: boolean; autoReturn: boolean };

const KEYS = { autoSwitch: "failover_auto_switch", autoReturn: "failover_auto_return" } as const;

function read(key: string): boolean {
  const row = db.prepare("SELECT value FROM runtime_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value !== "0" : true;
}

export function getFailoverSettings(): FailoverSettings {
  return { autoSwitch: read(KEYS.autoSwitch), autoReturn: read(KEYS.autoReturn) };
}

export function setFailoverSettings(patch: Partial<FailoverSettings>): FailoverSettings {
  const put = db.prepare(
    `INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  );
  if (patch.autoSwitch !== undefined) put.run(KEYS.autoSwitch, patch.autoSwitch ? "1" : "0");
  if (patch.autoReturn !== undefined) put.run(KEYS.autoReturn, patch.autoReturn ? "1" : "0");
  return getFailoverSettings();
}
