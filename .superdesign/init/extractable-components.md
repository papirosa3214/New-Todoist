# extractable-components.md — меню извлекаемых компонентов

Что можно вынести в переиспользуемые дизайн-компоненты, а что связано с
конкретной страницей. Формат: имя (PascalCase) · путь · категория (layout/basic)
· одно предложение · **извлекаемые пропсы** (только per-page состояние и
навигация) · **захардкожено** (иконки, подписи, классы).

Правило разбора: пропс попадает в «извлекаемые», если он меняется от страницы к
странице (активный элемент, счётчик, URL, флаг). Пропс, который отражает данные
одной сущности, остаётся внутри компонента.

Категория `layout` — влияет на поток и раскладку. `basic` — элемент внутри потока.

---

# 🖼 Аватары — ключевой брендовый актив

**Проект уже поставляет наборы аватарок агентов в `avatar-sets/` в корне
репозитория.** Это не файлы `src/`, а дизайн-активы, которые применяются на
сервере без пересборки приложения.

## Что там лежит

```
avatar-sets/
├── README.md
├── taskflow-app-icon.png
├── owner/
│   └── u1.png                     ← единственный аватар человека
├── red/         ← комплект, СЕЙЧАС на сервере
├── noir/
├── neon/
└── classic/     ← прежние портреты
```

**Внутри каждого комплекта ролей — 7 PNG + 2 служебных (8 файлов):**

| Файл | Кому |
| --- | --- |
| `role_architect.png` | Архитектор |
| `role_analyst.png` | Аналитик |
| `role_builder.png` | Разработчик |
| `role_researcher.png` | Исследователь |
| `role_critic_verifier.png` | Критик-проверяющий |
| `role_qa.png` | Лайф-тестировщик |
| `u-secretary.png` | Секретарь |
| `orchestrator.png` | «Оркестратор Claude» |

## Несоответствие комплектов, важное для дизайна

Семь ролей в коде (`roleRouting.ts`) — это `researcher`, `analyst`,
`critic_verifier`, `architect`, `builder`, `qa`, **`designer`**.

Но **`role_designer.png` есть только в комплекте `red/`**. В `noir/`, `neon/`
и `classic/` его нет — там шесть ролевых PNG. Если рисовать аватарку роли
`designer` в другом стиле, это будет не соответствующим остальным.

## Как применяется комплект (из `avatar-sets/README.md`)

```
python3 ~/.claude/vault-run.py --secret T=TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN \
  -- python3 scripts/apply_avatar_set.py noir
```

Приложение подхватывает смену **без пересборки**. Свой комплект — новая папка
с теми же именами файлов.

## Как это отражается в UI

Аватарки отдаются API по относительному пути (`/api/avatars/…`) в
`ApiTask.assignee_avatar_url`. Компонент `Avatar` (`UI.tsx:505`) резолвит его
к `API_BASE_URL`, рисует **`<img>` с `rounded-lg` и `objectFit: "contain"`** —
НЕ круг (решение владельца 18.08.2026: круглая обрезка превращала портрет в
«кругляш вокруг рисунка»).

Следствие для дизайна: **портрет агента — квадрат со скруглением 8px, а не
кружок.** Буквенный фолбэк (инициалы на цветной заливке) — круг, `rounded-full`.
Это два РАЗНЫХ визуальных принципа для одного понятия, и путать их нельзя.

Плюс отдельно `taskflow-app-icon.png` в корне `avatar-sets/` — иконка приложения.

---

# Категория layout

## ScreenShell

**Путь:** собирается из `Layout.tsx` (400) + `UI.tsx:1344` (`ScreenHeader`)
**Описание:** оболочка экрана — липкая шапка + прокручиваемый контент с
отступом под нижнюю панель.

**Извлекаемые пропсы:**
- `variant: "large" | "compact"` — форма шапки (корневой раздел vs вложенный экран)
- `title: ReactNode`
- `leading?: ReactNode` — если не передан и экран не корневая вкладка, шапка
  рисует стрелку «назад» сама
- `actions?: ReactNode`, `below?: ReactNode`
- `isRootTab: boolean` — вычисляется из `NAV_ITEMS`; влияет только на стрелку
- `hasBottomNav: boolean` — `pb-content-safe` vs без отступа
- `padding?: string` — горизонтальное поле экрана (`px-4` почти везде)
- `goBackFallbackPath: string` (дефолт `/overview`) — куда уходить, если
  `history.length <= 1`

**Захардкожено:** `mb-4` у шапки (16px, единый отступ для всех экранов);
градиенты `HEADER_FADE_STRONG/SOFT/TINT`; `transform:
translateY(var(--vv-top, 0px))`; `z-20`; классы высоты `min-h-[56px] pt-0.5
pb-3.5` / `h-control-md`; скрытие до первого замера (`visibility: hidden`).

**Что НЕ извлекается:** логика замера (`ResizeObserver`, `useFullBleedInset`,
`usePublishHeaderHeight`) — это поведение, а не проп.

## BottomTabBar

**Путь:** `UI.tsx:837` (`BottomNav`) + `AnimatedTabBar.tsx` (132)
**Описание:** нижняя панель из четырёх вкладок с центральной кнопкой создания.

**Извлекаемые пропсы:**
- `items: { path, label, icon }[]`
- `activePath: string` — совпадает с `item.path`, иначе активной вкладки нет
- `onNavigate: (path) => void`
- `badge?: { path, count, label }` — счётчик на конкретной вкладке
- `badgeVisible: boolean` — погас после первого захода в день
- `centerAction?: { label, open, onPress }`

**Захардкожено:** 4 записи `NAV_ITEMS`; `z-[35]`; `fixed inset-x-0 bottom-0`;
`centerAt = Math.ceil(items.length / 2)`; ключ
`taskflow_today_badge_seen_date` в `localStorage`; иконки `todayDate`/`home`/
`calendarSmall`/`chat`; класс `.nt-tabbar-badge`.

## SideNav

**Путь:** `UI.tsx:966` · **Описание:** десктопная колонка из тех же четырёх
направлений.

**Извлекаемые пропсы:** те же, что у `BottomTabBar` минус `centerAction`.
**Захардкожено:** `w-60`, `h-12` строки, `rounded-xl`, `border-r border-stroke`;
активное состояние только цветом (`text-red`), без плашки.

## FloatingActionButton

**Путь:** `UI.tsx:1015` · **Описание:** круглая красная кнопка создания в правом
нижнем углу с опциональным долгим нажатием.

**Извлекаемые пропсы:**
- `onPress?: () => void`
- `onLongPress?: () => void` — порог 500 мс; без пропа кнопка ведёт себя как обычная
- `dueToday?: boolean` — на `/today` сразу ставит срок
- `hidden?: boolean` — на `/overview`, на доске «Сегодня», при открытой панели

**Захардкожено:** `right-[18px]`, `w/h-[58px]`, `bg-red`, `shadow-fab`, `z-30`,
`fab-safe-bottom` (112px + safe-area), иконка `plus` 26px.

## CreateMenu

**Путь:** `src/components/CreateMenu.tsx` (127) · **Описание:** карточка из трёх
пунктов, выпадающая над панелью вкладок.

**Извлекаемые пропсы:**
- `open: boolean`
- `onClose: () => void`
- `items: { icon, label, hint, onPress }[]`
- `currentPath: string` — на `/today` задача создаётся со сроком

**Захардкожено:** `w-[232px]`, `rounded-2xl`, `shadow-xl`, `z-[36]`,
`bottom: calc(100% + 8px)`, `duration-200`, `scale-95` в закрытом состоянии,
подложка `z-[34]` БЕЗ затемнения, три пункта (Задача / Заметка / Проект).

**Извлекаемо:** `items` — структура уже параметризована, но подписи и цели
захардкожены в массиве внутри компонента.

## AppHeader

**Путь:** `UI.tsx:609` (`SheetHeader`) · **Описание:** шапка нижней шторки.

**Извлекаемые пропсы:** `title: string`, `onClose: () => void`,
`rightAction?: "none" | "text" | "filled" | "plain"`, `textAction?: { label,
onClick, disabled }`, `actionIcon?: string`, `actionDisabled?: boolean`,
`preventMouseDown?: boolean` (нужно, когда шторка открыта при живой клавиатуре).

**Захардкожено:** крестик `IconButton icon="x" label="Закрыть"` с `-ml-2 text-sub`;
заголовок `tf-title truncate px-2`; `text-[13px] text-sub h-11` для текстового
действия; круглая красная кнопка 44×44 для `filled`; пустой слот `<span
className="w-11" />`, когда действия нет.

## SheetContainer

**Путь:** нет файла — каркас собирается руками в каждой шторке
(`Dialog.tsx:126`, `CreateChatSheet.tsx:141`) · **Описание:** оболочка нижней шторки.

**Извлекаемые пропсы:** `open`, `onClose`, `title`, `children`, `maxHeight?`,
`showDragHandle?`.

**Захардкожено:** `fixed inset-0 z-50 flex flex-col justify-end`,
`data-overlay`, скрим `absolute inset-0 bg-black` (прозрачность анимирует хук),
тело `bg-card rounded-sheet-top pb-bottom-safe max-h-[88vh] overflow-y-auto`,
клик по подложке закрывает, клик по телу — `stopPropagation`.

**Извлекаемо** — самое очевидное, чего не хватает проекту.

## Toolbar / ComposerBar

**Путь:** `src/components/ChatComposer.tsx` (625) + инлайн-форма комментария в
`TaskDetailScreen.tsx:921–988` · **Описание:** строка ввода с кнопками по краям.

**Извлекаемые пропсы:**
- `value`, `onChange`, `placeholder`
- `onSubmit: () => void`
- `onAttach?: (file) => void`, `attachDisabled?: boolean`
- `sendDisabled?: boolean`
- `onBlurDelay?: number` — дефолт 150 мс: дать клику отработать до гашения панели
- `paddingBottom?: string` — `var(--kb-inset)` или `--kb-height`
- `leftSlot?`, `rightSlot?` — MicKeyboardBar, ChatStatsSheet

**Захардкожено:** скрепка `w-[40px] h-[40px] rounded-xl bg-card` иконка
`paperclip` 18 `text-sub`; отправка `bg-red` иконка `chevron` 16
`className="text-white -rotate-90"`; поле `tf-input bg-card rounded-xl px-3 py-2.5`;
у обеих кнопок `before:absolute before:-inset-[2px]` — добор зоны до 44×44 HIG;
`onMouseDown={e => e.preventDefault()}` на отправке (иначе клавиатура съезжает и
клик не приходит).

## MicKeyboardBar

**Путь:** `src/components/MicKeyboardBar.tsx` (170) · **Описание:** кнопка
микрофона в портале над системной клавиатурой.

**Извлекаемые пропсы:** `onStart: () => void`, `ariaLabel: string`,
`visible: boolean` (условие в вызывающем: поле в фокусе и `mic.state === "idle"`).

**Захардкожено:** `createPortal(…, document.body)`; `z-[55]`;
`right-[18px]`; `bottom: max(var(--kb-height, 0px), calc(100dvh - var(--vv-top,
0px) - var(--vv-height, 100dvh)))`; `stopPropagation` на обёртке;
`bg-bg/15 backdrop-blur-[2px] backdrop-saturate-[1.8] shadow-mic-glass`;
иконка `mic` 20.

## MasterDetailPanel

**Путь:** `src/components/TaskDetailPanel.tsx` · **Описание:** колонка задачи
рядом со списком на широких десктопах.

**Извлекаемые пропсы:** `open: boolean`, `taskId: string`, `onClose: () => void`,
`listWidth?: string`, `eligible: boolean` (порог 1280px).

**Захардкожено:** то, что панель живёт по правилам модального роута
(`lib/backgroundLocation.tsx`), а не по собственному состоянию.

---

# Категория basic

## TaskListItem

**Путь:** `src/components/TaskRow.tsx` (905) · **Описание:** строка задачи в
списке — заголовок, мета-бейджи, аватар, свайп-меню.

**Извлекаемые пропсы (только per-page состояние/навигация):**
- `onOpen: (id) => void` — вместо `onClick`
- `active: boolean` — для подсветки открытой строки
- `overdue?: boolean` — только `TodayScreen`: меняет обычный бейдж срока на
  красную пилюлю «Просрочено, …»
- `pinned?: boolean`, `onTogglePin?: () => void` — **только
  `ProjectTasksScreen`**
- `showAgentState?: boolean` (дефолт `true`)
- `showDueBadge?: boolean`, `showSubtasksBadge?: boolean`,
  `showAvatar?: boolean`, `showProjectBadge?: boolean`
- `maxLabels?: number` (дефолт `Infinity`)
- `verboseProgress?: boolean` — «N из M» вместо «N/M»

**Захардкожено:** высота и сетка строки; иконки статуса, приоритета, флага;
формат бейджа подзадач; `tap-row`; правило «статус агента виден в любом списке,
а не только на доске»; рассуждение, почему дефолты именно такие (они выбраны,
чтобы новый экран получил правильный вид по умолчанию, а не по забывчивости).

**Ключевое извлекаемое правило:** `showDueBadge=false` для экранов, где дата уже
сказана группировкой (`/upcoming`, `/today`), `showProjectBadge=false` для
`/inbox`-подобных экранов, где проект уже назван заголовком секции. Логика
«есть повтор рядом — не дублируй» единая для всех четырёх пропов.

## AgentStatusTag

**Путь:** `UI.tsx:745` · **Описание:** плашка статуса агента на задаче.

**Извлекаемые пропсы:** `state: AgentState | null`, `stale?: boolean`,
`lastSeenAt?: string`, `display: "pill" | "compact" | "plain"`.
**Захардкожено:** три подписи («в работе» / «заблокировано» / «на проверке»)
и три цветовые пары `bg-*/15 + text-*`; особая подача «Агент пропал»
(`bg-coral/20 text-coral`); иконка `bot` 10px; формат `· {formatAbsoluteTime}`.
**Извлекаемо:** маппинг подписей и цветов вынести в словарь.

## PriorityIndicator

**Путь:** `UI.tsx:2104` (`PriorityArrows`) · **Описание:** приоритет
вертикальной стопкой шевронов.

**Извлекаемые пропсы:** `priority: 1|2|3|4`, `size?: number`.
**Захардкожено:** соответствие `1→4 шеврона, 2→3, 3→2, 4→1`; вертикальная
стопка с отрицательными отступами (`marginBottom: -2` / `-3`) — в ряд четыре
шеврона слипаются в зигзаг и читаются как волна, а не как уровень; цвет из
`getPriorityColor`.

## ReadyFlagIcon

**Путь:** `UI.tsx:2129` · **Описание:** поднятый флаг готовности к самозахвату.

**Извлекаемые пропсы:** `raised: boolean` (при `false` компонент не рисуется —
отдельной «пустой» иконки нет, чтобы не шуметь), `size?: number`.
**Захардкожено:** иконка `flag`, цвет `text-green`.

**Важно:** с 11.09.2026 приоритет и флаг **разведены**. Флаг значит только
«владелец подтвердил, можно брать в работу»; приоритет читается шевронами.
Пока флаг означал две разные вещи, отличить их было нельзя.

## ProjectBadge

**Путь:** инлайн в `TaskDetailScreen.tsx:542–554` и `TaskRow`
**Описание:** принадлежность к проекту — решётка + цветной текст.

**Извлекаемые пропсы:** `project: { id, name, color } | null`.
**Захардкожено:** иконка `hash` 10px; `tf-caption`; **без заливки**, только цвет
(решение владельца 19.08.2026: «она не должна иметь заливки, просто цветной текст
с решёткой»); `max-w-[220px] truncate`.

## LabelChip

**Путь:** инлайн в `TaskDetailScreen.tsx:700–709` · **Описание:** метка задачи.

**Извлекаемые пропсы:** `label: { id, name, color }`, `onClick?`.
**Захардкожено:** `px-2.5 py-1 rounded-lg`, фон `${color}26`, цвет текста
`${color}`, иконка `tag` 11px, контейнер `flex flex-wrap gap-1.5`.

## PlanNodeRow

**Путь:** `src/components/CollaborationPlanPanel.tsx:65–95` · **Описание:** строка
узла плана совместной работы — роль + состояние.

**Извлекаемые пропсы:**
- `roleTitle: string`
- `executionState: string` (одно из 8)
- `blockers?: string[]` — для состояния `waiting`, чтобы «ждёт: Архитектор» было
  понятнее, чем «ждёт своей очереди»
- `iteration?: number` — круг доработки
- `reworkOfKey?: string | null` — для показа «↺ круг 2»
- `isResponsible?: boolean`
- `skipped?: boolean`, `skipReason?: string`

**Захардкожено:** восемь подписей состояний; словарь `STATE_TONE` на сырых
палитрах Tailwind (единственное место в проекте, где не токены) и **пробел в
нём**: `returned`, `blocked`, `skipped` откатываются к тону `waiting`.
**Первое, что стоит починить при генерации дизайна.**

**Важно:** это НЕ граф. Зависимости выражены текстом «— ждёт: X, Y», рёбер нет.
Если задача просит «граф», его надо спроектировать заново, а не дорисовывать.

## AttemptLadderBadge

**Путь:** `src/components/AttemptLadderBadge.tsx` (26) · **Описание:** лестница
моделей `N/M → модель`.

**Извлекаемые пропсы:** `currentStep`, `totalSteps`, `model?: string | null`,
`escalated: boolean` (`currentStep > 1` или `agent_state === "blocked"`).
**Захардкожено:** amber-тон при эскалации, нейтральный иначе; `tabular-nums` в
знаменателе; текст «модель не указана» при отсутствии.

**Не путать:** это НЕ номер круга доработки плана. Круг доработки — это поле
`iteration` узла плана.

## MetadataRow

**Путь:** повторяется 4 раза в `TaskDetailScreen.tsx` (строки 632–675)
**Описание:** строка метаданных задачи.

**Извлекаемые пропсы:** `icon: string`, `iconColor: string`, `children`,
`onClick?`.
**Захардкожено:** `flex items-center gap-3 py-3 px-4 bg-card rounded-xl` —
это готовое переиспользование, которого нет.

## Avatar

**Путь:** `UI.tsx:505` · **Описание:** аватар человека или роли.

**Извлекаемые пропсы:** `src: string | null`, `alt`, `initials?: string`,
`color?: string`, `size?: number`.
**Захардкожено:** **два разных визуальных принципа** — картинка `rounded-lg` +
`objectFit: contain`, буквы `rounded-full` на цветной заливке с
`fontSize: size * 0.43`. Резолв относительного URL к `API_BASE_URL`.

## IconButton / Button / TextField / Checkbox / Switch / EmptyState / Loading / ErrorBanner

**Пути:** `UI.tsx` строки 1811 / 1781 / 1731 / 1845 / 1997 / 2048 / 1901 / 1949

Уже параметризованы правильно, извлекаемы как есть. Обязательные инварианты:

| Компонент | Что нельзя терять |
| --- | --- |
| `IconButton` | `label` обязателен (часть API, не опция) |
| `Button` | `icon` всегда 16px; три фиксированных варианта; `tap-fade` |
| `TextField` | `.tf-input` = 16px **только** здесь (iOS зумит вне полей ввода) |
| `Checkbox` | без `onToggle` — индикатор (`aria-hidden`), не кнопка; отметка всегда 21×21 |
| `Switch` | 43×25 + прозрачный `::before` до 44×44; `ariaLabel` обязателен |
| `EmptyState` | `variant: "icon" \| "plain"`; `action` без подписи = факт пустоты, а не призыв |
| `Loading` | `px` — значением из `LOADING_PX`, не строкой `px-${n}` |
| `ErrorBanner` | пустая ошибка → `null` (можно вешать безусловно); `fallback` всегда |

---

# Что НЕ имеет смысла извлекать

| Файл | Почему |
| --- | --- |
| `src/lib/useBottomSheet.ts` (263) | механика, а не разметка; API у шторок не унифицирован |
| `src/lib/useVisualViewportInset.ts` (232) | инфраструктура раскладки, не компонент |
| `src/components/ActivityChart.tsx` (750) | узкоспециальный график активности |
| `src/components/TaskFields.tsx` (1370) | форма задачи, а не примитив; 9 экспортов разной природы |
| `src/lib/dictationParser.ts` (499) | парсер текста, не UI |
| `src/components/FanMenu.tsx` | **не рендерится** (`MOBILE_NAV_STYLE === "tabbar"`), но жив |
| `src/screens/InboxScreen.tsx` | **не подключён** к роутеру |
| `src/components/AppKeyboard.tsx` | **отключён** решением владельца 20.08.2026, нигде не подключён |
| `src/components/TaskDetailScreen.tsx` (1011) | экран, а не компонент; внутренние инлайны стоит извлекать, сам файл — нет |

---

# Быстрый индекс: где что лежит

| Понятие | Файл | Строк |
| --- | --- | --- |
| Все примитивы | `src/components/UI.tsx` | 2138 |
| Оболочка приложения | `src/components/Layout.tsx` | 400 |
| Нижняя панель (логика) | `src/components/AnimatedTabBar.tsx` | 132 |
| Нижняя панель (CSS) | `src/index.css:698–1010` | — |
| План совместной работы | `src/components/CollaborationPlanPanel.tsx` | 98 |
| Журнал задачи | `src/components/TaskJournal.tsx` | 1034 |
| Чек-лист шагов | `src/components/SubtaskFeed.tsx` | 768 |
| Строка ввода чата | `src/components/ChatComposer.tsx` | 625 |
| Кнопка микрофона | `src/components/MicKeyboardBar.tsx` | 170 |
| Строка задачи | `src/components/TaskRow.tsx` | 905 |
| Главный экран | `src/screens/TaskDetailScreen.tsx` | 1011 |
| Шторка контекста роли | `src/components/RoleContextSheet.tsx` | 482 |
| Менеджер шторок | `src/lib/useBottomSheet.ts` | 263 |
| Роли (данные) | `server/src/roleRouting.ts` | 40 |
| Мутации плана / rework | `server/src/runtime/planMutations.ts` | — |
| Вывод состояния узла | `server/src/routes/task-collaboration-plans.ts:91` | — |
| Аватарки ролей | `avatar-sets/` | — |
| Токены темы | `src/index.css:3–234` | — |
| Типографика `.tf-*` | `src/index.css:1269–1320` | — |