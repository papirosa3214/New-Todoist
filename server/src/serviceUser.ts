/**
 * Служебная учётка трекера — от её имени действует планировщик и прочая
 * серверная автоматика, которой открыты служебные ручки (repick-role,
 * служебные поля блокировки). Это «Система» (`taskflow_system`) — та же
 * учётка, которой подписаны системные сообщения чатов. Исторически служба
 * ходила прежняя служебная учётка снаружи ключом; 06.10.2026 (MAK-72) она
 * удалена, планировщик ходит внутренним пропуском под «Системой».
 */
export const SERVICE_USER_IDS = new Set<string>([
  "taskflow_system", // Система
]);

export const SCHEDULER_USER_ID = "taskflow_system";

export function isServiceUser(userId: string): boolean {
  return SERVICE_USER_IDS.has(userId);
}
