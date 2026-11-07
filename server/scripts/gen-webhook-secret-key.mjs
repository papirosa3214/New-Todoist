#!/usr/bin/env node
// Генерация симметричного ключа для шифрования секретов webhook-подписок.
//
// Карточка 905db3e3-… (webhook V2): AES-256-GCM через node:crypto,
// ключ — 32 байта из `TASKFLOW_WEBHOOK_SECRET_KEY` в окружении сервера.
//
// Зачем отдельный скрипт: даёт однострочник, который владелец может
// запустить без зависимостей от dev-сборки (без `tsx`, без `npm`),
// и сразу копипастить строку в `server/.env`.
//
// По умолчанию выводит base64 — `secretBox.ts` принимает и base64,
// и hex (64 символа). Формат переключается флагом `--hex`.
//
// Использование:
//   node server/scripts/gen-webhook-secret-key.mjs
//   node server/scripts/gen-webhook-secret-key.mjs --hex
//
// Полученную строку впишите в server/.env:
//   TASKFLOW_WEBHOOK_SECRET_KEY=<вывод скрипта>
//
// Если у вас уже есть подписки с зашифрованными секретами
// (колонка `secret_encrypted` в `webhook_subscriptions`) и вы
// сменили ключ — старые секреты НЕ расшифруются. Их нужно либо
// ротировать через PATCH `/api/integrations/webhooks/:id` с новым
// `secret`, либо удалить подписки и создать заново. Скрипт сам
// по себе никаких проверок совместимости не делает — это решение
// владельца при первой установке ключа.

import crypto from "node:crypto";

const useHex = process.argv.includes("--hex");
const bytes = crypto.randomBytes(32);
const encoded = useHex ? bytes.toString("hex") : bytes.toString("base64");

console.log(encoded);