# Внутренний Оркестратор: инструменты управления
08.10.2026. Роль отображается как «Оркестратор», ключ code_orchestrator сохранён для связей. MiniMax-M3, runtime Pi, fallback=[].

Общий orchestratorTools используется в work/subtask runtime и chatTools. Каталог /api/roles передаёт реальный ключ роли в inProcessToolNames. Доступ выдаётся через существующее users.permissions: orchestrate=true для AI-agent. Старый role=orchestrator продолжает работать. Вызов каждого управляющего инструмента повторно проверяет допуск; отзыв блокирует и ранее созданный инструмент.

Инструменты: team_read, children, assign, dependencies, plan_read/create/propose/edit/ops/approve, node_run (префикс taskflow_). Создание draft и назначение не запускают; approve и ops approved-плана могут запускать готовые узлы. API продолжает проверять состояние, версии, циклы и зависимости. Decisions сверхлимитных proposals, настройка прав/провайдеров и прочие owner-only маршруты не расширялись. Удаление и статус completed запрещены сервером.

Проверка: 6 новых интеграционных тестов плюс rolesManage и roleMatrix, всего 32/32. Проверены реальный draft, назначение без смены статуса, чтение дерева, зависимость и отказ цикла, удаление/закрытие 403, отзыв допуска, одинаковые инструменты work/chat/catalog. Изолированная tsc-сборка прошла. В broader suites два падения roles.test.ts (устаревшее ожидание fallback=[]) и task-collaboration-plans.test.ts (source_subtask_id) воспроизведены на неизменённом HEAD: 17 passed/2 failed. Основная серверная сборка сохраняет прежнюю notesFolders.ts:43 ошибку; новых TypeScript ошибок нет.

Выкладка: backup /home/maksim/backups/taskflow/orchestrator-tools-20261008; patch применён с git apply --check, чужие dirty изменения сохранены. Перезапуск при пустой очереди/отсутствии работающих шагов. Live API: title=Оркестратор, model=MiniMax-M3, runtime_ready=true, problems=[], все 11 новых controls; health=true, DB integrity=ok.

MAK-100 ещё не импортирована, исполнение эксперимента не запускалось. Дальше импорт всей структуры, стандартная подготовка/план с ведущей ролью и запуск. Оценивать граф и реальные интервалы запусков, лимиты, ручные вмешательства, качество/стоимость. Наличие инструментов не является доказательством автономного выполнения всей задачи.
