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
// Живые роли в тестах (14.10.2026: после прогона inProcessRun.test.ts воркер
// vitest продолжил жить, поднял настоящую модель в рабочей папке репозитория
// и сделал коммиты от автора «test», один дошёл до main).
// 1) Флаг запуска ролей не переживает файл: setup выполняется перед КАЖДЫМ
//    файлом, а тест, которому запуск нужен, ставит флаг у себя заново.
delete process.env.TASKFLOW_KICK_IN_TESTS;
// 2) Папка проекта по умолчанию — временная, не репозиторий TaskFlow
//    (runtime/inProcessRun.ts, projectRepo).
const testProjectDir = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-project");
fs.mkdirSync(testProjectDir, { recursive: true });
process.env.TASKFLOW_TEST_PROJECT_DIR = testProjectDir;
// 3) Ключей настоящих моделей у прогона нет: каталог агента Pi (auth.json,
//    models.json) — пустая временная папка. Даже если тест забыл подменить
//    createAgentSession, модель не авторизуется и в сеть не пойдёт.
const piAgentDir = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-pi-agent");
fs.mkdirSync(piAgentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = piAgentDir;
// 4) Коммит и слияние в живом репозитории TaskFlow (и любом его worktree)
//    отклоняются хуком git: переменные GIT_CONFIG_* наследует каждый
//    дочерний процесс прогона. Временные репозитории тестов не затронуты.
{
  const liveRepo = path.resolve(process.cwd(), "..");
  const hooksDir = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-git-hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const guard = `#!/bin/sh
common=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
live=$(cd "$(git -C '${liveRepo}' rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
if [ -n "$live" ] && [ "$common" = "$live" ]; then
  echo "taskflow tests: commit into the live repository is forbidden" >&2
  exit 1
fi
exit 0
`;
  for (const hook of ["pre-commit", "pre-merge-commit", "commit-msg", "pre-push"]) {
    fs.writeFileSync(path.join(hooksDir, hook), guard, { mode: 0o755 });
  }
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  process.env.GIT_CONFIG_COUNT = String(n + 1);
  process.env[`GIT_CONFIG_KEY_${n}`] = "core.hooksPath";
  process.env[`GIT_CONFIG_VALUE_${n}`] = hooksDir;
}
// Роли в тестах не заводят git worktree живого репозитория
// (runtime/roleWorkspace.ts); свой тест включает их на временной папке.
process.env.TASKFLOW_ROLE_WORKTREES ??= "off";
// Сторож локальной модели (lib/ollamaHealthWatcher.ts) ходит настоящим
// запросом в Ollama машины и при отказе заводит карточку в «Серверные
// уведомления». В тестах это внешняя зависимость: 13.10.2026 локальная
// Ollama отвечает 503 «server busy», и карточка падала в тестовой БД —
// красным был taskPreparationApi («анализ не пишет БД»). Тесты проверяют
// сервер, а не локальную модель владельца, поэтому сторож на прогоне выключен
// (такой же предохранитель, как TASKFLOW_ROLE_WORKTREES выше).
process.env.OLLAMA_HEALTH_WATCHER_DISABLED ??= "1";
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

// Карточка 905db3e3-…: durable HMAC секрет. Без ключа
// TASKFLOW_WEBHOOK_SECRET_KEY createSubscription fail-closed (D-1).
// Тесты задают ключ здесь, чтобы createSubscription и processWakePass
// могли отработать.
process.env.TASKFLOW_WEBHOOK_SECRET_KEY =
  process.env.TASKFLOW_WEBHOOK_SECRET_KEY ||
  Buffer.from(crypto.randomBytes(32)).toString("base64");

// Вложения кладутся на диск рядом с базой (UPLOAD_DIR в
// routes/attachments.ts, вычисляется при импорте модуля) — на прогон свой
// временный каталог, чтобы тестовые файлы не оседали в server/uploads
// живого сервера.
const uploadDir = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-uploads");
process.env.UPLOAD_DIR = uploadDir;

// Временные файлы подключения ролей (runtime/roleRunAccess.ts) — в папку
// прогона, а не в общую /tmp/taskflow-runs живого сервера.
process.env.TASKFLOW_RUNS_DIR = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-runs");
// Ролевые папки тестов не пишутся в ~/taskflow живого пользователя.
process.env.TASKFLOW_ROLES_DIR = path.join(os.tmpdir(), path.basename(dbPath, ".db") + "-roles");

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
  fs.rmSync(process.env.TASKFLOW_ROLES_DIR!, { recursive: true, force: true });
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
