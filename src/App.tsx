import { useEffect } from "react";
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { useAppStore } from "./store";
import { Layout } from "./components/Layout";
import { RealLocationProvider } from "./lib/backgroundLocation";
import { getOverlayState } from "./lib/backgroundLocationContext";
import { RequireAuth } from "./components/RequireAuth";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { TodayScreenTimeline } from "./screens/TodayScreenTimeline";
import { InboxScreenTimeline } from "./screens/InboxScreenTimeline";
import { UpcomingScreen } from "./screens/UpcomingScreen";
import { OverviewScreen } from "./screens/OverviewScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TaskDetailScreen } from "./screens/TaskDetailScreen";
import { TaskFormScreen } from "./screens/TaskFormScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { ChatRoomScreen } from "./screens/ChatRoomScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { AgentWorkScreen } from "./screens/AgentWorkScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { LabelsScreen } from "./screens/LabelsScreen";
import { ProjectTasksScreen } from "./screens/ProjectTasksScreen";
import { LabelTasksScreen } from "./screens/LabelTasksScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { VoiceModelsScreen } from "./screens/VoiceModelsScreen";
import { IntegrationsScreen } from "./screens/IntegrationsScreen";
import { ProvidersScreen } from "./screens/ProvidersScreen";
import { RolesModelsScreen } from "./screens/RolesModelsScreen";
import { TemplatesScreen } from "./screens/TemplatesScreen";
import { NotesScreen } from "./screens/NotesScreen";
import { NoteEditorScreen } from "./screens/NoteEditorScreen";
import { Icon } from "./components/UI";

// Catch-all for unknown routes: without this a bad/typo'd URL renders the
// Routes tree with zero matches — a blank black screen with no explanation
// and no way out. "/" resolves through the existing auth logic below (to
// /overview when logged in, /login otherwise), so it's always a safe target.
function NotFoundScreen() {
  const navigate = useNavigate();
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 px-6 text-center bg-bg">
      <div className="w-16 h-16 rounded-full bg-card flex items-center justify-center">
        <Icon name="info" size={28} className="text-dim" />
      </div>
      <div>
        <h1 className="text-[19px] font-semibold text-text mb-1">
          Страница не найдена
        </h1>
        <p className="text-[14px] text-sub leading-relaxed max-w-[280px]">
          Такого адреса нет в приложении. Возможно, ссылка устарела.
        </p>
      </div>
      <button
        onClick={() => navigate("/")}
        className="h-12 px-6 rounded-xl bg-red text-[15px] font-semibold text-white"
      >
        На главную
      </button>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const theme = useAppStore((s) => s.settings.theme);
  // Модальный роут для десктопной панели задачи (TaskDetailPanel.tsx,
  // Layout.tsx) — см. lib/backgroundLocation.tsx за полным разбором. Здесь
  // же useLocation() вызван РАНЬШЕ подмены (см. `location` в <Routes> ниже)
  // — это и есть тот самый «настоящий» location, который раздаём вниз через
  // RealLocationProvider.
  const location = useLocation();
  const background = getOverlayState(location)?.backgroundLocation;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Обработка Deep Links (например, taskflow://dictate из Action Button / Экрана блокировки)
  useEffect(() => {
    const handleUrl = (data: { url: string }) => {
      try {
        const urlStr = data.url;
        if (urlStr.startsWith("taskflow://")) {
          const pathWithQuery = urlStr.replace("taskflow://", "");
          const [pathPart] = pathWithQuery.split("?");
          const host = pathPart.replace(/^\//, "").split("/")[0];

          if (host === "dictate" || host === "new-task" || host === "new") {
            navigate("/task/new?dictate=1");
          } else if (host === "task") {
            const taskId = pathPart.replace(/^\/?task\/?/, "");
            if (taskId) navigate(`/task/${taskId}`);
          } else if (host === "inbox") {
            navigate("/overview");
          } else if (host === "today") {
            navigate("/today");
          } else if (host === "overview") {
            navigate("/overview");
          } else {
            navigate("/task/new?dictate=1");
          }
        }
      } catch (err) {
        console.error("Deep link error:", err);
      }
    };

    const listenerPromise = CapApp.addListener("appUrlOpen", handleUrl);
    return () => {
      listenerPromise.then((handle) => handle.remove());
    };
  }, [navigate]);

  return (
    <RealLocationProvider location={location}>
      <Routes location={background ?? location}>
        {/* Auth (no layout) */}
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/register" element={<RegisterScreen />} />

        {/* App shell (requires auth) */}
        <Route element={<RequireAuth />}>
          {/* Клавиатура — СИСТЕМНАЯ, как было до 18.08.2026. Своя экранная
            (components/AppKeyboard.tsx + lib/keyboardContext.tsx) отключена
            20.08.2026 по решению владельца: «головника больше, чем
            преимуществ — то печатает, то криво смотрится». Файлы оставлены
            нетронутыми, но нигде не подключены — см. шапку AppKeyboard.tsx. */}
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/today" element={<TodayScreen />} />
            <Route path="/timeline" element={<TodayScreenTimeline />} />
            <Route path="/inbox-timeline" element={<InboxScreenTimeline />} />
            <Route path="/upcoming" element={<UpcomingScreen />} />
            <Route path="/overview" element={<OverviewScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="/task/:id" element={<TaskDetailScreen />} />
            <Route path="/task/new" element={<TaskFormScreen />} />
            <Route path="/task/:id/edit" element={<TaskFormScreen />} />
            <Route path="/notifications" element={<NotificationsScreen />} />
            <Route path="/chat" element={<ChatScreen />} />
            {/* Чаты с ролями-агентами (этап 8 клиент, этап 1 сервера):
                /chats — список моих чатов, /chats/:id — комната.
                Маршрут НЕ путать с /chat выше: там — служебная
                переписка поверх задачи, здесь — отдельные сущности
                «чат с ролью/ролями», своя лента, свой кэш, своя
                точка входа (OverviewScreen → пункт «Чаты»). */}
            <Route path="/chats" element={<ChatsScreen />} />
            <Route path="/chats/:id" element={<ChatRoomScreen />} />
            {/* Drill-down, not a tab — see Layout.tsx's TAB_ROUTES allowlist.
              Deliberately absent from it, so no bottom nav / FAB here. */}
            <Route path="/activity" element={<ActivityScreen />} />
            <Route path="/agents" element={<AgentsScreen />} />
            <Route path="/agent-work" element={<AgentWorkScreen />} />
            <Route path="/projects" element={<ProjectsScreen />} />
            <Route path="/projects/:id" element={<ProjectTasksScreen />} />
            <Route path="/labels" element={<LabelsScreen />} />
            <Route path="/labels/:id" element={<LabelTasksScreen />} />
            <Route path="/search" element={<SearchScreen />} />
            {/* Drill-down из «Ежедневника» (пункт «Дневник» под тремя
              точками, заменил «Заметки» 25.08.2026) — не своя вкладка, тем
              же приёмом, что /activity выше: отсутствует в Layout.tsx
              TAB_ROUTES нарочно. */}
            {/* Заметки. Вход из меню ведёт СЮДА (26.08.2026, Максим:
              «логичнее попадать не сразу в заметку, а в меню, где папки
              и заметки»), редактор — уже по тапу на заметку.
              Папки отдельного маршрута НЕ имеют: дерево раскрывается
              на месте, как в Obsidian. */}
            <Route path="/notes" element={<NotesScreen />} />
            <Route path="/notes/:id" element={<NoteEditorScreen />} />
            <Route
              path="/settings/voice-models"
              element={<VoiceModelsScreen />}
            />
            <Route
              path="/settings/integrations"
              element={<IntegrationsScreen />}
            />
            <Route
              path="/settings/providers"
              element={<ProvidersScreen />}
            />
            <Route
              path="/settings/roles-models"
              element={<RolesModelsScreen />}
            />
            <Route path="/settings/templates" element={<TemplatesScreen />} />
          </Route>
        </Route>

        {/* Unknown routes — outside auth/layout so it always renders. */}
        <Route path="*" element={<NotFoundScreen />} />
      </Routes>
    </RealLocationProvider>
  );
}
