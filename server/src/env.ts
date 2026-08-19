// Секрет подписи JWT — больше не зашит в код.
//
// Было: `process.env.JWT_SECRET || "taskflow-dev-secret-2026"` в двух
// местах (index.ts, routes/auth.ts) — рабочий, но публичный секрет прямо
// в git-истории. Пока трекер был черновиком, это было терпимо; для того,
// на который переезжаешь с Kaneo, — нет: кто угодно, кто видел репозиторий
// (или просто его историю), мог подписать себе JWT на любого пользователя.
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
  process.env.JWT_SECRET = secret;
}
