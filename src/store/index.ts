import { create } from "zustand";
import { persist } from "zustand/middleware";

// ═══════════ UI-only store ═══════════
// All app data (tasks, projects, labels, users, notifications) now lives
// in the React Query cache, backed by the live API — see src/api/*.
// This store only keeps client-side UI preferences that don't belong on
// the server.

// "hours" — календарная развёртка по часам (18.08.2026), доступна только
// на экране «Сегодня»: у неё есть смысл ровно для одного дня, на
// «Входящих» раскладывать по часам нечего. Хранится тем же полем, что
// список и доска, — выбор вида запоминается между заходами.
export type TaskLayout = "list" | "board" | "hours";

interface AppState {
  settings: {
    theme: "dark" | "light";
    calendarView: "month" | "week";
  };
  setCalendarView: (view: "month" | "week") => void;
  // Реальный переключатель темы (SettingsScreen.tsx) — settings.theme уже
  // существовал и персистился, но до 2026-08-12 ничто его не читало и не
  // меняло: SettingsScreen показывал захардкоженную строку «Темный».
  // App.tsx применяет текущее значение на <html data-theme> при каждом
  // изменении (см. index.css, LIGHT THEME OVERRIDE).
  setTheme: (theme: "dark" | "light") => void;
  // Список↔доска, per screen. Kept as one object with a key per screen
  // (not a single flat value like calendarView above) because Inbox and
  // Today are independent screens that can each sit in their own mode at
  // once — switching one to "board" must not drag the other along.
  taskLayout: {
    inbox: TaskLayout;
    today: TaskLayout;
  };
  setTaskLayout: (screen: "inbox" | "today", layout: TaskLayout) => void;
  // 1 день / 3 дня внутри вида «по часам» (19.08.2026, по присланным
  // скриншотам Apple Reminders — «Сегодня» и «Предстоящее» там та же
  // сетка, только на 3 колонки). Отдельное поле, а не третье значение
  // TaskLayout: это настройка ВНУТРИ hours, а не отдельный вид рядом со
  // списком/доской, и переключается своим мини-тумблером в самом экране.
  hoursSpan: 1 | 3;
  setHoursSpan: (span: 1 | 3) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      settings: { theme: "dark", calendarView: "month" },
      setCalendarView: (view) =>
        set((s) => ({ settings: { ...s.settings, calendarView: view } })),
      setTheme: (theme) => set((s) => ({ settings: { ...s.settings, theme } })),
      taskLayout: { inbox: "list", today: "list" },
      setTaskLayout: (screen, layout) =>
        set((s) => ({ taskLayout: { ...s.taskLayout, [screen]: layout } })),
      hoursSpan: 1,
      setHoursSpan: (span) => set({ hoursSpan: span }),
    }),
    // Renamed from "taskflow-store" so any previously persisted mock
    // tasks/projects/users don't hydrate into the reshaped store.
    { name: "taskflow-ui" },
  ),
);
