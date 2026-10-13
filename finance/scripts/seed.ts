/**
 * Создаёт начального пользователя-владельца и базовый набор категорий,
 * если их ещё нет.
 *
 * ENV:
 *   FINANCE_INITIAL_USER     — логин (по умолчанию "owner")
 *   FINANCE_INITIAL_PASSWORD — пароль (по умолчанию "changeme")
 */
import Database from "better-sqlite3";
import argon2 from "argon2";
import { ulid } from "ulid";
import path from "node:path";
import fs from "node:fs";

const DB_PATH =
  process.env.FINANCE_DB_PATH ?? path.resolve(process.cwd(), "data", "finance.sqlite");

if (!fs.existsSync(DB_PATH)) {
  console.error(`[seed] БД не найдена: ${DB_PATH}. Сначала запустите npm run db:migrate`);
  process.exit(1);
}

const sqlite = new Database(DB_PATH);

const username = process.env.FINANCE_INITIAL_USER ?? "owner";
const password = process.env.FINANCE_INITIAL_PASSWORD ?? "changeme";

const existingUser = sqlite.prepare("SELECT id FROM users WHERE username = ?").get(username);
if (!existingUser) {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  sqlite
    .prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(ulid(), username, hash, new Date().toISOString());
  console.log(`[seed] создан пользователь: ${username}`);
} else {
  console.log(`[seed] пользователь уже существует: ${username}`);
}

// Базовые категории расходов и доходов.
const baseCategories: Array<[string, string, string | null]> = [
  ["Продукты", "🛒", null],
  ["Кафе и рестораны", "🍽️", null],
  ["Транспорт", "🚇", null],
  ["Жильё и ЖКХ", "🏠", null],
  ["Здоровье", "💊", null],
  ["Одежда и обувь", "👕", null],
  ["Развлечения", "🎮", null],
  ["Связь и интернет", "📱", null],
  ["Образование", "📚", null],
  ["Путешествия", "✈️", null],
  ["Подарки", "🎁", null],
  ["Прочие расходы", "💸", null],
  ["Зарплата", "💼", null],
  ["Подарки полученные", "🎉", null],
  ["Возврат", "↩️", null],
  ["Прочие доходы", "💰", null],
];

const insert = sqlite.prepare(
  "INSERT OR IGNORE INTO categories (id, name, icon, archived) VALUES (?, ?, ?, 0)",
);

for (const [name, icon] of baseCategories) {
  insert.run(ulid(), name, icon);
}

console.log(`[seed] готово`);
sqlite.close();