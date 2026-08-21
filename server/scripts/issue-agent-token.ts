/**
 * Выдать API-токен агенту, у которого нет своего входа.
 *
 * Обычный путь — POST /api/auth/api-token под JWT самого агента: токен
 * нельзя выпустить чужой учётке, и это правильно. Но у агентов вроде
 * Гермеса пароля нет вовсе — учётка заведена, а войти под ней некому.
 *
 * Отсюда служебный скрипт: запускается руками на машине, где лежит база.
 * Печатает токен ОДИН раз в stdout — вызывающий обязан сразу положить его
 * в хранилище секретов и нигде больше не хранить (в базе только отпечаток).
 *
 *   npx tsx scripts/issue-agent-token.ts Hermes
 */
import db, { hashApiToken } from "../src/db.js";
import crypto from "crypto";

const name = process.argv[2];
if (!name) {
  console.error("Использование: tsx scripts/issue-agent-token.ts <имя агента>");
  process.exit(1);
}

const user = db
  .prepare("SELECT id, name, type FROM users WHERE name = ?")
  .get(name) as { id: string; name: string; type: string } | undefined;

if (!user) {
  console.error(`Агента «${name}» в базе нет`);
  process.exit(1);
}
if (user.type !== "ai") {
  console.error(`«${name}» — не агент (type=${user.type}), токен не выдаём`);
  process.exit(1);
}

const token = "tf_" + crypto.randomBytes(24).toString("hex");
db.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(
  hashApiToken(token),
  user.id,
);
process.stdout.write(token);
