// Четыре раздела нижней навигации — общий источник для UI.tsx (BottomNav,
// SideNav) и FanMenu.tsx. Отдельный файл, а не export внутри UI.tsx: тот
// файл экспортирует компоненты, oxlint(react/only-export-components)
// предупреждает, что примесь данных туда ломает Fast Refresh.
export const NAV_ITEMS = [
  { path: "/inbox", label: "Входящие", icon: "inbox" },
  // "calendarCheck" — отдельная от "calendar" иконка (Lucide CalendarCheck),
  // а не переиспользование "calendar": тот ключ завязан на ~170 других
  // вызовов <Icon name="calendar"/> по проекту, трогать его нельзя.
  // Раньше здесь стоял тот же "calendar", что и у «Предстоящего» —
  // владелец (2026-08-11): «у нас всё равно два календаря одинаковых,
  // подбери какую-нибудь другую» — теперь силуэты различаются издалека.
  { path: "/today", label: "Сегодня", icon: "calendarCheck" },
  { path: "/upcoming", label: "Предстоящее", icon: "calendarSmall" },
  { path: "/overview", label: "Обзор", icon: "home" },
];
