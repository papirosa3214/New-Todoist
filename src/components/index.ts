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

export type AiProviderType = "local" | "claude" | "hermes" | "antigravity" | "deepseek";

export interface AiProviderInfo {
  id: AiProviderType;
  name: string;
  subtitle: string;
  badge: string;
  iconName: string;
  color: string;
}

export const AI_PROVIDERS: Record<AiProviderType, AiProviderInfo> = {
  local: {
    id: "local",
    name: "Локальная модель",
    subtitle: "Ollama / Локальный домашний сервер",
    badge: "Локально",
    iconName: "server",
    color: "#34C759",
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    subtitle: "Anthropic Claude Agent Hub",
    badge: "Claude",
    iconName: "brain",
    color: "#D97706",
  },
  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    subtitle: "OpenRouter & Autonomous Routing Hub",
    badge: "Agentic",
    iconName: "sparkles",
    color: "#8B5CF6",
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    subtitle: "Google DeepMind / Gemini & Sidecars",
    badge: "Gemini",
    iconName: "zap",
    color: "#06B6D4",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    subtitle: "DeepSeek Engine (Reasoner / Chat)",
    badge: "DeepSeek",
    iconName: "cpu",
    color: "#3B82F6",
  },
};

interface AppState {
  settings: {
    theme: "dark" | "light";
    calendarView: "month" | "week";
  };
  aiProvider: AiProviderType;
  setAiProvider: (provider: AiProviderType) => void;
  localOllamaModel: string;
  setLocalOllamaModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  hermesModel: string;
  setHermesModel: (model: string) => void;
  deepseekModel: string;
  setDeepseekModel: (model: string) => void;
  setCalendarView: (view: "month" | "week") => void;
  setTheme: (theme: "dark" | "light") => void;
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
      settings: {
        theme: "dark",
        calendarView: "month",
      },
      aiProvider: "local",
      setAiProvider: (provider) => set({ aiProvider: provider }),
      localOllamaModel: "coder30b-abl:latest",
      setLocalOllamaModel: (model) => set({ localOllamaModel: model }),
      antigravityModel: "gemini-3.1-pro",
      setAntigravityModel: (model) => set({ antigravityModel: model }),
      claudeModel: "claude-sonnet-4.6",
      setClaudeModel: (model) => set({ claudeModel: model }),
      hermesModel: "nous-hermes-3-405b",
      setHermesModel: (model) => set({ hermesModel: model }),
      deepseekModel: "deepseek-r1",
      setDeepseekModel: (model) => set({ deepseekModel: model }),
      setCalendarView: (view) =>
        set((state) => ({ settings: { ...state.settings, calendarView: view } })),
      setTheme: (theme) =>
        set((state) => ({ settings: { ...state.settings, theme } })),
      taskLayout: {
        inbox: "list",
        today: "list",
      },
      setTaskLayout: (screen, layout) =>
        set((state) => ({
          taskLayout: { ...state.taskLayout, [screen]: layout },
        })),
      upcomingLayout: "month",
      setUpcomingLayout: (layout) => set({ upcomingLayout: layout }),
    }),
    {
      name: "taskflow-ui",
      partialize: (state) => ({
        settings: state.settings,
        taskLayout: state.taskLayout,
        upcomingLayout: state.upcomingLayout,
        aiProvider: state.aiProvider,
        localOllamaModel: state.localOllamaModel,
        antigravityModel: state.antigravityModel,
        claudeModel: state.claudeModel,
        hermesModel: state.hermesModel,
        deepseekModel: state.deepseekModel,
      }),
    },
  ),
);
