# Notifications Backend — раздел документации

> Отдельный контур уведомлений, заменивший старый n8n→tg-relay→Telegram канал.
> Карточки уведомлений живут в БД TaskFlow (НЕ отдельный контур), файлы
> `.md` — это evidence-канал, HTTP API читает их для iOS-приложения.

📂 **Полная документация:** [docs/notifications/](notifications/README.md)

**Зачем смотреть:**
- Понять, как слать уведомления из нового эмиттера → [integration.md](notifications/integration.md)
- Контракт HTTP API для приложения → [api.md](notifications/api.md)
- Формат .md файлов и маркеры тревог → [file-format.md](notifications/file-format.md)
- Полный цикл жизни уведомления → [lifecycle.md](notifications/lifecycle.md)
- Запуск/диагностика на проде → [operations.md](notifications/operations.md)

**Искать по KB:** `kb_query.py "сводка уведомлений"` или
`kb_query.py "rendezvous inbox triage"`.
