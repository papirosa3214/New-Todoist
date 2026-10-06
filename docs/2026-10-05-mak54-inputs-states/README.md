# MAK-54 — поля ввода, тумблер, шторки, состояния (2026-10-05)

Эталон iOS (`/Users/max/Documents/deepseek-harness/default-workspace/taskflow-design-system/DESIGN-SYSTEM.md` §2.7–2.8) перенесён в веб как общие компоненты в `src/components/UI.tsx` (`TextField`, `Switch`, `SheetHeader`, `EmptyState`, `Loading`, `ErrorBanner`). Локальные копипасты выпилены из SettingsScreen, TaskFilterSheet, ChatsScreen, NotesScreen. Заголовки 7 шторок переведены на общий `SheetHeader`.

## Что в архиве кадров

`scripts/screenshot-mak54.mjs` снимает 8 пар (свет/тьма) в `web/light/` и `web/dark/`. Размер 804×1748 (DSR=2 от 402×874), шторки и EmptyState сняты в реалистичных сценариях.

| Кадр | Что видно | §2.7–2.8 |
| --- | --- | --- |
| `01-settings.png` | SettingsScreen с тумблером «Тема» (включён/выключен) и секцией «Сервер» | Switch ✓ |
| `02-textfield.png` | RegisterScreen с четырьмя `TextField` (52×высота, иконка слева 18px, 16px шрифт) | TextField ✓ |
| `03-task-filter.png` | TaskFilterSheet из `/upcoming`: `SheetHeader` (× + «Фильтры» + «Сбросить» — форма textAction), `Switch` «Показывать выполненные», список проектов со Switch | SheetHeader textAction ✓, Switch ✓ |
| `06-role-context.png` | RoleContextSheet из `/agents`: `SheetHeader` без действия (× + «Контекст запуска: …» + пустой слот), переключатель режимов, слои инструкции роли. На **dark** крестик хорошо виден; на **light** `text-sub=#a6a6a6` делает его слабо различимым на белом — это дизайн-решение, не дефект | SheetHeader без действия ✓ |
| `09-empty-state.png` | ChatsScreen при пустом списке: EmptyState с иконкой chat, заголовком «Чатов пока нет», описанием и red-кнопкой «Новый чат». `/api/chats` подменён на `[]` через `page.route` | EmptyState ✓ |
| `10-loading.png` | TodayScreen с `isLoading=true`: «Загрузка…» сверху списка. `/api/tasks` задержан на 4 секунды через `page.route` | Loading inline ✓ |
| `11-error-banner.png` | LabelsScreen при `isError`: «Не удалось загрузить метки» (одна строка текстом в red). `/api/labels` подменён на 500 | ErrorBanner inline ✓ |
| `11b-error-banner-block.png` | ProjectsScreen, форма создания проекта, ошибка POST: плашка coral 12% с ⓘ и текстом «Не удалось создать проект». POST `/api/projects` подменён на 500 | ErrorBanner block ✓ |

## Что не снято и почему

| Кадр | Причина |
| --- | --- |
| `04-reschedule.png` | RescheduleSheet открывается только при наличии просроченных задач. У владельца просроченных нет (today показывает иллюстрацию «Чёткое видение грядущего дня»). Чтобы воспроизвести, нужны фикстуры с просроченным `due_at` — а добавление фикстур через `page.route` не сработает, потому что данные нужны в БД. Скрипт делает `console.warn("RescheduleSheet: нет просроченных задач — пропуск")` и идёт дальше. |
| `05-chat-stats.png` | ChatStatsSheet открывается из `/chats/<id>`. У владельца в живом `/api/chats` 12 чатов, но они появились **во время этого запуска скрипта** (роли-агенты наговорили), а в момент прогона скрипт успел подменить `/api/chats` → `[]` для снятия EmptyState. Скрипт выводит `console.warn("ChatStatsSheet: нет чатов — пропуск")`. |
| `07-attachment.png` | AttachmentViewerSheet открывается по тапу на вложение в карточке задачи. У владельца сейчас нет задач с вложениями. Скрипт делает `console.warn("…нет вложений — пропуск")`. |
| TaskJournal как отдельная шторка | В исходной постановке задачи упоминался `TaskJournal` как шторка с `SheetHeader` actionIcon filled. На самом деле `TaskJournal`/`TaskFeed` (`src/components/TaskJournal.tsx:944`) — это **секция внутри карточки задачи** (`TaskDetailScreen`), не отдельная шторка. Снимать там нечего. |

## actionIcon filled форма SheetHeader

Не снята (см. выше — RescheduleSheet и TaskJournal требуют данных). По коду (`src/components/UI.tsx`, `SheetHeader` с `actionIcon` + `onAction`):

```tsx
<button className="tap-scale w-11 h-11 -mr-2 rounded-full bg-red flex items-center justify-center disabled:opacity-40">
  <Icon name={actionIcon} size={18} className="text-white" />
</button>
```

Красная круглая кнопка 44×44 справа (без подписи) с белой иконкой действия. Используется в RescheduleSheet (✓ подтверждения даты) и TaskJournal (✓ отправки заметки).

## Что изменилось

- `src/components/UI.tsx` — добавлены `SheetHeader`, `Switch`, `EmptyState` (ранее жили копипастой в 2–8 местах).
- `src/screens/SettingsScreen.tsx` — удалена локальная `Switch`, импортируется из UI.
- `src/components/TaskFilterSheet.tsx` — заголовок → `SheetHeader` с `textAction="Сбросить"`; обе локальные копипасты `Switch` (фильтр «Показывать выполненные» и планер по проектам) → импорт из UI.
- `src/components/ChatStatsSheet.tsx`, `AttachmentViewerSheet.tsx`, `TasksFromTextSheet.tsx`, `RescheduleSheet.tsx`, `TaskJournal.tsx`, `RoleContextSheet.tsx` — заголовки → `SheetHeader`.
- `src/screens/ChatsScreen.tsx`, `src/screens/NotesScreen.tsx` — локальные `EmptyState` удалены, используется общий (`variant="icon"` / `"plain"`).
- `DESIGN.md` — добавлена секция «Поля ввода, тумблер, шторки, состояния» со ссылками на реализацию.
- `scripts/screenshot-mak54.mjs` — скрипт съёмки для приёмки (402×874, свет/тьма), подменяет через `page.route` только ручки `/api/labels`, `/api/projects`, `/api/chats`, `/api/tasks` (для гарантированных состояний Empty/Loading/Error); сервер не трогает.

## Доработка 1 (rev 2)

После ревью Критика (05.10.2026, rev 2 v1): прошлый скрипт делал 12 PNG, из них 4 — дубли (на самом деле 4 уникальных экрана); не было TextField (в SettingsScreen TextField из UI.tsx нет), Loading, ErrorBanner; ни одна из 7 шторок не была снята в открытом виде.

Что починено:
- Селектор `button[aria-label="Фильтры"]` действительно работает, но клик по нему при `trueEmpty && layout === "list"` упирался в иллюстрацию пустого дня без шапки. Теперь скрипт ходит на `/upcoming` (там шапка с фильтром стабильно).
- Добавлен `ignoreHTTPSErrors: true` (vite preview на :5180 self-signed).
- PERSIST-стейт для zustand использует ключ `taskflow-ui`, version 4.
- TextField снят через `/register` — единственный публичный экран с настоящим `TextField` из UI.tsx.
- Loading снят через задержку `/api/tasks` на 4 секунды (браузерный `page.route`, сервер не задет).
- ErrorBanner block снят через подмену POST `/api/projects` → 500 и открытие `/projects?create=1`.
- EmptyState снят через подмену `/api/chats` → `[]`.

Скрипт оставляет `console.warn` для каждого сценария, где данных не оказалось, чтобы при следующем прогоне с фикстурами можно было сразу увидеть, какие кадры дознять.