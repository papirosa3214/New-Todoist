# pages.md — деревья зависимостей ключевых маршрутов

Локальные импорты прослежены рекурсивно (node_modules пропущены, `.css` и
`.tsx/.ts` разрешаются с расширением). В скобках — число строк файла.
Это набор-кандидат для `--context-file` при генерации дизайна: по дереву сразу
видно, какие примитивы экран тянет за собой.

**Главная цель — `/task/:id` → `src/screens/TaskDetailScreen.tsx`** (53 локальных
модуля). Это рабочее пространство задачи: чат, сотрудничество агентов, план/граф.

Общие для почти всех деревьев узлы (вынесены один раз, дальше помечены `↩`):
`src/components/UI.tsx` (2139), `src/lib/useSpring.ts` (149),
`src/lib/haptics.ts` (142), `src/lib/navItems.ts` (52), `src/lib/priority.ts` (40),
`src/lib/appleIntegrations.ts` (411), `src/lib/errors.ts` (48),
`src/lib/date.ts` (282), `src/api/types.ts` (430), `src/api/client.ts` (210),
`src/api/tasks.ts` (325), `src/lib/useBottomSheet.ts` (263),
`src/components/CreateMenu.tsx` (127), `src/components/AnimatedTabBar.tsx` (132),
`src/lib/useGuardedCallback.ts` (62), `src/components/Dialog.tsx` (184).

---

## 1. `/task/:id` — карточка задачи ★ главная цель

`src/screens/TaskDetailScreen.tsx` (1011) — **53 локальных модуля**

### 1.1 Прямые импорты экрана

```
TaskDetailScreen.tsx
├── components/UI.tsx (2139)                      ← иконка, Avatar, ScreenHeader, Loading,
│                                                   ErrorBanner, PriorityArrows, ReadyFlag, Button
├── components/TaskJournal.tsx (1034)             ← AgentStatusRow, AgentOwnerActions, TaskFeed
├── components/SubtaskFeed.tsx (768)              ← чек-лист шагов, форма возврата
├── components/TaskFields.tsx (1370)              ← PRIORITIES, DueDateField, LabelsField, SubtaskRow
├── components/TaskRow.tsx (905)                  ← дочерние задачи
├── components/CollaborationPlanPanel.tsx (98)    ← «граф» плана
├── components/AttemptLadderBadge.tsx (26)        ← лестница моделей
├── components/AttachmentView.tsx (171)           ← вложения задачи
├── components/MicKeyboardBar.tsx (170)           ← кнопка микрофона в портале
├── components/MicOverlay.tsx (83)                ← оверлей записи
├── components/MarkdownInline.tsx (40)            ← markdown в заголовке
├── lib/useMicRecorder.ts (257)                   ← запись/диктовка
├── lib/dictationParser.ts (499)                  ← разбор надиктованного текста
├── lib/liveActivity.ts (322)                     ← Dynamic Island
├── lib/templates.ts (153)                        ← сохранение в шаблоны
├── lib/taskOwner.ts (91)                         ← isTaskOwner
├── lib/pluralize.ts (12)
├── api/tasks.ts (325)                            ← useTask, useUpdateTask, useTasks
├── api/subtasks.ts (69)                          ← toggle / return / comment по шагу
├── api/comments.ts (25)
├── api/attachments.ts (68)                       ← загрузка, удаление
├── api/projects.ts (103)
├── api/auth.ts (73)
├── api/client.ts (210)
├── api/types.ts (430)
└── …плюс транзитивно ↓
```

### 1.2 Транзитивные модули (полный список 53)

**Компоненты (13 дополнительно):**
`Dialog.tsx` (184) · `TaskControlSheet.tsx` (212) · `ActionsMenu.tsx` (242) ·
`AttachmentViewerSheet.tsx` (153) · `MicRing.tsx` (219) · `AnimatedTabBar.tsx` (132) ·
`CreateMenu.tsx` (127)

**API (11):** `ws.ts` (266) · `audio.ts` (52) · `roles.ts` (65) · `agents.ts` (143) ·
`control.ts` (56) · `collaborationPlans.ts` (70) ↩ плюс перечисленные выше

**Lib (17):** `useSpring.ts` (149) · `haptics.ts` (142) · `localAI.ts` (207) ·
`localLLM.ts` (96) · `navItems.ts` (52) · `priority.ts` (40) · `pluralize.ts` (12) ·
`taskOwner.ts` (91) · `templates.ts` (153) · `markdownInline.ts` (156) ·
`useBottomSheet.ts` (263) · `useMicRecorder.ts` (257) · `dictationParser.ts` (499) ·
`useTaskActivity.ts` (224) · `appleIntegrations.ts` (411) · `errors.ts` (48) ·
`date.ts` (282) · `useGuardedCallback.ts` (62) · `useVisualViewportInset.ts` (232)

### 1.3 Что и в каком порядке рисует экран

```
<div className="px-4 pb-[calc(1rem+var(--kb-inset,0px))]">
├── Toast: шаблоны / Dynamic Island (fixed top-4, bg-card, border, rounded-xl)
├── ScreenHeader variant="compact" title="" actions={…}
│     actions: activity 18 (Dynamic Island) · bookmark 18 (шаблон) · trash/archive 18
│     → три кнопки w-[40px] h-[44px] tap-scale, отступ -ml-2.5 у стрелки «назад»
├── <div className="tf-caption text-dim">{task.id.slice(0, 8)}</div>   ← короткий id
├── Бейдж проекта: Icon hash 10 + название, цвет проекта, tf-caption, без заливки
├── (если task.archived_at) плашка «Задача в архиве» bg-card2 tf-meta
├── Заголовок: h1.tf-task-title + MarkdownInline; line-through+text-sub если completed
│     справа ReadyFlag size={16} (зелёный флаг готовности)
├── ErrorBanner variant="block" (updateTask)
├── Описание: p.tf-row.text-sub.leading-relaxed.whitespace-pre-wrap
├── task.attachments → AttachmentView[]
├── Блок метаданных (space-y-[2px], каждая строка bg-card rounded-xl py-3 px-4):
│     ├── Срок: Icon calendarSmall 18 text-red + tf-row.text-red
│     │        «Сегодня, 19 авг. · 13:45—14:30» (formatDueLabel + formatTimeRange)
│     ├── Приоритет: PriorityArrows size={13} + слово «Приоритет» цветом приоритета
│     ├── (ready_for_pickup) ReadyFlag 16 + «Флаг поднят — можно брать в работу» text-green
│     ├── (assignee) Avatar size={24} + tf-row.text-text
│     ├── AgentStatusRow            ← TaskJournal
│     ├── AttemptLadderBadge        ← попытка N/M → модель
│     └── CollaborationPlanPanel    ← «План совместной работы»
├── AgentOwnerActions (только владельцу, только когда релевантно)
├── Метки: flex flex-wrap gap-1.5, чипы px-2.5 py-1 rounded-lg, фон `${color}26`
├── [Табы — только если ЕСТЬ И subtasks И children]
│     <div className="flex gap-4 border-b border-sub/20 mb-4 px-1">
│       Чек-лист (N) | Команда (M)   ← tf-row pb-2 border-b-2,
│                                        активная: border-red text-text
├── SubtaskFeed (чек-лист) + ErrorBanner variant="block"
├── Дочерние задачи: tf-caption.text-sub «Дочерние задачи (N)» + TaskRow[]
├── Кнопки действий (space-y-2 mb-4):
│     ├── Завершить задачу (primary, check) — active и без agent_state
│     ├── Открыть задачу заново (secondary, refresh) — completed
│     ├── Готово к работе / Снять флаг готовности (primary/secondary, flag/check)
│     ├── Глубокое исследование: включено (secondary, search)
│     ├── Запустить исследование (primary, sparkles)
│     └── Изменить (outline, edit) → /task/:id/edit
├── Лента:
│     ├── h3.tf-action.text-sub.mb-2.px-1 «Лента»
│     ├── ErrorBanner (addComment)
│     ├── pending-вложения (bg-card rounded-xl h-11 + paperclip 14 + крестик)
│     ├── ErrorBanner (uploadAttachment)
│     ├── form: [скрепка 40×40] [input.tf-input bg-card rounded-xl px-3 py-2.5] [отправить bg-red 40×40]
│     ├── MicKeyboardBar (когда поле в фокусе и mic.state === "idle")
│     └── MicOverlay (когда recording/processing)
└── TaskFeed  ← TaskJournal
```

Порядок кнопок отправки: скрепка слева (40×40, `bg-card`, `text-sub`) —
отправка справа (`bg-red`, шеврон 16 повёрнут на `-rotate-90`). Обе зоны
добираются прозрачным `::before` на 2pt в каждую сторону до 44×44 HIG.

---

## 2. `/overview` — Обзор

`src/screens/OverviewScreen.tsx` (337) — 17 модулей

```
OverviewScreen.tsx
├── components/UI.tsx (2139)                     ← ScreenHeader (large), Card, ListRow, Icon…
├── components/WeeklySummaryModal.tsx            ← итоговая сводка за период
└── …транзитивно: CreateMenu, AnimatedTabBar, useBottomSheet,
                  appleIntegrations, date, errors, haptics, navItems,
                  priority, useGuardedCallback, useSpring, api/{tasks,types,client}
```

Сводный экран (поиск, свои проекты, «ждут вас»), **FAB скрыт** — задачу заводят
там, где её потом видно (просьба владельца 14.08.2026). Навигация остаётся.

---

## 3. `/projects` — Проекты

`src/screens/ProjectsScreen.tsx` (385) — 18 модулей

```
ProjectsScreen.tsx
├── components/UI.tsx (2139)                     ← ScreenHeader (large), ListRow, Dialog-подтверждение
├── components/Dialog.tsx (184)                  ← подтверждение удаления проекта
├── api/projects.ts (103)
└── …транзитивно ↩
```

---

## 4. `/projects/:id` — задачи проекта

`src/screens/ProjectTasksScreen.tsx` (166) — 17 модулей

```
ProjectTasksScreen.tsx
├── components/TaskRow.tsx (905)                 ← строки задач (с pinned/onTogglePin)
├── components/ProjectNotes.tsx                  ← заметки проекта
├── components/UI.tsx (2139)
└── …транзитивно ↩
```

См. комментарий в шапке файла: раскладка скопирована с `InboxScreen`.
Единственный экран, передающий в `TaskRow` пару `pinned` / `onTogglePin`.

---

## 5. `/today` — Ежедневник

`src/screens/TodayScreen.tsx` (732) — 21 модуль

```
TodayScreen.tsx
├── components/TaskBoard.tsx                     ← доска колонками (TaskBoard/BoardCard)
├── components/DayHours.tsx                      ← пул часов дня + поповер деталей
├── components/AppleCalendarEvents.tsx           ← события календаря Apple
├── components/TaskFilterSheet.tsx               ← фильтры шторкой
├── components/RescheduleSheet.tsx               ← перенос срока шторкой
├── components/ActionsMenu.tsx (242)              ← контекстное меню строки
├── components/TaskRow.tsx (905)                 ← список
├── components/UI.tsx (2139)
└── …транзитивно ↩
```

Единственный экран, который сам выбирает `className` у `ScreenHeader`
(`w-full` для пустого состояния). `overdue` у `TaskRow` — только здесь.
В режиме board FAB скрыт: под каждой колонкой есть своя пилюля «Добавить задачу».
Подписи дней 3-дневной сетки передаются в `ScreenHeader below`.

---

## 6. `/upcoming` — Планирование

`src/screens/UpcomingScreen.tsx` (1330) — **самый большой экран**, 25 модулей

```
UpcomingScreen.tsx
├── components/UpcomingCalendar.tsx              ← календарь планирования
├── components/DayHours.tsx                      ← сетка дней и часов
├── components/PlannerProjectChips.tsx           ← чипы проектов
├── components/TaskFilterSheet.tsx
├── components/AppleCalendarEvents.tsx
├── components/ActionsMenu.tsx (242)
├── components/TaskRow.tsx (905)
├── components/UI.tsx (2139)
└── …транзитивно ↩
```

`--shadow-sticky` (`0 10px 16px -12px`) живёт в блоке липкой шапки этого экрана.
`showDueBadge={false}` и `maxLabels={1}` у `TaskRow` — только здесь: дата уже
сказана группировкой экрана, вторая копия на строке читалась бы как «ровно
та же причина», что и на «Сегодня».

---

## 7. `/inbox-timeline` — таймлайн входящих

`src/screens/InboxScreenTimeline.tsx` — экспериментальный экран («POC
time-thread»), комментарий прямо в файле: «`InboxScreen.tsx` не трогаем — это
экспериментальный экран».

**Важно:** `/inbox` как маршрута **не существует** (удалён 26.08.2026: «зачем эти
входящие нам нужны, они по сути часть ежедневника»). `src/screens/InboxScreen.tsx`
остался в дереве, но **не подключён** — не рисовать для него дизайн.

---

## 8. `/chat` — служебный чат поверх задачи

`src/screens/ChatScreen.tsx` (531) — 29 модулей

```
ChatScreen.tsx
├── components/ChatComposer.tsx (625)            ← строка ввода (заменяет нижнюю навигацию)
├── components/ChatStatsSheet.tsx (185)          ← статистика шторкой
├── components/MicRing.tsx (219)                 ← кольцо записи
├── components/MicOverlay.tsx (83)
├── components/ActionsMenu.tsx (242)
├── components/UI.tsx (2139)
├── api/chat.ts (271)                            ← своя лента поверх задачи
├── api/notifications.ts (46)
├── api/attachments.ts (68)
├── lib/useMicRecorder.ts (257)
├── lib/dictationParser.ts (499)
├── lib/localAI.ts (207)
└── …транзитивно ↩
```

**Единственный экран без нижней навигации** (`Layout.hideNav`). Выход с него
переехал в шапку — кнопка «назад» в «Обзор». Убрать исключение можно только
вместе со строкой ввода, иначе с `/chat` будет некуда уйти.

Не путать с `/chats` — там отдельные сущности «чат с ролью/ролями».

---

## 9. `/chats` и `/chats/:id` — чаты с ролями

**`/chats` → `src/screens/ChatsScreen.tsx` (233) — 20 модулей**

```
ChatsScreen.tsx
├── screens/CreateChatSheet.tsx (270)            ← шторка нового чата (компонент, не маршрут)
├── api/chats.ts (206)
├── api/agents.ts (143)
├── api/ws.ts (266)
└── …транзитивно ↩
```

**`/chats/:id` → `src/screens/ChatRoomScreen.tsx` (423)**

```
ChatRoomScreen.tsx
├── components/Dialog.tsx (184)
├── components/UI.tsx (2139)
└── …транзитивно ↩
```

---

## 10. `/agents` — роли-агенты

`src/screens/AgentsScreen.tsx` (799) — 24 модуля

```
AgentsScreen.tsx
├── components/RoleContextSheet.tsx (482)         ← шторка контекста роли
├── components/Dialog.tsx (184)                  ← подтверждения владельца
├── lib/useRowSwipe.ts (188)                     ← свайп по строке
├── api/roles.ts (65)
├── api/avatars.ts (33)
├── api/agents.ts (143)
├── lib/taskOwner.ts (91)
└── …транзитивно ↩
```

---

## 11. `/tasks/archive` — архив задач

`src/screens/TaskArchiveScreen.tsx` (191) — 18 модулей

```
TaskArchiveScreen.tsx
├── components/Dialog.tsx (184)                  ← «Удалить навсегда?»
├── lib/pluralize.ts (12)
└── …транзитивно ↩
```

Мягкое удаление, затем окончательное — **только** здесь, доступ владельцу.
Обычный путь «удалить» в строке/карточке отправляет задачу сюда же (серверный
`DELETE`). На карточке задачи (`/task/:id`) для архивной задачи кнопки в шапке
меняются на «Вернуть» (`restore`, `text-blue`) и «Удалить навсегда»
(`trash`, `text-coral`).

---

## 12. `/projects/archive` — архив проектов

`src/screens/ProjectArchiveScreen.tsx` (172) — 19 модулей

```
ProjectArchiveScreen.tsx
├── components/Dialog.tsx (184)
├── api/projects.ts (103)
├── lib/pluralize.ts (12)
└── …транзитивно ↩
```

Маршрут объявлен в роутере **раньше** `/projects/:id` — статический сегмент
ранжируется выше динамического, поэтому архив не попадает в карточку проекта.

---

## 13. `/library` — библиотека

`src/screens/LibraryScreen.tsx` (123) — 15 модулей. Самая лёгкая полноценная
страница: тянет только `UI.tsx`, `CreateMenu`, `AnimatedTabBar` и стандартный
набор lib/api.

```
LibraryScreen.tsx
└── components/UI.tsx (2139)
    + lib/{appleIntegrations, date, errors, haptics, navItems, priority,
           useSpring, useBottomSheet, useGuardedCallback}
    + components/{CreateMenu, AnimatedTabBar, Dialog}
    + api/{tasks, types, client}
```

---

## 14. `/activity` — активность

`src/screens/ActivityScreen.tsx` (791) — 20 модулей

```
ActivityScreen.tsx
├── components/ActivityChart.tsx (750)            ← график
├── components/TaskFields.tsx (1370)
├── components/MarkdownInline.tsx (40)
├── components/UI.tsx (2139)
├── lib/markdownInline.ts (156)
└── …транзитивно ↩
```

Намеренно **не** вкладка (drill-down из «Обзора»).

---

## 15. Прочие экраны без детального дерева

Все они — тянaщие `UI.tsx` + стандартный набор lib/api, ничего уникального
в дереве не вносят. Размеры для контекста:

| Маршрут | Экран | Строк |
| --- | --- | --- |
| `/settings` | `SettingsScreen.tsx` | — |
| `/settings/voice-models` | `VoiceModelsScreen.tsx` | — |
| `/settings/integrations` | `IntegrationsScreen.tsx` | — |
| `/settings/providers` | `ProvidersScreen.tsx` | — |
| `/settings/templates` | `TemplatesScreen.tsx` | — |
| `/task/new`, `/task/:id/edit` | `TaskFormScreen.tsx` | — |
| `/notifications` | `NotificationsScreen.tsx` | — |
| `/agent-work` | `AgentWorkScreen.tsx` | — |
| `/labels`, `/labels/:id` | `LabelsScreen.tsx`, `LabelTasksScreen.tsx` | — |
| `/search` | `SearchScreen.tsx` | — |
| `/notes`, `/notes/:id` | `NotesScreen.tsx`, `NoteEditorScreen.tsx` | tiptap |
| `/timeline` | `TodayScreenTimeline.tsx` | — |
| `/login`, `/register` | `LoginScreen.tsx`, `RegisterScreen.tsx` | вне Layout |

---

# Контекст продукта: роли, состояния, попытки

Это то, ради чего `/task/:id` и нужен в дизайне. Всё прочитано из кода, ничего
не додумано.

## Роли (7) — `server/src/roleRouting.ts:29–37`

Роли — **данные, а не код**: таблица `roles` (миграция 056), начальный состав
`DEFAULT_ROLES`. Учётка роли — `role_<ключ>`.

| key | title | summary |
| --- | --- | --- |
| `researcher` | Исследователь | узнать, найти, сравнить варианты вне нашего кода и свести найденное в выводы или документ |
| `analyst` | Аналитик | посчитать цифры, метрики, деньги |
| `critic_verifier` | Критик-проверяющий | проверить готовую работу и вынести вердикт |
| `architect` | Архитектор | продумать устройство системы до кода, когда решений несколько |
| `builder` | Разработчик | пишет и чинит код: сервер, приложение, веб |
| `qa` | Лайф-тестировщик | пройти сценарии в живом приложении и найти баги |
| `designer` | Дизайнер | как выглядит: макет, экран, отступы, цвета |

## Два РАЗНЫХ набора состояний — не путать

### A. Состояние задачи (`agent_state`) — 3 значения + `null`

`src/api/types.ts:162`: `type AgentState = "in_progress" | "blocked" | "review"`.
Ставится исключительно через `POST /api/tasks/:id/{claim,state}`.
`null` = «никто не взял». Ортогонально `status`: задача остаётся `status:"active"`
всё время работы агента.

Плюс серверное `agent_stale` → в UI подаётся как «Агент пропал».

### B. Состояние узла плана (`execution_state`) — 8 значений

Вычисляется на сервере (`server/src/routes/task-collaboration-plans.ts:91–95`):

```
нет подзадачи                        → 'waiting'
done && result начинается с
  'changes_requested:'              → 'returned'
done                                → 'accepted'
agent_state === 'in_progress'       → 'active'
agent_state === 'blocked'           → 'blocked'
canPlanSubtaskBecomeReady(step)     → 'ready'
иначе                              → 'waiting'
```

Подписи и тона — в `CollaborationPlanPanel.tsx` (см. `components.md`).
**Тона заданы только для 5 состояний из 8**: `returned`, `blocked`, `skipped`
попадают в `?? STATE_TONE.waiting` и рисуются как «Ждёт».

### C. Состояние подзадачи в чек-листе (`SubtaskState`) — 5 значений

`src/components/SubtaskFeed.tsx:48–49`: `"done" | "running" | "pending" | "blocked" | "review"`.
Отдельный набор от обоих предыдущих.

## Доработка (rework) — как на самом деле

**Доработка НЕ создаёт новую попытку в том же слоте.** Вместо этого
`server/src/runtime/planMutations.ts:259–300` при `op: "rework"` создаёт
**ДВА новых узла плана**:

1. `<role>_fix` — роль-исполнитель (по умолчанию `builder`),
   `expected_result = "Доработка по замечаниям (<роль проверяющего>): <defects>"`,
   `instructions = defects`, `origin: "rework"`, `iteration: from.iteration + 1`,
   `rework_of_key: from.slot_key`.
2. `<role>_recheck` — роль проверяющего, `expected_result = "Повторная
   проверка после доработки: <исходный expected_result>"`, те же `origin`,
   `iteration`, `rework_of_key`.

Условия: на доработку отправляет **только** проверяющая роль
(`CHECKER_ROLES = {qa, critic_verifier}`), `defects` обязателен, лимит —
`MAX_REWORK_ROUNDS = 2` («круги доработки исчерпаны — решение за владельцем»).
Исходный узел не удаляется: слоты `*_fix` и `*_recheck` получают новые имена
через `freshSlot`.

Поля узла, доступные UI (`task-collaboration-plans.ts:108–113`):
`instructions`, `origin` (`"template"` | `"owner"` | `"role"` | `"rework"`),
`added_by`, `added_reason`, `iteration`, `rework_of_key`, `skipped_at`,
`skip_reason`.

## Операции над планом (`PlanOp`, `planMutations.ts:41–47`)

`request_help` · `add_step` · `update_step` · `remove_step` · `skip_step` · `rework`
(через `POST`, тело: `{kind, from_slot, role?, defects, …}`).

Лимиты: `ROLE_GROWTH_MAX_NODES = 12` (до скольких узлов план может вырасти по
инициативе ролей), `ROLE_ADDED_STEPS_MAX = 3` (сколько шагов одна роль добавит
сама).

Начатый или сданный шаг **не меняют** — это история (`PlanOpError` 409:
«шаг уже начат, сдан или пропущен — его не меняют, это история»).

## Профили плана

`single_executor` «Один исполнитель» · `research` «Исследование» ·
`delivery` «Доставка» · `full_cycle` «Полный цикл» · `manual` «Вручную».

Показывается только план со `status === "approved"`.

## Архив: soft-delete, затем окончательный

- Обычный путь «удалить» → задача получает `archived_at`, попадает в
  `/tasks/archive` (или `/projects/archive`).
- **Окончательное удаление — только внутри архива.** Доступно только владельцу.
- На `/task/:id` архивной задачи шапка даёт «Вернуть» и «Удалить навсегда»
  вместо обычной «В архив»; островок и шаблонизация недоступны (задача неактивна).
- На живой карточке сразу под шапкой появляется плашка
  `bg-card2 text-sub tf-meta` с иконкой `archive`: «Задача в архиве. Действия
  в шапке: вернуть в обычные списки или стереть навсегда.»