# routes.md — карта маршрутов TaskFlow

Источник: `src/App.tsx` (217 строк), `react-router-dom`. Все маршруты объявлены
одним блоком `<Routes>`; вложенность = оболочка (`Layout`), а не отдельные layout-компоненты.
Аутентификация — через `<RequireAuth>` (`src/components/RequireAuth.tsx`).

## Оболочки

| Оболочка | Файл | Что оборачивает |
| --- | --- | --- |
| `Layout` | `src/components/Layout.tsx` (400) | все маршруты внутри `<RequireAuth>`: мобильный `BottomNav` + pull-to-refresh + swipe-back; десктопный `SideNav` + колонка 880px + `TaskDetailPanel` |
| `RequireAuth` | `src/components/RequireAuth.tsx` | проверка токена, редирект на `/login` |
| `RealLocationProvider` | `src/lib/backgroundLocation.tsx` | отдаёт «настоящий» location вниз; `<Routes location={background ?? location}>` — модальный роут для десктоп-панели задачи |
| — (без оболочки) | — | `/login`, `/register`, `*` (404) |

## Таблица маршрутов

| URL | Компонент | Файл экрана | Оболочка | Роль в навигации |
| --- | --- | --- | --- | --- |
| `/` | `<Navigate to="/overview" replace />` | — | Layout | редирект |
| `/login` | `LoginScreen` | `src/screens/LoginScreen.tsx` | **вне Layout** | вход, без навигации |
| `/register` | `RegisterScreen` | `src/screens/RegisterScreen.tsx` | **вне Layout** | регистрация, без навигации |
| `/today` | `TodayScreen` | `src/screens/TodayScreen.tsx` (732) | Layout | **вкладка** нижней навигации |
| `/overview` | `OverviewScreen` | `src/screens/OverviewScreen.tsx` (337) | Layout | **вкладка** + стартовый экран; FAB скрыт |
| `/upcoming` | `UpcomingScreen` | `src/screens/UpcomingScreen.tsx` (1330) | Layout | **вкладка** («Планирование») |
| `/chat` | `ChatScreen` | `src/screens/ChatScreen.tsx` (531) | Layout | **вкладка**; `BottomNav` скрыта (заменена строкой ввода) |
| `/timeline` | `TodayScreenTimeline` | `src/screens/TodayScreenTimeline.tsx` | Layout | вариант таймлайна «Сегодня» |
| `/inbox-timeline` | `InboxScreenTimeline` | `src/screens/InboxScreenTimeline.tsx` | Layout | экспериментальный таймлайн входящих |
| `/settings` | `SettingsScreen` | `src/screens/SettingsScreen.tsx` | Layout | drill-down из «Обзора» |
| `/settings/voice-models` | `VoiceModelsScreen` | `src/screens/VoiceModelsScreen.tsx` | Layout | подраздел настроек |
| `/settings/integrations` | `IntegrationsScreen` | `src/screens/IntegrationsScreen.tsx` | Layout | подраздел настроек |
| `/settings/providers` | `ProvidersScreen` | `src/screens/ProvidersScreen.tsx` | Layout | подраздел настроек (07.10.2026 сюда переехали модели ролей) |
| `/settings/roles-models` | `<Navigate to="/settings/providers" replace />` | — | Layout | редирект |
| `/settings/templates` | `TemplatesScreen` | `src/screens/TemplatesScreen.tsx` | Layout | подраздел настроек |
| `/task/:id` | `TaskDetailScreen` | `src/screens/TaskDetailScreen.tsx` (1011) | Layout | **основной экран дизайна** — карточка задачи |
| `/task/new` | `TaskFormScreen` | `src/screens/TaskFormScreen.tsx` | Layout | форма создания |
| `/task/:id/edit` | `TaskFormScreen` | `src/screens/TaskFormScreen.tsx` | Layout | форма редактирования |
| `/notifications` | `NotificationsScreen` | `src/screens/NotificationsScreen.tsx` | Layout | drill-down |
| `/chats` | `ChatsScreen` | `src/screens/ChatsScreen.tsx` (233) | Layout | список чатов с ролями-агентами |
| `/chats/:id` | `ChatRoomScreen` | `src/screens/ChatRoomScreen.tsx` (423) | Layout | комната чата с ролью/ролями |
| `/activity` | `ActivityScreen` | `src/screens/ActivityScreen.tsx` (791) | Layout | drill-down, намеренно НЕ вкладка |
| `/agents` | `AgentsScreen` | `src/screens/AgentsScreen.tsx` (799) | Layout | список ролей-агентов |
| `/agent-work` | `AgentWorkScreen` | `src/screens/AgentWorkScreen.tsx` | Layout | заход агента в работу |
| `/projects` | `ProjectsScreen` | `src/screens/ProjectsScreen.tsx` (385) | Layout | список проектов |
| `/projects/archive` | `ProjectArchiveScreen` | `src/screens/ProjectArchiveScreen.tsx` (172) | Layout | архив проектов |
| `/projects/:id` | `ProjectTasksScreen` | `src/screens/ProjectTasksScreen.tsx` (166) | Layout | задачи проекта |
| `/tasks/archive` | `TaskArchiveScreen` | `src/screens/TaskArchiveScreen.tsx` (191) | Layout | архив задач; доступ только владельцу |
| `/labels` | `LabelsScreen` | `src/screens/LabelsScreen.tsx` | Layout | список меток |
| `/labels/:id` | `LabelTasksScreen` | `src/screens/LabelTasksScreen.tsx` | Layout | задачи по метке |
| `/search` | `SearchScreen` | `src/screens/SearchScreen.tsx` | Layout | поиск |
| `/notes` | `NotesScreen` | `src/screens/NotesScreen.tsx` | Layout | дерево заметок (папки — на месте, без маршрута) |
| `/notes/:id` | `NoteEditorScreen` | `src/screens/NoteEditorScreen.tsx` | Layout | редактор заметки (tiptap) |
| `/library` | `LibraryScreen` | `src/screens/LibraryScreen.tsx` (123) | Layout | библиотека/справочник |
| `*` | `NotFoundScreen` (внутри `App.tsx`) | `src/App.tsx:49–71` | **вне Layout и вне auth** | 404: «Страница не найдена» |

Всего: **36 маршрутов**, из них 32 внутри `Layout`.

## Навигация и видимость навигации

Активная вкладка определяется списком `NAV_ITEMS` (`src/lib/navItems.ts`, 4 записи):

| `#` | path | label | icon |
| --- | --- | --- | --- |
| 0 | `/today` | Сегодня | `todayDate` (кастомная иконка с живым числом) |
| 1 | `/overview` | Обзор | `home` |
| 2 | `/upcoming` | Планирование | `calendarSmall` |
| 3 | `/chat` | Чат | `chat` |

Центр панели — не вкладка, а круглая кнопка создания (`AnimatedTabBar.centerAction`),
она открывает `CreateMenu` (Задача / Заметка / Проект).

`Layout.tsx` прячет нижнюю навигацию только на `/chat` (`hideNav`) — там её
заменяет строка ввода `ChatComposer`. FAB дополнительно скрыт на `/overview`
(просьба владельца: задачу заводят там, где её видно) и на доске «Сегодня» в
режиме board (там есть своя пилюля «Добавить задачу»).

Массив `TAB_ROUTES` в `Layout.tsx:64` объявлен как `const … void TAB_ROUTES;` —
то есть это справочный список, ни на что не влияет.

## Что по какому экрану рисуется — коротко

- **`/task/:id`** — главный экран: компактная `ScreenHeader` с пустым заголовком и
  тремя кнопками-иконками (Dynamic Island, шаблон, архив/удалить); короткий id
  задачи; бейдж проекта; заголовок с `MarkdownInline` + `ReadyFlag`; описание;
  вложения; блок метаданных (срок, `PriorityArrows`, флаг, исполнитель с `Avatar`,
  `AgentStatusRow`, `AttemptLadderBadge`, `CollaborationPlanPanel`); действия
  владельца (`AgentOwnerActions`); метки; табы «Чек-лист / Команда»;
  `SubtaskFeed`; дочерние `TaskRow`; кнопки действий; лента комментариев
  (`TaskFeed`) с полем ввода, скрепкой и `MicKeyboardBar`.
- **`/today`** — экран 732 строки: список или доска (`useAppStore.taskLayout.today`),
  пул часов `DayHours`, события календаря Apple, `TaskFilterSheet`, `RescheduleSheet`,
  `ActionsMenu` на строке.
- **`/upcoming`** — самый большой экран (1330 строки): 3-дневная сетка с подписями
  дней (`ScreenHeader.below`), `UpcomingCalendar`, `PlannerProjectChips`, поповер
  с деталями, `ActionsMenu`.
- **`/overview`** — 337 строк: сводный экран (поиск, свои проекты, «ждут вас»),
  плюс `WeeklySummaryModal`.
- **`/projects`** — список проектов + диалог создания.
- **`/projects/:id`** — задачи проекта, `ProjectNotes`, строки `TaskRow`.
- **`/chat`** — служебная переписка поверх задачи; строка ввода `ChatComposer`,
  `ChatStatsSheet`, `MicRing`/`MicOverlay`. Единственный экран без нижней навигации.
- **`/chats`** / **`/chats/:id`** — отдельные сущности «чат с ролью/ролями»;
  `ChatsScreen` открывает `CreateChatSheet` (`src/screens/CreateChatSheet.tsx`).
- **`/agents`** — список ролей с аватарами, `RoleContextSheet` (482 строки) по тапу.
- **`/tasks/archive`** — 191 строка: удалённые задачи, «Вернуть» и «Удалить навсегда».
- **`/projects/archive`** — 172 строки: то же для проектов.
- **`/activity`** — 791 строка + `ActivityChart` (750 строк).
- **`/library`** — 123 строки, самая лёгкая полноценная страница.

## Конфигурация роутера как есть

```tsx
// src/App.tsx:126–215
<RealLocationProvider location={location}>
  <Routes location={background ?? location}>
    {/* Auth (no layout) */}
    <Route path="/login" element={<LoginScreen />} />
    <Route path="/register" element={<RegisterScreen />} />

    {/* App shell (requires auth) */}
    <Route element={<RequireAuth />}>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/today" element={<TodayScreen />} />
        <Route path="/timeline" element={<TodayScreenTimeline />} />
        <Route path="/inbox-timeline" element={<InboxScreenTimeline />} />
        <Route path="/upcoming" element={<UpcomingScreen />} />
        <Route path="/overview" element={<OverviewScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/task/:id" element={<TaskDetailScreen />} />
        <Route path="/task/new" element={<TaskFormScreen />} />
        <Route path="/task/:id/edit" element={<TaskFormScreen />} />
        <Route path="/notifications" element={<NotificationsScreen />} />
        <Route path="/chat" element={<ChatScreen />} />
        <Route path="/chats" element={<ChatsScreen />} />
        <Route path="/chats/:id" element={<ChatRoomScreen />} />
        <Route path="/activity" element={<ActivityScreen />} />
        <Route path="/agents" element={<AgentsScreen />} />
        <Route path="/agent-work" element={<AgentWorkScreen />} />
        <Route path="/projects" element={<ProjectsScreen />} />
        <Route path="/projects/archive" element={<ProjectArchiveScreen />} />
        <Route path="/projects/:id" element={<ProjectTasksScreen />} />
        <Route path="/tasks/archive" element={<TaskArchiveScreen />} />
        <Route path="/labels" element={<LabelsScreen />} />
        <Route path="/labels/:id" element={<LabelTasksScreen />} />
        <Route path="/search" element={<SearchScreen />} />
        <Route path="/notes" element={<NotesScreen />} />
        <Route path="/notes/:id" element={<NoteEditorScreen />} />
        <Route path="/library" element={<LibraryScreen />} />
        <Route path="/settings/voice-models" element={<VoiceModelsScreen />} />
        <Route path="/settings/integrations" element={<IntegrationsScreen />} />
        <Route path="/settings/providers" element={<ProvidersScreen />} />
        <Route path="/settings/roles-models"
          element={<Navigate to="/settings/providers" replace />} />
        <Route path="/settings/templates" element={<TemplatesScreen />} />
      </Route>
    </Route>

    {/* Unknown routes — outside auth/layout so it always renders. */}
    <Route path="*" element={<NotFoundScreen />} />
  </Routes>
</RealLocationProvider>
```

## Порядок `/projects` и `/projects/archive` — важно для дизайна

В конфиге `/projects/archive` объявлен **раньше** `/projects/:id`. Это осознанно:
react-router ранжирует статический сегмент выше динамического, так что
`/projects/archive` не попадёт в `/projects/:id`. Ошибить это при копировании
структуры — получить архив проектов внутри карточки проекта.

## Deep links (Capacitor)

`src/App.tsx:90–124` — обработчик `appUrlOpen` для схемы `taskflow://`:

| Хост | Куда ведёт |
| --- | --- |
| `dictate`, `new-task`, `new` | `/task/new?dictate=1` |
| `task` | `/task/<id>` (если id непустой) |
| `inbox` | `/overview` (входящих больше нет как раздела) |
| `today` | `/today` |
| `overview` | `/overview` |
| что угодно ещё | `/task/new?dictate=1` |

## Экраны без маршрута (мёртвый код — не рисовать для них дизайн)

- `src/screens/InboxScreen.tsx` — `/inbox` удалён 26.08.2026 («входящие — часть
  ежедневника»); экран остался в дереве, но не подключён. На `/inbox-timeline`
  рендерится другой файл, `InboxScreenTimeline.tsx`.
- `src/screens/KeyboardDemoScreen.tsx`
- `src/screens/RolesModelsScreen.tsx` — модели ролей переехали в
  `/settings/providers`, `/settings/roles-models` редиректит туда.
- `src/screens/CreateChatSheet.tsx` — это не экран, а шторка; вызывается из
  `ChatsScreen`. Лежит в `src/screens/`, но по смыслу компонент.