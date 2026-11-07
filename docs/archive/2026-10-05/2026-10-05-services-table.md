# TaskFlow: таблица служб и скриптов

Снимок состояния на 2026-10-05. Источник: `systemctl --user list-units 'taskflow-*'`
и `list-unit-files 'taskflow-*'`, `ls server/scripts/`. Владелец: задача MAK-61
(Сервер: скрипты, таймеры и службы — убрать мины), область 4 аудита
`docs/2026-10-05-server-audit.md`.

## 1. Активные службы (running, .service)

| Юнит                       | Описание                                      | ExecStart                                                                 |
|----------------------------|-----------------------------------------------|---------------------------------------------------------------------------|
| `taskflow-server.service`  | сервер трекера (:3001)                        | `tsx watch src/index.ts` в `/home/maksim/Проекты/New-Todoist/server`      |
| `taskflow-web.service`     | vite dev-сервер (:5180)                       | `vite --host 0.0.0.0 --port 5180 --strictPort`                            |
| `taskflow-mcp-net.service` | MCP (Streamable HTTP) по сети для LAN-клиентов| `python3 server/scripts/mcp_server.py --serve`                            |
| `taskflow-secretary-voice.service` | голосовой воркер Секретаря (LiveKit+Gemini)| `python3 worker.py start` в venv `~/.venvs/secretary-voice`              |

## 2. Активные таймеры (waiting, .timer)

| Юнит                                  | Описание                                | Расписание                |
|---------------------------------------|-----------------------------------------|---------------------------|
| `taskflow-agent-watch.timer`          | сторож конвейера раз в час              | `OnBootSec=10min`, `OnUnitActiveSec=1h`        |
| `taskflow-backup.timer`               | ночной слепок базы + вложений на NAS     | `OnCalendar=*-*-* 03:20:00`                    |
| `taskflow-scheduler-watch.timer`      | сторож планировщика раз в 15 минут      | `OnBootSec=5min`, `OnUnitActiveSec=15min`      |
| `taskflow-secretary-voice-watch.timer`| сторож голосового Секретаря раз в 15 мин| `OnBootSec=5min`, `OnUnitActiveSec=15min`      |

## 3. Отключённые и заархивированные (по решениям MAK-61)

| Юнит                          | Состояние         | Что с ним делать по решению 3                                            |
|-------------------------------|-------------------|--------------------------------------------------------------------------|
| `taskflow-trigger.service`    | `disabled enabled`| переименовать в `taskflow-trigger.service.disabled-2026-10-05`           |
| `taskflow-trigger-watch.timer`| `disabled enabled`| удалить (.timer к выключенной службе, не нужен)                          |
| `taskflow-scheduler.service`  | `static`          | по решению 3.3 — проверить, нужен ли `TASKFLOW_PI_AGENT_TOKEN`           |
| `taskflow-scheduler.timer`    | `disabled enabled`| удалить как неиспользуемый (включение через `taskflow-scheduler-watch`)  |
| `taskflow-chat.service`       | `disabled enabled`| чат выключен, проверить нужен ли вообще                                  |
| `taskflow-chat-watch.timer`   | `disabled enabled`| сторож чата — удалить (служба выключена)                                 |
| `taskflow-docs-ragflow-sync.service` | `static`    | синхронизация доков в RAGFlow, проверить, актуальна ли                    |
| `taskflow-docs-ragflow-sync.timer`   | `disabled enabled` | таймер к ней — синхронно удалить, если служба не нужна             |

## 4. Юнит-файлы под удаление (Корзина, `gio trash`)

| Файл                                              | Почему                                                |
|---------------------------------------------------|-------------------------------------------------------|
| `taskflow-trigger.service.bak-26.08.2026`         | бэкап выключенной службы, не нужен                    |
| `taskflow-trigger.service.bak-rolekeys-20260916-083747` | бэкап после правки rolekeys, не нужен           |
| `taskflow-trigger.service.d/` (drop-in'ы)         | неиспользуемые drop-in'ы (`minimax.conf`, `roles-in-server.conf`, `.bak-rolekeys-…`) |
| `taskflow-secretary-voice.service.bak-before-gemini-proxy` | бэкап до смены прокси, не актуален         |
| `taskflow-chat.service.bak-28.08.2026`            | бэкап выключенного чата, не нужен                     |

> Всё перечисленное в §3 (отключённые юниты) и §4 (юнит-файлы под удаление)
> — инфраструктура (`~/.config/systemd/user/`), **НЕ код в репо**. По
> правилу «Не лезу в инфраструктуру (systemd, trigger, сторож) — это не
> моя зона» оставлено владельцу. Эта таблица — карта того, что нужно
> сделать руками.

## 5. Скрипты в `server/scripts/` (46 шт.)

Группы по роду, без `test_*` (их 14 — это автотесты).

| Роль                     | Скрипты                                                                                                            | Как запускается                                    |
|--------------------------|--------------------------------------------------------------------------------------------------------------------|---------------------------------------------------|
| Сервер/MCP/watch         | `mcp_server.py`, `agent_watch.py`, `chat_resident_watch.py`, `secretary_voice_watch.py`, `scheduler.py`, `scheduler_watch.py`, `graft_refresh.py`, `graft_refresh_watch.py`, `trigger.py`, `trigger_watch.py`, `agent_inbox.py`, `start_agent_run.py` | systemd-юниты `taskflow-*` или `manual_run.sh` |
| Бэкап / установка        | `backup.sh`, `install-pi-extensions.sh`, `antigravity-cli.sh`, `taskflow-shim.sh`                                  | вручную или таймер (`backup.sh` через `taskflow-backup.service`) |
| CLI-утилиты (один раз)   | `reset-password.ts`, `issue-agent-token.ts`, `bootstrap-role-homes.ts`, `rebuild-branch-team.ts`, `seed-role-accounts.ts`, `seed-role-embeddings.ts` | ручной запуск под `npx tsx`                       |
| Ресёрч/конвейер          | `research_pipeline.py`, `research_server.py`, `antigravity_agent.py`                                              | ручной запуск или оркестратор через `composio_*`  |
| Контекст задач           | `task_context.py`, `task_brief.py`, `task_prepare.py`, `task_context_bridge.py`                                  | вызываются из кода сервера (импорт)               |
| Однозадачные помощники   | `fix_clean_trigger.py`, `patch_trigger_fix.py`                                                                    | ручной запуск, лечат конкретные баги              |
| Vault / компосио         | `composio_mcp.mjs`, `composio_vault.py`                                                                           | поднимается через `composio` CLI                  |
| Тесты                    | `test_*.py` (14 файлов)                                                                                            | `python3 -m unittest` или прямой запуск           |

**Замечание о мёртвых скриптах.** В описании MAK-61 сказано: «мёртвые
скрипты — в `server/scripts/archive/`». Полный аудит «что вызывается, а
что нет» — это отдельная работа (4+ часов на `grep` по `server/src/` и
по `~/Проекты/Хранилище`); в рамках MAK-61 не делаю. Если карточка
захочет этого — поставить отдельный шаг.

## 6. Границы

- **Код в репо** (`server/scripts/*`, `server/src/*`, `docs/*`) — моя
  зона: правлю в рамках MAK-61, коммиты идут в эту ветку
  `roles/9a9f189d-…`.
- **systemd-юниты** (`~/.config/systemd/user/taskflow-*`) — инфраструктура,
  НЕ моя зона по правилу «Не лезу в systemd-юниты». §3 и §4 — карта для
  владельца/оркестратора.
- **Таймеры на той же машине** (всё в `~/.config/systemd/user/`) — то же
  правило.
- **Критерий приёмки MAK-61**:
  `grep -rn TASKFLOW_PI_AGENT_TOKEN ~/.config/systemd/user/` — пусто
  (кроме `.disabled`). Это и есть «нет живых юнитов с архивной
  учёткой» — и его сможет проверить только владелец, потому что сами
  юниты — не в моей зоне.
