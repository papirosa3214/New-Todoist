# theme.md — TaskFlow design tokens

Источник: `src/index.css` (1987 строк). Tailwind CSS v4, конфига `tailwind.config.js`
нет — все токены объявлены в блоке `@theme` (строки 3–172). Ниже часть 1 — компактная
выжимка со ВСЕМИ значениями, часть 2 — сырые блоки CSS.

Полезно знать: `@theme` в Tailwind v4 сам генерирует утилиты из этих токенов.
`--shadow-fab` → `shadow-fab`, `--control-h-md` → `h-control-md`,
`--radius-xl` → `rounded-xl`, `--space-4` → `p-4`. Отдельные `@utility` написаны
только там, где одного токена не хватает (`shadow-mic-glass`, `rounded-sheet-top`).

---

# PART 1 — Компактная сводка токенов

## Цвета — тёмная тема (значения по умолчанию, `@theme`)

| Токен | Значение | Роль |
| --- | --- | --- |
| `--color-bg` | `#171717` | фон приложения |
| `--color-card` | `#242424` | поверхность карточки |
| `--color-card2` | `#2b2b2b` | вторая поверхность (контролы, плашки) |
| `--color-stroke` | `rgba(255, 255, 255, 0.09)` | разделители и рамки |
| `--color-text` | `#ffffff` | основной текст |
| `--color-sub` | `#a6a6a6` | вторичный текст, подписи |
| `--color-dim` | `#949494` | третичный текст, плейсхолдеры (поднят с `#717171` по WCAG 19.08.2026) |
| `--color-red` | `#e44332` | акцент, вкладки, FAB |
| `--color-red-solid` | `#d63a28` | заливка ПОД БЕЛЫЙ текст (4.67:1, WCAG) |
| `--color-orange` | `#ff9a14` | «заблокировано», предупреждения |
| `--color-pink` | `#ff7a8a` | |
| `--color-blue` | `#4a9fd8` | «на проверке», ссылки-действия |
| `--color-purple` | `#a78bfa` | «сдано» в графе плана |
| `--color-yellow` | `#f7d038` | |
| `--color-coral` | `#ff6b6b` | ошибки, «Агент пропал», деструктивные действия |
| `--color-teal` | `#35b8a3` | «в работе» |
| `--color-green` | `#15937e` | успех, «принято», чекбокс, флаг готовности |

## Цвета — светлая тема (`:root[data-theme="light"]`, строки 199–234)

Тема переключается через `document.documentElement.dataset.theme` в `src/App.tsx:87`
(значение `settings.theme` из zustand-стора).

| Токен | Светлая тема |
| --- | --- |
| `--color-bg` | `#f4f4f5` |
| `--color-card` | `#ffffff` |
| `--color-card2` | `#ececee` |
| `--color-stroke` | `rgba(0, 0, 0, 0.09)` |
| `--color-text` | `#171717` |
| `--color-sub` | `#424242` |
| `--color-dim` | `#4e4e4e` |
| `--color-red` | `#c53426` |
| `--color-red-solid` | `#d63a28` (**намеренно тот же**, чтобы primary-кнопка не «прыгала» при смене темы) |
| `--color-orange` | `#945200` |
| `--color-pink` | `#b32a55` |
| `--color-blue` | `#246da3` |
| `--color-purple` | `#7353b6` |
| `--color-yellow` | `#7b6500` |
| `--color-coral` | `#bc3342` |
| `--color-teal` | `#147466` |
| `--color-green` | `#14745f` |
| `color-scheme` | `light` |

## Шрифт

```
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Avenir Next",
             "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
```

## Отступы (шкала iOS, намеренно НЕ совпадает с `space-1..N` Tailwind — конфликт имён)

| Токен | Значение | Применение |
| --- | --- | --- |
| `--space-1` | `4px` | лейбл→значение в одной строке, межстрочный |
| `--space-2` | `8px` | секция→поле, блок→блок внутри группы |
| `--space-3` | `12px` | поле→поле в строке, отступ подписи сверху |
| `--space-4` | `16px` | левое поле экрана, секция→секция |
| `--space-6` | `24px` | блок→блок в потоке, верхняя граница крупной секции |

## Радиусы

| Токен | Значение | Применение |
| --- | --- | --- |
| `--radius-sm` | `6px` | мелкий контрол, маленький чип |
| `--radius-md` | `8px` | кнопка, поле ввода |
| `--radius-lg` | `12px` | крупный контрол, шторка |
| `--radius-xl` | `16px` | карточка, sheet-тело, крупная поверхность |
| `--radius-pill` | `4px` | капсульная кнопка/чип (**НЕ** `full`, иначе квадратная пилюля с подписью станет эллипсом) |

Значения `20px` и `14px` в системе НЕТ — любой такой радиус считается ошибкой шкалы.

Фактически код пользуется штатными утилитами Tailwind, которые дают ту же шкалу:
`rounded-2xl` = 16px (карточки), `rounded-xl` = 12px (кнопки/поля),
`rounded-lg` = 8px (Avatar, мелкие чипы), `rounded-full` (пилюли, круглые кнопки).
Дополнительно: `@utility rounded-sheet-top` — `border-top-left-radius: 1.25rem`
(20px) + такой же справа; на `≥1024px` переопределяется на ширину 640px и центрируется.

## Высоты контролов

| Токен | Значение | Применение |
| --- | --- | --- |
| `--control-h-sm` | `36px` | второстепенный ряд (превью в атаче, чип) |
| `--control-h-md` | `48px` | кнопка, компактное поле |
| `--control-h-lg` | `52px` | поле ввода формы |
| `--tap-min` | `44px` | минимум HIG, ниже — нельзя |

## Иконки

| Токен | Значение | Рядом с текстом |
| --- | --- | --- |
| `--icon-xs` | `14px` | только inline-в-подписи |
| `--icon-sm` | `18px` | caption / footnote |
| `--icon-md` | `22px` | body (и дефолт в `Icon`) |

Плюс `ICON_SIZE` в `src/components/UI.tsx:268` — `{ xs: 14, sm: 18, md: 22, lg: 26 }`.

## Тени (модель возвышенности)

| Токен | Значение | Где |
| --- | --- | --- |
| `--shadow-fab` | `0 6px 16px rgba(228, 67, 50, 0.45)` | FAB (`UI.tsx`) |
| `--shadow-fan-fab` | `0 8px 32px rgba(228, 67, 50, 0.4)` | центр веера (`FanMenu.tsx`) |
| `--shadow-fan-item` | `0 6px 16px rgba(0, 0, 0, 0.22)` | пункт веера |
| `--shadow-dropdown` | `0 6px 16px rgba(0, 0, 0, 0.45)` | всплывающий список (`DayHours`) |
| `--shadow-toggle` | `0 1px 3px rgba(0, 0, 0, 0.3)` | бегунок тумблера |
| `--shadow-sticky` | `0 10px 16px -12px rgba(0, 0, 0, 0.55)` | липкая шапка (`UpcomingScreen`) |
| `--shadow-tabbar` | `0 -6px 9px rgb(0 0 0 / 0.35)` | таббар (перенос из CRM; сейчас панель приклеена и без тени) |
| `--shadow-pop` | `0 10px 30px rgba(0, 0, 0, 0.35)` | единый поповер (`ActionsMenu`, поповер `UpcomingScreen`) |
| `shadow-mic-glass` (`@utility`) | `0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.14)` | `MicKeyboardBar` — двухслойная тень |

## Движение

| Токен | Значение | Назначение |
| --- | --- | --- |
| `--dur-instant` | `80ms` | тоггл, микро-взаимодействие |
| `--dur-fast` | `150ms` | hover, цветовой кроссфейд |
| `--dur-base` | `200ms` | базовое движение интерфейса |
| `--dur-slow` | `350ms` | открытие шторки, смена вкладки |
| `--dur-deliberate` | `500ms` | разворот/сворачивание, drag шторки |

В коде есть и числа вне шкалы, но они НЕ случайные: `--duration: 0.35s` в
`.nt-tabbar-menu` (перенос из CRM), `dots-scale-rotate 1.2s` (1:1 с нативным
DotsScaleRotate), `mic-rec-pulse 1s` (системное значение).

## Типографическая шкала `.tf-*`

10 ступеней, объявлены в `@layer components` (`src/index.css:1269–1320`).

| Класс | font-size | weight | line-height | letter-spacing |
| --- | --- | --- | --- | --- |
| `.tf-title-large` | 28px | 700 | 32px | -0.03em |
| `.tf-task-title` | 20px | 600 | 23px | -0.02em |
| `.tf-title` | 17px | 600 | — (по умолчанию) | -0.012em |
| `.tf-input` | 16px | 400 | — | -0.006em |
| `.tf-body` | 15px | 400 | — | -0.002em |
| `.tf-row` | 14px | 400 | — | 0 |
| `.tf-action` | 13px | 400 | — | 0.008em |
| `.tf-meta` | 12px | 500 | — | 0.012em |
| `.tf-caption` | 11px | 500 | — | 0.018em |
| `.tf-micro` | 10px | 500 | — | 0.025em |

**Правило из кода:** 16px разрешён ТОЛЬКО внутри `input`/`textarea`/`contenteditable`
(иначе iOS зумит страницу на фокусе поля с мелким кеглем). Вне полей ввода 16px
запрещён. `.tf-input` не должен использоваться для не-инпутов.

## Отклик на нажатие (четыре класса, выбирать по ФОРМЕ элемента)

| Класс | Эффект | К кому |
| --- | --- | --- |
| `.tap-scale` | `transform: scale(0.94)` | иконочные/круглые/квадратные кнопки — кнопка сама себе карточка |
| `.tap-row` | `background: rgba(255,255,255,0.04)` | строка внутри списка/карточки (FieldGroup, settings, sidebar) |
| `.tap-fade` | `opacity: 0.85` | полноширинный CTA и текстовые ссылки — форма не меняется |
| `.tap-menu` | `background: rgba(255,255,255,0.06)` | пункт плавающего меню на уже приподнятой поверхности |

Все четыре: `:active:not(:disabled)` (guard обязателен — Chromium матчит `:active`
на disabled-кнопке, и она становилась ЯРЧЕ под нажатием). Для всех сразу
`disabled { opacity: 0.5; cursor: not-allowed }`. Под `prefers-reduced-motion`
двигается только `.tap-scale`, и он падает на `opacity: .75`.

`.drag-lift` — отдельный класс захвата при перетаскивании (`scale(1.04)` +
тень, пружина `cubic-bezier(0.34, 1.56, 0.64, 1)` 0.22s).

## Безопасные зоны и отступы контента

| Утилита | Значение |
| --- | --- |
| `.nav-pill-bottom` | `bottom: max(8px, env(safe-area-inset-bottom))` |
| `.pb-content-safe` | `padding-bottom: calc(72px + env(safe-area-inset-bottom))` |
| `.pb-bottom-safe` | `padding-bottom: max(16px, env(safe-area-inset-bottom))` |
| `.fab-safe-bottom` | `bottom: calc(112px + env(safe-area-inset-bottom))` |
| `html.app-shell-locked` | фиксирует `html`/`body` на `100dvh` + `overflow: hidden` (только мобильная ветка `Layout`) |

Переменные клавиатуры публикуются на `<html>` хуком `useVisualViewportInset`:
`--kb-inset` (для элементов «в потоке», с учётом `offsetTop`),
`--kb-height` (для `position:fixed`, без `offsetTop`),
`--vv-top` / `--vv-height`. Отличать эти два — неочевидная, но обязательная часть
работы с раскладкой: см. комментарий в `src/components/MicKeyboardBar.tsx:1–60`.

## Геометрия таббара (`.nt-tabbar-menu`, перенос из CRM)

| Переменная | Значение |
| --- | --- |
| `--duration` | `0.35s` |
| `--tab-h` | `52px` |
| `--tab-icon` | `28px` |
| `--tab-orb` | `44px` (круг активной вкладки, вписан в панель: 44+4+4=52) |
| `--tab-fab` | `44px` (центральная кнопка создания, тот же диаметр) |
| `font-size` | `12px` (только ради счётчика) |
| `padding` | `0 8px` |
| `border-radius` | `0` — панель приклеена к низу, скругление противопоказано |

Панель не имеет ни заливки, ни тени, ни углов. Плотность дают два слоя
`::before`/`::after` с масками — зеркало `ScreenHeader`, развёрнутое снизу вверх
(`blur(20px)` и `blur(6px)`, `linear-gradient(to top, …)`). Пункт
`.nt-tabbar-menu__item` — `padding: calc(12px + env(safe-area-inset-bottom)/2) 0`,
`color: var(--color-dim)`, активный — красный. Активная кнопка создания —
`.nt-tabbar-menu__action` с красным кругом `::before`.

## Контрольные точки (breakpoints)

| Ширина | Поведение |
| --- | --- |
| `< 1024px` | мобильная раскладка: `BottomNav` + FAB-отсутствие, `h-[100dvh]` + один вложенный скроллер |
| `≥ 1024px` | десктоп: `SideNav` (`w-60`) + колонка контента `max-w-[880px] mx-auto` |
| `≥ 1280px` | + `TaskDetailPanel` (master-detail: список и задача рядом); ниже — открытие задачи остаётся полной навигацией |

Источники: `useIsMobile()` / `useDesktopPanelEligible()` в `src/lib/viewport.ts`,
`if (isMobile)` в `src/components/Layout.tsx:270`, `@media (min-width: 1024px)` в
`src/index.css:174`. Есть также `@media (max-width: 380px)` (`index.css:1190`) —
сужение под маленькие телефоны.

## Фокус

Глобальное правило в `@layer base` (`index.css`): кольцо фокуса показывается
только при `pointer: fine`, через `:focus-visible`. Глобально снят
`-webkit-tap-highlight-color` — его заменяют четыре `tap-*` класса выше.

---

# PART 2 — Сырые блоки CSS

## `@theme` (`src/index.css:3–172`) — с комментариями сокращены, значения как есть

```css
@theme {
  --color-bg: #171717;
  --color-card: #242424;
  --color-card2: #2b2b2b;
  --color-stroke: rgba(255, 255, 255, 0.09);
  --color-text: #ffffff;
  --color-sub: #a6a6a6;
  --color-dim: #949494;                    /* было #717171, поднято по WCAG */
  --color-red: #e44332;
  --color-red-solid: #d63a28;             /* заливка под белый текст: 4.67:1 */
  --color-orange: #ff9a14;
  --color-pink: #ff7a8a;
  --color-blue: #4a9fd8;
  --color-purple: #a78bfa;
  --color-yellow: #f7d038;
  --color-coral: #ff6b6b;
  --color-teal: #35b8a3;
  --color-green: #15937e;                 /* L 33%, hue 170°, sat 75% */

  --font-sans:
    -apple-system, BlinkMacSystemFont, "SF Pro Text", "Avenir Next", "Segoe UI",
    Roboto, "Helvetica Neue", Arial, sans-serif;

  --shadow-fab: 0 6px 16px rgba(228, 67, 50, 0.45);
  --shadow-fan-fab: 0 8px 32px rgba(228, 67, 50, 0.4);
  --shadow-fan-item: 0 6px 16px rgba(0, 0, 0, 0.22);
  --shadow-dropdown: 0 6px 16px rgba(0, 0, 0, 0.45);
  --shadow-toggle: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-sticky: 0 10px 16px -12px rgba(0, 0, 0, 0.55);
  --shadow-tabbar: 0 -6px 9px rgb(0 0 0 / 0.35);
  --shadow-pop: 0 10px 30px rgba(0, 0, 0, 0.35);

  --dur-instant: 80ms;
  --dur-fast: 150ms;
  --dur-base: 200ms;
  --dur-slow: 350ms;
  --dur-deliberate: 500ms;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 4px;

  --control-h-sm: 36px;
  --control-h-md: 48px;
  --control-h-lg: 52px;
  --tap-min: 44px;

  --icon-xs: 14px;
  --icon-sm: 18px;
  --icon-md: 22px;
}

/* Двухслойная тень для MicKeyboardBar — в @theme нет одиночного токена */
@utility shadow-mic-glass {
  box-shadow:
    0 2px 10px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

@utility rounded-sheet-top {
  border-top-left-radius: 1.25rem;
  border-top-right-radius: 1.25rem;
}

@media (min-width: 1024px) {
  .rounded-sheet-top {
    /* десктоп: шторка не тянется во всю ширину окна, а центрируется
       на 640px — см. комментарий в index.css:160–173 */
  }
}
```

## `:root[data-theme="light"]` (`src/index.css:199–234`)

```css
:root[data-theme="light"] {
  color-scheme: light;
  --color-bg: #f4f4f5;
  --color-card: #ffffff;
  --color-card2: #ececee;
  --color-stroke: rgba(0, 0, 0, 0.09);
  --color-text: #171717;
  --color-sub: #424242;
  --color-dim: #4e4e4e;
  --color-red: #c53426;
  --color-orange: #945200;
  --color-pink: #b32a55;
  --color-blue: #246da3;
  --color-purple: #7353b6;
  --color-yellow: #7b6500;
  --color-coral: #bc3342;
  --color-teal: #147466;
  --color-green: #14745f;
  --color-red-solid: #d63a28;
}
```

## Типографическая шкала (`src/index.css:1269–1320`, внутри `@layer components`)

```css
.tf-title-large {
  font-size: 28px;
  font-weight: 700;
  line-height: 32px;
  letter-spacing: -0.03em;
}
.tf-task-title {
  font-size: 20px;
  font-weight: 600;
  line-height: 23px;
  letter-spacing: -0.02em;
}
.tf-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.012em;
}
.tf-input {
  /* 16 px — ТОЛЬКО для полей ввода */
  font-size: 16px;
  font-weight: 400;
  letter-spacing: -0.006em;
}
.tf-body {
  font-size: 15px;
  font-weight: 400;
  letter-spacing: -0.002em;
}
.tf-row {
  font-size: 14px;
  font-weight: 400;
  letter-spacing: 0;
}
.tf-action {
  font-size: 13px;
  font-weight: 400;
  letter-spacing: 0.008em;
}
.tf-meta {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.012em;
}
.tf-caption {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.018em;
}
.tf-micro {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.025em;
}
```

## Safe-area утилиты (`src/index.css:394–433`)

```css
@layer utilities {
  .nav-pill-bottom {
    bottom: max(8px, env(safe-area-inset-bottom));
  }
  .pb-content-safe {
    padding-bottom: calc(72px + env(safe-area-inset-bottom));
  }
  .pb-bottom-safe {
    padding-bottom: max(16px, env(safe-area-inset-bottom));
  }
  .fab-safe-bottom {
    bottom: calc(112px + env(safe-area-inset-bottom));
  }
}
```

## Tap-отклик (`src/index.css:494–545`)

```css
@layer utilities {
  .tap-scale:active:not(:disabled) { transform: scale(0.94); }
  .tap-row:active:not(:disabled)  { background-color: rgba(255, 255, 255, 0.04); }
  .tap-fade:active:not(:disabled)  { opacity: 0.85; }
  .tap-menu:active:not(:disabled)  { background-color: rgba(255, 255, 255, 0.06); }

  .drag-lift {
    transform: scale(1.04);
    box-shadow:
      0 12px 28px rgba(0, 0, 0, 0.45),
      0 2px 8px rgba(0, 0, 0, 0.35);
    transition:
      transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 0.22s ease;
  }

  .tap-scale:disabled,
  .tap-row:disabled,
  .tap-fade:disabled,
  .tap-menu:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
```

## Геометрия панели навигации (`src/index.css:698–768`, `:962–1010`)

```css
.nt-tabbar-menu {
  --duration: 0.35s;
  --bgColorMenu: var(--color-card);
  position: relative;
  display: flex;
  width: 100%;
  --tab-h: 52px;
  --tab-icon: 28px;
  --tab-orb: 44px;
  --tab-fab: 44px;
  font-size: 12px;
  padding: 0 8px;
  align-items: center;
  justify-content: center;
  list-style: none;
  background-color: transparent;   /* плотность дают ::before/::after */
  border-radius: 0;                /* панель приклеена к низу экрана */
  overflow: visible;
}

/* два слоя затухания — зеркало ScreenHeader, снизу вверх */
.nt-tabbar-menu::before,
.nt-tabbar-menu::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.nt-tabbar-menu::before {
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 40%,
    rgb(0 0 0 / 0.55) 62%,
    rgb(0 0 0 / 0.2) 80%,
    transparent 94%
  );
}

.nt-tabbar-menu__item {
  all: unset;
  flex-grow: 1;
  z-index: 100;
  display: flex;
  cursor: pointer;
  position: relative;
  border-radius: 50%;
  align-items: center;
  will-change: transform;
  justify-content: center;
  padding: calc(12px + env(safe-area-inset-bottom, 0px) / 2) 0;
  color: var(--color-dim);
  transition:
    transform var(--timeOut, var(--duration)),
    color var(--duration);
  -webkit-tap-highlight-color: transparent;
}

.nt-tabbar-menu__item.active { color: var(--color-red); }

.nt-tabbar-menu__action {
  all: unset;
  flex-grow: 1;
  z-index: 100;
  display: flex;
  cursor: pointer;
  position: relative;
  align-items: center;
  justify-content: center;
  padding: calc(12px + env(safe-area-inset-bottom, 0px) / 2) 0;
  color: #fff;
  -webkit-tap-highlight-color: transparent;
}

.nt-tabbar-menu__action::before {
  content: "";
  position: absolute;
  width: var(--tab-fab);
  height: var(--tab-fab);
  border-radius: 50%;
  background-color: var(--color-red);
  z-index: -1;
  transition: transform var(--duration);
}
```

## Что НЕ выгружено (осознанно)

`src/index.css` содержит ещё ~1500 строк: `@layer base` (глобальный reset),
блоки типографики по трекингу, `.tiptap-content` (редактор заметок, строки
1748+), `@media (prefers-reduced-transparency)` / `prefers-contrast` (834, 951),
`prefers-reduced-motion` (1936). Это компонентно-локальные правила, а не токены;
выгружать их в discovery-слой значило бы раздуть контекст без пользы.