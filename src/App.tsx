import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { LoginScreen } from "./screens/LoginScreen";
import { RegisterScreen } from "./screens/RegisterScreen";
import { InboxScreen } from "./screens/InboxScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { UpcomingScreen } from "./screens/UpcomingScreen";
import { OverviewScreen } from "./screens/OverviewScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TaskDetailScreen } from "./screens/TaskDetailScreen";
import { TaskFormScreen } from "./screens/TaskFormScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { LabelsScreen } from "./screens/LabelsScreen";
import { ProjectTasksScreen } from "./screens/ProjectTasksScreen";
import { LabelTasksScreen } from "./screens/LabelTasksScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { Icon } from "./components/UI";

// Catch-all for unknown routes: without this a bad/typo'd URL renders the
// Routes tree with zero matches — a blank black screen with no explanation
// and no way out. "/" resolves through the existing auth logic below (to
// /inbox when logged in, /login otherwise), so it's always a safe target.
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
  return (
    <Routes>
      {/* Auth (no layout) */}
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/register" element={<RegisterScreen />} />

      {/* App shell (requires auth) */}
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<InboxScreen />} />
          <Route path="/today" element={<TodayScreen />} />
          <Route path="/upcoming" element={<UpcomingScreen />} />
          <Route path="/overview" element={<OverviewScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/task/:id" element={<TaskDetailScreen />} />
          <Route path="/task/new" element={<TaskFormScreen />} />
          <Route path="/task/:id/edit" element={<TaskFormScreen />} />
          <Route path="/notifications" element={<NotificationsScreen />} />
          {/* Drill-down, not a tab — see Layout.tsx's TAB_ROUTES allowlist.
              Deliberately absent from it, so no bottom nav / FAB here. */}
          <Route path="/activity" element={<ActivityScreen />} />
          <Route path="/agents" element={<AgentsScreen />} />
          <Route path="/projects" element={<ProjectsScreen />} />
          <Route path="/projects/:id" element={<ProjectTasksScreen />} />
          <Route path="/labels" element={<LabelsScreen />} />
          <Route path="/labels/:id" element={<LabelTasksScreen />} />
          <Route path="/search" element={<SearchScreen />} />
        </Route>
      </Route>

      {/* Unknown routes — outside auth/layout so it always renders. */}
      <Route path="*" element={<NotFoundScreen />} />
    </Routes>
  );
}
