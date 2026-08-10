import { useLocation, useNavigate } from "react-router-dom";
import {
  Children,
  useMemo,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Calendar,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Crown,
  Ellipsis,
  EllipsisVertical,
  Eye,
  Flag,
  Hash,
  Home,
  Image,
  Inbox,
  Info,
  LayoutGrid,
  Link,
  Lock,
  Mail,
  MapPin,
  Menu,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Shield,
  Star,
  Tag,
  Trash2,
  User,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTasks } from "../api/tasks";
import { todayStr } from "../lib/date";
import { getErrorMessage } from "../lib/errors";

// ═══════════ ICON SET (Lucide) ═══════════
// База набора — Lucide (lucide-react): единая сетка 24×24, единая толщина
// обводки 1.5 (задаётся ниже пропсом, у Lucide по умолчанию 2). Ключи —
// прежние «наши» имена, под них заточены ~170 вызовов <Icon name="..."/>
// по всему проекту, поэтому сам компонент Icon снаружи не поменялся —
// поменялось только то, чем он рисует.
//
// Раньше "calendar" и "calendarSmall" были одним и тем же попиксельно
// нарисованным значком — из-за этого вкладки «Сегодня» и «Предстоящее»
// в нижнем меню выглядели близнецами. Теперь это два разных компонента
// Lucide, как и в mockup-reference (data-i="cal" vs data-i="calGrid"):
// обычный календарь и календарь с сеткой дней.
//
// Кастомный (не-Lucide) рисунок остаётся только один — многоцветный логотип
// Google чуть ниже в самом компоненте Icon: в Lucide нет цветных брендовых
// иконок, а перекрашивать чужой лого в один цвет неверно.
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  calendar: Calendar,
  calendarSmall: CalendarDays,
  home: Home,
  homeFilled: Home, // тот же контур, залитый — см. fill в рендере ниже
  tag: Tag,
  hash: Hash,
  flag: Flag,
  flagSmall: Flag,
  dots: EllipsisVertical,
  dotsH: Ellipsis,
  plus: Plus,
  check: Check,
  chevron: ChevronRight,
  chevronLeft: ChevronLeft,
  chevronDown: ChevronDown,
  close: X,
  x: X,
  search: Search,
  bell: Bell,
  bellSlash: BellOff,
  settings: Settings,
  gear: Settings,
  mail: Mail,
  lock: Lock,
  eye: Eye,
  person: User,
  crown: Crown,
  bot: Bot,
  list: Menu,
  grid: LayoutGrid,
  activity: Activity,
  star: Star,
  cloud: Cloud,
  shield: Shield,
  play: Play,
  link: Link,
  share: Share2,
  trash: Trash2,
  edit: Pencil,
  info: Info,
  moon: Moon,
  sync: RefreshCw,
  zap: Zap,
  image: Image,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  pin: MapPin,
};

export const Icon = ({
  name,
  size = 22,
  className = "",
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) => {
  // Единственное исключение из Lucide: многоцветный логотип Google.
  if (name === "google") {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={className}
        style={style}
      >
        <path
          d="M22.5 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5.1 5.1 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z"
          fill="#4285F4"
        />
        <path
          d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.7 1.1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.9A11 11 0 0 0 12 23z"
          fill="#34A853"
        />
        <path
          d="M5.9 14.1a6.5 6.5 0 0 1 0-4.2V7H2.2a11 11 0 0 0 0 10l3.7-2.9z"
          fill="#FBBC05"
        />
        <path
          d="M12 5.3c1.5 0 2.9.5 3.9 1.5l2.9-2.9C17.5 2.3 15 1.3 12 1.3A11 11 0 0 0 2.2 7l3.7 2.9C6.8 7.1 9.2 5.3 12 5.3z"
          fill="#EA4335"
        />
      </svg>
    );
  }

  const Glyph = LUCIDE_ICONS[name];
  if (!Glyph) return null;

  return (
    <Glyph
      size={size}
      strokeWidth={1.5}
      className={className}
      style={style}
      fill={name === "homeFilled" ? "currentColor" : "none"}
    />
  );
};

// ═══════════ STATUS BAR ═══════════

export function StatusBar() {
  return (
    <div className="flex items-center justify-between px-[22px] h-[46px] shrink-0">
      <span className="text-[14px] font-semibold tracking-[0.2px]">08:17</span>
      <div className="flex items-center gap-[5px]">
        <Icon name="bellSlash" size={15} className="opacity-90" />
        <svg viewBox="0 0 16 13" className="w-[16px] h-[13px]">
          <rect
            x="0"
            y="6"
            width="2.5"
            height="5"
            rx="0.8"
            fill="rgba(255,255,255,.9)"
          />
          <rect
            x="4.5"
            y="4"
            width="2.5"
            height="7"
            rx="0.8"
            fill="rgba(255,255,255,.9)"
          />
          <rect
            x="9"
            y="2"
            width="2.5"
            height="9"
            rx="0.8"
            fill="rgba(255,255,255,.9)"
          />
          <rect
            x="13.5"
            y="0"
            width="2.5"
            height="11"
            rx="0.8"
            fill="rgba(255,255,255,.9)"
          />
        </svg>
        <svg viewBox="0 0 16 13" className="w-[16px] h-[13px]">
          <path
            d="M1 5a8 8 0 0 1 14 0"
            fill="none"
            stroke="white"
            strokeWidth="1.5"
          />
          <path
            d="M3.5 8a5 5 0 0 1 9 0"
            fill="none"
            stroke="white"
            strokeWidth="1.5"
          />
          <circle cx="8" cy="11.5" r="1.6" fill="white" />
        </svg>
        <svg viewBox="0 0 29 13" className="w-[29px] h-[13px]">
          <rect x="0" y="0" width="26" height="12" rx="3.5" fill="#4CD964" />
          <text
            x="13"
            y="8.6"
            textAnchor="middle"
            fontSize="7"
            fontWeight="700"
            fill="#0A0A0A"
          >
            49%
          </text>
          <rect
            x="27"
            y="3.5"
            width="1.8"
            height="5"
            rx="0.9"
            fill="rgba(255,255,255,.5)"
          />
        </svg>
      </div>
    </div>
  );
}

// ═══════════ AVATAR ═══════════

export function Avatar({
  initials,
  color,
  size = 32,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: size * 0.43,
        fontWeight: 600,
        color: "white",
      }}
    >
      {initials}
    </div>
  );
}

// ═══════════ BOTTOM NAV ═══════════

// Активная вкладка не получает никакой плашки-подложки — просто загорается
// красным иконка и подпись. Плашки вокруг иконок были собственной выдумкой
// (и вдобавок разной у разных вкладок), из-за чего подсветка выглядела кривой.
const NAV_ITEMS = [
  {
    path: "/inbox",
    label: "Входящие",
    icon: "inbox",
    activeIcon: "inbox",
    activeIconClass: "text-red",
  },
  {
    path: "/today",
    label: "Сегодня",
    icon: "calendar",
    activeIcon: "calendar",
    activeIconClass: "text-red",
  },
  {
    path: "/upcoming",
    label: "Предстоящее",
    icon: "calendarSmall",
    activeIcon: "calendarSmall",
    activeIconClass: "text-red",
  },
  {
    path: "/overview",
    label: "Обзор",
    icon: "home",
    activeIcon: "homeFilled",
    activeIconClass: "text-red",
  },
];

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

  return (
    <nav className="nav-pill-bottom fixed inset-x-3 z-20 flex items-stretch h-[60px] rounded-[26px] border border-white/10 bg-[#1e1e1e]/88 backdrop-blur-2xl backdrop-saturate-150 shadow-[0_8px_28px_-8px_rgba(0,0,0,.65)]">
      {NAV_ITEMS.map((item) => {
        const active = location.pathname === item.path;
        const isToday = item.path === "/today";
        const showBadge = isToday && todayTasks.length > 0;
        return (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`flex-1 flex flex-col items-center justify-center gap-[2px] transition-colors tap-scale ${
              active ? "text-text" : "text-dim"
            }`}
          >
            {/* Обёртка иконки одинакова в обоих состояниях — ничего не
                прыгает при переключении, меняется только цвет.
                Раньше здесь стоял isToday-хак, который на вкладке «Сегодня»
                всегда рисовал "calendarSmall" — тот же значок, что и у
                «Предстоящего». Из-за этого вкладки выглядели близнецами;
                теперь у каждого пункта свой icon/activeIcon. */}
            <div className="relative flex h-6 items-center justify-center px-2.5">
              <Icon
                name={active ? item.activeIcon : item.icon}
                size={22}
                className={active ? item.activeIconClass : ""}
              />
              {showBadge && (
                <div className="absolute -top-1.5 -right-1.5 bg-red text-white text-[9px] font-bold rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1">
                  {todayTasks.length}
                </div>
              )}
            </div>
            <span
              className={`text-[10px] font-medium ${active ? "text-red" : "text-dim"}`}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// ═══════════ FAB ═══════════

export function FAB({ onClick }: { onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={onClick ?? (() => navigate("/task/new"))}
      className="fab-safe-bottom fixed right-[18px] w-[58px] h-[58px] rounded-full bg-red flex items-center justify-center shadow-[0_6px_16px_rgba(228,67,50,.45)] z-30 tap-scale"
    >
      <Icon name="plus" size={26} className="text-white" />
    </button>
  );
}

// ═══════════ SCREEN HEADER ═══════════
// Sticky header for screen roots. Two variants matching the two header
// shapes already used across the app:
//   - "large" (default): big left-aligned title, e.g. Inbox/Today/
//     Overview. `actions` (view-toggle buttons, icons, …) render as a row
//     to the right of the title, same line.
//   - "compact": iOS-nav-bar shape used by detail/secondary screens
//     (Register, TaskDetail, NewTask, Settings, …) — an optional
//     `leading` element (usually a back button) on the left, a title
//     genuinely centered via absolute positioning, and `actions` pinned
//     to the right.
//
// Usage:
//   <ScreenHeader title="Входящие" actions={<>{viewToggleButtons}</>} />
//
//   <ScreenHeader
//     variant="compact"
//     leading={<BackButton onClick={() => navigate(-1)} />}
//     title="Регистрация"
//   />
//
// Renders `sticky top-0`, so drop it as the first child inside a screen's
// existing `px-4 ...` root div — no extra wrapper/margin needed, it just
// stays put at the top of the (document-level) scroll while the rest of
// the screen's content scrolls underneath it.
export function ScreenHeader({
  title,
  leading,
  actions,
  variant = "large",
  className = "",
}: {
  title: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  variant?: "large" | "compact";
  className?: string;
}) {
  const isCompact = variant === "compact";
  return (
    <div
      className={`sticky top-0 z-20 bg-bg/90 backdrop-blur-xl border-b border-stroke ${className}`}
    >
      <div
        className={`flex items-center gap-2 relative ${
          isCompact ? "h-[48px]" : "min-h-[56px] py-2"
        }`}
      >
        {leading}
        {isCompact ? (
          <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold whitespace-nowrap">
            {title}
          </h2>
        ) : (
          <h1 className="flex-1 min-w-0 truncate text-[28px] font-bold">
            {title}
          </h1>
        )}
        {actions && (
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════ PANEL (reference sidebar) ═══════════

const PANEL_ITEMS = [
  { label: "Обзор", path: "/overview" },
  { label: "Настройки", path: "/settings" },
  { label: "Предстоящее", path: "/upcoming" },
  { label: "Сегодня (пусто)", path: "/today" },
  { label: "Входящие", path: "/inbox" },
  { label: "Логин", path: "/login" },
  { label: "Регистрация", path: "/register" },
  { label: "Новая задача", path: "/task/new" },
  { label: "Уведомления", path: "/notifications" },
  { label: "Агенты", path: "/agents" },
  { label: "Проекты", path: "/projects" },
  { label: "Поиск", path: "/search" },
];

export function Panel() {
  const navigate = useNavigate();
  return (
    <aside className="hidden xl:flex flex-col w-[260px] p-4 border-l border-stroke gap-2">
      <h4 className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-1">
        Экраны · Референсы
      </h4>
      {PANEL_ITEMS.map((item, i) => (
        <button
          key={item.path}
          onClick={() => navigate(item.path)}
          className="w-full flex items-center gap-2 px-2 py-[5px] rounded-lg tap-row text-left text-[13px] text-sub hover:text-text"
        >
          <span className="w-4 text-[11px] text-dim text-right shrink-0">
            {i + 1}
          </span>
          {item.label}
        </button>
      ))}
      <div className="mt-auto text-center text-[11px] text-dim leading-relaxed">
        React + Tailwind · Todoist dark
        <br />
        собран 1:1 по скриншотам от 10.08.2026
      </div>
    </aside>
  );
}

// ═══════════ FORM PRIMITIVES ═══════════
// Unified spacing/radius scale for forms across the app:
//   - FieldGroup: bg-card rounded-2xl card wrapping a list of rows, with a
//     single consistent inset divider (h-px bg-stroke mx-4) between them.
//   - TextField: one icon+input row, fixed 52px height (comfortable >44px
//     touch target), meant to live inside a FieldGroup.
//   - Button: full-width h-12 (48px) CTA with a small variant set.

export function FieldGroup({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <div className="w-full bg-card rounded-2xl overflow-hidden">
      {items.map((child, i) => (
        <div key={i}>
          {child}
          {i < items.length - 1 && <div className="h-px bg-stroke mx-4" />}
        </div>
      ))}
    </div>
  );
}

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
    <div className="flex items-center gap-3 px-4 h-[52px]">
      {icon && <Icon name={icon} size={18} className="text-dim shrink-0" />}
      <input
        {...inputProps}
        className={`flex-1 min-w-0 bg-transparent text-[16px] text-text placeholder:text-dim outline-none ${className}`}
      />
      {trailing}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "outline";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-red text-white",
  secondary: "bg-card2 border border-stroke text-text",
  outline: "border border-stroke text-sub bg-transparent",
};

export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: {
  variant?: ButtonVariant;
  className?: string;
} & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      {...props}
      className={`w-full h-12 rounded-xl text-[15px] font-semibold flex items-center justify-center gap-3 tap-fade disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

// ═══════════ ERROR BANNER ═══════════
// Generalizes InboxScreen's inline query-error line (`<p className="px-1
// text-[13px] text-coral">…</p>`) into a reusable primitive that also
// covers mutation errors. Accepts the raw `error` — a caught exception, a
// mutation's `.error`, or a plain string already extracted into local
// state (e.g. the try/catch pattern in LoginScreen/RegisterScreen) — and
// runs it through getErrorMessage itself, so callers never need to call
// that separately. Renders nothing for a falsy/empty error, so it's safe
// to mount unconditionally: `<ErrorBanner error={mutation.error} />` with
// no surrounding `{mutation.isError && ...}` needed.
//
//   - variant="inline" (default): exact InboxScreen look — a plain coral
//     line. Use for query-load errors and anywhere space is tight.
//   - variant="block": a tinted rounded panel (same bg-X/opacity tint
//     pattern as the app's label pills / UpcomingScreen's "Просрочено"
//     chip), with an icon. Use directly above a form's submit/save button
//     for mutation errors — the "офлайн жмёт «Сохранить»" case needs more
//     visual weight than a thin text line under a long scrolling list.
//
// Always pass `fallback` — a specific, Russian, one-sentence description
// of what failed ("Не удалось сохранить задачу"). The server's own error
// strings are a mix of Russian and English (see getErrorMessage in
// ../lib/errors); English ones are swapped for `fallback` automatically,
// so a call site that omits it can end up showing only a generic
// "Что-то пошло не так" for what might be a very common, specific failure.
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
        className={`flex items-start gap-2 bg-coral/12 text-coral rounded-xl px-3 py-2.5 text-[13px] leading-relaxed ${className}`}
      >
        <Icon name="info" size={15} className="shrink-0 mt-[1px]" />
        <span>{message}</span>
      </div>
    );
  }

  return (
    <p role="alert" className={`px-1 text-[13px] text-coral ${className}`}>
      {message}
    </p>
  );
}
