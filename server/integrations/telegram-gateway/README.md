# taskflow-telegram-gateway

Отдельный long-polling процесс для одного private Telegram-чата владельца.

Переменные окружения:

- `TELEGRAM_BOT_TOKEN`
- `TASKFLOW_TELEGRAM_INTEGRATION_SECRET`
- `TASKFLOW_TELEGRAM_BOT_ID`
- `TASKFLOW_TELEGRAM_OWNER_USER_ID`
- `TASKFLOW_TELEGRAM_OWNER_CHAT_ID`
- `TASKFLOW_API_URL` (по умолчанию `http://127.0.0.1:3001`)
- `TELEGRAM_GATEWAY_STATE`

Gateway не принимает owner JWT/API token. Unit-шаблон: `server/systemd/taskflow-telegram-gateway.service`.
