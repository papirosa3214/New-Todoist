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
// список и доска, — выбор вида запоминается между заходами. В «Сегодня»
// это всегда РОВНО один день — 3-дневная развёртка 20.08.2026 переехала
// в «Предстоящее» (см. UpcomingLayout ниже), владелец: «это просто перенос
// кода, из „сегодня“ убрать».
export type TaskLayout = "list" | "board" | "hours";
// Вид раздела «Предстоящее»: привычный список с календарём-лентой,
// календарные раскладки — неделя и месяц (19.08.2026, по присланным
// скриншотам) — и «hours»: та же 3-дневная почасовая сетка, что рисует
// «Сегодня» в своём единственном дне, только на три колонки вперёд
// (today/+1/+2, без своей навигации). Переехала сюда с экрана «Сегодня»
// 20.08.2026 — компонент DayHours тот же, span-агностичный, менялась
// только «прописка». Отдельный тип, а не значения TaskLayout: «доски» в
// предстоящем по-прежнему нет, а недели и месяца нет во «Входящих» и
// «Сегодня» — общий союз только позволил бы выставить несуществующее
// сочетание.
export type UpcomingLayout = "list" | "week" | "month" | "hours";

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
  upcomingLayout: UpcomingLayout;
  setUpcomingLayout: (layout: UpcomingLayout) => void;
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
      upcomingLayout: "list",
      setUpcomingLayout: (layout) => set({ upcomingLayout: layout }),
    }),
    // Renamed from "taskflow-store" so any previously persisted mock
    // tasks/projects/users don't hydrate into the reshaped store.
    { name: "taskflow-ui" },
  ),
);
