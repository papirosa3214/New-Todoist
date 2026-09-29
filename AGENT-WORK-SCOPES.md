# Реестр активных работ по серверу

Заведён 29.09.2026 по прямому указанию владельца, вслед за
`/Users/max/Проекты/TaskFlowNativeBuild/AGENT-WORK-SCOPES.md` (иOS-репозиторий
ведёт такой реестр с самого начала). Здесь — то же самое, но для
`/home/maksim/Проекты/New-Todoist` (сервер + веб): что сейчас в работе, какими
файлами, зачем и что уже проверено. Открыл длинную многошаговую работу —
заведи строку `IN_PROGRESS`; закончил или уткнулся в лимит — переведи в
`REVIEW`/`BLOCKED` и опиши состояние, чтобы следующая сессия не гадала.

| Lock ID | Статус | Scope ID | Что делаем | Разрешённые/затронутые файлы | Цель / контекст | Исполнитель | Проверено |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LOCK-T03-01 | IN_PROGRESS | COLLABORATION-PLAN-T03-ARTIFACT-CONTRACT | Первый исполняемый шаблон совместной работы T03 «Продуктовая фича» — версионируемые артефакты между ролями одной карточки поверх существующих `task_dependencies`/`TaskContext v1` | `server/src/migrations.ts` (075/076), `server/src/routes/task-collaboration-plans.ts`, `server/src/routes/task-role-slots.ts`, `server/src/runtime/collaborationPlanContext.ts` (новый), `server/src/runtime/inProcessRun.ts`, `server/src/runtime/taskContextBridge.ts`, `server/scripts/task_context.py`, `server/scripts/task_context_bridge.py`, тесты рядом с каждым. iOS-файлы НЕ трогать до отдельного согласования (см. handoff) | Дизайн и план — `/Users/max/Проекты/TaskFlowNativeBuild/docs/2026-09-29-collaboration-plan-templates/` (HANDOFF-T03-CONTRACT.md, t03-product-feature/T03-IMPLEMENTATION-PLAN.md). Прошлая сессия дошла до середины Task 2 и упёрлась в лимит, не закоммитив готовую работу — эта сессия нашла её в рабочем дереве, проверила тестами и закоммитила, затем продолжила с Task 3 | Claude Sonnet 5 | Task 1 (`4b848568`) и Task 2 (`96a3f13`) — контракты node/edge и версии slot-артефактов с gate-логикой, `tsc` чисто, `npm test` 611/611. Task 3 (`c62e041`) — `collaborationPlanContext.ts` строит прямой (не транзитивный) контекст предшественников, проброшен в `TaskContext v1` через оба бридж-слоя (TS + Python), событие `collaboration_context_used` пишется в `task_events`; `tsc` чисто, `npm test` 616/616 (server), `python3 scripts/test_task_context.py` 16/16. Живой E2E прогон через реальный HTTP-flow (approve → submit → accept → автостарт delivery) — адресным тестом `inProcessRun.test.ts`, не ручным curl. Осталось: Task 4 (T03 template profile `product_feature` с `include_architecture`/`include_design`/`include_qa`) и Task 5 (полная регрессия + запись evidence в хендофф, отдельный E2E на реальной БД). |
