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

export type AiProviderType =
  "local" | "claude" | "hermes" | "antigravity" | "deepseek";

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
    // `inbox` осиротел 26.08.2026 вместе с удалённым экраном Входящих, но
    // поле оставлено намеренно: оно лежит в persist-хранилище на устройствах,
    // и выкидывать его из формы состояния без миграции — ломать сохранённые
    // настройки ради одной неиспользуемой строки.
    inbox: TaskLayout;
    today: TaskLayout;
  };
  setTaskLayout: (screen: "inbox" | "today", layout: TaskLayout) => void;
  upcomingLayout: UpcomingLayout;
  setUpcomingLayout: (layout: UpcomingLayout) => void;
  // 25.08.2026: «Входящие», вид списка — секция проекта сворачивается
  // аккордеоном, чтобы задачи одного плотного проекта не захламляли ленту
  // (просьба Максима). Только вид списка — на доске у колонки и так есть
  // явные границы, сворачивать там нечего. id проекта → свёрнута ли;
  // отсутствие ключа = развёрнута (иначе пришлось бы заранее знать все id).
  collapsedInboxProjects: Record<string, boolean>;
  toggleInboxProjectCollapsed: (projectId: string) => void;
  // 25.08.2026: «Ежедневник» (бывш. «Сегодня») — владелец хочет сам
  // выбирать, какие проекты попадают в выборку («Просрочено»/«Сегодня»/
  // «Ждут вас» + сетка часов), а не видеть задачи из всех проектов разом.
  // id проекта → скрыт ли; отсутствие ключа = виден — тот же приём, что у
  // collapsedInboxProjects чуть выше, не нужно заранее знать все id, и
  // новый проект по умолчанию виден без отдельной миграции состояния.
  // Задачи без project_id (Входящие) фильтром не затрагиваются — они не
  // принадлежат ни одному проекту, скрывать их через «скрыть проект»
  // нечем.
  hiddenDailyPlannerProjects: Record<string, boolean>;
  toggleDailyPlannerProjectHidden: (projectId: string) => void;
  // Шаг 2 (feature/projects-decouple-planner-merge): opt-in список проектов
  // для ежедневника. Семантика противоположна hiddenDailyPlannerProjects
  // (там «скрыть», здесь «показать»); новое поле, потому что
  // инвертировать hidden в UI — это плодить путаницу. По умолчанию {} —
  // пустой выбор = только входящие (как и в Шаге 1). Чтобы добавить
  // проект в ежедневник, пользователь тапает [+] в полоске чипов и
  // выбирает в picker внутри TaskFilterSheet. Старый
  // hiddenDailyPlannerProjects сохранён как legacy и будет выпилен в
  // Шаге 3 после того, как все юзеры перейдут на новую схему.
  plannerVisibleProjects: Record<string, true>;
  togglePlannerVisibleProject: (projectId: string) => void;
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
      // Дефолт — qwen3.6-27b (Максим 26.08.2026). coder30b рабочая (диагноз
      // «битая» от 25.08 не подтвердился — был временный тупняк сервера) и
      // доступна в выборе, но 27b по умолчанию.
      localOllamaModel: "qwen3.6-27b-iq4-16k:latest",
      setLocalOllamaModel: (model) => set({ localOllamaModel: model }),
      antigravityModel: "gemini-3.7-flash-high",
      setAntigravityModel: (model) => set({ antigravityModel: model }),
      claudeModel: "claude-sonnet-4.6",
      setClaudeModel: (model) => set({ claudeModel: model }),
      hermesModel: "nous-hermes-3-405b",
      setHermesModel: (model) => set({ hermesModel: model }),
      deepseekModel: "deepseek-r1",
      setDeepseekModel: (model) => set({ deepseekModel: model }),
      setCalendarView: (view) =>
        set((state) => ({
          settings: { ...state.settings, calendarView: view },
        })),
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
      collapsedInboxProjects: {},
      toggleInboxProjectCollapsed: (projectId) =>
        set((state) => ({
          collapsedInboxProjects: {
            ...state.collapsedInboxProjects,
            [projectId]: !state.collapsedInboxProjects[projectId],
          },
        })),
      hiddenDailyPlannerProjects: {},
      toggleDailyPlannerProjectHidden: (projectId) =>
        set((state) => ({
          hiddenDailyPlannerProjects: {
            ...state.hiddenDailyPlannerProjects,
            [projectId]: !state.hiddenDailyPlannerProjects[projectId],
          },
        })),
      plannerVisibleProjects: {},
      togglePlannerVisibleProject: (projectId) =>
        set((state) => {
          const next = { ...state.plannerVisibleProjects };
          if (next[projectId]) {
            delete next[projectId];
          } else {
            next[projectId] = true;
          }
          return { plannerVisibleProjects: next };
        }),
    }),
    {
      name: "taskflow-ui",
      // 25.08.2026: coder30b-abl:latest — старый дефолт localOllamaModel —
      // надёжно роняет Ollama CUDA-ошибкой (см. server/src/routes/ai.ts).
      // Смены значения ТОЛЬКО в коде недостаточно: persist уже записал
      // старый дефолт в localStorage у каждого, кто открывал приложение
      // раньше, и при мёрже персистентное значение побеждает над новым
      // дефолтом. version+migrate — разовая правка именно этого битого
      // значения, не трогает выбор, если он был осознанно другим.
      // v2 (26.08.2026): БЫЛА миграция «coder30b битая → заменить на 27b»
      // по подстроке. Диагноз не подтвердился (Максим: модель рабочая,
      // временный тупняк сервера), но миграция уже применилась у всех —
      // оставлена как есть (повторно не сработает, version уже 2), выбор
      // coder30b руками снова возможен и переживает перезапуск.
      // v3 (30.08.2026, feature/projects-decouple-planner-merge, Шаг 2):
      // добавлен plannerVisibleProjects. Семантика другая, чем у
      // hiddenDailyPlannerProjects, поэтому переносить значения нельзя —
      // старый словарь остаётся в persist как legacy до Шага 3. Дефолт
      // для нового поля — {}, как и в инициализации стора.
      version: 3,
      migrate: (persisted: any, version) => {
        if (
          version < 1 &&
          persisted?.localOllamaModel === "coder30b-abl:latest"
        ) {
          persisted.localOllamaModel = "qwen3.6-27b-iq4-16k:latest";
        }
        if (
          version < 2 &&
          /coder30b/i.test(persisted?.localOllamaModel || "")
        ) {
          persisted.localOllamaModel = "qwen3.6-27b-iq4-16k:latest";
        }
        if (version < 3) {
          persisted.plannerVisibleProjects =
            persisted.plannerVisibleProjects || {};
        }
        return persisted;
      },
      partialize: (state) => ({
        settings: state.settings,
        taskLayout: state.taskLayout,
        upcomingLayout: state.upcomingLayout,
        collapsedInboxProjects: state.collapsedInboxProjects,
        hiddenDailyPlannerProjects: state.hiddenDailyPlannerProjects,
        plannerVisibleProjects: state.plannerVisibleProjects,
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
