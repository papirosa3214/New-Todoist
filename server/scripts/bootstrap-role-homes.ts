/** Запускать из server/: npx tsx scripts/bootstrap-role-homes.ts --all [--dry-run] [--refresh-system]
 *  --refresh-system перезаписывает SYSTEM.md роли новой редакцией канона
 *  (scripts/role-system-prompt.md); без флага существующий файл не трогается.
 *
 *  КАНОН: scripts/role-system-prompt.md — базовая системная инструкция, общая
 *  для всех ролей. Раскладывается в папку роли как SYSTEM.md и становится
 *  основанием запуска: пока файла нет, базу подставляет Pi SDK, и роль
 *  получает чужой текст вместо своего. Подстановка {{IDENTITY}} и {{FOLDER}}
 *  делается в ensureRoleHome, поэтому в самом файле не должно быть ничего,
 *  кроме текста, который увидит модель, — служебные пояснения здесь неуместны.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureRoleHome, importRoleResources, roleHome } from "../src/runtime/roleHome.js";

const args = process.argv.slice(2);
const roles: string[] = [];
const legacyDirs: string[] = [];
let dryRun = false;
let all = false;
let refreshSystem = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--refresh-system") refreshSystem = true;
  else if (arg === "--all") all = true;
  else if ((arg === "--role" || arg === "--legacy-agent-dir") && args[i + 1] && !args[i + 1].startsWith("--")) {
    const value = args[++i];
    if (arg === "--role") roles.push(value);
    else legacyDirs.push(path.resolve(value));
  } else throw new Error(`Неизвестный или неполный аргумент: ${arg}`);
}
if (all) {
  // Только чтение: bootstrap не запускает миграции и не меняет БД.
  const database = new Database(process.env.DB_PATH || path.resolve("taskflow.db"), { readonly: true, fileMustExist: true });
  try {
    roles.push(...(database.prepare("SELECT key FROM roles ORDER BY position, key").all() as Array<{ key: string }>).map(r => r.key));
  } finally { database.close(); }
}
if (!roles.length) throw new Error("Укажите --all или --role <ключ> (можно несколько ролей).");
for (const role of roles) roleHome(role); // Все ключи проверяются до первой записи.
for (const dir of legacyDirs) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Исходная папка отсутствует: ${dir}`);
}
for (const role of [...new Set(roles)]) {
  const home = dryRun ? roleHome(role) : ensureRoleHome(role, { refreshSystem });
  const files = legacyDirs.flatMap(dir => importRoleResources(role, dir, dryRun));
  process.stdout.write(JSON.stringify({ role, home: home.dir, workspace: home.workspace, dryRun, refreshSystem, importedFiles: files }) + "\n");
}
