# TaskFlow: уровни рассуждений внутренних ролей — 21.10.2026

## Применено
Модель внутренних ролей: minimax/MiniMax-M3.1-Flash.
- code_orchestrator, architect: max.
- critic_verifier, secretary: low.
- researcher, analyst, builder, qa, designer, infra_engineer: medium.

Секретарь: выключение отклонено провайдером HTTP 400 (requires adaptive thinking).
Владелец согласовал минимальную поддерживаемую интенсивность low.
Провайдер принял короткие запросы с low, high, max. SDK проверен перехватом
payload без сети: thinking.type=adaptive, output_config.effort=max/low/medium.
Каталог ~/.pi/agent/models.json: compat.forceAdaptiveThinking=true,
thinkingLevelMap.off=null, thinkingLevelMap.max=max; резервная копия сохранена.

## Сессии
При пустой очереди и отсутствии живых попыток остановлен только taskflow-server.service.
Созданы и проверены 658 пустых сессий внутренних ролей:
71 чат, 486 слотов, 101 прочий рабочий контекст.
Прежние jsonl и история чатов сохранены. Привязки БД указывают на новые ID.
Модельные ответы в новых сессиях не инициировались; следующий ход использует новую сессию.
API запущен с пересобранным dist, /api/health возвращает ok=true.

Внешний Claude Code исключён. Ошибочно удалённая привязка одного его чата
восстановлена из backup; все её поля совпадают с исходными. Модель и настройки CLI
не менялись. Операционный скрипт исправлен: внешние участники пропускаются.

## Реализация
server/scripts/role-thinking.json — единая политика.
resolveThinkingLevel(model, role) учитывает capabilities и снижает max до high
у резервной модели, не поддерживающей max.
Chat, work и slot conversation применяют политику и после восстановления старой сессии.
Уровень сохраняется в сессии; глобальные defaults SDK не переписываются.

## Проверки
- До правки: 13 FAIL / 1 PASS нового набора.
- Итоговый профильный прогон: 15 PASS (13 проверок политики и 2 интеграционных проверки передачи уровня в chat SDK).
- tsc --noEmit PASS; tsc build PASS; git diff --check PASS.
- Полный набор: 2199 PASS, 96 FAIL, 49 skipped, 1 unhandled error.
  Это НЕ зелёный полный прогон. Семь сбоев в chat-session-runtime и
  runtime/thinkingLevel воспроизведены на исходном коде.
  Остальные не исправлялись и не объявляются подтверждёнными baseline-сбоями.
  Падающие файлы перечислены ниже; точные названия тестов и ошибки в full log.

## Артефакты и откат
/home/maksim/.local/state/taskflow-thinking-20261021/
- before-reset.db — резервная копия БД перед сбросом;
- models.json — исходный каталог моделей;
- session-reset-plan.json, new-sessions.json — старые привязки и новые файлы;
- reset-sessions.mjs — выполненный операционный скрипт;
- taskflow-thinking-*.log — проверки;
- full-suite-failures.txt — перечень падающих файлов.

Коммит и push не выполнялись. Изменения применены локально на .110.

## Падающие файлы полного прогона
- test/abandonedStep.test.ts
- test/agentMessaging.test.ts
- test/artifactEvidenceAndClose.test.ts
- test/blockedHelpGate.test.ts
- test/branchPlan.test.ts
- test/chat-session-runtime.test.ts
- test/chatQueueRecovery.test.ts
- test/chats-common-lifecycle.test.ts
- test/chats-online.test.ts
- test/consultation.test.ts
- test/diagnosticDispatch.test.ts
- test/hostToolRequestId.test.ts
- test/inProcessRun.test.ts
- test/instructionRuntime.test.ts
- test/mak70MergeMarker.test.ts
- test/orchestratorTools.test.ts
- test/ownerDictation.test.ts
- test/planComplete.test.ts
- test/privateRoleChat.test.ts
- test/providerFailover.test.ts
- test/roleProfiles.test.ts
- test/rolePromptLaconism.test.ts
- test/roleResultReport.test.ts
- test/roleToolCatalog.test.ts
- test/roleWorkspace.test.ts
- test/roles.test.ts
- test/rolesManage.test.ts
- test/runtime/api.test.ts
- test/runtime/thinkingLevel.test.ts
- test/runtimeContext.test.ts
- test/stalledStepWatcher.test.ts
- test/worktreeTestGate.test.ts
