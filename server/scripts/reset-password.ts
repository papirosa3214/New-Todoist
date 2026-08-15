// Админский сброс пароля — CLI, не веб-эндпоинт.
//
// Решение по шагу «Решить, нужно ли восстановление пароля» (задача
// b376ab48, 15.08.2026): email-восстановление НЕ делаем. На сервере нет
// SMTP (тот же вывод уже был для Kaneo — см. память), заводить его ради
// одной формы «забыли пароль» для трекера с одним живым человеком-
// пользователем (Максим; остальные учётки — агенты на постоянном
// api_token, им пароль для повседневной работы не нужен вовсе) —
// несоразмерно риску: письмо со ссылкой сброса — самая частая дыра в
// самодельной аутентификации, тестировать её не на чем и незачем.
//
// Вместо этого — прямой путь: у Максима есть SSH на машину, где живёт база
// (то же самое доверие, на котором и так держится доступ к серверу). Этот
// скрипт открывает ровно ту базу, что открывает сам сервер (тот же
// DB_PATH/db.ts), и переписывает password_hash тем же bcrypt, что и обычная
// регистрация — с точки зрения /api/auth/login разницы нет.
//
// Использование:
//   cd server && npx tsx scripts/reset-password.ts user@example.com
// (или npm run reset-password -- user@example.com)
// Пароль спрашивается один раз, интерактивно, без эха в терминал — не
// через argv (осел бы в истории шелла и в `ps`) и не печатается никуда,
// включая этот вывод. Опечатался — просто запусти снова, второй запрос на
// подтверждение сознательно не заведён: два вопроса подряд на одном stdin
// оказались куда более хрупкими, чем кажется (см. комментарий у main —
// первая версия скрипта именно на этом и подвисала).
import bcrypt from "bcryptjs";
import readline from "readline";
import db, { DB_PATH } from "../src/db.js";

const MIN_LENGTH = 8;

function hiddenPrompt(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const anyRl = rl as any;
    const originalWrite = anyRl._writeToOutput?.bind(anyRl);
    anyRl._writeToOutput = (data: string) => {
      // Эхо только для самого приглашения — набранные символы не отдаём
      // в терминал вообще (ни звёздочками, ни как есть).
      if (data.startsWith(prompt)) originalWrite?.(prompt);
    };
    // `answered` разруливает гонку с самим собой: rl.close() в успешной
    // ветке ниже — это ТОЖЕ источник события 'close', на которое подписан
    // этот же обработчик. Без флага reject() из "ввод прервался" срабатывал
    // бы синхронно раньше resolve(answer) на следующей строке (emit у
    // EventEmitter синхронный) — промис уже был бы отклонён к моменту
    // вызова resolve, и он молча проигнорировался бы. Поймано 15.08.2026:
    // скрипт репортил "ввод прервался до ответа" на КАЖДОМ успешном
    // ответе, включая обычный однострочный пайп с валидным паролем.
    let answered = false;
    rl.once("close", () => {
      if (!answered) reject(new Error("ввод прервался до ответа"));
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Использование: reset-password.ts <email>");
    process.exit(1);
  }

  const user = db
    .prepare("SELECT id, name, email FROM users WHERE email = ?")
    .get(email) as { id: string; name: string; email: string } | undefined;
  if (!user) {
    console.error(`Пользователь с email ${email} не найден в ${DB_PATH}`);
    process.exit(1);
  }

  console.log(`База: ${DB_PATH}`);
  console.log(`Учётка: ${user.name} <${user.email}> (id ${user.id})`);

  const password = await hiddenPrompt("Новый пароль: ");
  if (password.length < MIN_LENGTH) {
    console.error(`Пароль короче ${MIN_LENGTH} символов — не сохранён.`);
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(hash, user.id);
  if (result.changes !== 1) {
    // Не должно случиться (user.id только что прочитан из этой же базы),
    // но если случится — явная ошибка лучше тихого "готово" без записи.
    console.error(
      `Не удалось записать: изменено строк ${result.changes}, ожидалась 1.`,
    );
    process.exit(1);
  }

  console.log(`Пароль обновлён для ${user.email}.`);
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
});
