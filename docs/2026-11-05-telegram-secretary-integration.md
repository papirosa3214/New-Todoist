# Telegram ↔ chat-secretary: первый релиз

## Результат

Добавлен отдельный long-polling gateway для @ckor22_bot и узкий loopback-only API TaskFlow. Gateway не получает owner JWT/API token: у него только bot token и отдельный integration secret.

## Что сделано

- Allowlist одновременно по bot id, точным Telegram user/chat id и private chat; bot sender и группы не проходят.
- Durable inbound ledger с UNIQUE `(bot_id, update_id)`; повтор update не создаёт новое сообщение или ход.
- Вход публикуется только в `chat-secretary` от владельца и ставится в существующую durable FIFO очередь Помощника с delivery id `tg:<bot>:<update>`.
- Отдельный delivery outbox для ACK/final/error: состояния pending/sending/delivered/retry_wait/ambiguous/abandoned, 4 попытки, интервалы 5/30/120 секунд, 429 учитывает retry_after, зависший sending старше 2 минут становится ambiguous.
- Текст, фото, документ, voice/audio до 15 МБ. До скачивания проверяется Telegram metadata; архивы и исполняемые форматы отвергаются. Файлы сохраняются под случайным именем, пользовательский basename очищается.
- Добавлена точка фиксации финального ответа в outbox; gateway отправляет только outbox и не перезапускает роль при retry.
- Gateway хранит polling offset отдельным атомарно обновляемым state-файлом и продвигает его после ответа узкого API, то есть после durable записи ledger.
- Добавлены status-счётчики: last update, rejected, pending/retry/ambiguous, oldest pending.
- Добавлен systemd user unit-шаблон; TaskFlow вручную не перезапускался.

## Проверки

- `npx vitest run test/telegramIntegration.test.ts --maxWorkers=4`: 3/3 PASS.
- `npm run build` в `server`: PASS (`tsc`).
- `git diff --check`: PASS.
- `node --check server/integrations/telegram-gateway/gateway.mjs`: PASS.
- Проверены сценарии: десятичный update dedupe на уровне UNIQUE, allowlist reject до публикации, retry доставки без повторного исполнения.

## Ограничения

- Реальный Bot API не проверялся: bot token и Telegram owner user/chat id не читались из секретов роли.
- Voice сохраняется исходным audio attachment и перед публикацией проходит через узкий loopback ASR endpoint; при ошибке ASR аудио не теряется и получает пометку «Голосовое не распознано».
- Финальное сообщение Помощника автоматически фиксируется в outbox при сохранении ответа в `chat-secretary`.
- Systemd unit не установлен и не активирован: для этого нужны реальные секреты и действие владельца/инженера .110. TaskFlow вручную не перезапускался.

## Материалы

- Спецификация: note://a8dc9cdf-3896-4505-ab4e-cc88a7022a40
- Сервер: `server/src/integrations/telegram.ts`, `server/src/routes/telegram-integration.ts`
- Gateway: `server/integrations/telegram-gateway/gateway.mjs`
- Unit: `server/systemd/taskflow-telegram-gateway.service`
- Проверка: `server/test/telegramIntegration.test.ts`
