# layouts.md — оболочки, панели и шторки

Файлы верхнего уровня раскладки. В отличие от `components.md`, здесь целиком —
потому что форма и правила вложенности здесь и есть дизайн.

Обзор: `Layout.tsx` (400) — оболочка приложения с двумя ветками
(мобильная/десктопная). `AnimatedTabBar.tsx` (132) — нижняя панель вкладок.
`MicKeyboardBar.tsx` (170) — кнопка микрофона в портале над клавиатурой.
`CreateMenu.tsx` (127) — меню создания. `CreateChatSheet.tsx` (270, лежит в
`src/screens/`) — шторка нового чата.

---

## Layout — оболочка приложения

**Файл:** `src/components/Layout.tsx` (400 строк) · **Тип:** layout

Рендерится как `<Route element={<Layout />}>` внутри `<RequireAuth>`, поэтому
охватывает все 32 внутренних маршрута (см. `routes.md`). Содержимое — `<Outlet />`.

### Что решает компонент

| Решение | Условие |
| --- | --- |
| Мобильная или десктопная ветка | `useIsMobile()` (`src/lib/viewport.ts`) |
| Нижняя навигация скрыта | `matchPath({ path: "/chat", end: true })` — единственное исключение |
| FAB скрыт | `hideNav` **или** доска «Сегодня» (там своя пилюля «Добавить задачу») **или** `/overview` (задачу заводят там, где её видно) **или** открыта десктоп-панель задачи |
| Десктопная панель задачи | `!isMobile && panelEligible (≥1280px) && hasBackground && overlayTaskId` |
| FAB с долгим нажатием | `/projects` → `/projects?create=1`; `/notes` → `/notes?create=1` |

**Важно для дизайна:** `loc` — это подменённый location ФОНА на десктопе с
открытой панелью (список, а не `/task/:id`): react-router подставляет его через
`<Routes location>` выше по дереву. Поэтому весь код, завязанный на «какая
вкладка», продолжает работать без изменений. Реальный путь берётся отдельно
через `useRealLocation()`.

`TAB_ROUTES = ["/projects", "/today", "/upcoming", "/overview", "/notes"]`
объявлен как справочный список с `void TAB_ROUTES;` — ни на что не влияет
(панель показывается везде с 27.08.2026).

### Побочные эффекты, подключённые здесь

| Хук | Зачем |
| --- | --- |
| `useVisualViewportInset()` | публикует `--kb-inset`, `--kb-height`, `--vv-top`, `--vv-height` на `<html>`. Безусловно, даже на десктопе: один общий вызов проще двух условных |
| `usePullToRefresh(scrollerRef, …, isMobile)` | жест «потянул — обновил»; инвалидирует **все** активные React Query-запросы (`refetchType: "active"`), потому что перечислять ключи всех экранов здесь означало бы чинить список при каждом новом экране |
| `useSwipeBack(…, !isRootTab)` | свайп назад только на вложенных экранах — из корневого раздела уходить некуда, а там жест дрался бы с горизонтальными свайпами контента |
| `useNotificationsSocket(!!currentUser)` | WebSocket уведомлений |
| `useLiveActivitySync(!!currentUser)` | островок живёт из любого раздела, пока агент работает |
| `useCurrentUser()`, `useQueryClient()` | данные для FAB и обновления |

Плюс на монтировании `warmUpWhisper()` и `flushArchiveQueue()` — прогрев модели
распознавания обязан быть заранее (загрузка CoreML занимает больше трёх секунд,
которые отводит плагин под ожидание), досылка — потому что `.110` мог быть
недоступен в момент записи.

### Мобильная ветка

```tsx
if (isMobile) {
  const isFan = MOBILE_NAV_STYLE === "fan";
  return (
    <>
      <div className="h-[100dvh] overflow-hidden flex flex-col bg-bg">
        <div
          ref={scrollerRef}
          className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain"
        >
          {/* Индикатор pull-to-refresh: height = pull.pull, едет с пальцем */}
          <div
            aria-hidden={pull.pull === 0}
            className="pointer-events-none sticky top-0 z-20 -mb-px flex items-end justify-center overflow-hidden"
            style={{
              height: pull.pull,
              transition:
                pull.refreshing || pull.pull === 0
                  ? "height 0.25s ease"
                  : "none",
            }}
          >
            <div className="pb-2">
              {pull.refreshing ? (
                <div className="h-5 w-5 rounded-full border-2 border-stroke border-t-red animate-spin" />
              ) : (
                <Icon
                  name="arrowDown"
                  size={18}
                  className={pull.armed ? "text-red" : "text-dim"}
                  style={{
                    transform: pull.armed ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s ease, color 0.2s ease",
                  }}
                />
              )}
            </div>
          </div>
          {/* Контент за пальцем НЕ едет. Контент внутри с padding-bottom
              под нижнюю панель (или под веер, если включён fan-режим). */}
          <div
            className={isFan ? undefined : "pb-content-safe"}
            style={
              isFan ? { paddingBottom: FAN_MENU_CONTENT_PADDING } : undefined
            }
          >
            <Outlet />
          </div>
        </div>
        {!hideNav && isFan && <FanMenu />}
        {!hideNav && !isFan && <BottomNav />}
        {/* Отдельной плавающей кнопки на мобильном нет: её действие
            переехало в красный круг внутри самой панели. */}
      </div>
    </>
  );
}
```

**Ключевые решения раскладки (обязательны к воспроизведению):**

1. **`h-[100dvh]`, а не `min-h-[100dvh]`, и НЕ скролл документа.** Колонка
   `flex`, высота которой приходит только из `min-height`, ненадёжно ограничивает
   `flex-1 overflow-y-auto` ребёнка — колонка вырастает за вьюпорт, и скроллится
   документ. А скролль документа на мобильном выкатывает адресную строку браузера
   поверх приложения.
2. **`min-h-0` на вложенном скроллере** — снимает дефолт `min-height: auto` у
   флекс-элемента; без этого `overflow-y-auto` может не включиться вовсе.
3. **`html.app-shell-locked`** (эффект через `useLayoutEffect`, не `useEffect` —
   класс должен попасть на `<html>` до отрисовки кадра) реально останавливает
   скролл документа: перекрывает базовый `min-height: 100vh` и фиксирует
   `html`/`body` на `100dvh` + `overflow: hidden`. Сделано в CSS, а не здесь,
   чтобы блокировка жила ровно пока смонтирован `Layout` — `/login` и `/register`
   рендерятся вне Layout и продолжают полагаться на обычный скролл документа.
4. **`BottomNav`/`FAB` остаются `position: fixed`**, а у обёртки **нет
   `transform`** — иначе `fixed` привязался бы к этому div, а не к окну.
5. **Контент за пальцем не едет** при pull-to-refresh: ездил через `translateX`,
   но шапка внутри прибита `position: fixed`, а `fixed` внутри элемента с
   `transform` привязывается к ЭТОМУ элементу — заголовок ездил вместе с
   контентом и прижимался к левому краю.

`MOBILE_NAV_STYLE: "fan" | "tabbar" = "tabbar"` (строка 71) — один флаг
переключает «веер» (`FanMenu`) и обычную панель. Сейчас включён `tabbar`;
`BottomNav` и `FAB` из кода не удалены.

### Десктопная ветка

```tsx
return (
  <>
    <div className="h-[100dvh] overflow-hidden flex bg-bg">
      {!hideNav && <SideNav />}
      <div className="flex-1 min-w-0 h-full overflow-y-auto overflow-x-hidden overscroll-y-contain">
        <div className="max-w-[880px] mx-auto pb-bottom-safe">
          <Outlet />
        </div>
      </div>
      {showTaskPanel && overlayTaskId && (
        <TaskDetailPanel location={realLoc} />
      )}
      {!hideFAB && (
        <FAB
          dueToday={loc.pathname === "/today"}
          onLongPress={
            loc.pathname === "/projects"
              ? () => navigate("/projects?create=1")
              : loc.pathname === "/notes"
                ? () => navigate("/notes?create=1")
                : undefined
          }
        />
      )}
    </div>
  </>
);
```

Три фиксированных колонки при `≥1280px` (навигация 240 + список 880 + панель 460).
Ниже 1280 открытие задачи остаётся полной навигацией — три колонки не читаются.
`max-w-[880px]` — потолок, а не фиксированная ширина: при открытой панели
колонка и так стоит в более узком слоте `flex-1`, отдельный вариант ширины
«панель открыта» не нужен.

### FanMenu

**Файл:** `src/components/FanMenu.tsx` · **Тип:** layout · **Не рендерится**
при `MOBILE_NAV_STYLE === "tabbar"`, но полностью жив (см. строки 27–53).

Константы геометрии: `TRIGGER_SIZE = 64`, `ITEM_SIZE = 28`,
`FAN_ARC_DEG = 180`, `stepFor(n) = FAN_ARC_DEG / (n - 1)`,
`ITEM_BOTTOM_EXTRA = TRIGGER_SIZE / 2 - ITEM_SIZE / 2` (4),
`FAN_MENU_CONTENT_PADDING = calc(SAFE_BOTTOM + 72px)` — экспортируется,
`Layout` использует его как `paddingBottom` контента в fan-режиме.

---

## AnimatedTabBar — нижняя панель вкладок

**Файл:** `src/components/AnimatedTabBar.tsx` (132 строки) · **Тип:** layout

Рендерится **только** из `BottomNav` (`UI.tsx:837`), а тот — только на мобильной
ветке `Layout`. На десктопе вместо него `SideNav`.

Форма: `<menu className="nt-tabbar-menu">` с центральной кнопкой создания.
Геометрия живёт в CSS (см. `theme.md`, часть 1): панель 52px, иконка 28px,
круг активной вкладки 44px, центральная кнопка 44px, `border-radius: 0`,
без заливки и тени — плотность дают два слоя `::before`/`::after` с масками.

Центральная кнопка встаёт ровно в середину: `centerAt = Math.ceil(items.length / 2)`,
при 4 вкладках это две слева и две справа.

**Props:** `items: TabItem[]` (`{ icon: ReactNode; label?: string }`),
`defaultIndex?: number` (дефолт 0), `onTabChange?: (index) => void`,
`centerAction?: { label, onPress, open? }`.

`activeIndex` — локальное состояние + `useLayoutEffect` на `defaultIndex`,
чтобы смена вкладки извне (программный `navigate`, переход по ссылке, экран
вне вкладок — тогда приходит `-1` и активной не остаётся ни одной) отражалась
сразу. Подписи под иконками **не рисуются**: они не влезают в геометрию
оригинала, и владелец их не просил; `label` идёт только в `aria-label`.

У центральной кнопки есть `aria-expanded` и своя подпись («Создать» /
«Закрыть меню создания»); `open` доворачивает «плюс» в «крестик».

```tsx
export interface TabItem {
  icon: ReactNode;
  label?: string;
}

export interface CenterAction {
  label: string;
  onPress: () => void;
  open?: boolean;
}

export interface AnimatedTabBarProps {
  items: TabItem[];
  defaultIndex?: number;
  onTabChange?: (index: number) => void;
  centerAction?: CenterAction;
}

export function AnimatedTabBar({
  items,
  defaultIndex = 0,
  onTabChange,
  centerAction,
}: AnimatedTabBarProps) {
  const [activeIndex, setActiveIndex] = useState(defaultIndex);

  useLayoutEffect(() => {
    setActiveIndex(defaultIndex);
  }, [defaultIndex]);

  const handleItemClick = (index: number) => {
    if (activeIndex === index) return;
    setActiveIndex(index);
    onTabChange?.(index);
  };

  const centerAt = Math.ceil(items.length / 2);

  return (
    <menu className="nt-tabbar-menu">
      {items.slice(0, centerAt).map((item, index) => (
        <TabButton
          key={index}
          item={item}
          index={index}
          active={activeIndex === index}
          onClick={handleItemClick}
        />
      ))}

      {centerAction && (
        <button
          type="button"
          className={`nt-tabbar-menu__action ${centerAction.open ? "open" : ""}`}
          onClick={centerAction.onPress}
          aria-label={centerAction.label}
          aria-expanded={centerAction.open ?? false}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {items.slice(centerAt).map((item, i) => {
        const index = centerAt + i;
        return (
          <TabButton
            key={index}
            item={item}
            index={index}
            active={activeIndex === index}
            onClick={handleItemClick}
          />
        );
      })}
    </menu>
  );
}

function TabButton({
  item,
  index,
  active,
  onClick,
}: {
  item: TabItem;
  index: number;
  active: boolean;
  onClick: (index: number) => void;
}) {
  return (
    <button
      type="button"
      className={`nt-tabbar-menu__item ${active ? "active" : ""}`}
      onClick={() => onClick(index)}
      aria-label={item.label ?? `Tab ${index + 1}`}
      aria-current={active ? "page" : undefined}
    >
      {item.icon}
    </button>
  );
}
```

### BottomNav — сборка панели

**Файл:** `src/components/UI.tsx:837` · **Тип:** layout

```tsx
export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: allTasks = [] } = useTasks();
  const todayTasks = useMemo(
    () =>
      allTasks.filter(
        (t) => t.due_date === todayStr() && t.status === "active",
      ),
    [allTasks],
  );
  const [badgeSeenDate, setBadgeSeenDate] = useState(() =>
    localStorage.getItem(TODAY_BADGE_SEEN_KEY),
  );
  useEffect(() => {
    if (location.pathname !== "/today") return;
    const today = todayStr();
    if (badgeSeenDate === today) return;
    localStorage.setItem(TODAY_BADGE_SEEN_KEY, today);
    setBadgeSeenDate(today);
  }, [location.pathname, badgeSeenDate]);

  // -1 — намеренно, без clamp к нулю: панель висит на КАЖДОМ экране, и на
  // не-вкладке (настройки, метки, задача…) ни одна вкладка не активна —
  // иначе горб вставал бы на неверную вкладку.
  const navIndex = NAV_ITEMS.findIndex(
    (item) => item.path === location.pathname,
  );

  const tabItems: TabItem[] = NAV_ITEMS.map((item) => {
    const isToday = item.path === "/today";
    const showBadge =
      isToday && todayTasks.length > 0 && badgeSeenDate !== todayStr();
    return {
      // Счётчик идёт в aria-label, потому что бейдж сам помечен aria-hidden.
      label: showBadge
        ? `${item.label}, задач: ${todayTasks.length}`
        : item.label,
      icon: (
        <span className="relative inline-flex">
          <Icon name={item.icon} size={22} />
          {showBadge && (
            <span className="nt-tabbar-badge" aria-hidden="true">
              {todayTasks.length}
            </span>
          )}
        </span>
      ),
    };
  });

  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    setCreateOpen(false);
  }, [location.pathname]);

  const activeIndex = navIndex;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-[35]">
      <CreateMenu open={createOpen} onClose={() => setCreateOpen(false)} />
      <AnimatedTabBar
        items={tabItems}
        defaultIndex={activeIndex}
        onTabChange={(i) => navigate(NAV_ITEMS[i].path)}
        centerAction={{
          label: createOpen ? "Закрыть меню создания" : "Создать",
          open: createOpen,
          onPress: () => {
            hapticTap();
            setCreateOpen((v) => !v);
          },
        }}
      />
    </nav>
  );
}
```

**`z-[35]`** — FAB (`z-30`) стоит над панелью и тащит за собой красный `shadow-fab`
(blur 16px), который выступает ниже самой кнопки. При этом `z-[35]` НЕ поднимает
панель над диалогами (`z-40`/`z-50` в `Dialog.tsx`, `ActionsMenu.tsx`,
`TaskJournal.tsx`, `ActivityScreen.tsx`) — они по-прежнему перекрывают панель.

**Счётчик на «Сегодня» гаснет ПОСЛЕ первого захода** в `/today` за день и не
появляется заново до полуночи, даже если список изменился. Хранится в
`localStorage` (не `sessionStorage`) под ключом
`taskflow_today_badge_seen_date`, иначе счётчик возвращался бы при каждом
перезапуске вкладки в тот же день.

### SideNav — десктопная колонка

**Файл:** `src/components/UI.tsx:966` · **Тип:** layout

```tsx
export function SideNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: allTasks = [] } = useTasks();
  const todayCount = useMemo(
    () =>
      allTasks.filter((t) => t.due_date === todayStr() && t.status === "active")
        .length,
    [allTasks],
  );

  return (
    <nav className="w-60 h-full shrink-0 flex flex-col gap-1 p-4 border-r border-stroke">
      {NAV_ITEMS.map((item) => {
        const active = item.path === location.pathname;
        const showBadge = item.path === "/today" && todayCount > 0;
        return (
          <button
            key={item.path}
            type="button"
            onClick={() => navigate(item.path)}
            aria-current={active ? "page" : undefined}
            className={`tf-row tap-row w-full h-12 flex items-center gap-3 px-3 rounded-xl ${
              active ? "text-red" : "text-dim hover:text-sub"
            }`}
          >
            <Icon name={item.icon} size={22} />
            <span className="flex-1 text-left truncate">{item.label}</span>
            {showBadge && (
              <span className="tf-caption min-w-5 h-5 px-1 rounded-full bg-red text-white flex items-center justify-center leading-none shrink-0">
                {todayCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
```

Те же четыре направления, что и у `BottomNav`, но колонкой: `w-60`, строка 48px
(`h-12`), `rounded-xl`, отклик `tap-row`. Активная вкладка **не получает
плашки-подложки** — загорается красным иконка и подпись (то же правило, что и
в горизонтальной панели). Отдельный компонент, а не общий рефакторинг: вся
геометрия `AnimatedTabBar` заточена под горизонтальную полосу и не имеет
осмысленного вертикального аналога для четырёх строк.

---

## CreateMenu — меню создания

**Файл:** `src/components/CreateMenu.tsx` (127 строк) · **Тип:** layout

Три пункта: **Задача** (`check`, «Со сроком и шагами», на `/today` сразу
`/task/new?due=today`), **Заметка** (`notebook`, «Запись в дневнике» →
`/notes?create=1`), **Проект** (`inbox`, «Задачи и документация» →
`/projects?create=1`).

Рендерится внутри `<nav className="fixed inset-x-0 bottom-0 z-[35]">` из
`BottomNav`, поэтому позиционируется от верхней кромки панели
(`bottom: calc(100% + 8px)`, `absolute left-1/2 -translate-x-1/2`, `z-[36]`).

Ключевое: карточка **всегда в DOM** — так она сворачивается с анимацией
(`transition-all duration-200`, `scale-100` → `scale-95`), а не исчезает мгновенно;
скрытая получает `pointer-events-none`, `tabIndex={-1}` и `aria-hidden`.
Подложка ловит тап мимо, но **не затемняет**: карточка маленькая, и затемнение
всего экрана ради трёх строк выглядело бы как модалка (`fixed inset-0 z-[34]`).

Геометрия: `w-[232px] bg-card rounded-2xl border border-stroke shadow-xl`,
строки `tap-row … px-4 py-3`, иконка в плашке `w-[32px] h-[32px] rounded-xl
bg-white/10` 18px, подпись `tf-body`, подсказка `tf-meta block text-sub`.

```tsx
<div
  className={`absolute left-1/2 -translate-x-1/2 z-[36] origin-bottom transition-all duration-200 ${
    open
      ? "opacity-100 scale-100 pointer-events-auto"
      : "opacity-0 scale-95 pointer-events-none"
  }`}
  style={{ bottom: "calc(100% + 8px)" }}
  aria-hidden={!open}
>
  <div className="w-[232px] bg-card rounded-2xl border border-stroke shadow-xl overflow-hidden">
    {items.map((item, i) => (
      <button
        key={item.label}
        type="button"
        tabIndex={open ? 0 : -1}
        onClick={item.onPress}
        className={`tap-row w-full flex items-center gap-3 px-4 py-3 text-left ${
          i > 0 ? "border-t border-stroke" : ""
        }`}
      >
        <span className="w-[32px] h-[32px] rounded-xl bg-white/10 flex items-center justify-center text-text shrink-0">
          <Icon name={item.icon} size={18} />
        </span>
        <span className="min-w-0">
          <span className="tf-body block text-text">{item.label}</span>
          <span className="tf-meta block text-sub">{item.hint}</span>
        </span>
      </button>
    ))}
  </div>
</div>
```

Esc закрывает — на телефоне не нужно, но панель живёт и в браузере.
После ухода с экрана меню закрывается само (`useEffect` на `location.pathname`).

---

## MicKeyboardBar — кнопка микрофона над клавиатурой

**Файл:** `src/components/MicKeyboardBar.tsx` (170 строк) · **Тип:** layout ·
Рендерится через `createPortal(…, document.body)`.

Плавающая круглая кнопка 44×44, прижатая к правому краю экрана
(`right-[18px]` — тот же отступ, что у FAB, канон плавающих круглых кнопок
проекта), над системной accessory-панелью iOS.

**Props:** `onStart: () => void`, `ariaLabel: string`.

Три решения, которые обязательны к воспроизведению:

1. **`z-[55]`, не 45.** Портал уходит в `document.body`, а шторки — прямые дети
   body с `z-50`. При `z-45` вся шторка рисовалась ПОВЕРХ кнопки: геометрически
   кнопка на месте, но физически невидима и некликабельна (владелец трижды
   жаловался «микрофон пропал в шторке ответа»).
2. **`onClick={(e) => e.stopPropagation()}`** на обёртке. Портал живёт в body,
   но React всплывает по дереву КОМПОНЕНТОВ: кнопка, отрисованная изнутри
   шторки, отдавала клик её подложке, и шторка закрывалась в тот же миг, что
   начиналась запись.
3. **`onMouseDown={(e) => e.preventDefault()}`** на кнопке — не крадёт фокус у
   textarea, иначе `blur` сорвал бы запись раньше, чем `onClick` отработает.

**Позиция по вертикали** — `bottom: max(var(--kb-height, 0px), calc(100dvh - var(--vv-top, 0px) - var(--vv-height, 100dvh)))`.
Разница между `--kb-height` и `--kb-inset` принципиальна: `--kb-inset`
(`innerHeight − vv.height − vv.offsetTop`) верен для элементов «в потоке»
документа, а для `position: fixed` это двойной учёт — пан сам уже сдвинул
элемент, и `offsetTop` вычитается ещё раз. `--kb-height` (`innerHeight − vv.height`)
без `offsetTop` — чистая высота клавиатуры, верная для fixed-элементов.

**Стекло:** `bg-bg/15 backdrop-blur-[2px] backdrop-saturate-[1.8] border border-stroke shadow-mic-glass`.
Значения подобраны замерами, а не на глаз: `backdrop-blur-md` (12px) размывает
текст в однородное пятно независимо от плотности заливки — радиус blur, а не
прозрачность, оказался неверной ручкой; `blur(2px)` оставляет буквы различимыми
по силуэту, как на референде.

```tsx
return createPortal(
  <div
    onClick={(e) => e.stopPropagation()}
    className="fixed right-[18px] z-[55] pb-2"
    style={{
      bottom:
        "max(var(--kb-height, 0px), calc(100dvh - var(--vv-top, 0px) - var(--vv-height, 100dvh)))",
    }}
  >
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onStart}
      aria-label={ariaLabel}
      className="tap-scale w-11 h-11 rounded-full bg-bg/15 backdrop-blur-[2px] backdrop-saturate-[1.8] border border-stroke shadow-mic-glass flex items-center justify-center"
    >
      <Icon name="mic" size={20} className="text-text" />
    </button>
  </div>,
  document.body,
);
```

**Ограничение платформы, о котором нельзя забывать:** залезть физически
внутрь системной accessory-панели iOS невозможно — это часть системного слоя
браузера, композитится ОС поверх контента страницы. Проверено не на глаз и
подтверждено обсуждением на Apple Developer Forums. Эффект «линзы»
(`feDisplacementMap` как `backdrop-filter`) в Safari/WebKit тоже не работает:
открытый баг bugs.webkit.org #245510. Так что кнопка стоит РОВНО ВЫШЕ панели —
это подтверждённая рабочая зона, а не компромисс.

---

## Общий паттерн шторок (useBottomSheet)

**Файл:** `src/lib/useBottomSheet.ts` (263 строки) · **Тип:** layout

Компонента `Sheet` в проекте нет. Каждая шторка собирает одинаковый каркас
руками — так делают `Dialog.tsx`, `CreateChatSheet.tsx`, `TaskFilterSheet.tsx`,
`RescheduleSheet.tsx`, `TaskControlSheet.tsx`, `RoleContextSheet.tsx`,
`ChatStatsSheet.tsx`, `AttachmentViewerSheet.tsx`, `TasksFromTextSheet.tsx`,
`TaskJournal.tsx`.

Хук отдаёт:

| Поле | Что |
| --- | --- |
| `scrimRef` | реф на затемнение (прозрачность анимируется пружиной хука) |
| `sheetRef` | реф на тело шторки |
| `dragProps` | для `SheetHandle` |
| `mounted` | `false`, пока шторка не должна быть в DOM (нужно для анимации выхода) |

Каркас (взят из `CreateChatSheet.tsx:141–156`):

```tsx
if (!sheet.mounted) return null;

return (
  <div
    data-overlay                              // свайп назад не уводит экран из-под шторки
    className="fixed inset-0 z-50 flex flex-col justify-end"
    onClick={handleClose}
  >
    <div ref={sheet.scrimRef} className="absolute inset-0 bg-black" style={{ opacity: 0 }} />
    <div
      ref={sheet.sheetRef}
      className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[88vh] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <SheetHandle dragProps={sheet.dragProps} />
      {/* … содержимое … */}
    </div>
  </div>
);
```

Инварианты, общие для всех шторок:

- `z-50` — максимум в проекте (кроме `MicKeyboardBar`, которому нужен 55).
- `rounded-sheet-top` — единственная точка скругления верхних углов тела
  шторки; на `≥1024px` переопределяется на ширину 640px с центрированием,
  чтобы на 1440px строка не растягивалась в две подписи по краям экрана.
- `pb-bottom-safe` вместо ручного `env(safe-area-inset-bottom)`.
- `data-overlay` обязателен: `useSwipeBack` ищет этот атрибут.
- Клик по подложке закрывает, клик по телу — гасится `stopPropagation`.
- Диалоги подтверждения drag-to-dismiss **не имеют**: подтверждение не должно
  закрываться случайно (`Dialog.tsx:123`).

---

## CreateChatSheet — шторка нового чата

**Файл:** `src/screens/CreateChatSheet.tsx` (270 строк) · **Тип:** layout

Лежит в `src/screens/`, а не в `src/components/` — по смыслу это компонент,
вызывается из `ChatsScreen.tsx:91`. **Не маршрут** (проверено: в `App.tsx` его
имени нет, см. `routes.md`).

**Props:** `{ open, onClose }` (`CreateChatSheet.tsx:45`).

Содержимое: `SheetHandle` → собственный хедер (крестик 44×44 слева, `tf-title`
«Новый чат», пустой слот 44×44 справа — **не** `SheetHeader`, потому что у шторки
нет правого действия) → подсказка про вид чата → `Loading variant="block"` /
`ErrorBanner` → выбор ролей чипами `h-9 px-3.5 rounded-full tap-fade` → поле
заголовка.

Ключевое поведение: после создания шторка закрывается и **сразу проваливается в
созданный чат** (`navigate(/chats/${res.chat.id})`) — без отдельного шага
«вернуться в список». Так задумано: тестовый канал проверки ожидает именно
«создал → открылся».

---

## TaskDetailPanel — десктопная панель задачи

**Файл:** `src/components/TaskDetailPanel.tsx` · **Тип:** layout

Мастер-деталь: на широких десктопах задача открывается **рядом** со списком,
а не навигацией (`≥1280px`, `useDesktopPanelEligible`). Список при этом остаётся
на своём маршруте — отсюда подменённый location ФОНА и `useRealLocation()`
в `Layout`. Переключение — через `navigate` из `lib/useOpenTask.ts`; ниже 1280
остаётся полная навигация.

Панель получает `location={realLoc}`, а не `loc`: ей нужно знать, что на САМОМ
ДЕЛЕ открыт `/task/:id`.

---

## Прочие оболочечные элементы

| Файл | Строк | Роль |
| --- | --- | --- |
| `src/components/RequireAuth.tsx` | — | проверка токена, редирект на `/login` |
| `src/lib/backgroundLocation.tsx` | — | `RealLocationProvider` + состояние модального роута |
| `src/lib/viewport.ts` | — | `useIsMobile()` (1024px), `useDesktopPanelEligible()` (1280px) |
| `src/lib/useVisualViewportInset.ts` | 232 | публикация `--kb-inset` / `--kb-height` / `--vv-top` / `--vv-height` |
| `src/lib/usePullToRefresh.ts` | — | жест обновления + состояние `pull` / `armed` / `refreshing` |
| `src/lib/useSwipeBack.ts` | — | свайп назад от левого края |
| `src/lib/useBottomSheet.ts` | 263 | механика шторок |
| `src/components/ActionsMenu.tsx` | 242 | контекстное меню строки через портал + anchor |