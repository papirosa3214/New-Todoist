// Секрет подписи JWT — больше не зашит в код.
//
// Было: `process.env.JWT_SECRET || "taskflow-dev-secret-2026"` в двух
// местах (index.ts, routes/auth.ts) — рабочий, но публичный секрет прямо
// в git-истории. Пока трекер был черновиком, это было терпимо; для того,
// на который переезжали с Kaneo (история, миграция август 2026), — нет:
// кто угодно, кто видел репозиторий (или просто его историю), мог
// подписать себе JWT на любого пользователя.
//
// История: «Kaneo» — предыдущая доска Максима, мигрировали на TaskFlow
// в августе 2026. Сейчас это просто ссылка в прошлое.
//
// ensureJwtSecret() гарантирует, что process.env.JWT_SECRET есть к моменту
// регистрации @fastify/jwt (index.ts), без хардкода и без риска не
// подняться:
//  1. Задан снаружи (systemd EnvironmentFile, экспортированная
//     переменная) — используем как есть.
//  2. Есть server/.env (JWT_SECRET=...) — грузим оттуда.
//  3. Ни того ни другого — генерируем случайный (32 случайных байта, hex)
//     и СОХРАНЯЕМ в server/.env, чтобы следующий старт — включая каждый
//     перезапуск tsx watch при разработке, он перезапускается на каждое
//     сохранение файла — увидел тот же секрет, а не разлогинил всех
//     заново. Процесс сейчас поднят вручную (tsx watch из чьего-то
//     терминала, не systemd), поэтому переменную окружения снаружи
//     подложить некому — секрет обязан быть самодостаточным.
//
// server/.env — в .gitignore, секрет в репозиторий не попадёт. Ротация
// JWT_SECRET разлогинивает всех, у кого есть JWT (30 дней жизни) — это
// не задевает агентов: их api_token живёт в отдельной колонке и проверяется
// отдельным путём (resolveUserIdFromToken в auth.ts), не через JWT.
// Если Максима разлогинило и пароль забыт — server/scripts/reset-password.ts.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

/**
 * Подтянуть server/.env в окружение процесса целиком.
 *
 * Раньше файл читался только по дороге за JWT_SECRET и только когда того нет
 * в окружении — из-за чего любая ДРУГАЯ настройка в .env (например,
 * TASKFLOW_LAN_NO_AUTH — вход без пароля из домашней сети) могла остаться
 * непрочитанной. Значения, уже заданные снаружи, loadEnvFile не перетирает.
 */
export function loadEnvFile(): void {
  if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
}

export function ensureJwtSecret(): void {
  loadEnvFile();
  if (process.env.JWT_SECRET) return;

  const secret = crypto.randomBytes(32).toString("hex");
  // 0o600 — читает и пишет только владелец файла, тот же уровень доступа,
  // что и у server/taskflow.db по умолчанию в этой ОС.
  fs.writeFileSync(ENV_PATH, `JWT_SECRET=${secret}\n`, { mode: 0o600 });
  hardenEnvFile();
  process.env.JWT_SECRET = secret;
}

/**
 * Закрыть server/.env от всех, кроме владельца файла.
 *
 * `mode: 0o600` в writeFileSync действует ТОЛЬКО на новый файл: если .env
 * уже создан, права не меняются. Плюс на каталоге server/ висел
 * default-ACL `u:tfrole:rwx` — по нему НОВЫЕ файлы наследовали доступ
 * пользователя tfrole, под которым работают роли (localRoleOperations.ts,
 * `sudo -n -u tfrole /bin/bash -c`). Итог: роль через свой bash читала
 * server/.env целиком — JWT_SECRET, GOOGLE_CLIENT_SECRET, LIVEKIT_API_SECRET,
 * RAGFLOW_TOKEN, — подделывала JWT владельца и получала полный доступ к API
 * (24.10.2026, аудит безопасности).
 *
 * Что здесь:
 *  - снять все расширенные ACL с файла (setfacl -b) — наследование от
 *    каталога и ручные права на tfrole;
 *  - поставить 0600 — читает и пишет только владелец.
 *
 * Права чинятся на каждом старте: если кто-то (или другая программа)
 * расширит доступ позже, следующий запуск сервера его закроет.
 */
export function hardenEnvFile(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  try {
    // setfacl -b — снять расширенные ACL целиком (включая default-наследие).
    execFileSync("setfacl", ["-b", ENV_PATH], { stdio: "ignore", timeout: 5000 });
  } catch {
    // setfacl нет в системе или не хватило прав — chmod ниже всё равно
    // закрывает файл для group/other; расширенные ACL останутся, поэтому
    // сообщаем в журнал, а не молчим.
    console.warn("[env] setfacl не сработал: права server/.env закрыты только chmod");
  }
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch (error) {
    console.warn(
      "[env] не удалось закрыть права server/.env:",
      error instanceof Error ? error.message : error,
    );
  }
}
