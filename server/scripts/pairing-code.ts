// Привязка телефона по QR одной командой с сервера.
//
// Запуск из server/:  npx tsx scripts/pairing-code.ts [--no-qr]
//
// Зачем: вход без пароля из домашней сети выключен (08.11.2026), а код
// привязки в HTTP выдаёт только уже вошедший владелец. Стоит токену на
// телефоне пропасть — выписать QR нечем. Эта команда работает с базой
// напрямую, под пользователем сервера: нужен физический доступ к машине,
// в сети она ничего не открывает.
import { spawnSync } from "node:child_process";
import db from "../src/db.js";
import { issuePairingCode, pairingQrUri } from "../src/lib/pairingCodes.js";

const owner = db
  .prepare(
    "SELECT id, name FROM users WHERE role = 'owner' AND type = 'human' ORDER BY created_at LIMIT 1",
  )
  .get() as { id: string; name: string | null } | undefined;

if (!owner) {
  console.error("Владелец не найден: в users нет role='owner'.");
  process.exit(1);
}

// Адрес, по которому телефон достаёт сервер. Дома это его LAN-адрес; поле
// host в ссылке нужно внешнему доступу (ретранслятор), дома оно не влияет.
const host = (process.env.TASKFLOW_PAIR_HOST || "192.168.1.110:3001").trim();
const { code, expiresAt } = issuePairingCode(owner.id, "cli");
const uri = pairingQrUri(code, host);

console.log("");
console.log(`Привязка iPhone к TaskFlow — владелец: ${owner.name ?? owner.id}`);
console.log(`Код:     ${code}`);
console.log(`Ссылка:  ${uri}`);
console.log(`Живёт:   5 минут, до ${expiresAt}`);
console.log("");

if (!process.argv.includes("--no-qr")) {
  const qr = spawnSync("qrencode", ["-t", "ANSIUTF8", uri], { encoding: "utf8" });
  if (qr.status === 0 && qr.stdout) {
    console.log(qr.stdout);
  } else {
    console.error(
      "QR не нарисован (нет qrencode): введите код на телефоне вручную или откройте ссылку выше.",
    );
  }
}

console.log("Телефон: на экране входа «Войти по QR-коду» (или «Настройки → Сервер → Привязать этот iPhone»).");
console.log("");
