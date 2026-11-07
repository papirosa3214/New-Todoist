# Пакеты шаблонов — план реализации, 18.10.2026

Основание: согласованный каталог от 16 октября в нативном репозитории. Семь существующих профилей плюс UX-концепция, API-интеграция и аудит. Manual остаётся индивидуальным планом.

1. Сохранить специализированные инструкции и порционный список навыков в узлах создаваемого плана, с версией пакета. Начатые планы не менять.
2. Добавить три графа с контрактами результатов. В API-интеграции подготовка QA параллельна реализации; итоговая QA ждёт обе ветки. Аудит не включает исправления.
3. Передавать инструкцию текущего узла в SDK, ограничивать список навыков списком этапа, затем использовать существующий JEV для уточнения. Нет навыка — явно сообщить, без подмены всем набором.
4. Вывести десять профилей в iOS. Фича и баг из меню имеют полноценный стандарт без дополнительного выбора флагов. Существующие явные API-флаги совместимы.
5. Проверить сохранение инструкций, графы и настоящую загрузку SDK на изолированной базе/папках. Проверить наличие и шапки живых навыков без запуска модели. Собрать iOS. Коммит и push Gitea; деплой сервера отдельно не выполняется.

## Реализовано

Граф и инструкция каждого этапа сохраняются в плане. Версия пакета — 1. Начатые планы не пересчитываются. Поля instructions проходят API и остаются при старом whole-graph редактировании; инструкция сохраняется при превращении терминального критика в итоговую проверку и при клонировании доработки. Review-job без subtaskId восстанавливает свой этап по активному маркеру; чужая роль/карточка его не получает.

Ниже — пример наборов для карточки с кодом, API и исследованием. Дополнительно по Apple-контексту подключаются платформенные навыки; интервью/отзывы включают user-research/research-synthesis. Это не безусловное применение всех навыков.

| Профиль | Этап / роль | Кандидаты навыков |
| --- | --- | --- |
| single_executor | executor / builder | verify-after-edit |
| research | research / researcher | writing-for-agents, explore-codebase, research-synthesis |
| research | analysis / analyst | writing-for-agents, research-synthesis |
| delivery | architecture / architect | domain-modeling, writing-for-agents |
| delivery | executor / builder | verify-after-edit |
| delivery | qa / qa | unhappy |
| delivery | critic / critic_verifier | review-changes, verdict-requires-live-scenario |
| full_cycle | research / researcher | writing-for-agents, explore-codebase, research-synthesis |
| full_cycle | analysis / analyst | writing-for-agents, research-synthesis |
| full_cycle | architecture / architect | domain-modeling, writing-for-agents |
| full_cycle | design / designer | information-architecture, ux-copy, design-critique |
| full_cycle | executor / builder | verify-after-edit |
| full_cycle | qa / qa | unhappy |
| full_cycle | critic / critic_verifier | review-changes, verdict-requires-live-scenario |
| orchestrated | orchestrate / code_orchestrator | one-agent-one-task, orchestrate-step-submission |
| orchestrated | assemble / code_orchestrator | one-agent-one-task, orchestrate-step-submission |
| product_feature | analysis / analyst | writing-for-agents, research-synthesis |
| product_feature | architecture / architect | domain-modeling, writing-for-agents |
| product_feature | design / designer | information-architecture, ux-copy, design-critique |
| product_feature | delivery / builder | verify-after-edit |
| product_feature | qa / qa | unhappy |
| bug_regression | analysis / analyst | writing-for-agents, research-synthesis |
| bug_regression | root_cause / architect | domain-modeling, writing-for-agents, diagnosing-bugs |
| bug_regression | fix / builder | verify-after-edit, diagnosing-bugs |
| bug_regression | regression_test / qa | unhappy |
| ux_concept | design / designer | information-architecture, ux-copy, design-critique |
| ux_concept | critique / critic_verifier | design-critique |
| api_integration | research / researcher | writing-for-agents, explore-codebase, research-synthesis |
| api_integration | architecture / architect | domain-modeling, writing-for-agents |
| api_integration | delivery / builder | verify-after-edit, property-based-testing |
| api_integration | qa_prepare / qa | unhappy, property-based-testing |
| api_integration | qa_verify / qa | unhappy, property-based-testing |
| audit | scope / analyst | writing-for-agents, research-synthesis |
| audit | inspection / architect | writing-for-agents, audit-context-building |
| audit | review / critic_verifier | writing-for-agents, audit-context-building, differential-review |

## Доставка навыков

SDK получает только кандидатов текущего этапа. Если включён JEV и выполнен действующий порог размера набора, он уточняет этот список по карточке и заданию. При выключенном/недоступном JEV сохраняются кандидаты этапа; возврата ко всей пачке роли нет. Для manual и старых планов без пакета поведение прежнее. Недоступный навык явно перечисляется в системной инструкции, не выдаётся за подключённый. Тела навыков не менялись. Версии самих файлов зафиксированы SHA256 в template-skill-inventory.json на дату проверки; будущая правка файла навыка остаётся независимой от версии шаблона.

JEV выбора профиля знает UX/API/аудит; текущая эвристика и приоритет ранее существовавших специализированных продуктового и багового шаблонов сохранены. Настройки и пороги JEV не переключались. Применение явного шаблона не требует сетевой оценки JEV профиля.

## Проверки

- Реальный SDK loadSkills: 84 навыка восьми ролей, 0 диагностик, 0 отсутствующих ссылок пакетов. Полная инвентаризация: docs/2026-10-18-template-skill-inventory.json. Модель не запускалась.
- Сервер: 84 теста пакетов, SDK, миграции, графов, review lifecycle, оркестратора и in-process runtime прошли. После расширения JEV — 46 тестов (19 пакетов + 27 JEV) прошли; прогоны пересекаются, числа не суммируются. npm run build / tsc прошёл.
- API-проверки: создание всех десяти профилей, стандарт фичи/бага без флагов, обе зависимости итогового QA, сохранение инструкции при редактировании и восстановление review-контекста. База и runtime изолированы; настоящие агенты не запускались.
- Миграция 154 проверена на сохранении существующего плана, узлов, ребра и индекса, повторном применении и foreign_key_check. В боевой БД миграция не запускалась.
- iOS: десять явных профилей, подписи новых графов и актуальная подсказка. BUILD SUCCEEDED; 13 HintCenterTests прошли. Скан оформления — 0 отклонений. Новое меню не проверено на физическом устройстве.

## Поставка

Поручение — коммит и push Gitea в main обоих репозиториев. Сервер не перезапускается, роли/планы на боевом сервере не запускаются, приложение на iPhone не устанавливается. Для появления новых вариантов в работающей системе потребуется применить миграцию 154 и обновить сервер, затем клиент; это не заменено проверкой исходников. Перед коммитом очередь role_run_jobs пуста, активных шагов 0.
