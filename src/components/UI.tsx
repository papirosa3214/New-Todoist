import { useLocation, useNavigate } from "react-router-dom";
import {
  Children,
  useMemo,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTasks } from "../api/tasks";
import { todayStr } from "../lib/date";

// ═══════════ SVG ICON STROKE SET ═══════════

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
  const icons: Record<string, ReactElement> = {
    inbox: (
      <>
        <path d="M3.5 12.5l3.5-7h10l3.5 7" />
        <path d="M3.5 12.5h17a1 1 0 0 1 1 1v1a3 3 0 0 1-3 3h-13a3 3 0 0 1-3-3v-1a1 1 0 0 1 1-1z" />
        <path d="M9.5 7v3" />
        <path d="M14.5 7v3" />
      </>
    ),
    calendar: (
      <>
        <rect x="3.5" y="4" width="17" height="16.5" rx="3" />
        <path d="M3.5 9h17" />
        <path d="M8 2.5v4" />
        <path d="M16 2.5v4" />
      </>
    ),
    calendarSmall: (
      <>
        <rect x="3.5" y="4" width="17" height="16.5" rx="3" />
        <path d="M3.5 9h17" />
        <path d="M8 2.5v4" />
        <path d="M16 2.5v4" />
      </>
    ),
    home: (
      <>
        <path d="M3.5 11.5l8.5-8 8.5 8" />
        <path d="M6 10v8.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10" />
      </>
    ),
    homeFilled: (
      <>
        <path d="M12 2.7L2.5 11a1.5 1.5 0 0 0 .5 2.7h2v7a1 1 0 0 0 1 1h4v-5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V18.7h4a1.5 1.5 0 0 0 .5-2.7L12 2.7z" />
      </>
    ),
    tag: (
      <>
        <path d="M2.5 13.5V3.5a1 1 0 0 1 1-1h10l7.5 7.5-10 10-9-9.5z" />
        <circle cx="7" cy="7" r="1.5" />
      </>
    ),
    hash: (
      <>
        <path d="M6 3.5l-2 17" />
        <path d="M14 3.5l-2 17" />
        <path d="M1 9.5h22" />
        <path d="M1 14.5h22" />
      </>
    ),
    flag: (
      <>
        <path d="M5 2.5v19" />
        <path d="M5 2.5h12l-3 4 3 4H5" />
      </>
    ),
    flagSmall: (
      <>
        <path d="M5 2.5v19" />
        <path d="M5 2.5h12l-3 4 3 4H5" />
      </>
    ),
    dots: (
      <>
        <circle cx="12" cy="5" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="12" cy="19" r="1.5" />
      </>
    ),
    dotsH: (
      <>
        <circle cx="5" cy="12" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    check: (
      <>
        <path d="M4.5 12.5l5 5L19.5 7" />
      </>
    ),
    chevron: (
      <>
        <path d="M9 5l7 7-7 7" />
      </>
    ),
    chevronLeft: (
      <>
        <path d="M15 5l-7 7 7 7" />
      </>
    ),
    chevronDown: (
      <>
        <path d="M5 9l7 7 7-7" />
      </>
    ),
    close: (
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </>
    ),
    x: (
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="7" />
        <path d="M15.5 15.5L21 21" />
      </>
    ),
    bell: (
      <>
        <path d="M12 4a5 5 0 0 0-5 5v3.5L5 15h14l-2-3.5V9a5 5 0 0 0-5-5z" />
        <path d="M9.8 17.6a2.3 2.3 0 0 0 4.4 0" />
      </>
    ),
    bellSlash: (
      <>
        <path d="M12 4a5 5 0 0 0-5 5v3.5L5 15h14l-2-3.5V9a5 5 0 0 0-5-5z" />
        <path d="M9.8 17.6a2.3 2.3 0 0 0 4.4 0" />
        <path d="M3.5 3.5l17 17" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1.5v3m0 15v3m-8.5-11.5h3m15 0h3m-3.3-6.8l-2.1 2.1m-9.8 9.8l-2.1 2.1m0-14l2.1 2.1m9.8 9.8l2.1 2.1" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1.5v3m0 15v3m-8.5-11.5h3m15 0h3m-3.3-6.8l-2.1 2.1m-9.8 9.8l-2.1 2.1m0-14l2.1 2.1m9.8 9.8l2.1 2.1" />
      </>
    ),
    mail: (
      <>
        <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
        <path d="M2.5 6.5l9.5 6 9.5-6" />
      </>
    ),
    lock: (
      <>
        <rect x="4" y="10.5" width="16" height="11.5" rx="2.5" />
        <path d="M7.5 10.5V7.5a4.5 4.5 0 0 1 9 0v3" />
      </>
    ),
    eye: (
      <>
        <path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z" />
        <circle cx="12" cy="12" r="3.5" />
      </>
    ),
    person: (
      <>
        <path d="M20.5 21.5v-2a4 4 0 0 0-4-4h-9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7.5" r="4" />
      </>
    ),
    crown: (
      <>
        <path d="M2 18h20l-3-10-5 4-4-7-4 7-3-4z" />
        <path d="M2 18v2h20v-2" />
        <circle cx="2" cy="7" r="1.5" />
        <circle cx="12" cy="4" r="1.5" />
        <circle cx="22" cy="7" r="1.5" />
      </>
    ),
    bot: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="3" />
        <circle cx="9" cy="14" r="1.5" />
        <circle cx="15" cy="14" r="1.5" />
        <path d="M9 18.5h6" />
        <path d="M12 4v3" />
        <circle cx="12" cy="2.5" r="1.5" />
        <path d="M4 12H2" />
        <path d="M22 12h-2" />
      </>
    ),
    google: (
      <>
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
      </>
    ),
    list: (
      <>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h12" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </>
    ),
    activity: (
      <>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </>
    ),
    star: (
      <>
        <polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3" />
      </>
    ),
    cloud: (
      <>
        <path d="M18 10a5 5 0 0 0-9.8-1A4 4 0 0 0 5 17h13a4 4 0 0 0 0-8z" />
      </>
    ),
    shield: (
      <>
        <path d="M12 2l8 4v6c0 5.5-3.8 9.7-8 11-4.2-1.3-8-5.5-8-11V6l8-4z" />
      </>
    ),
    play: (
      <>
        <polygon points="5 3 19 12 5 21" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
      </>
    ),
    share: (
      <>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
      </>
    ),
    trash: (
      <>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </>
    ),
    edit: (
      <>
        <path d="M17 3l4 4L7 21H3v-4L17 3z" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <circle cx="12" cy="8" r="0.5" />
      </>
    ),
    moon: (
      <>
        <path d="M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8z" />
      </>
    ),
    sync: (
      <>
        <path d="M21.5 2v6h-6" />
        <path d="M2.5 22v-6h6" />
        <path d="M2.5 11.5a10 10 0 0 1 18-4.5" />
        <path d="M21.5 12.5a10 10 0 0 1-18 4.5" />
      </>
    ),
    zap: (
      <>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" />
      </>
    ),
    image: (
      <>
        <rect x="2.5" y="3.5" width="19" height="17" rx="2" />
        <circle cx="8.5" cy="9" r="2" />
        <path d="M21.5 15.5l-5-5L3.5 21.5" />
      </>
    ),
    arrowUp: (
      <>
        <path d="M12 19V5" />
        <path d="M5 12l7-7 7 7" />
      </>
    ),
    arrowDown: (
      <>
        <path d="M12 5v14" />
        <path d="M19 12l-7 7-7-7" />
      </>
    ),
    pin: (
      <>
        <path d="M12 2l-4 7h8l-4-7z" />
        <path d="M8 9l-4 7h16l-4-7" />
        <path d="M12 16v6" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {icons[name]}
    </svg>
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

const NAV_ITEMS = [
  { path: "/inbox", label: "Входящие", icon: "inbox", activeIcon: "inbox" },
  {
    path: "/today",
    label: "Сегодня",
    icon: "calendar",
    activeIcon: "calendar",
  },
  {
    path: "/upcoming",
    label: "Предстоящее",
    icon: "calendarSmall",
    activeIcon: "calendarSmall",
  },
  { path: "/overview", label: "Обзор", icon: "home", activeIcon: "homeFilled" },
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
    <nav className="pb-nav-safe fixed inset-x-0 bottom-0 z-20 flex items-stretch h-[60px] bg-bg/90 backdrop-blur-xl border-t border-stroke">
      {NAV_ITEMS.map((item) => {
        const active = location.pathname === item.path;
        const isToday = item.path === "/today";
        const showBadge = isToday && todayTasks.length > 0;
        return (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`flex-1 flex flex-col items-center justify-center gap-[2px] transition-colors ${
              active ? "text-text" : "text-dim"
            }`}
          >
            {active && !isToday ? (
              <div className="bg-red/18 rounded-[10px] px-3 py-1.5 flex items-center justify-center">
                <Icon name={item.activeIcon} size={22} className="text-red" />
              </div>
            ) : (
              <div className="relative px-3 py-1.5">
                <Icon
                  name={isToday ? "calendarSmall" : item.icon}
                  size={22}
                  className={active ? "text-red" : ""}
                />
                {showBadge && (
                  <div className="absolute -top-0 right-0 bg-red text-white text-[9px] font-bold rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1">
                    {todayTasks.length}
                  </div>
                )}
              </div>
            )}
            <span
              className={`text-[10px] font-medium ${active ? "text-text" : "text-dim"}`}
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
      className="fab-safe-bottom fixed right-[18px] w-[58px] h-[58px] rounded-full bg-red flex items-center justify-center shadow-[0_6px_16px_rgba(228,67,50,.45)] z-30 transition-transform active:scale-95"
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
          className="w-full flex items-center gap-2 px-2 py-[5px] rounded-lg hover:bg-card text-left text-[13px] text-sub hover:text-text transition-colors"
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
      className={`w-full h-12 rounded-xl text-[15px] font-semibold flex items-center justify-center gap-3 transition-opacity active:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
