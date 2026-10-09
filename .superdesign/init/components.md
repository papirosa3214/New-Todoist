# components.md — общие UI-примитивы

Источник: `src/components/UI.tsx` (2138 строк), плюс соседние файлы, которые
целевые экраны используют наравне с примитивами. Компонентной библиотеки нет —
всё написано руками. Русские комментарии-обоснования сокращены до сути,
**весь JSX, className и значения оставлены как есть**.

## Карта экспортов `UI.tsx` (строки)

```
Icon 367 · StatusBar 444 · Avatar 505 · SheetHandle 573 · SheetHeader 609
AgentStateTag 745 · BottomNav 837 · SideNav 966 · FAB 1015 · BackButton 1076
FadeTrail 1326 · ScreenHeader 1344 · Divider 1588 · SectionHeader 1593
Card 1609 · ListRow 1636 · FieldGroup 1717 · TextField 1731 · Button 1781
IconButton 1811 · Checkbox 1845 · Loading 1901 · ErrorBanner 1949 · Switch 1997
EmptyState 2048 · PriorityArrows 2104 · ReadyFlag 2129
```

## Чего в проекте НЕТ (обязательно к сведению при генерации)

- **Нет `Tabs`.** Переключатель «Чек-лист / Команда» на `/task/:id` — инлайновая
  разметка в самом экране (`TaskDetailScreen.tsx:717–739`), скопированная
  дважды подряд. Единственное место во всём `src/`, где встречается
  `border-b-2 border-red text-text`.
- **Нет `Badge` / `Chip`.** Пилюли пишутся инлайном: `px-2.5 py-1 rounded-lg` с
  фоном `${color}26` (метки задачи), `rounded-full border px-2 py-0.5` +
  `STATE_TONE[...]` (состояние узла плана), `px-2 py-0.5 rounded` +
  `bg-teal/15 text-teal` (`AgentStateTag`).
- **Нет `Screen`.** Экран = `<div className="px-4 …">` + `ScreenHeader` первым
  ребёнком. Оболочку обеспечивает `Layout` (см. `layouts.md`).
- **Нет `Sheet`.** Есть два независимых механизма: хук `useBottomSheet`
  (`src/lib/useBottomSheet.ts`, 263 строки) и примитивы `SheetHandle` /
  `SheetHeader`. Каждая шторка собирает свой `fixed inset-0 z-50` + `scrimRef` +
  `sheetRef` руками (см. `Dialog.tsx:126–142`, `CreateChatSheet.tsx:141–156`).
- **Нет `Tabs` в `TaskFields`**, нет `Avatar`-групп, нет `Table`.

---

## Icon

**Файл:** `src/components/UI.tsx:367` · **Тип:** basic · Единственная точка входа
ко всем иконкам приложения.

Обёртка над `lucide-react`. Мапа ключей — `LUCIDE_ICONS` (`UI.tsx:135–266`,
около 90 имён в lowerCamelCase: `inbox`, `todayDate`, `flag`, `dots`, `chevronLeft`,
`trash`, `mic`, …). Разрешённых размеров четыре: `xs 14 / sm 18 / md 22 / lg 26`
(`ICON_SIZE`, строка 268), либо конкретное число.

**Props:** `name: string` (ключ из `LUCIDE_ICONS` либо одно из двух особых:
`"todayDate"`, `"google"`), `size?: number | "xs"|"sm"|"md"|"lg"` (дефолт 22),
`className?: string`, `style?: CSSProperties`.
**Неизвестный ключ** → компонент возвращает `null`, а не падает.

Три особых случая:
- `todayDate` — рисуется руками `TodayDateIcon` (`UI.tsx:288`): контур
  `Lucide Calendar` (viewBox 24, stroke-width 2, `currentColor`) с ЖИВЫМ числом
  сегодняшнего дня, со своим таймером на полночь. Нужен вкладке «Сегодня».
- `google` — единственный не-Lucide многоцветный SVG (логотип Google, 4 `path`).
- Все Lucide-иконки рисуются `strokeWidth={1.5}`, `fill="none"`. Заливок нет ни
  у одной иконки проекта — заливка `homeFilled` была багом и удалена 11.08.2026.

```tsx
export const Icon = ({
  name,
  size = 22,
  className = "",
  style,
}: {
  name: string;
  size?: number | "xs" | "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
}) => {
  const resolvedSize = typeof size === "string" ? ICON_SIZE[size] : size;
  if (name === "todayDate") {
    return (
      <TodayDateIcon size={resolvedSize} className={className} style={style} />
    );
  }
  if (name === "google") {
    return (
      <svg
        viewBox="0 0 24 24"
        width={resolvedSize}
        height={resolvedSize}
        className={className}
        style={style}
      >
        <path d="M22.5 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5.1 5.1 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z" fill="#4285F4" />
        <path d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.7 1.1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.9A11 11 0 0 0 12 23z" fill="#34A853" />
        <path d="M5.9 14.1a6.5 6.5 0 0 1 0-4.2V7H2.2a11 11 0 0 0 0 10l3.7-2.9z" fill="#FBBC05" />
        <path d="M12 5.3c1.5 0 2.9.5 3.9 1.5l2.9-2.9C17.5 2.3 15 1.3 12 1.3A11 11 0 0 0 2.2 7l3.7 2.9C6.8 7.1 9.2 5.3 12 5.3z" fill="#EA4335" />
      </svg>
    );
  }

  const Glyph = LUCIDE_ICONS[name];
  if (!Glyph) return null;

  return (
    <Glyph
      size={resolvedSize}
      strokeWidth={1.5}
      className={className}
      style={style}
      fill="none"
    />
  );
};
```

---

## Avatar

**Файл:** `src/components/UI.tsx:505` · **Тип:** basic · Аватар человека или роли.

Два взаимоисключающих режима:

1. **`avatar_url` задан** → `<img>`. URL относительный (`/api/avatars/…`) и
   резолвится к `API_BASE_URL`, потому что в нативной обёртке origin страницы —
   `capacitor://localhost`, и относительный `src` ушёл бы не туда.
   **Не `rounded-full`** (решение владельца 18.08.2026): круглая обрезка превращала
   портрет в «кругляш вокруг рисунка». Берётся `rounded-lg`.
   **`objectFit: "contain"`, не `cover`** — `cover` обрезал персонажа по бокам,
   если пропорции не квадратные.
2. **Нет `avatar_url`** → круг с инициалами на цветной заливке:
   `rounded-full`, `fontSize: size * 0.43`, `fontWeight: 600`, `color: "white"`,
   фон `color ?? "#A6A6A6"`.

**Props:** `initials?: string`, `color?: string`, `avatar_url?: string | null`,
`size?: number` (дефолт 32). Типовые вызовы: `size={24}` в метаданных задачи,
`size={32}` в списках, `size={40}` в шапке агента.

```tsx
export function Avatar({
  initials,
  color,
  avatar_url,
  size = 32,
}: {
  initials?: string;
  color?: string;
  avatar_url?: string | null;
  size?: number;
}) {
  if (avatar_url) {
    const resolvedUrl = /^https?:\/\//.test(avatar_url)
      ? avatar_url
      : `${API_BASE_URL}${avatar_url}`;
    return (
      <img
        src={resolvedUrl}
        alt=""
        className="rounded-lg shrink-0"
        style={{ width: size, height: size, objectFit: "contain" }}
      />
    );
  }
  const fallback = initials ?? "";
  const bg = color ?? "#A6A6A6";
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: size * 0.43,
        fontWeight: 600,
        color: "white",
      }}
    >
      {fallback}
    </div>
  );
}
```

---

## ScreenHeader

**Файл:** `src/components/UI.tsx:1344` · **Тип:** layout · Липкая шапка корня
экрана. Самый важный примитив для дизайна — на нём держатся все экраны.

Два варианта, совпадающие с двумя формами шапок в приложении:

- **`variant="large"` (по умолчанию)** — крупный заголовок слева
  (`tf-title-large`, 28/700), `actions` рендерятся строкой справа от него, на
  одной линии. Высота `min-h-[56px] pt-0.5 pb-3.5`. Экраны: `/today`, `/overview`,
  `/projects`, `/upcoming`, `/labels`, `/notes`, `/library`.
- **`variant="compact"`** — форма нав-бара iOS для вложенных экранов: опциональный
  `leading`, заголовок по-настоящему по центру через абсолютное позиционирование
  (`absolute left-1/2 -translate-x-1/2 whitespace-nowrap`, класс `tf-title`),
  `actions` прижаты вправо. Высота `h-control-md` (48px). Экраны: `/task/:id`,
  `/task/new`, `/settings`, `/register`.

**Props:** `title: ReactNode`, `leading?: ReactNode`, `actions?: ReactNode`,
`below?: ReactNode`, `variant?: "large" | "compact"` (дефолт `"large"`),
`className?: string`.

Поведение, которое важно не сломать:

- **Стрелка «назад» появляется сама.** Если экран не корневая вкладка
  (`NAV_ITEMS` не содержит текущий путь) и `leading` не передан — рисуется
  `<BackButton onClick={goBack} />`. `goBack`: `history.length > 1` → `navigate(-1)`,
  иначе → `navigate("/overview")`, чтобы прямой вход по ссылке не выкинул из приложения.
- **`position: fixed`, не `sticky`.** Шапка прибита к окну, а не к прокрутке:
  при оттяжке (rubber-band) `sticky` уезжал вниз вместе с контентом.
  Место в потоке держит распорка той же высоты (`height: barH`).
- **Шапка следует за ВИДИМОЙ областью, а не за окном:** `transform:
  translateY(var(--vv-top, 0px))`. Именно `transform`, а не `top` — `top`
  пересчитывал бы раскладку на каждый кадр анимации клавиатуры. Без клавиатуры
  переменная равна 0.
- **Затухание вместо сплошной плашки.** Три слоя `absolute inset-0`:
  1. `backdropFilter: blur(20px)` + маска `HEADER_FADE_STRONG`
  2. `backdropFilter: blur(6px)` + маска `HEADER_FADE_SOFT`
  3. фон-градиент `HEADER_TINT`
  Границы (`border-b`) нет — она спорила бы с плавностью.
- **`below`** — строка ВНУТРИ шапки под заголовком; попадает под общие слои
  затухания, поэтому подписи дней в сетке «Сегодня» не читаются чужой плашкой.
  Вместе с ней рендерится `FadeTrail`. Высота шапки публикуется как
  `--screen-header-h` через `usePublishHeaderHeight`.
- **Отступ `mb-4` (16px) — часть самой шапки**, стоит последним классом перед
  внешним `className`. Единственный экран, несущий свой `className` — `TodayScreen`
  (`w-full` для пустого состояния).
- До первого замера (`fixedBox === null`) шапка скрыта (`visibility: hidden`),
  иначе на первом кадре мелькнула бы во всю ширину окна поверх бокового меню.
- `useFullBleedInset(rootRef)` считает горизонтальные выступы контента
  (например, полноширинную сетку дня) и растягивает шапку на них через
  отрицательные `marginLeft/marginRight` + `width`.

```tsx
const FADE_LAYER = "pointer-events-none absolute inset-x-0 top-0 bottom-0";

const HEADER_FADE_STRONG =
  "linear-gradient(to bottom, #000 0%, #000 40%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.2) 80%, transparent 94%)";
const HEADER_FADE_SOFT =
  "linear-gradient(to bottom, #000 0%, #000 52%, rgba(0,0,0,0.5) 74%, rgba(0,0,0,0.18) 88%, transparent 100%)";
const HEADER_TINT =
  "linear-gradient(to bottom, var(--color-bg) 0%, var(--color-bg) 46%, color-mix(in srgb, var(--color-bg) 74%, transparent) 66%, color-mix(in srgb, var(--color-bg) 34%, transparent) 84%, transparent 100%)";

const HEADER_TRAIL_H = 18;
const HEADER_TRAIL_FADE =
  "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.2) 72%, transparent 100%)";
const HEADER_TRAIL_TINT =
  "linear-gradient(to bottom, var(--color-bg) 0%, color-mix(in srgb, var(--color-bg) 55%, transparent) 45%, color-mix(in srgb, var(--color-bg) 20%, transparent) 72%, transparent 100%)";

export function ScreenHeader({
  title,
  leading,
  actions,
  below,
  variant = "large",
  className = "",
}: {
  title: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  below?: ReactNode;
  variant?: "large" | "compact";
  className?: string;
}) {
  const isCompact = variant === "compact";
  const headerLocation = useLocation();
  const headerNavigate = useNavigate();
  const isRootTab = NAV_ITEMS.some(
    (item) => item.path === headerLocation.pathname,
  );
  const goBack = () => {
    if (window.history.length > 1) headerNavigate(-1);
    else headerNavigate("/overview");
  };
  const leadingNode =
    leading ?? (isRootTab ? null : <BackButton onClick={goBack} />);

  const rootRef = useRef<HTMLDivElement>(null);
  const bleed = useFullBleedInset(rootRef);
  usePublishHeaderHeight(rootRef);

  const [fixedBox, setFixedBox] = useState<{ left: number; width: number } | null>(null);
  const [barH, setBarH] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const spacer = rootRef.current;
    const bar = barRef.current;
    if (!spacer || !bar) return;
    const measure = () => {
      const r = spacer.getBoundingClientRect();
      setFixedBox((prev) =>
        prev && prev.left === r.left && prev.width === r.width
          ? prev
          : { left: r.left, width: r.width },
      );
      setBarH(bar.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(spacer);
    ro.observe(bar);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`mb-4 ${className}`}
      style={{
        marginLeft: -bleed.left,
        marginRight: -bleed.right,
        ...(bleed.width !== undefined ? { width: bleed.width } : {}),
        height: barH || undefined,
      }}
    >
      <div
        ref={barRef}
        className="fixed top-0 z-20"
        style={{
          left: fixedBox ? fixedBox.left : undefined,
          width: fixedBox ? fixedBox.width : undefined,
          transform: "translateY(var(--vv-top, 0px))",
          paddingLeft: bleed.left,
          paddingRight: bleed.right,
          visibility: fixedBox ? undefined : "hidden",
        }}
      >
        <div
          aria-hidden
          className={FADE_LAYER}
          style={{
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            maskImage: HEADER_FADE_STRONG,
            WebkitMaskImage: HEADER_FADE_STRONG,
          }}
        />
        <div
          aria-hidden
          className={FADE_LAYER}
          style={{
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            maskImage: HEADER_FADE_SOFT,
            WebkitMaskImage: HEADER_FADE_SOFT,
          }}
        />
        <div aria-hidden className={FADE_LAYER} style={{ background: HEADER_TINT }} />
        <div
          className={`flex items-center gap-2 relative z-10 ${
            isCompact ? "h-control-md" : "min-h-[56px] pt-0.5 pb-3.5"
          }`}
        >
          {leadingNode}
          {isCompact ? (
            <h2 className="tf-title absolute left-1/2 -translate-x-1/2 whitespace-nowrap">
              {title}
            </h2>
          ) : (
            <h1 className="tf-title-large flex-1 min-w-0 truncate ">{title}</h1>
          )}
          {actions && (
            <div className="flex items-center gap-2 shrink-0 ml-auto">{actions}</div>
          )}
        </div>
        {below && (
          <>
            <div className="relative z-10">{below}</div>
            <FadeTrail />
          </>
        )}
      </div>
    </div>
  );
}
```

> `-webkit-backdrop-filter` и `-webkit-mask-image` обязательны: в WebKit без
> префикса не работает ни то, ни другое (владелец смотрит с айфона).

---

## FadeTrail

**Файл:** `src/components/UI.tsx:1326` · **Тип:** basic · Шлейф под плотной
подложкой, растворяющий контент вниз.

Отдельный компонент, потому что нужен не только шапке: у пула задач без времени
(«Сегодня», вид часов) подложка кончается такой же прямой кромкой, и подпись часа
резалась пополам. Один профиль затухания на оба места.

Лежит `top: 100%` (вне бокса подложки), поэтому её измеряемая высота
(`--screen-header-h`) не меняется. Высота 18px, `blur(6px)`, маска
`HEADER_TRAIL_FADE`, фон `HEADER_TRAIL_TINT`.

```tsx
export function FadeTrail() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-0 right-0"
      style={{
        top: "100%",
        height: HEADER_TRAIL_H,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        maskImage: HEADER_TRAIL_FADE,
        WebkitMaskImage: HEADER_TRAIL_FADE,
        background: HEADER_TRAIL_TINT,
      }}
    />
  );
}
```

---

## BackButton

**Файл:** `src/components/UI.tsx:1076` · **Тип:** basic · Стрелка назад.

Отдельный компонент существует по одной причине: до 20.08.2026 кнопка нажималась
**без видимого ответа** на всех экранах, где она стояла — глобальный
`-webkit-tap-highlight-color: transparent` снял системную подсветку, а своего
отклика у кнопки не было. Лечится одним `tap-scale` внутри `IconButton`.

**Props:** `onClick: () => void`, `className?: string`. Отступ слева `-ml-2.5`.

```tsx
export function BackButton({
  onClick,
  className = "",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <IconButton
      icon="chevronLeft"
      label="Назад"
      onClick={onClick}
      className={`-ml-2.5 ${className}`}
    />
  );
}
```

---

## Button

**Файл:** `src/components/UI.tsx:1781` · **Тип:** basic · Полноширинный CTA.

Веб-аналог нативного `TFButton`. Три варианта:

| variant | классы |
| --- | --- |
| `primary` (дефолт) | `bg-[var(--color-red-solid)] text-white` |
| `secondary` | `bg-card2 border border-stroke text-text` |
| `outline` | `border border-stroke text-sub bg-transparent` |

Геометрия: `w-full h-control-md` (48px), `r-control-lg` (12px), текст
`tf-body font-semibold` (15/600), `gap-3`, отклик `tap-fade`, `disabled:opacity-50`.
Иконка — пропом `icon`, всегда 16px (чтобы новый вызов не поставил 18/20).
Цвета только токенами, hex в className не появляется.

**Props:** `variant?`, `icon?`, `className?` + все `ComponentPropsWithoutRef<"button">`.

```tsx
type ButtonVariant = "primary" | "secondary" | "outline";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[var(--color-red-solid)] text-white",
  secondary: "bg-card2 border border-stroke text-text",
  outline: "border border-stroke text-sub bg-transparent",
};

export function Button({
  variant = "primary",
  icon,
  className = "",
  children,
  ...props
}: {
  variant?: ButtonVariant;
  icon?: string;
  className?: string;
} & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      {...props}
      className={`tf-body font-semibold w-full h-control-md r-control-lg flex items-center justify-center gap-3 tap-fade disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {icon && <Icon name={icon} size={16} className="shrink-0" />}
      {children}
    </button>
  );
}
```

---

## IconButton

**Файл:** `src/components/UI.tsx:1811` · **Тип:** basic · Кнопка-иконка.

Веб-аналог `TFIconButton`. Прозрачная, без плашки, зона нажатия
`w-11 h-11` (44×44), иконка 18px по умолчанию, отклик `tap-scale` (scale .94).

**`label` ОБЯЗАТЕЛЕН** — у кнопки без текста VoiceOver нечего читать, поэтому
`aria-label` часть API, а не опция вызывающего. До появления этого компонента
в проекте было 74 инлайновых `tap-scale w-11 h-11`, часть без `aria-label`.

**Props:** `icon: string`, `label: string`, `size?`, `className?` +
`Omit<ComponentProps<"button">, "aria-label">`.

```tsx
export function IconButton({
  icon,
  label,
  size = 18,
  className = "",
  ...props
}: {
  icon: string;
  label: string;
  size?: number | "xs" | "sm" | "md" | "lg";
  className?: string;
} & Omit<ComponentProps<"button">, "aria-label">) {
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      className={`tap-scale w-11 h-11 shrink-0 flex items-center justify-center ${className}`}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
```

---

## TextField

**Файл:** `src/components/UI.tsx:1731` · **Тип:** basic · Строка поля ввода.

Одна строка «иконка + инпут + хвост» фиксированной высоты `h-control-lg` (52px) —
удобнее и выше 44px HIG. Предназначена для жизни внутри `FieldGroup`.

Класс `.tf-input` даёт 16px только здесь (вне инпутов 16px запрещён — iOS зумит).
Фокус даёт `index.css` одним правилом на все поля и **только при `pointer: fine`**;
утилитами на классе он раньше срабатывал на телефоне при любом тапе.

**Props:** `icon?: string` (18px `text-dim`), `trailing?: ReactNode`,
`className?: string` + все `ComponentPropsWithoutRef<"input">`.

```tsx
export function TextField({
  icon,
  trailing,
  className = "",
  ...inputProps
}: {
  icon?: string;
  trailing?: ReactNode;
  className?: string;
} & ComponentPropsWithoutRef<"input">) {
  return (
    <div className="flex items-center gap-3 px-4 h-control-lg">
      {icon && <Icon name={icon} size={18} className="text-dim shrink-0" />}
      <input
        {...inputProps}
        className={`tf-input flex-1 min-w-0 bg-transparent text-text placeholder:text-dim outline-none ${className}`}
      />
      {trailing}
    </div>
  );
}
```

---

## FieldGroup

**Файл:** `src/components/UI.tsx:1717` · **Тип:** basic · Обёртка-группа полей.

`bg-card` + `r-surface` + `overflow-hidden`, между детьми — `Divider` с `mx-4`
(внутренний отступ разделителя, а не полноширинный).

```tsx
export function FieldGroup({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="w-full bg-card r-surface overflow-hidden">
      {items.map((child, i) => (
        <div key={i}>
          {child}
          {i < items.length - 1 && <Divider className="mx-4" />}
        </div>
      ))}
    </div>
  );
}
```

---

## Card

**Файл:** `src/components/UI.tsx:1609` · **Тип:** basic · Поверхность-карточка.

`bg-card` + радиус 16 (`r-surface`) + `overflow-hidden`, БЕЗ рамки; строки внутри
разделяются `Divider` во всю ширину. Единственная реализация в проекте —
`TaskFields.tsx` реэкспортирует её, чтобы старые импорты не сломались.

```tsx
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const items = Children.toArray(children);
  return (
    <div className={`w-full bg-card r-surface overflow-hidden ${className}`}>
      {items.map((child, i) => (
        <div key={i}>
          {child}
          {i < items.length - 1 && <Divider />}
        </div>
      ))}
    </div>
  );
}
```

---

## ListRow

**Файл:** `src/components/UI.tsx:1636` · **Тип:** basic · Строка списка.

Высота 52 (`h-control-lg`) — та же, что у `FieldRow`/`TextField`, поэтому все
встают в одну сетку. Три формы иконки:

| Условие | Вид |
| --- | --- |
| `icon` + `iconColor` | квадрат `w-[40px] h-[40px] r-control-md` с заливкой `{iconColor}18`, иконка 18px `text-text` (или `text-coral` при `danger`) |
| только `icon` | голые 18px `text-dim` (или `text-coral`) |
| без `icon` | только текст |

Типографика: `label` — `tf-body`, `sublabel` и `value` — `tf-action` (13).
Отклик — `tap-row` (фон 4%).

**Без `onClick` рендерится `<div>`, а не `<button>`** — строка-констатация
(информация, тумблер) не должна притворяться кнопкой.

**Props:** `icon?`, `iconColor?`, `label: ReactNode`, `sublabel?`, `value?`,
`chevron?` (шеврон 13px `text-dim`), `trailing?`, `onClick?`, `danger?`, `className?`.

```tsx
export function ListRow({
  icon,
  iconColor,
  label,
  sublabel,
  value,
  chevron = false,
  trailing,
  onClick,
  danger = false,
  className = "",
}: {
  icon?: string;
  iconColor?: string;
  label: ReactNode;
  sublabel?: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  trailing?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  className?: string;
}) {
  const content = (
    <>
      {icon &&
        (iconColor ? (
          <span
            className="w-[40px] h-[40px] r-control-md flex items-center justify-center shrink-0"
            style={{ backgroundColor: iconColor + "18" }}
          >
            <Icon
              name={icon}
              size={18}
              className={danger ? "text-coral" : "text-text"}
            />
          </span>
        ) : (
          <Icon
            name={icon}
            size={18}
            className={`shrink-0 ${danger ? "text-coral" : "text-dim"}`}
          />
        ))}
      <span className="flex-1 min-w-0 flex flex-col justify-center">
        <span
          className={`tf-body truncate ${danger ? "text-coral" : "text-text"}`}
        >
          {label}
        </span>
        {sublabel && (
          <span className="tf-action text-sub truncate">{sublabel}</span>
        )}
      </span>
      {value !== undefined && (
        <span className="tf-action text-sub shrink-0">{value}</span>
      )}
      {trailing}
      {chevron && (
        <Icon name="chevron" size={13} className="text-dim shrink-0" />
      )}
    </>
  );
  const cls = `w-full flex items-center gap-3 px-4 h-control-lg bg-card text-left ${className}`;
  if (!onClick) return <div className={cls}>{content}</div>;
  return (
    <button type="button" onClick={onClick} className={`tap-row ${cls}`}>
      {content}
    </button>
  );
}
```

---

## SectionHeader

**Файл:** `src/components/UI.tsx:1593` · **Тип:** basic · Заголовок секции.
`tf-action text-sub px-1`. Плюс `className` — единственная точка настройки.

```tsx
export function SectionHeader({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`tf-action text-sub px-1 ${className}`}>{children}</div>
  );
}
```

---

## Divider

**Файл:** `src/components/UI.tsx:1588` · **Тип:** basic · Разделитель 1px `stroke`.

```tsx
export function Divider({ className = "" }: { className?: string }) {
  return <div className={`h-px bg-stroke ${className}`} />;
}
```

---

## EmptyState

**Файл:** `src/components/UI.tsx:2048` · **Тип:** basic · Пустое состояние.

Согласно DESIGN.md §2.7: иконка, текст, описание, кнопка red. Эталон iOS —
`ContentUnavailableView`. Два варианта подачи:

| variant | Иконка |
| --- | --- |
| `"icon"` (дефолт) | крупная 28px `text-sub` в кружке `w-16 h-16 rounded-full bg-card`, `mb-1` над заголовком — для «раздел пуст, и так должно быть» |
| `"plain"` | 48px `text-dim` без плашки — для контентных пустот |

Заголовок 16px/600, описание 13px `max-w-[280px]`, действие — `tap-fade`,
`h-12 px-6 rounded-xl bg-red text-[15px] font-semibold text-white`, `mt-3`.
Если действия нет — это факт пустоты, а не сигнал «что-то сделать».

**Props:** `icon: string`, `text: string`, `description?`, `action?: {label, onClick}`,
`variant?`, `className?`.

```tsx
export function EmptyState({
  icon,
  text,
  description,
  action,
  variant = "icon",
  className = "",
}: {
  icon: string;
  text: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  variant?: "icon" | "plain";
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center px-6 py-16 gap-3 ${className}`}
    >
      {variant === "icon" ? (
        <div className="w-16 h-16 rounded-full bg-card flex items-center justify-center mb-1">
          <Icon name={icon} size={28} className="text-sub" />
        </div>
      ) : (
        <Icon name={icon} size={48} className="text-dim" />
      )}
      <p className="text-[16px] font-semibold text-text">{text}</p>
      {description && (
        <p className="text-[13px] text-sub max-w-[280px] leading-snug">
          {description}
        </p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="tap-fade mt-3 h-12 px-6 rounded-xl bg-red text-[15px] font-semibold text-white"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
```

---

## Checkbox

**Файл:** `src/components/UI.tsx:1845` · **Тип:** basic · Чекбокс / индикатор.

Веб-аналог `TFCheckbox` (§2.6): круг 21×21; отмечен — залитый `green` с белой
галочкой 12; не отмечен — контурное кольцо `dim` 2px.

Два режима:
- `onToggle` задан → интерактивный контрол: кнопка-обёртка `w-11 h-11` (зона 44×44)
  + обязательный `label` для VoiceOver + `aria-pressed`.
- `onToggle` не задан → чистый **индикатор** внутри строки: `aria-hidden`, смысл
  несёт контейнер.

Сама отметка остаётся 21×21 в обоих режимах — зону даёт обёртка, а не увеличенный кружок.

```tsx
export function Checkbox({
  checked,
  onToggle,
  label,
  className = "",
}: {
  checked: boolean;
  onToggle?: () => void;
  label?: string;
  className?: string;
}) {
  const mark = (
    <span
      aria-hidden={onToggle ? true : undefined}
      className={`w-[21px] h-[21px] rounded-full flex items-center justify-center shrink-0 ${
        checked ? "bg-green border-2 border-green" : "border-2 border-dim"
      }`}
    >
      {checked && <Check size={12} className="text-white" />}
    </span>
  );
  if (!onToggle) return mark;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label ?? "Отметить"}
      aria-pressed={checked}
      className={`tap-scale w-11 h-11 shrink-0 inline-flex items-center justify-center ${className}`}
    >
      {mark}
    </button>
  );
}
```

---

## Switch

**Файл:** `src/components/UI.tsx:1997` · **Тип:** basic · Тумблер.

DESIGN.md §2.7: **43×25**, включённый `bg-red`, выключенный `bg-card2` с рамкой,
белый кружок 20px, `shadow-toggle`, `duration-150`.

Ширина 43 — на 1px ниже HIG, поэтому зона нажатия добирается до 44×44
прозрачным `::before` по центру (`before:h-11 before:w-11 before:-translate-x-1/2
before:-translate-y-1/2`), не меняя видимый размер. `disabled` — отдельный проп,
позволяющий гасить отдельные переключатели (планер на скрытом проекте).

**Props:** `checked`, `onChange: (next: boolean) => void`, `disabled?`, `ariaLabel: string`.

```tsx
export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`tap-scale relative w-[43px] h-[25px] rounded-full shrink-0 transition-colors before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] ${
        checked ? "bg-red" : "bg-card2 border border-stroke"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <span
        className="absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow-toggle transition-[right] duration-150"
        style={{ right: checked ? "2.5px" : "20.5px" }}
      />
    </button>
  );
}
```

---

## Loading

**Файл:** `src/components/UI.tsx:1901` · **Тип:** basic · Заглушка загрузки.

Случай был введён, чтобы убрать дословные копипасты «Загрузка…» в 13 экранах.
Списком значений `LOADING_PX` управляет дефолт, а не собранная на лету строка
`px-${n}` — иначе Tailwind срезал бы класс.

| variant | Вывод |
| --- | --- |
| `"inline"` (дефолт) | `<p className="tf-action {px} text-dim">Загрузка…</p>` |
| `"block"` | `<div className="px-4 py-8 text-center text-sub">Загрузка…</div>` — когда экрану нечего показать до прихода данных |

**Props:** `variant?`, `px?: keyof typeof LOADING_PX` (`1` \| `3` \| `4`), `className?`.

```tsx
const LOADING_PX = { 1: "px-1", 3: "px-3", 4: "px-4" } as const;

export function Loading({
  variant = "inline",
  px = 1,
  className = "",
}: {
  variant?: "inline" | "block";
  px?: keyof typeof LOADING_PX;
  className?: string;
}) {
  if (variant === "block") {
    return (
      <div className={`px-4 py-8 text-center text-sub ${className}`}>
        Загрузка…
      </div>
    );
  }
  return (
    <p className={`tf-action ${LOADING_PX[px]} text-dim ${className}`}>
      Загрузка…
    </p>
  );
}
```

---

## ErrorBanner

**Файл:** `src/components/UI.tsx:1949` · **Тип:** basic · Ошибка.

Принимает сырое `error` — пойманное исключение, `.error` мутации или строку —
и сам прогоняет через `getErrorMessage`, вызывающему не нужно готовить текст.
**При пустой ошибке рендерит `null`**, поэтому его можно вешать безусловно:
`<ErrorBanner error={mutation.error} />`.

| variant | Вывод |
| --- | --- |
| `"inline"` (дефолт) | `<p role="alert" className="tf-action px-1 text-coral">` — ошибки загрузки, тесно |
| `"block"` | панель `bg-coral/12 text-coral rounded-xl px-3 py-2.5` + иконка `info` 15 — над кнопкой сохранения (случай «офлайн жмёт Сохранить» весит больше, чем тонкая строка под длинным списком) |

**`fallback` передавать всегда** — конкретное русское предложение о том, что
именно сломалось. Английские строки сервера заменяются на `fallback`
автоматически.

```tsx
export function ErrorBanner({
  error,
  fallback,
  variant = "inline",
  className = "",
}: {
  error: unknown;
  fallback?: string;
  variant?: "inline" | "block";
  className?: string;
}) {
  const message = getErrorMessage(error, fallback);
  if (!message) return null;

  if (variant === "block") {
    return (
      <div
        role="alert"
        className={`tf-action flex items-start gap-2 bg-coral/12 text-coral rounded-xl px-3 py-2.5 leading-relaxed ${className}`}
      >
        <Icon name="info" size={15} className="shrink-0 mt-[1px]" />
        <span>{message}</span>
      </div>
    );
  }

  return (
    <p role="alert" className={`tf-action px-1 text-coral ${className}`}>
      {message}
    </p>
  );
}
```

---

## PriorityArrows

**Файл:** `src/components/UI.tsx:2104` · **Тип:** basic · Приоритет шевронами.

С 11.09.2026 приоритет перестал быть флажком: рисуется вертикальной стопкой
шевронов, флажок освободился под **поднятый флаг готовности**.

Вертикально, а не в ряд: четыре шеврона в ряд слипаются в зигзаг и читаются как
волна, а не как уровень. Стопка растёт вниз от `marginBottom: -2`, шевроны с
`marginBottom: -3` — чтобы стать плотным блоком, а не лесенкой.

**Соответствие:** приоритет 1 → 4 шеврона, 2 → 3, 3 → 2, 4 → 1 (дефолт).
Цвет берётся из `getPriorityColor(priority)`.

```tsx
const PRIORITY_ARROW_COUNT: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };

export function PriorityArrows({
  priority,
  size = 10,
}: {
  priority: number | null | undefined;
  size?: number;
}) {
  const count = PRIORITY_ARROW_COUNT[priority ?? 4] ?? 1;
  const name = PRIORITIES.find((p) => p.key === (priority ?? 4))?.name ?? "";
  return (
    <span
      className="inline-flex flex-col items-center shrink-0"
      style={{ color: getPriorityColor(priority), marginBottom: -2 }}
      aria-label={`Приоритет: ${name}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <Icon key={i} name="chevronUp" size={size} style={{ marginBottom: -3 }} />
      ))}
    </span>
  );
}
```

---

## ReadyFlag

**Файл:** `src/components/UI.tsx:2129` · **Тип:** basic · Поднятый флаг готовности.

Владелец подтвердил карточку, её можно брать в работу. Значка нет — значит не
подтверждена; отдельной «пустой» иконки не рисуем, чтобы не шуметь.

```tsx
export function ReadyFlag({ size = 12 }: { size?: number }) {
  return (
    <Icon
      name="flag"
      size={size}
      className="text-green shrink-0"
      aria-label="Готова к работе: флаг поднят"
    />
  );
}
```

---

## AgentStateTag

**Файл:** `src/components/UI.tsx:745` · **Тип:** basic · Статус агента на задаче.

Три состояния из `ApiTask.agent_state: "in_progress" | "blocked" | "review"` (+ `null`):

| agent_state | подпись | цвета |
| --- | --- | --- |
| `in_progress` | «в работе» | `bg-teal/15` + `text-teal` |
| `blocked` | «заблокировано» | `bg-orange/15` + `text-orange` |
| `review` | «на проверке» | `bg-blue/15` + `text-blue` |

**Особое состояние «Агент пропал»:** `in_progress` + `agent_stale` (аренда
истекла, вычисляется сервером в `agentState.ts isStale`, на клиенте не
пересчитывается) — плотная заливка `bg-coral/20`, жирный `text-coral`, потому
что это состояние требует решения владельца, в отличие от спокойного «в работе».

**Три режима подачи:**

| проп | геометрия |
| --- | --- |
| дефолт | `px-2 py-0.5 rounded` + плашка цвета; `in_progress` дописывает `· {formatAbsoluteTime(agent_heartbeat_at)}` |
| `compact` | `px-1.5 py-0.5`; относительное время скрыто ЦЕЛИКОМ (обрезанное «· 5 …» читалось бы как баг). Для доски, где колонка 260px |
| `plain` | без плашки-фона вовсе, просто цветное слово — статус ставится отдельной строкой сразу после заметки в `TaskRow`/`BoardCard` |

Иконка `bot` 10px у всех трёх. При `agent_state === null` — `null`.

```tsx
const AGENT_TAG_META: Record<
  "in_progress" | "blocked" | "review",
  { label: string; bg: string; text: string }
> = {
  in_progress: { label: "в работе", bg: "bg-teal/15", text: "text-teal" },
  blocked: { label: "заблокировано", bg: "bg-orange/15", text: "text-orange" },
  review: { label: "на проверке", bg: "bg-blue/15", text: "text-blue" },
};

export function AgentStateTag({
  task,
  compact = false,
  plain = false,
}: {
  task: ApiTask;
  compact?: boolean;
  plain?: boolean;
}) {
  if (!task.agent_state) return null;

  const pad = plain ? "" : compact ? "px-1.5 py-0.5" : "px-2 py-0.5";

  if (task.agent_state === "in_progress" && task.agent_stale) {
    return (
      <span
        className={`tf-caption inline-flex items-center gap-1 ${pad} rounded ${plain ? "" : "bg-coral/20"}text-coral`}
      >
        <Icon name="bot" size={10} />
        Агент пропал
        {!compact && task.agent_heartbeat_at && (
          <span className="font-normal opacity-80">
            · {formatAbsoluteTime(task.agent_heartbeat_at)}
          </span>
        )}
      </span>
    );
  }

  const meta = AGENT_TAG_META[task.agent_state];
  return (
    <span
      className={`tf-caption inline-flex items-center gap-1 ${pad} rounded ${plain ? "" : `${meta.bg} `}${meta.text}`}
    >
      <Icon name="bot" size={10} />
      {meta.label}
      {!compact && task.agent_state === "in_progress" && task.agent_heartbeat_at && (
        <span className="opacity-80">
          · {formatAbsoluteTime(task.agent_heartbeat_at)}
        </span>
      )}
    </span>
  );
}
```

---

## AttemptLadderBadge

**Файл:** `src/components/AttemptLadderBadge.tsx` (26 строк) · **Тип:** basic ·
Лестница моделей `попытка N из M → модель`.

Данные — `ApiTask.attempt_ladder` (`src/api/types.ts:289`):
`{ current_step, total_steps, current_model }`. Это НЕ номер круга доработки
плана, а ступень эскалации моделей.

**Тон:** «эскалация», если `current_step > 1` **или** `agent_state === "blocked"` —
`border-amber-500/30 bg-amber-500/10 text-amber-500`; иначе нейтральный
`border-border bg-card text-sub`.
Возвращает `null`, если лестницы нет или `current_step < 1`.

```tsx
export function AttemptLadderBadge({ task }: { task: ApiTask }) {
  const ladder = task.attempt_ladder;
  if (!ladder || ladder.current_step < 1 || ladder.total_steps < 1) return null;

  const escalated = ladder.current_step > 1 || task.agent_state === "blocked";
  const tone = escalated
    ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
    : "border-border bg-card text-sub";
  const model = ladder.current_model || "модель не указана";

  return (
    <div
      className={`tf-caption inline-flex items-center gap-1.5 rounded-full border px-2 py-1 ${tone}`}
      aria-label={`Попытка ${ladder.current_step} из ${ladder.total_steps}, ${model}`}
    >
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-current/10 px-1 tabular-nums">
        {ladder.current_step}/{ladder.total_steps}
      </span>
      <span aria-hidden="true">→</span>
      <span>{model}</span>
    </div>
  );
}
```

---

## SheetHandle

**Файл:** `src/components/UI.tsx:573` · **Тип:** basic · Индикатор шторки.

Полоска 9×1 `bg-stroke`, намёк «можно потянуть вниз» и точка захвата для
drag-to-dismiss. `dragProps` приходят из `useBottomSheet`.

```tsx
export function SheetHandle({
  dragProps,
}: {
  dragProps?: BottomSheetDragProps;
}) {
  return (
    <div className="flex justify-center pt-2 pb-1 -mx-4 px-4" {...dragProps}>
      <div className="w-9 h-1 rounded-full bg-stroke" />
    </div>
  );
}
```

---

## SheetHeader

**Файл:** `src/components/UI.tsx:609` · **Тип:** basic · Шапка нижней шторки.

Три формы (общий хедер шторок, заменяет копипасту в 8 местах):

| Форма | Правая часть |
| --- | --- |
| без действия | пустой слот `<span className="w-11" />` — заголовок не уезжает влево |
| `textAction` | текстовая кнопка `text-[13px] text-sub h-11` (это и есть «действие 13px text-sub» из DESIGN.md §2.7) |
| `actionIcon` + `actionVariant="filled"` (дефолт) | круглая красная кнопка 44×44 `rounded-full bg-red` с белой иконкой 18 — «созревшее» действие подтверждения |
| `actionIcon` + `actionVariant="plain"` | обычная `IconButton` 44×44, цвет иконки задаётся снаружи |

Слева всегда `IconButton icon="x" label="Закрыть"` с `-ml-2 text-sub`.
Заголовок — `tf-title` (17/600) с `truncate px-2`.
Контейнер: `flex items-center justify-between pb-3`.

**`preventMouseDown`** — гасит `mousedown`, когда шторка открывается при живой
системной клавиатуре (textarea в `TaskJournal`): иначе фокус уходит с textarea,
клавиатура сворачивается, шторка переезжает, и `click` не доходит.

```tsx
export function SheetHeader({
  title,
  onClose,
  textAction,
  actionIcon,
  onAction,
  actionDisabled = false,
  actionAriaLabel,
  actionVariant = "filled",
  className = "",
  preventMouseDown = false,
}: {
  title: string;
  onClose: () => void;
  textAction?: { label: string; onClick: () => void; disabled?: boolean };
  actionIcon?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionAriaLabel?: string;
  actionVariant?: "filled" | "plain";
  className?: string;
  preventMouseDown?: boolean;
}) {
  const mouseDown = (e: React.MouseEvent) => {
    if (preventMouseDown) e.preventDefault();
  };
  return (
    <div className={`flex items-center justify-between pb-3 ${className}`}>
      <IconButton
        icon="x"
        label="Закрыть"
        onMouseDown={mouseDown}
        onClick={onClose}
        className="-ml-2 text-sub"
      />
      <h3 className="text-[17px] font-semibold text-text truncate px-2">
        {title}
      </h3>
      {textAction ? (
        <button
          type="button"
          onMouseDown={mouseDown}
          onClick={textAction.onClick}
          disabled={textAction.disabled}
          className="text-[13px] text-sub disabled:opacity-40 -mr-1 px-2 h-11"
        >
          {textAction.label}
        </button>
      ) : actionIcon && onAction ? (
        actionVariant === "filled" ? (
          <button
            type="button"
            onMouseDown={mouseDown}
            onClick={onAction}
            disabled={actionDisabled}
            aria-label={actionAriaLabel ?? "Подтвердить"}
            className="tap-scale w-11 h-11 -mr-2 rounded-full bg-red flex items-center justify-center disabled:opacity-40"
          >
            <Icon name={actionIcon} size={18} className="text-white" />
          </button>
        ) : (
          <IconButton
            icon={actionIcon}
            label={actionAriaLabel ?? "Подтвердить"}
            onMouseDown={mouseDown}
            onClick={onAction}
            disabled={actionDisabled}
            className="-mr-2 text-text"
          />
        )
      ) : (
        <span className="w-11" />
      )}
    </div>
  );
}
```

---

## FAB

**Файл:** `src/components/UI.tsx:1015` · **Тип:** layout · Плавающая кнопка.

`fixed right-[18px]` (десктоп), `fab-safe-bottom` по вертикали, `w-[58px] h-[58px] rounded-full bg-red`,
`shadow-fab`, `z-30`, `tap-scale`, иконка `plus` 26px `text-white`.

**Долгое нажатие (500 мс, порог тот же, что у системных long-press в iOS) —
альтернативное действие на некоторых разделах:** на `/projects` короткое нажатие
заводит задачу, долгое — сам проект; на `/notes` — заметку. Без `onLongPress`
поведение не меняется. При `Layout`: `dueToday={loc.pathname === "/today"}`.

`onClick` не задан → дефолтная навигация `` `/task/new${dueToday ? "?due=today" : ""}` ``.

```tsx
const LONG_PRESS_MS = 500;

export function FAB({
  onClick,
  onLongPress,
  dueToday,
}: {
  onClick?: () => void;
  onLongPress?: () => void;
  dueToday?: boolean;
}) {
  const navigate = useNavigate();
  const firedLongPress = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const handlePointerDown = () => {
    if (!onLongPress) return;
    firedLongPress.current = false;
    timer.current = setTimeout(() => {
      firedLongPress.current = true;
      hapticTap();
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const handleClick = () => {
    if (firedLongPress.current) {
      firedLongPress.current = false;
      return;
    }
    (onClick ?? (() => navigate(`/task/new${dueToday ? "?due=today" : ""}`)))();
  };

  return (
    <button
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
      className="fab-safe-bottom fixed right-[18px] w-[58px] h-[58px] rounded-full bg-red flex items-center justify-center shadow-fab z-30 tap-scale"
    >
      <Icon name="plus" size={26} className="text-white" />
    </button>
  );
}
```

---

## StatusBar

**Файл:** `src/components/UI.tsx:444` · **Тип:** layout · Фальшивый статус-бар.

Рисует только `bellSlash` (значок вызова), сигнал и wifi. Фиктивные часы
«08:17» и батарея «49%» **удалены решением владельца 12.08.2026**, даже
хотя это часть телефонной рамки в mockup-reference. Все значки переведены на
`currentColor` — литеральный белый был бы невидим на светлой теме.

Используется только в мокап-рамках; в живом приложении не участвует.

---

# Примитивы вне `UI.tsx`, но центральные для целевых экранов

## CollaborationPlanPanel — «граф» плана

**Файл:** `src/components/CollaborationPlanPanel.tsx` (98 строк) · **Тип:** basic

**Это НЕ граф в смысле визуализации узлов и рёбер.** Это плоский вертикальный
список узлов плана; зависимости выражены ТЕКСТОМ в строке ожидания
(«— ждёт: Исследователь, Архитектор»), а не линиями. Название компонента
вводит в заблуждение — при генерации дизайна рисовать узлы с рёбрами, если
задача не просит этого явно.

**Состояния узла** (`STATE_LABELS`) — 8 штук:

| `execution_state` | Подпись |
| --- | --- |
| `waiting` | Ждёт |
| `ready` | Готов к старту |
| `active` | В работе |
| `submitted` | Сдано |
| `accepted` | Принято |
| `returned` | На доработку |
| `blocked` | Заблокирован |
| `skipped` | Пропущен |

**Тона зашиты на сырых палитрах Tailwind, не на токенах темы** (`STATE_TONE`) —
единственное место, где так сделано в проекте:

| state | классы |
| --- | --- |
| `waiting` | `border-border bg-card text-sub` |
| `ready` | `border-blue-500/30 bg-blue-500/10 text-blue-500` |
| `active` | `border-amber-500/30 bg-amber-500/10 text-amber-500` |
| `submitted` | `border-purple-500/30 bg-purple-500/10 text-purple-500` |
| `accepted` | `border-green-500/30 bg-green-500/10 text-green-600` |
| `returned`, `blocked`, `skipped` | **не заданы** → `?? STATE_TONE.waiting`, то есть рисуются как `waiting` |

Последнее — реальное поведение кода, а не опечатка в этом файле: три состояния
визуально неотличимы. При генерации дизайна их стоит различать.

Профили плана (`PROFILE_LABELS`): `single_executor` «Один исполнитель»,
`research` «Исследование», `delivery` «Доставка», `full_cycle` «Полный цикл»,
`manual` «Вручную».

Показывает только план со `status === "approved"`; черновики не рисуются.
Если approved-плана нет (у большинства задач) — компонент **не рисует ничего**.

```tsx
const PROFILE_LABELS: Record<string, string> = {
  single_executor: "Один исполнитель",
  research: "Исследование",
  delivery: "Доставка",
  full_cycle: "Полный цикл",
  manual: "Вручную",
};

const STATE_LABELS: Record<string, string> = {
  waiting: "Ждёт",
  ready: "Готов к старту",
  active: "В работе",
  submitted: "Сдано",
  accepted: "Принято",
  returned: "На доработку",
  blocked: "Заблокирован",
  skipped: "Пропущен",
};

const STATE_TONE: Record<string, string> = {
  waiting: "border-border bg-card text-sub",
  ready: "border-blue-500/30 bg-blue-500/10 text-blue-500",
  active: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  submitted: "border-purple-500/30 bg-purple-500/10 text-purple-500",
  accepted: "border-green-500/30 bg-green-500/10 text-green-600",
};

export function CollaborationPlanPanel({ taskId }: { taskId: string }) {
  const { data: plansData } = useCollaborationPlans(taskId);
  const { data: rolesData } = useRoles();

  const plan = (plansData?.plans ?? []).find((p) => p.status === "approved");
  if (!plan) return null;

  const roleTitle = (roleKey: string) =>
    (rolesData ?? []).find((r) => r.role === roleKey)?.title ?? roleKey;

  const predecessorsOf = (slotKey: string) =>
    plan.edges
      .filter((e) => e.to_slot_key === slotKey)
      .map((e) => plan.nodes.find((n) => n.slot_key === e.from_slot_key))
      .filter((n): n is NonNullable<typeof n> => !!n);

  return (
    <div className="py-3 px-4 bg-card rounded-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="tf-action text-text">План совместной работы</span>
        <span className="tf-meta text-sub">
          {PROFILE_LABELS[plan.profile] ?? plan.profile}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {plan.nodes.map((node) => {
          const state = node.execution_state ?? "waiting";
          const blockers =
            state === "waiting" ? predecessorsOf(node.slot_key) : [];
          return (
            <div
              key={node.slot_key}
              className="tf-action flex items-center justify-between gap-2"
            >
              <span className="text-text">
                {roleTitle(node.role_key)}
                {blockers.length > 0 && (
                  <span className="text-sub">
                    {" "}
                    — ждёт:{" "}
                    {blockers.map((b) => roleTitle(b.role_key)).join(", ")}
                  </span>
                )}
              </span>
              <span
                className={`tf-caption shrink-0 rounded-full border px-2 py-0.5 ${
                  STATE_TONE[state] ?? STATE_TONE.waiting
                }`}
              >
                {STATE_LABELS[state] ?? state}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## SubtaskFeed

**Файл:** `src/components/SubtaskFeed.tsx` (768 строк) · **Тип:** basic ·
Чек-лист шагов с лентой ответов и формой возврата на доработку.

Состояния подзадачи (`SubtaskState`, строки 48–49) — **другой набор, чем у
плана совместной работы**:

```ts
export type SubtaskState =
  "done" | "running" | "pending" | "blocked" | "review";
```

Состояние выводится из галочки, если сервер его не прислал:
`stateOf(st) = st.state ?? (st.done ? "done" : "pending")`.

Цветовое решение владельца: `done` и `running` — **одного зелёного цвета**
(`--color-green`), различаются формой (сплошное кольцо с галочкой vs пунктирное
кольцо с бегущей дугой `DashedRing`). Кольцо рисуется **только** у «готово»;
у остальных состояний виден только сам значок — раньше получалось два кольца
одно в другом.

`PendingAttachment` — `{ id, file_name }`, файл, загруженный но ещё не отправленный.

Пропсы компонента (сигнатура в строке 695) включают `subtasks`, `isOwner`,
`onToggle`, `onReturn`, `onComment`, `onUploadFile` — вызовы видны в
`TaskDetailScreen.tsx:745–773`.

---

## ChatComposer

**Файл:** `src/components/ChatComposer.tsx` (625 строк) · **Тип:** basic ·
Строка ввода с диктовкой.

Живёт в портале/фиксе над клавиатурой на `/chat` — единственный экран без нижней
навигации, потому что композер её заменяет. `onMouseDown={(e) => e.preventDefault()}`
на кнопке отправки: без этого фокус уходит с поля, клавиатура съезжает, кнопка
уходит из-под пальца между `touchstart` и `touchend`, и `click` не приходит вовсе.
Тот же приём в `MicKeyboardBar` и форме возврата `SubtaskFeed`.

---

## TaskJournal

**Файл:** `src/components/TaskJournal.tsx` (1034 строки) · **Тип:** basic ·
Журнал задачи (лента событий) — экспортирует три компонента:

| Экспорт | Строка | Что |
| --- | --- | --- |
| `AgentStatusRow` | 227 | строка статуса агента (`{ task: ApiTask }`) |
| `AgentOwnerActions` | 289 | действия владельца по протоколу `AGENT-PROTOCOL.md`, видны только создателю и только когда релевантны |
| `TaskFeed` | 991 | сама лента (`{ task: ApiTask }`) |

Лента — единый хронологический поток комментариев и событий. Поле ввода
комментариев перенесено в начало секции, чтобы можно было писать без прокрутки
всей ленты.

---

## RoleContextSheet

**Файл:** `src/components/RoleContextSheet.tsx` (482 строки) · **Тип:** basic ·
Шторка контекста роли-агента. Открывается из `/agents`.

---

## MicRing / MicOverlay

| Файл | Строк | Что |
| --- | --- | --- |
| `src/components/MicRing.tsx` | 219 | кольцо записи с анимацией (`mic-rec-pulse 1s`) |
| `src/components/MicOverlay.tsx` | 83 | оверлей записи/обработки; пропсы `state`, `elapsedLabel`, `getTimeDomainData`, `onStop` |

---

## TaskRow

**Файл:** `src/components/TaskRow.tsx` (905 строк) · **Тип:** basic ·
Строка задачи в списке. Самый переиспользуемый по числу пропов компонент.

**Props** (`TaskRowProps`, строки 113–170): `task: ApiTask`, `onClick`,
`overdue?`, `showAgentState?` (дефолт `true` — статус агента виден в любом
списке, а не только на доске), `maxLabels?` (дефолт `Infinity`),
`showDueBadge?`, `showSubtasksBadge?`, `showAvatar?`, `showProjectBadge?`,
`pinned?` + `onTogglePin?` (только `ProjectTasksScreen`), `verboseProgress?`
(«N из M» вместо «N/M»).

Дефолты выбраны так, чтобы новый экран, взявший `TaskRow`, получил правильный вид
по умолчанию, а не по забывчивости. `overdue=true` меняет обычный бейдж срока на
красную пилюлю «Просрочено, …» (используется только `TodayScreen`).

---

## TaskFields (форма)

**Файл:** `src/components/TaskFields.tsx` (1370 строк) · **Тип:** basic

Экспортирует `PRIORITIES`, `Card` (реэкспорт), `FieldRow`, `PriorityPill`,
`PriorityField`, `formatDuration`, `DueDateField`, `LabelsField`, `SubtaskRow`,
`AddSubtaskRow`. Реэкспорт `Card` из `UI.tsx` — обратная совместимость.

---

## Прочее, что используют целевые экраны

| Файл | Строк | Роль |
| --- | --- | --- |
| `src/components/MarkdownInline.tsx` | 40 | инлайновый markdown в заголовке задачи |
| `src/components/AttachmentView.tsx` | 171 | карточка вложения + `formatSize` |
| `src/components/ActionsMenu.tsx` | 242 | контекстное меню строки (портал + anchor) |
| `src/components/TaskControlSheet.tsx` | 212 | шторка управления задачей (`TaskControlKind`) |
| `src/components/TaskBoard.tsx` | — | доска колонками (Today в режиме board, 260px колонка) |
| `src/components/DayHours.tsx` | — | пул часов дня + поповер деталей |
| `src/components/UpcomingCalendar.tsx` | — | календарь планирования |
| `src/components/ActivityChart.tsx` | 750 | график активности |
| `src/components/ProjectNotes.tsx` | — | заметки проекта |
| `src/components/PlannerProjectChips.tsx` | — | чипы проектов в планировании |
| `src/lib/useBottomSheet.ts` | 263 | механика шторок: `scrimRef`, `sheetRef`, `dragProps`, `mounted` |