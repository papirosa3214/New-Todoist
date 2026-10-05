# MAK-54 — поля ввода, тумблер, шторки, состояния (2026-10-05)

Эталон iOS (`/Users/max/Documents/deepseek-harness/default-workspace/taskflow-design-system/DESIGN-SYSTEM.md` §2.7–2.8) перенесён в веб как общие компоненты в `src/components/UI.tsx` (`TextField`, `Switch`, `SheetHeader`, `EmptyState`, `Loading`, `ErrorBanner`). Локальные копипасты выпилены из SettingsScreen, TaskFilterSheet, ChatsScreen, NotesScreen. Заголовки 7 шторок переведены на общий `SheetHeader`.

Кадры снимаются скриптом `scripts/screenshot-mak54.mjs` (требует dev-сервер на :5180 + бэкенд :3001 с `TASKFLOW_LAN_NO_AUTH=1` и реальный chromium с UA Mozilla/*).

| Кадр | Что видно |
| --- | --- |
| `01-settings.png` | `Switch` (тема), `TextField` (поиск), `FieldGroup`, `Button` |
| `02-task-filter.png` | `SheetHeader` (крестик/заголовок «Фильтры»/«Сбросить»), `Switch` (выполненные), `TextField` в карточке фильтра |
| `02-today-base.png` | Базовое состояние «Сегодня» (контекст для 02) |
| `03-reschedule.png` | `SheetHeader` с круглой red-кнопкой ✓ (подтверждение даты) — есть только при наличии просроченных |
| `04-task-journal.png` | `SheetHeader` с ✓ (отправка заметки) — открывается из карточки задачи |
| `05-chats-list.png` | Список чатов |
| `05-chat-room.png` | Комната чата (контекст для 05-chat-stats) |
| `05-chat-stats.png` | `SheetHeader` без действия (пустой слот 44×44) |
| `06-agents.png` | Список ролей (контекст для 06) |
| `06-role-context.png` | `SheetHeader` без действия с длинным заголовком `Контекст запуска: <role>` |
| `07-attachment.png` | `SheetHeader` с `actionVariant="plain"` (иконка-стрелка без подложки) — есть только если у задачи есть вложение |
| `08-chats.png` | Список чатов: если пустой — `EmptyState` с иконкой в плашке и кнопкой «Новый чат» |

Кадры снимаются попарно в `light/` и `dark/`.

## Что изменилось

- `src/components/UI.tsx` — добавлены `SheetHeader`, `Switch`, `EmptyState` (ранее жили копипастой в 2–8 местах).
- `src/screens/SettingsScreen.tsx` — удалена локальная `Switch`, импортируется из UI.
- `src/components/TaskFilterSheet.tsx` — заголовок → `SheetHeader` с `textAction="Сбросить"`; обе локальные копипасты `Switch` (фильтр «Показывать выполненные» и планер по проектам) → импорт из UI.
- `src/components/ChatStatsSheet.tsx`, `AttachmentViewerSheet.tsx`, `TasksFromTextSheet.tsx`, `RescheduleSheet.tsx`, `TaskJournal.tsx`, `RoleContextSheet.tsx` — заголовки → `SheetHeader`.
- `src/screens/ChatsScreen.tsx`, `src/screens/NotesScreen.tsx` — локальные `EmptyState` удалены, используется общий (`variant="icon"` / `"plain"`).
- `DESIGN.md` — добавлена секция «Поля ввода, тумблер, шторки, состояния» со ссылками на реализацию.
- `scripts/screenshot-mak54.mjs` — скрипт съёмки для приёмки (402×874, свет/тьма).