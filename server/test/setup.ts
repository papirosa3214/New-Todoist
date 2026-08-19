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
});
