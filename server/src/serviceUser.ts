/**
 * Служебная учётка трекера — её действует планировщик и прочая серверная
 * автоматика, которой открыты служебные ручки (repick-role, служебные поля
 * блокировки). Исторически это «Pi Agent»: он держал служебную дверь снаружи
 * ключом. С 01.10.2026 планировщик живёт внутри сервера и ходит этой учёткой
 * по внутреннему пропуску, без внешнего ключа.
 */
export const SERVICE_USER_IDS = new Set<string>([
  "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2", // Pi Agent
]);

export const SCHEDULER_USER_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2";

export function isServiceUser(userId: string): boolean {
  return SERVICE_USER_IDS.has(userId);
}
