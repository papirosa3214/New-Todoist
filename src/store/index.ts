import { create } from "zustand";
import { persist } from "zustand/middleware";

// ═══════════ UI-only store ═══════════
// All app data (tasks, projects, labels, users, notifications) now lives
// in the React Query cache, backed by the live API — see src/api/*.
// This store only keeps client-side UI preferences that don't belong on
// the server.

interface AppState {
  settings: {
    theme: "dark" | "light";
    calendarView: "month" | "week";
  };
  setCalendarView: (view: "month" | "week") => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      settings: { theme: "dark", calendarView: "month" },
      setCalendarView: (view) =>
        set((s) => ({ settings: { ...s.settings, calendarView: view } })),
    }),
    // Renamed from "taskflow-store" so any previously persisted mock
    // tasks/projects/users don't hydrate into the reshaped store.
    { name: "taskflow-ui" },
  ),
);
