import { Routes, Route, Navigate } from "react-router-dom";
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
import { AgentsScreen } from "./screens/AgentsScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { SearchScreen } from "./screens/SearchScreen";

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
          <Route path="/agents" element={<AgentsScreen />} />
          <Route path="/projects" element={<ProjectsScreen />} />
          <Route path="/search" element={<SearchScreen />} />
        </Route>
      </Route>
    </Routes>
  );
}
