# Карточки разбора бюджета действий (LOCK-CHAT-BUDGET-CASES-20261026)

Статус: IN_PROGRESS. Исполнитель: Codex. Поручение владельца: 100 + 50 действий на пункт,
приватные карточки с материалами, без автозапуска.

## Что происходит

1. Пункт плана получает 100 основных действий (настройка `chat_item_max_actions`).
2. Когда они кончаются, ход роли перезапускается в **новой сессии** ещё на 50 действий.
3. Материалы первого хода (события, системный промпт, файл сессии) сохраняются в
   приватную карточку разбора: таблица `chat_budget_cases`, миграция `179_chat_budget_cases`.
4. Продолжение запускает вызывающий код (PiRuntimeAdapter), а не карточка:
   `budgetContinuationPrompt` собирает промпт, `safelyCaptureBudgetCases` кладёт материалы.

## API

| Функция | Смысл |
|---|---|
| `BUDGET_CASE_SCHEMA` | SQL схемы карточек, применяется миграцией 179 |
| `openBudgetCase({id, chatId, roleId, itemId, title, used, base, total})` | открыть карточку в момент исчерпания базовых действий |
| `updateBudgetCase(caseId, used)` | учесть ещё одно действие в карточке |
| `safelyCaptureBudgetCases(chatId, roleId, {sessionFile, systemPrompt, events, error})` | сохранить материалы хода; никогда не бросает |
| `budgetContinuationPrompt(chatId, roleId)` | промпт продолжения в новой сессии; `null`, если карточки нет |
| `startBudgetCaptureWatcher()` | раз в 15 минут напоминает владельцу о карточках без материалов; автозапуска хода не делает |

## Таблица

`chat_budget_cases`: `id`, `created_at`, `updated_at`, `chat_id`, `role_id`, `item_id`, `title`,
`used`, `base`, `total`, `materials` (0/1), `session_file`, `system_prompt`, `events`, `error`.

## Восстановление 26.10.2026

Файл `server/src/runtime/chatBudgetCases.ts` был незакоммиченной работой роли и потерян
при уборке рабочего дерева. Восстановлен заново по контракту из импортов
(`chatActionBudget.ts`, `PiRuntimeAdapter.ts`, `migrations.ts`, `index.ts`) и по смыслу задачи.
Реализация может отличаться от оригинала в деталях; перед merges её стоит
пересмотреть вместе с ролью-исполнителем.