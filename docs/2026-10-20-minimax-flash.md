# MiniMax Flash без Preview — 20.10.2026

По поручению владельца основная модель TaskFlow заменена с MiniMax-M3.1-Flash-Preview на MiniMax-M3.1-Flash.
Официальное имя и Anthropic API подтверждены: https://platform.minimax.io/docs/api-reference/text-anthropic-api
Тариф каталога обновлён по https://www.minimax.io/blog/minimax-m31f — input 0.15, output 0.60, cacheRead 0.015 USD/1M.

Изменены девять явных назначений в server/scripts/role-routing.yaml. infra_engineer получает ту же модель через существующее правило основной модели по умолчанию. Каталог /home/maksim/.pi/agent/models.json: запись Flash Preview заменена на Flash; остальные настройки модели и провайдеров сохранены. Запасные цепочки, исторические сообщения/попытки, явные модели старых шагов и JEV не менялись.

Проверки:
- SDK ModelRuntime видит minimax/MiniMax-M3.1-Flash.
- Реальная проба completeSimple: model MiniMax-M3.1-Flash, stopReason stop, text OK.
- Реальная проба tool call с общим taskflow: action invoke, operation taskflow_task_summary, version 1, arguments.query заполнен правильно. Операция в пробе не исполнялась.
- Все эффективные первичные назначения ролей указывают на Flash; доступность через SDK подтверждена.
- Тесты providerFailover + roles: 12 PASS / 2 FAIL. Те же два FAIL воспроизведены с прежним role-routing.yaml (не регрессии смены модели): пустая fallback-цепочка добавленной роли; ожидание taskflow_doc_write вместо общего taskflow.
- Пустые очереди ролей/чатов перед перезапуском; taskflow-server active, MainPID 137845, health ok=true.
- Резервные копии YAML, models.json и online SQLite backup с integrity_check ok: /home/maksim/.local/state/taskflow-backups/2026-10-20-minimax-flash-100633.

Новые ходы используют Flash. Проба аргументов показывает корректный единичный вызов, но не доказывает исправность всех сценариев помощника.
