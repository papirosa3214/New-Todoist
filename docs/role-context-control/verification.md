# Контекст запуска ролей — серверная реализация

Точка входа в полную карту и аудит: `/Users/max/Проекты/TaskFlowNativeBuild/docs/2026-09-30-role-context-control/{sources,text-audit,verification}.md`. Серверная ветка `codex/role-context-control` содержит исходный commit `65c60a4` с работой архитектора и завершение resolver/runtime/API/web поверх него.

Проверка на Mac: `npm run build` в `server/` прошёл; `npx vitest run` — 95 файлов / 700 тестов; Python MCP snapshot test — 1/1; `py_compile` для `mcp_server.py` и voice worker прошёл. Серверный тест Unix voice bridge подтверждает, что следующая голосовая сессия получает новую инструкцию. Реальный live запуск роли и deploy на `.110` ещё не проводились.

Открытая граница: верхний `npm run build` для веба пока падает в `CollaborationPlanPanel`, `DayHours`, `UpcomingCalendar`, `LabelTasksScreen` — эти файлы вне данного изменения. Правки live дефолтов ролей отложены до просмотра `text-audit.md` владельцем.
