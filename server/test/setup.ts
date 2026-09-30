// Выполняется ПОЛНОСТЬЮ раньше файла теста (vitest.config.ts, setupFiles) —
// единственный надёжный момент выставить DB_PATH/JWT_SECRET до того, как
// db.ts (модульный синглтон: `new Database(DB_PATH)` на верхнем уровне при
// импорте) откроет хоть что-то. Без этого тесты открыли бы боевую
// server/taskflow.db.
import { afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const dbPath = path.join(
  os.tmpdir(),
  `taskflow-test-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);
process.env.DB_PATH = dbPath;
// Роли в тестах не заводят git worktree живого репозитория
// (runtime/roleWorkspace.ts); свой тест включает их на временной папке.
process.env.TASKFLOW_ROLE_WORKTREES ??= "off";
// Выгрузка в базу знаний пишет состояние в свою папку — в тестах временную,
// и старое состояние скрипта ~/kb не подхватывает (lib/knowledgeSync.ts).
process.env.TASKFLOW_KB_SYNC_DIR ??= path.join(os.tmpdir(), `taskflow-kb-sync-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
process.env.TASKFLOW_KB_SYNC_LEGACY_STATE ??= path.join(os.tmpdir(), "taskflow-kb-sync-no-legacy.json");

// Свой секрет на прогон — без этого ensureJwtSecret() (env.ts) читал бы
// или писал server/.env настоящего сервера.
// Тесты заводят учётки через /api/auth/register — в проде она закрыта
// (routes/auth.ts, 18.08.2026), здесь открываем явным флагом.
process.env.TASKFLOW_ALLOW_REGISTRATION = "1";

process.env.JWT_SECRET =
  "test-secret-" + crypto.randomBytes(16).toString("hex");

// Вложения кладутся на диск рядом с базой (UPLOAD_DIR в
// routes/attachments.ts, вычисляется при импорте модуля) — на прогон свой
// временный каталог, чтобы тестовые файлы не оседали в server/uploads
// живого сервера.
const uploadDir = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-uploads");
process.env.UPLOAD_DIR = uploadDir;

// Временные файлы подключения ролей (runtime/roleRunAccess.ts) — в папку
// прогона, а не в общую /tmp/taskflow-runs живого сервера.
process.env.TASKFLOW_RUNS_DIR = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-runs");

// PUT /api/runtime/routing/:role пишет role-routing.yaml. Тесты не должны
// трогать боевой файл — работаем с копией в tmp. Копия делается ДО импорта
// roleRouting.ts (setupFiles выполняется раньше файлов тестов), иначе
// модуль зафиксирует боевой путь.
const routingTmp = path.join(
  os.tmpdir(),
  path.basename(dbPath, ".db") + "-role-routing.yaml",
);
try {
  fs.copyFileSync(
    path.join(process.cwd(), "scripts", "role-routing.yaml"),
    routingTmp,
  );
  process.env.TASKFLOW_ROLE_ROUTING_FILE = routingTmp;
} catch {
  // Нет исходного файла — роль-роутинг в этом прогоне просто недоступен.
}

// 18.09.2026: владелец 'u1' заводится миграцией 039_seed_owner. Раньше
// тесты падали на FOREIGN KEY в 040_archive_old_agents, потому что на
// свежей БД u1 не было. Теперь миграция закрывает это, setup.ts
// открывать БД вручную не нужно.

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // файла нет — и не должно быть, если тест ничего не открывал
    }
  }
  try {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  } catch {
    // каталога нет — тест вложений в этом прогоне не участвовал
  }
  try {
    fs.unlinkSync(routingTmp);
  } catch {
    // копии не было — и не надо
  }
});
